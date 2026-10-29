// The AI that comes with Closedhand. When an account claims its personal URL,
// closedhand.com makes it an OpenRouter key of its own (OpenRouter's
// provisioning API) and hands it, once, to the computer that claimed. That
// computer then talks to OpenRouter directly, so no message ever passes
// through here; what stays here is the key's hash and when its first month
// ends.
//
// Every key is attached to one guardrail: it can use only the models
// Closedhand chose, and only on providers that keep nothing. An account has
// one key: claiming again makes a new key with whatever was left and the same
// end date, and deletes the old one.
//
// The start is a first month, not an amount: the key has the fair-use ceiling
// (INCLUDED_AI_FAIR_USE_USD), never reset, and the hourly sweep stops it when
// the month (INCLUDED_AI_FIRST_MONTH_DAYS) is over, unless Closedhand+ has
// taken over. It is given once per person, ever (starter_grants keeps a
// one-way fingerprint of the sign-in, also after the account is deleted), and
// to at most a few people per internet connection a month, so nobody can
// collect it by making account after account. How many start is never a
// reason to refuse anyone: lib/capacity.js tells the maintainer in time to
// raise the limits instead.
//
// Closedhand picks the models (INCLUDED_AI_MODELS) and can change them without
// a release: each computer asks for the current pick a few times a day
// (current) and switches itself over. Models being switched away from stay
// allowed for that while (INCLUDED_AI_RETIRING_MODELS), so no computer is cut
// off between the change and its next look.
// Once the person has had it, from a connection that has had it often,
// without a provisioning key, or with OpenRouter unreachable, the claim goes
// on without a key and setup asks for an LLM provider instead.
//
// Closedhand+ (lib/plus.js) continues it: a subscriber's key gets a fair use
// for each paid month, from the day of the month they subscribed (as Polar
// renews it), doubled for a month they paid to carry on past it. A subscriber is never held to
// the first month's limits; one whose account has no key gets one the next
// time their computer asks (collect), and an ended subscription stops the key.
const crypto = require('crypto');

const API = 'https://openrouter.ai/api/v1';
const GUARDRAIL = 'Closedhand included AI';

