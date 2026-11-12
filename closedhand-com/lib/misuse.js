// Possible misuse of Closedhand Managed Models, for the insights page: signs
// read from what closedhand.com already holds and from the provider's own
// count of each key (NEAR AI, or OpenRouter), then a few lines an LLM writes
// from those signs saying what is most likely going on and what, if anything,
// to do. Code finds the signs and sets the bar; the LLM only reads them. It
// sees personal URL names, counts and amounts, never an email. With nothing
// to report there is nothing to show.
const crypto = require('crypto');

const DAY = 86400000;
// "Closedhand <account id>": the name included-ai.js gives a person's key.
const PERSON_KEY = /^Closedhand ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const usd = n => '$' + Number(n || 0).toFixed(2);

function create({ db, env = process.env, includedAi, request = fetch }) {
  const fairUse = Number(env.INCLUDED_AI_FAIR_USE_USD || 15);
  const trialUsd = Number(env.INCLUDED_AI_TRIAL_USD || 12);
  const label = () => includedAi?.label || 'NEAR AI';
  const perConnection = Number(env.INCLUDED_AI_PER_CONNECTION || 10);
  const dailyPeople = Number(env.INCLUDED_AI_DAILY_PEOPLE || 25);
  const budget = Number(env.INCLUDED_AI_MONTHLY_BUDGET_USD || 0);

  const operators = [...new Set(String(env.OPERATOR_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];

  // Each sign is one plain sentence about one thing, most pressing first,
  // marked when it is about the maintainer's own account (OPERATOR_EMAILS).
  async function collect(now = new Date()) {
    const found = [];
    const mine = new Set((await db.query('SELECT id FROM owners WHERE email_verified AND lower(email) = ANY($1::text[])', [operators])).rows.map(r => r.id));
    const add = (text, ownerId = null) => found.push({ text, you: !!ownerId && mine.has(ownerId) });
    const keys = includedAi?.enabled() ? await includedAi.allKeys() : [];
    const byId = new Map(keys.map(k => [k.id, k]));
    const held = (await db.query(
      `SELECT k.owner_id, k.key_id, k.granted_usd::float AS granted, k.granted_at, k.stopped_at,
              k.base_usd::float AS base, k.base_for,
              a.hostname, a.activated_at, a.last_seen_at, p.status AS plus
         FROM included_ai_keys k
         LEFT JOIN addresses a ON a.owner_id = k.owner_id
         LEFT JOIN plus_subscriptions p ON p.owner_id = k.owner_id`)).rows;
    const retired = (await db.query('SELECT key_id, tries FROM retired_ai_keys')).rows;
    const name = r => (r.hostname ? r.hostname.replace(/\.closedhand\.ai$/, '') : 'account ' + r.owner_id.slice(0, 8));

    // Spend at the provider that no account holds: a key that should be gone.
    const known = new Set([...held.map(r => r.key_id), ...retired.map(r => r.key_id)]);
    const loose = keys.filter(k => PERSON_KEY.test(String(k.name || '')) && !known.has(k.id));
    if (loose.length) {
      const spent = loose.reduce((t, k) => t + Number(k.usage || 0), 0);
      add(`${loose.length} ${label()} ${loose.length === 1 ? 'key is' : 'keys are'} live that no account holds, with ${usd(spent)} used.`);
    }

    // On pace to spend more than the budget this month.
    if (budget > 0 && keys.length) {
      // Managed Models only: the maintainer's own use with keys closedhand.com
      // did not make is no part of the budget.
      const split = includedAi.spendSplit ? await includedAi.spendSplit([...mine], now) : null;
      const spent = split ? split.total - split.own : await includedAi.spentThisMonth(now);
      const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
      const gone = Math.max(0.5, (now - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) / DAY);
      const pace = spent / gone * days;
      if (spent >= 1 && pace > budget) add(`${label()} spend is ${usd(spent)} so far this month, on pace for ${usd(pace)} against the ${usd(budget)} budget.`);
    }

    // Fair use going fast: half or more gone, at three times the even pace. A
    // subscriber's paid month counts from the use its key had when it began.
    for (const r of held) {
      const k = byId.get(r.key_id);
      if (!k || r.stopped_at) continue;
      const paid = !!r.plus && !!r.base_for, base = paid ? Number(r.base) || 0 : 0;
      const used = (Number(k.usage) || 0) - base, limit = (Number(k.limit) || 0) - base;
      if (used < 2 || limit <= 0 || used / limit < 0.5) continue;
      const since = paid ? new Date(r.base_for).getTime() : new Date(r.granted_at).getTime();
      const days = Math.max(0.25, (now - since) / DAY);
      if (used / limit / (days / 30) < 3) continue;
      const which = paid ? "this month's subscription fair use" : 'its free days';
      add(`${name(r)} has used ${Math.round(used / limit * 100)}% of ${which} (${usd(used)}) in ${days < 1 ? 'under a day' : Math.round(days) + (Math.round(days) === 1 ? ' day' : ' days')}.`, r.owner_id);
    }

    // Free days handed out that are not being used where they belong.
    const offline = held.filter(r => r.granted > 0 && !r.stopped_at && !r.plus && !r.last_seen_at && now - new Date(r.granted_at) > 6 * 3600000);
    for (const r of offline) add(`${name(r)} got free days, but its personal URL has never come online.`, r.owner_id);

    // Connections that reached the most free days they may have.
    const full = Number((await db.query(
      `SELECT count(*)::int AS n FROM (SELECT network_hash FROM starter_grants
         WHERE network_hash IS NOT NULL AND granted_at > now() - interval '30 days'
         GROUP BY network_hash HAVING count(*) >= $1) AS c`, [perConnection])).rows[0].n);
    if (perConnection > 0 && full) add(`${full} internet ${full === 1 ? 'connection has' : 'connections have'} reached the most free days one connection may have (${perConnection} in 30 days).`);

    const lastDay = Number((await db.query("SELECT count(*)::int AS n FROM starter_grants WHERE granted_at > now() - interval '1 day'")).rows[0].n);
    if (dailyPeople > 0 && lastDay >= dailyPeople) add(`${lastDay} free 14 days started in the last 24 hours, more than the ${dailyPeople} expected.`);

    // Upkeep that keeps failing.
    const stuck = retired.filter(r => r.tries >= 3).length;
    if (stuck) add(`${stuck} replaced or deleted ${stuck === 1 ? 'key has' : 'keys have'} not been deleted at ${label()} after 3 tries.`);
    const unsynced = Number((await db.query(
      "SELECT count(*)::int AS n FROM plus_subscriptions WHERE NOT key_synced AND updated_at < now() - interval '2 hours'")).rows[0].n);
    if (unsynced) add(`${unsynced} subscription ${unsynced === 1 ? 'change has' : 'changes have'} not reached ${unsynced === 1 ? 'its key' : 'their keys'} for over 2 hours.`);
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
    const who = llm.label || label();
    // Without thinking: the answer is short. NEAR passes the switch to the
    // model's own chat template.
    const response = await request(llm.base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + llm.key, 'Content-Type': 'application/json', ...(llm.headers || {}) },
      body: JSON.stringify({
        model: llm.model,
        max_tokens: 1500,
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: 'system', content: `You help the one person who runs closedhand.com keep Closedhand Managed Models from being misused. Each new Closedhand account gets 14 free days: a ${who} key with ${usd(trialUsd)} of use, once per Google or Microsoft sign-in and at most ${perConnection} per internet connection in 30 days. A monthly Managed Models subscription, sold through Polar, gives ${usd(fairUse)} of fair use each month. You are given signs found in closedhand.com's own records. In at most four short plain sentences, say what is most likely going on and what, if anything, to do. Say plainly when something is probably harmless, like a household sharing one connection or one heavy but honest user. Only suggest these actions: set INCLUDED_AI_PER_CONNECTION=0 on Railway to stop new free days; delete a key in ${who}'s dashboard (each is named "Closedhand" and the account id); cancel or refund a subscription in Polar; raise ADDRESS_LIMIT or INCLUDED_AI_MONTHLY_BUDGET_USD on Railway, or add credit at ${who}. Use only what the signs say. Never use dashes as punctuation.` },
          { role: 'user', content: list.map(s => '- ' + s).join('\n') },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error(who + ' answered ' + response.status);
    const choice = (await response.json())?.choices?.[0];
    const text = String(choice?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s*[\u2013\u2014]\s*/g, ', ').trim();
    if (!text) throw new Error('the LLM wrote nothing (it stopped for ' + String(choice?.finish_reason || 'no reason given').slice(0, 30) + ')');
    written = { of, text };
    return text;
  }

  const signs = async now => (await collect(now)).map(s => s.text);

  // The insights page's section: the signs, which of them are about the
  // maintainer's own account, and the summary when it could be written (the
  // LLM is told which are theirs).
  async function report(now = new Date()) {
    const found = await collect(now);
    let text = null;
    if (found.length) text = await summary(found.map(s => s.you ? s.text + ' (This is your own account.)' : s.text)).catch(e => { console.error('[misuse] no summary:', e.message); return null; });
    return { signs: found.map(s => s.text), mine: found.map(s => s.you), summary: text };
  }

  return { signs, summary, report };
}

module.exports = { create };
