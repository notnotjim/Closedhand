// Possible misuse of Closedhand Managed Models, for the insights page: signs
// read from what closedhand.com already holds and from OpenRouter's own count
// of each key, then a few lines an LLM writes from those signs saying what is
// most likely going on and what, if anything, to do. Code finds the signs and
// sets the bar; the LLM only reads them. It sees personal URL names, counts
// and amounts, never an email. With nothing to report there is nothing to show.
const crypto = require('crypto');

const DAY = 86400000;
// "Closedhand <account id>": the name included-ai.js gives a person's key.
const PERSON_KEY = /^Closedhand ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const usd = n => '$' + Number(n || 0).toFixed(2);

function create({ db, env = process.env, includedAi, request = fetch }) {
  const fairUse = Number(env.INCLUDED_AI_FAIR_USE_USD || 20);
  const perConnection = Number(env.INCLUDED_AI_PER_CONNECTION || 10);
  const dailyPeople = Number(env.INCLUDED_AI_DAILY_PEOPLE || 25);
  const budget = Number(env.OPENROUTER_MONTHLY_BUDGET_USD || 0);

  // Each sign is one plain sentence about one thing, most pressing first.
  async function signs(now = new Date()) {
    const found = [];
    const keys = includedAi?.enabled() ? await includedAi.allKeys() : [];
    const byHash = new Map(keys.map(k => [k.hash, k]));
    const held = (await db.query(
      `SELECT k.owner_id, k.key_hash, k.granted_usd::float AS granted, k.granted_at, k.stopped_at,
              a.hostname, a.activated_at, a.last_seen_at, p.status AS plus
         FROM included_ai_keys k
         LEFT JOIN addresses a ON a.owner_id = k.owner_id AND a.state <> 'revoked'
         LEFT JOIN plus_subscriptions p ON p.owner_id = k.owner_id`)).rows;
    const retired = (await db.query('SELECT key_hash, tries FROM retired_ai_keys')).rows;
    const name = r => (r.hostname ? r.hostname.replace(/\.closedhand\.ai$/, '') : 'account ' + r.owner_id.slice(0, 8));

    // Spend at OpenRouter that no account holds: a key that should be gone.
    const known = new Set([...held.map(r => r.key_hash), ...retired.map(r => r.key_hash)]);
    const loose = keys.filter(k => PERSON_KEY.test(String(k.name || '')) && !known.has(k.hash) && !k.disabled);
    if (loose.length) {
      const spent = loose.reduce((t, k) => t + Number(k.usage_monthly || 0), 0);
      found.push(`${loose.length} OpenRouter ${loose.length === 1 ? 'key is' : 'keys are'} live that no account holds, with ${usd(spent)} used this month.`);
    }

    // On pace to spend more than the budget this month.
    if (budget > 0 && keys.length) {
      const spent = keys.reduce((t, k) => t + Number(k.usage_monthly || 0), 0);
      const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
      const gone = Math.max(0.5, (now - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) / DAY);
      const pace = spent / gone * days;
      if (spent >= 1 && pace > budget) found.push(`OpenRouter spend is ${usd(spent)} so far this month, on pace for ${usd(pace)} against the ${usd(budget)} budget.`);
    }

    // Fair use going fast: half or more gone, at three times the even pace.
    for (const r of held) {
      const k = byHash.get(r.key_hash);
      if (!k || r.stopped_at) continue;
      const monthly = k.limit_reset === 'monthly';
      const used = Number(monthly ? k.usage_monthly : k.usage) || 0, limit = Number(k.limit) || 0;
      if (used < 2 || limit <= 0 || used / limit < 0.5) continue;
      const since = monthly ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) : new Date(r.granted_at).getTime();
      const days = Math.max(0.25, (now - since) / DAY);
      if (used / limit / (days / 30) < 3) continue;
      const which = monthly ? "this month's Closedhand+ fair use" : 'its first month';
      found.push(`${name(r)} has used ${Math.round(used / limit * 100)}% of ${which} (${usd(used)}) in ${days < 1 ? 'under a day' : Math.round(days) + (Math.round(days) === 1 ? ' day' : ' days')}.`);
    }

    // First months handed out that are not being used where they belong.
    const offline = held.filter(r => r.granted > 0 && !r.stopped_at && !r.plus && !r.last_seen_at && now - new Date(r.granted_at) > 6 * 3600000);
    for (const r of offline) found.push(`${name(r)} got a first month, but its personal URL has never come online.`);

    // Connections that reached the most first months they may have.
    const full = Number((await db.query(
      `SELECT count(*)::int AS n FROM (SELECT network_hash FROM starter_grants
         WHERE network_hash IS NOT NULL AND granted_at > now() - interval '30 days'
         GROUP BY network_hash HAVING count(*) >= $1) AS c`, [perConnection])).rows[0].n);
    if (perConnection > 0 && full) found.push(`${full} internet ${full === 1 ? 'connection has' : 'connections have'} reached the most first months one connection may have (${perConnection} in 30 days).`);

    const lastDay = Number((await db.query("SELECT count(*)::int AS n FROM starter_grants WHERE granted_at > now() - interval '1 day'")).rows[0].n);
    if (dailyPeople > 0 && lastDay >= dailyPeople) found.push(`${lastDay} first months started in the last 24 hours, more than the ${dailyPeople} expected.`);

    // Upkeep that keeps failing.
    const stuck = retired.filter(r => r.tries >= 3).length;
    if (stuck) found.push(`${stuck} replaced or deleted ${stuck === 1 ? 'key has' : 'keys have'} not been deleted at OpenRouter after 3 tries.`);
    const unsynced = Number((await db.query(
      "SELECT count(*)::int AS n FROM plus_subscriptions WHERE NOT key_synced AND updated_at < now() - interval '2 hours'")).rows[0].n);
    if (unsynced) found.push(`${unsynced} Closedhand+ ${unsynced === 1 ? 'change has' : 'changes have'} not reached ${unsynced === 1 ? 'its key' : 'their keys'} for over 2 hours.`);
    return found;
  }

  // What an LLM makes of the signs, written once for each set of them.
  let written = { of: null, text: null };
  async function summary(list) {
    if (!list.length) return null;
    const of = crypto.createHash('sha256').update(list.join('\n')).digest('hex');
    if (written.of === of) return written.text;
    const llm = await includedAi?.forOperator?.();
    if (!llm) return null;
    // Without thinking, or as little as the model allows: the answer is short.
    const ask = reasoning => request('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + llm.key, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://closedhand.com', 'X-Title': 'Closedhand' },
      body: JSON.stringify({
        model: llm.model,
        max_tokens: 1500,
        reasoning,
        messages: [
          { role: 'system', content: `You help the one person who runs closedhand.com keep Closedhand Managed Models from being misused. Each new Closedhand account gets a first month: an OpenRouter key with ${usd(fairUse)} of fair use, once per Google or Microsoft sign-in and at most ${perConnection} per internet connection in 30 days. Closedhand+ is a monthly subscription sold through Polar that renews the fair use each month. You are given signs found in closedhand.com's own records. In at most four short plain sentences, say what is most likely going on and what, if anything, to do. Say plainly when something is probably harmless, like a household sharing one connection or one heavy but honest user. Only suggest these actions: set INCLUDED_AI_PER_CONNECTION=0 on Railway to stop new first months; disable a key in OpenRouter's dashboard (each is named "Closedhand" and the account id); cancel or refund a subscription in Polar; raise ADDRESS_LIMIT or OPENROUTER_MONTHLY_BUDGET_USD on Railway, or top up OpenRouter. Use only what the signs say. Never use dashes as punctuation.` },
          { role: 'user', content: list.map(s => '- ' + s).join('\n') },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    let response = await ask({ enabled: false });
    if (response.status === 400) response = await ask({ effort: 'low', exclude: true });
    if (!response.ok) throw new Error('OpenRouter answered ' + response.status);
    const choice = (await response.json())?.choices?.[0];
    const text = String(choice?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s*[\u2013\u2014]\s*/g, ', ').trim();
    if (!text) throw new Error('the LLM wrote nothing (it stopped for ' + String(choice?.finish_reason || 'no reason given').slice(0, 30) + ')');
    written = { of, text };
    return text;
  }

  // The insights page's section: the signs, and the summary when it could be written.
  async function report(now = new Date()) {
    const list = await signs(now);
    let text = null;
    if (list.length) text = await summary(list).catch(e => { console.error('[misuse] no summary:', e.message); return null; });
    return { signs: list, summary: text };
  }

  return { signs, summary, report };
}

module.exports = { create };