// The part of an address that is one connection: all of an IPv4 address, the
// first half of an IPv6 one (a home gets a whole /64).
function connection(ip) {
  const text = String(ip || '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  if (!text) return null;
  if (!text.includes(':')) return text;
  const [head, tail = ''] = text.split('::');
  const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  const full = text.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return full.slice(0, 4).map(part => parseInt(part || '0', 16).toString(16)).join(':');
}

function create({ db, env = process.env, request = fetch }) {
  const managementKey = String(env.OPENROUTER_PROVISIONING_KEY || '');
  const fairUse = Number(env.INCLUDED_AI_FAIR_USE_USD || 20);
  const firstMonthDays = Number(env.INCLUDED_AI_FIRST_MONTH_DAYS || 30);
  // Ten, so an office or a household sharing one connection all get theirs,
  // while one connection can't collect it again and again.
  const perConnection = Number(env.INCLUDED_AI_PER_CONNECTION || 10);
  const pepper = String(env.TOKEN_ENCRYPTION_KEY || '');
  const fingerprint = (kind, text) => crypto.createHmac('sha256', pepper).update('included-ai-' + kind + ':' + text).digest('hex');
  const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  const models = list(env.INCLUDED_AI_MODELS || 'deepseek/deepseek-v4.1-flash');
  // Pictures and videos go to a model of their own: one that watches a video
  // and hears its sound, served by hosts that keep nothing. Empty: the chat
  // model reads pictures, and videos are watched through frames.
  const visionModel = String(env.INCLUDED_AI_VISION_MODEL ?? 'xiaomi/mimo-v2.6-flash').trim();
  const allowed = [...new Set([...models, ...(visionModel ? [visionModel] : []), ...list(env.INCLUDED_AI_RETIRING_MODELS)])];
  const enabled = () => managementKey.startsWith('sk-or-') && pepper.length >= 16 && fairUse > 0 && firstMonthDays > 0 && models.length > 0;

  async function api(path, method = 'GET', body) {
    const response = await request(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + managementKey, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://closedhand.com', 'X-Title': 'Closedhand' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!response.ok) throw Object.assign(new Error(`OpenRouter answered ${response.status} to ${method} ${path.split('?')[0]}`), { status: response.status });
    return json;
  }

  // The one guardrail every key made here is attached to, made the first time
  // and brought up to date with the chosen models after each start.
  let guardrailId = null;
  async function guardrail() {
    if (guardrailId) return guardrailId;
    const rules = {
      allowed_models: allowed,
      enforce_zdr_anthropic: true, enforce_zdr_openai: true, enforce_zdr_google: true, enforce_zdr_xai: true, enforce_zdr_other: true,
      allow_safety_retention_google: false, allow_safety_retention_other: false,
      enable_free_model_training: false, enable_paid_model_training: false, enable_free_model_publication: false,
    };
    const listed = await api('/guardrails?limit=100');
    const found = (listed?.data || []).find(g => g.name === GUARDRAIL);
    if (found) {
      await api('/guardrails/' + found.id, 'PATCH', rules);
      guardrailId = found.id;
    } else {
      const made = await api('/guardrails', 'POST', { name: GUARDRAIL, description: 'Keys made for Closedhand accounts: the models Closedhand chose, on providers that keep nothing.', ...rules });
      guardrailId = made?.data?.id || made?.id || null;
    }
    if (!guardrailId) throw new Error('OpenRouter did not return the guardrail');
    return guardrailId;
  }

  // Keys already given can use the models chosen since: the guardrail is
  // brought up to date as closedhand.com starts, before any computer asks
  // which models to use, and again by the sweep if that failed.
  async function settle() {
    if (enabled()) await guardrail().catch(e => console.error('[included ai] guardrail not updated:', e.message));
  }

  // A key as OpenRouter has it now, or null when it is gone.
  async function keyNow(hash) {
    try { return (await api('/keys/' + hash))?.data || null; }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  // Deletes a key at OpenRouter now; one that can't be deleted yet waits in
  // retired_ai_keys for the hourly sweep, so it never stays live unlisted.
  async function discard(hash) {
    try {
      await api('/keys/' + hash, 'DELETE').catch(e => { if (e.status !== 404) throw e; });
      await db.query('DELETE FROM retired_ai_keys WHERE key_hash = $1', [hash]);
    } catch (error) {
      console.error('[included ai] a key waits to be deleted:', error.message);
      await db.query('INSERT INTO retired_ai_keys (key_hash) VALUES ($1) ON CONFLICT DO NOTHING', [hash]).catch(() => {});
    }
  }
  const cents = n => Math.round(n * 100) / 100;
  // A limit OpenRouter holds to: never 0, whose meaning it doesn't promise.
  const atLeastACent = n => Math.max(0.01, cents(n));

  async function makeKey(ownerId, limit, { monthly = false } = {}) {
    const made = await api('/keys', 'POST', { name: 'Closedhand ' + ownerId, limit: Math.round(limit * 100) / 100, ...(monthly ? { limit_reset: 'monthly' } : {}) });
    const key = made?.key, hash = made?.data?.hash;
    if (typeof key !== 'string' || !key.startsWith('sk-or-') || typeof hash !== 'string') throw new Error('OpenRouter did not return a key');
    try {
      await api('/guardrails/' + await guardrail() + '/assignments/keys', 'POST', { key_hashes: [hash] });
    } catch (error) {
      // A key without its guardrail could use any model: it never leaves here.
      await api('/keys/' + hash, 'DELETE').catch(() => {});
      throw error;
    }
    return { key, hash };
  }

  // The key for an account that has just claimed its personal URL, from the
  // address the claim came from, or null when none can be given now. Never
  // throws: the claim must go on.
  async function forOwner(ownerId, { ip } = {}) {
    if (!enabled()) return null;
    try {
      const held = (await db.query('SELECT * FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
      const sub = await subscription(ownerId);
      if (held) {
        // Claiming again (another computer, or setup run again) makes a new
        // key that carries on from the one held: what it used stays used.
        const oldHash = held.key_hash;
        if (!sub && (held.stopped_at || !held.ends_at || new Date(held.ends_at) <= new Date())) return null;
        const old = await keyNow(oldHash);
        // What is left now goes to the new key. A subscriber keeps their key
        // for the months to come even with nothing left this month; their new
        // key's base is set so this month's fair use counts the same.
        const left = old ? Math.max(0, Number(old.limit_remaining ?? (Number(old.limit) - Number(old.usage)))) : (sub ? allowanceFor(sub) : 0);
        if (!sub && !(left > 0.01)) return null;
        const made = await makeKey(ownerId, atLeastACent(left));
        const base = sub ? cents(left - allowanceFor(sub)) : held.base_usd;
        // Only the claim that still finds the key it read replaces it: two
        // at once can't both hand out a key, and the other's is deleted.
        const swapped = await db.query(
          'UPDATE included_ai_keys SET key_hash = $2, base_usd = $3, updated_at = now() WHERE owner_id = $1 AND key_hash = $4 RETURNING owner_id',
          [ownerId, made.hash, base, oldHash]);
        if (!swapped.rowCount) { await discard(made.hash); return null; }
        await discard(oldHash);
        return { key: made.key, models: roles() };
      }
      if (sub) return await keyForSubscriber(ownerId, sub);
      const who = (await db.query('SELECT provider, subject FROM owners WHERE id = $1', [ownerId])).rows[0];
      const person = fingerprint('person', who && who.subject ? who.provider + ':' + who.subject : 'owner:' + ownerId);
      const place = connection(ip) && fingerprint('connection', connection(ip));
      await db.query("UPDATE starter_grants SET network_hash = NULL WHERE network_hash IS NOT NULL AND granted_at < now() - interval '30 days'");
      const refused = (await db.query('SELECT 1 FROM starter_grants WHERE person_hash = $1', [person])).rowCount ? 'this sign-in has had it'
        : await full(place);
      if (refused) {
        console.log('[included ai] no first month given: ' + refused);
        return null;
      }
      // Held first, so two claims at once can't both have it.
      const given = await db.query(
        'INSERT INTO starter_grants (person_hash, network_hash, granted_usd) VALUES ($1, $2, $3) ON CONFLICT (person_hash) DO NOTHING RETURNING id',
        [person, place, fairUse]);
      if (!given.rowCount) return null;
      let made;
      try { made = await makeKey(ownerId, fairUse); }
      catch (error) { await db.query('DELETE FROM starter_grants WHERE id = $1', [given.rows[0].id]); throw error; }
      const saved = await db.query(
        'INSERT INTO included_ai_keys (owner_id, key_hash, granted_usd, ends_at) VALUES ($1, $2, $3, now() + make_interval(days => $4)) ON CONFLICT (owner_id) DO NOTHING RETURNING owner_id',
        [ownerId, made.hash, fairUse, firstMonthDays]);
      if (!saved.rowCount) { await discard(made.hash); return null; }
      return { key: made.key, models: roles() };
    } catch (error) {
      console.error('[included ai] no key made:', error.message);
      return null;
    }
  }

  // Why no first month can go to this connection now, or null when it can.
  async function full(place) {
    if (place && Number((await db.query(
      "SELECT count(*) AS n FROM starter_grants WHERE network_hash = $1 AND granted_at >= now() - interval '30 days'", [place])).rows[0].n) >= perConnection) {
      return 'this connection has had it ' + perConnection + ' times in 30 days';
    }
    return null;
  }

  // Whether a claim made now, from this address, would come with a key, so
  // setup can say the LLM is included before the personal URL is claimed.
  async function offered({ ip } = {}) {
    if (!enabled()) return false;
    try { return !(await full(connection(ip) && fingerprint('connection', connection(ip)))); } catch (_) { return false; }
  }

  // Closedhand+: the account's subscription while it gives access (Polar keeps
  // access through a failed payment it is still retrying), or null.
  async function subscription(ownerId) {
    return (await db.query(
      "SELECT status, current_period_start, extended_for FROM plus_subscriptions WHERE owner_id = $1 AND status IN ('active', 'trialing', 'past_due')", [ownerId])).rows[0] || null;
  }
  // The paid month a subscription is in, by the day it began.
  const monthOf = sub => (sub.current_period_start ? new Date(sub.current_period_start).getTime() : 0);
  // This paid month's fair use: twice it when the person paid to carry on in it.
  const allowanceFor = sub => fairUse * (sub.extended_for && new Date(sub.extended_for).getTime() === monthOf(sub) ? 2 : 1);

  // A subscriber's key, made now: no first-month limits apply. Saved first, so two
  // requests at once can't both hand one out; the loser's key is deleted.
  async function keyForSubscriber(ownerId, sub) {
    const made = await makeKey(ownerId, allowanceFor(sub));
    const saved = await db.query(
      'INSERT INTO included_ai_keys (owner_id, key_hash, granted_usd, base_usd, base_for) VALUES ($1, $2, 0, 0, $3) ON CONFLICT (owner_id) DO NOTHING RETURNING owner_id',
      [ownerId, made.hash, new Date(monthOf(sub))]);
    if (!saved.rowCount) {
      await discard(made.hash);
      return null;
    }
    return { key: made.key, models: roles() };
  }

  // A key for a subscriber whose account holds none (the first month was never
  // given, or the subscription came first), handed once to their computer
  // when it next asks. Null for anyone else. Never throws.
  async function collect(ownerId) {
    if (!enabled()) return null;
    try {
      const sub = await subscription(ownerId);
      if (!sub || (await db.query('SELECT 1 FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rowCount) return null;
      return await keyForSubscriber(ownerId, sub);
    } catch (error) {
      console.error('[included ai] no key collected:', error.message);
      return null;
    }
  }

  // The held key set to what the subscription gives this paid month: the
  // use it had when the month began, plus the month's fair use (twice it when
  // the person paid to carry on). A month that has just begun starts from the
  // use the key has now, so whatever came before (a first month, the last
  // paid month) never counts against it, and the whole fair use is there from
  // the moment they pay. A renewal Polar is still retrying a card for gives
  // no new month: the last one's limit stands until it is paid. False when
  // the account holds no key yet (its computer collects one).
  async function subscribe(ownerId) {
    if (!enabled()) return false;
    const sub = await subscription(ownerId);
    const held = (await db.query('SELECT key_hash, base_usd, base_for FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!sub || !held) return false;
    const key = await keyNow(held.key_hash);
    if (!key) {
      // Gone at OpenRouter: the row goes too, and their computer collects a new key.
      await db.query('DELETE FROM included_ai_keys WHERE owner_id = $1 AND key_hash = $2', [ownerId, held.key_hash]);
      return false;
    }
    let base = Number(held.base_usd) || 0;
    if (!held.base_for || new Date(held.base_for).getTime() !== monthOf(sub)) {
      if (sub.status === 'past_due' && held.base_for) return true;
      base = cents(Number(key.usage || 0));
      await db.query('UPDATE included_ai_keys SET base_usd = $2, base_for = $3 WHERE owner_id = $1', [ownerId, base, new Date(monthOf(sub))]);
    }
    await api('/keys/' + held.key_hash, 'PATCH', { limit: atLeastACent(base + allowanceFor(sub)), limit_reset: null });
    await db.query('UPDATE included_ai_keys SET stopped_at = NULL, updated_at = now() WHERE owner_id = $1', [ownerId]);
    return true;
  }

  // An ended first month or subscription stops the key where it stands: its
  // limit becomes what it has used, never reset. False when there is no key.
  async function end(ownerId) {
    if (!enabled()) return false;
    const held = (await db.query('SELECT key_hash FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!held) return false;
    const key = await keyNow(held.key_hash);
    if (key) await api('/keys/' + held.key_hash, 'PATCH', { limit: atLeastACent(Math.floor(Number(key.usage || 0) * 100) / 100), limit_reset: null });
    await db.query('UPDATE included_ai_keys SET stopped_at = now(), updated_at = now() WHERE owner_id = $1', [ownerId]);
    return true;
  }

  // Run hourly: a first month that has run out, with no Closedhand+ to take
  // over, stops its key, and keys replaced or left by a deleted account are
  // deleted at OpenRouter. Closedhand+ months follow Polar's own renewals
  // (lib/plus.js).
  async function sweep() {
    if (!enabled()) return 0;
    await settle();
    const ended = (await db.query(
      `SELECT k.owner_id FROM included_ai_keys k
        WHERE k.stopped_at IS NULL AND k.ends_at IS NOT NULL AND k.ends_at <= now()
          AND NOT EXISTS (SELECT 1 FROM plus_subscriptions s WHERE s.owner_id = k.owner_id AND s.status IN ('active', 'trialing', 'past_due'))
        ORDER BY k.ends_at LIMIT 200`)).rows;
    for (const { owner_id: ownerId } of ended) await end(ownerId).catch(e => console.error('[included ai] first month not stopped:', e.message));
    // Keys replaced or left by a deleted account, deleted at OpenRouter.
    const retired = (await db.query('SELECT key_hash FROM retired_ai_keys ORDER BY tries, retired_at LIMIT 200')).rows;
    for (const { key_hash: hash } of retired) {
      try {
        await api('/keys/' + hash, 'DELETE').catch(e => { if (e.status !== 404) throw e; });
        await db.query('DELETE FROM retired_ai_keys WHERE key_hash = $1', [hash]);
      } catch (error) {
        console.error('[included ai] a retired key is not deleted yet:', error.message);
        await db.query('UPDATE retired_ai_keys SET tries = tries + 1 WHERE key_hash = $1', [hash]);
      }
    }
    return ended.length;
  }

  // Every key of the OpenRouter account, with what each has used, for the
  // maintainer (lib/capacity.js, lib/misuse.js). OpenRouter lists keys a page
  // of up to 100 at a time.
  async function allKeys() {
    const all = [];
    for (let offset = 0, page = 0; page < 100; page++) {
      const keys = (await api('/keys?offset=' + offset))?.data || [];
      all.push(...keys);
      if (!keys.length) break;
      offset += keys.length;
    }
    return all;
  }
  // This month's OpenRouter spend across every key of the account.
  async function spentThisMonth() {
    return cents((await allKeys()).reduce((total, k) => total + Number(k.usage_monthly || 0), 0));
  }

  // closedhand.com's own key, for the insights page's summary of possible
  // misuse (lib/misuse.js): made when first needed, behind the same guardrail,
  // a dollar a month at most. One left by an earlier start is deleted.
  const OPERATOR_KEY = 'Closedhand insights';
  let operatorKey = null;
  async function forOperator() {
    if (!enabled()) return null;
    if (!operatorKey) operatorKey = (async () => {
      for (const k of await allKeys()) if (k.name === OPERATOR_KEY && k.hash) await discard(k.hash);
      return (await makeKey('insights', 1, { monthly: true })).key;
    })().catch(error => { operatorKey = null; throw error; });
    return { key: await operatorKey, model: roles().chat };
  }

  // Which model does which job: the person's computer uses these as given.
  function roles() {
    return { chat: models[0], background: models[1] || models[0], ...(visionModel ? { vision: visionModel } : {}) };
  }

  // Deleting an account deletes its key. Its row goes with the account.
  async function forget(ownerId) {
    const held = (await db.query('SELECT key_hash FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!held || !enabled()) return;
    await api('/keys/' + held.key_hash, 'DELETE').catch(e => console.error('[included ai] could not delete a key:', e.message));
  }

  // How much of the account's fair use is used, as OpenRouter counts it (a
  // subscriber's this paid month), or null without a key. Never
  // shown as an amount: the account page only says when most of it is used.
  async function usage(ownerId) {
    if (!enabled()) return null;
    const held = (await db.query('SELECT key_hash, base_usd FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!held) return null;
    const key = (await api('/keys/' + held.key_hash))?.data;
    const base = Number(held.base_usd) || 0;
    const limit = Number(key?.limit) - base, used = Number(key?.usage) - base;
    return Number.isFinite(limit) && limit > 0 && Number.isFinite(used) ? { limit, used } : null;
  }

  // The models in use now, for computers checking whether Closedhand has
  // switched them.
  function current() {
    return enabled() ? roles() : null;
  }

  return { forOwner, forget, offered, current, enabled, collect, subscribe, end, sweep, settle, allKeys, spentThisMonth, forOperator, usage, fairUse };
}

module.exports = { create };
