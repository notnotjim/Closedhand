// The AI that comes with Closedhand. When an account claims its personal URL,
// closedhand.com makes it a NEAR AI key of its own (with its sign-in at NEAR,
// lib/near-session.js) and hands it, once, to the computer that claimed. That
// computer then talks to NEAR directly, encrypted into the sealed hardware the
// model runs in, so no message ever passes through here; what stays here is
// NEAR's id for the key and when its first month ends.
//
// A key's spending limit is all NEAR holds it to: it has no monthly reset and
// no list of models, so each paid month raises the limit by its fair use. An
// account has one key: claiming again makes a new key with whatever was left
// and the same end date, and deletes the old one. A new key takes NEAR up to
// ten seconds to accept; the computer that gets one waits and checks again
// (webapp/included-ai-setup.js).
//
// The start is a first month, not an amount: the key has the fair-use ceiling
// (INCLUDED_AI_FAIR_USE_USD), never reset, and the hourly sweep stops it when
// the month (INCLUDED_AI_FIRST_MONTH_DAYS) is over, unless a subscription has
// taken over. It is given once per person, ever (starter_grants keeps a
// one-way fingerprint of the sign-in, also after the account is deleted), and
// to at most a few people per internet connection a month, so nobody can
// collect it by making account after account. How many start is never a
// reason to refuse anyone: lib/capacity.js tells the maintainer in time to
// raise the limits instead.
//
// Closedhand picks the provider and models (INCLUDED_AI_MODELS) and can change
// them without a release: each computer asks for the current pick every hour
// (current) and switches itself over.
// Once the person has had it, from a connection that has had it often,
// without a sign-in at NEAR, or with NEAR unreachable, the claim goes on
// without a key and setup asks for an LLM provider instead.
//
// The subscription (lib/plus.js) continues it: a subscriber's key gets a fair use
// for each paid month, from the day of the month they subscribed (as Polar
// renews it), doubled for a month they paid to carry on past it. A subscriber is never held to
// the first month's limits; one whose account has no key gets one the next
// time their computer asks (collect), and an ended subscription stops the key.
const crypto = require('crypto');

// NEAR counts money in nano-dollars.
const NANO = 1e9;
const nano = usd => Math.round(usd * NANO);
const dollars = price => (price && Number.isFinite(Number(price.amount)) ? Number(price.amount) / 10 ** Number(price.scale ?? 9) : null);

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

function create({ db, env = process.env, request = fetch, notices = null }) {
  const session = require('./near-session').create({ db, env, request, notices });
  const fairUse = Number(env.INCLUDED_AI_FAIR_USE_USD || 20);
  const firstMonthDays = Number(env.INCLUDED_AI_FIRST_MONTH_DAYS || 30);
  // Ten, so an office or a household sharing one connection all get theirs,
  // while one connection can't collect it again and again.
  const perConnection = Number(env.INCLUDED_AI_PER_CONNECTION || 10);
  const pepper = String(env.TOKEN_ENCRYPTION_KEY || '');
  const fingerprint = (kind, text) => crypto.createHmac('sha256', pepper).update('included-ai-' + kind + ':' + text).digest('hex');
  const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  // Text only: NEAR's encryption carries words, so pictures and videos are
  // described by the vision language model on the person's computer.
  const models = list(env.INCLUDED_AI_MODELS || 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated');
  // The chat model's name as the person reads it in Settings and setup.
  const modelName = String(env.INCLUDED_AI_MODEL_NAME || 'DeepSeek V4.1 Flash, uncensored').trim().slice(0, 80);
  const enabled = () => session.configured() && pepper.length >= 16 && fairUse > 0 && firstMonthDays > 0 && models.length > 0;

  async function api(path, method = 'GET', body, again = false) {
    const response = await request(session.base + path, {
      method,
      headers: { Authorization: 'Bearer ' + await session.token(), 'User-Agent': session.agent, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    // An access token NEAR stopped taking early is renewed, once.
    if (response.status === 401 && !again) { session.forget(); return api(path, method, body, true); }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!response.ok) throw Object.assign(new Error(`NEAR AI answered ${response.status} to ${method} ${path.split('?')[0]}`), { status: response.status });
    return json;
  }

  // The organisation whose credit every key draws on, and the workspace the
  // keys are made in: as set, else the only one there is.
  let ids = null;
  async function where() {
    if (ids) return ids;
    let org = String(env.NEAR_ORG_ID || '').trim(), workspace = String(env.NEAR_WORKSPACE_ID || '').trim();
    if (!org) {
      const orgs = (await api('/v1/organizations?limit=100'))?.organizations || [];
      if (orgs.length !== 1) throw new Error(orgs.length ? 'NEAR AI has several organisations for this sign-in: set NEAR_ORG_ID' : 'NEAR AI has no organisation for this sign-in');
      org = orgs[0].id;
    }
    if (!workspace) {
      const spaces = (await api('/v1/organizations/' + encodeURIComponent(org) + '/workspaces?limit=100'))?.workspaces || [];
      if (spaces.length !== 1) throw new Error(spaces.length ? 'NEAR AI has several workspaces here: set NEAR_WORKSPACE_ID' : 'NEAR AI has no workspace here');
      workspace = spaces[0].id;
    }
    return (ids = { org: encodeURIComponent(org), workspace: encodeURIComponent(workspace) });
  }

  // A key as NEAR lists it, in dollars.
  const shape = k => ({ id: k.id, name: String(k.name || ''), limit: dollars(k.spend_limit), usage: dollars(k.usage) || 0 });
  // Every live key in the workspace (not deleted or switched off). NEAR has no
  // way to read one key alone, only pages of them, so the list is kept five
  // minutes for the account page and each computer's hourly look; a key not
  // in it is looked for afresh.
  let listed = { at: 0, keys: null };
  async function keys({ fresh = false } = {}) {
    if (!fresh && listed.keys && Date.now() - listed.at < 5 * 60000) return listed.keys;
    const { workspace } = await where();
    const found = new Map();
    for (let offset = 0, page = 0; page < 1000; page++) {
      const got = await api(`/v1/workspaces/${workspace}/api-keys?limit=100&offset=${offset}&order_by=created_at&order_direction=asc`);
      const batch = got?.api_keys || [];
      for (const k of batch) if (!k.deleted_at && k.is_active !== false && typeof k.id === 'string') found.set(k.id, shape(k));
      offset += batch.length;
      if (!batch.length || offset >= Number(got?.total ?? 0)) break;
    }
    listed = { at: Date.now(), keys: found };
    return found;
  }
  const remember = k => { if (listed.keys && typeof k?.id === 'string') listed.keys.set(k.id, shape(k)); };

  // A key as NEAR has it now, or null when it is gone.
  async function keyNow(id, { fresh = false } = {}) {
    return (await keys({ fresh })).get(id) || (fresh ? null : (await keys({ fresh: true })).get(id) || null);
  }
  async function drop(id) {
    const { workspace } = await where();
    await api(`/v1/workspaces/${workspace}/api-keys/${encodeURIComponent(id)}`, 'DELETE').catch(e => { if (e.status !== 404) throw e; });
    listed.keys?.delete(id);
  }
  // Deletes a key at NEAR now; one that can't be deleted yet waits in
  // retired_ai_keys for the hourly sweep, so it never stays live unlisted.
  async function discard(id) {
    try {
      await drop(id);
      await db.query('DELETE FROM retired_ai_keys WHERE key_id = $1', [id]);
    } catch (error) {
      console.error('[included ai] a key waits to be deleted:', error.message);
      await db.query('INSERT INTO retired_ai_keys (key_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]).catch(() => {});
    }
  }
  const cents = n => Math.round(n * 100) / 100;
  // A limit NEAR holds to: never 0 or none, which would mean no limit; at
  // least a billionth of a dollar, the smallest it takes.
  const atLeastANano = n => Math.max(1 / NANO, n);
  async function setLimit(id, usd) {
    const { workspace } = await where();
    remember(await api(`/v1/workspaces/${workspace}/api-keys/${encodeURIComponent(id)}/spend-limit`, 'PATCH', { spendLimit: { amount: nano(atLeastANano(usd)), currency: 'USD' } }));
  }

  async function makeKey(ownerId, limit) {
    const { workspace } = await where();
    const made = await api(`/v1/workspaces/${workspace}/api-keys`, 'POST', { name: 'Closedhand ' + ownerId, spendLimit: { amount: nano(cents(limit)), currency: 'USD' } });
    if (typeof made?.key !== 'string' || !made.key.startsWith('sk-') || typeof made.id !== 'string') throw new Error('NEAR AI did not return a key');
    remember(made);
    return { key: made.key, id: made.id };
  }

  // The one-way fingerprint of the account's sign-in, which starter_grants keeps.
  async function personOf(ownerId) {
    const who = (await db.query('SELECT provider, subject FROM owners WHERE id = $1', [ownerId])).rows[0];
    return fingerprint('person', who && who.subject ? who.provider + ':' + who.subject : 'owner:' + ownerId);
  }

  // Whether this person has had their one free month of Managed Models: given
  // to this account, or to their sign-in on an account before.
  async function hadFreeMonth(ownerId) {
    if ((await db.query('SELECT 1 FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rowCount) return true;
    return (await db.query('SELECT 1 FROM starter_grants WHERE person_hash = $1', [await personOf(ownerId)])).rowCount > 0;
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
        const oldId = held.key_id;
        if (!sub && (held.stopped_at || !held.ends_at || new Date(held.ends_at) <= new Date())) return null;
        const old = await keyNow(oldId, { fresh: true });
        // What is left now goes to the new key. A subscriber keeps their key
        // for the months to come even with nothing left this month; their new
        // key's base is set so this month's fair use counts the same.
        const left = old ? Math.max(0, Number(old.limit) - Number(old.usage)) : (sub ? allowanceFor(sub) : 0);
        if (!sub && !(left > 0.01)) return null;
        const made = await makeKey(ownerId, atLeastANano(left));
        const base = sub ? cents(left - allowanceFor(sub)) : held.base_usd;
        // Only the claim that still finds the key it read replaces it: two
        // at once can't both hand out a key, and the other's is deleted.
        const swapped = await db.query(
          'UPDATE included_ai_keys SET key_id = $2, base_usd = $3, updated_at = now() WHERE owner_id = $1 AND key_id = $4 RETURNING owner_id',
          [ownerId, made.id, base, oldId]);
        if (!swapped.rowCount) { await discard(made.id); return null; }
        await discard(oldId);
        return { key: made.key, models: roles() };
      }
      if (sub) return await keyForSubscriber(ownerId, sub);
      const person = await personOf(ownerId);
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
        'INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, ends_at) VALUES ($1, $2, $3, now() + make_interval(days => $4)) ON CONFLICT (owner_id) DO NOTHING RETURNING owner_id',
        [ownerId, made.id, fairUse, firstMonthDays]);
      if (!saved.rowCount) { await discard(made.id); return null; }
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

  // The account's subscription while it gives access (Polar keeps
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
      'INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, base_usd, base_for) VALUES ($1, $2, 0, 0, $3) ON CONFLICT (owner_id) DO NOTHING RETURNING owner_id',
      [ownerId, made.id, new Date(monthOf(sub))]);
    if (!saved.rowCount) {
      await discard(made.id);
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
    const held = (await db.query('SELECT key_id, base_usd, base_for FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!sub || !held) return false;
    const key = await keyNow(held.key_id, { fresh: true });
    if (!key) {
      // Gone at NEAR: the row goes too, and their computer collects a new key.
      await db.query('DELETE FROM included_ai_keys WHERE owner_id = $1 AND key_id = $2', [ownerId, held.key_id]);
      return false;
    }
    let base = Number(held.base_usd) || 0;
    if (!held.base_for || new Date(held.base_for).getTime() !== monthOf(sub)) {
      if (sub.status === 'past_due' && held.base_for) return true;
      base = cents(Number(key.usage || 0));
      await db.query('UPDATE included_ai_keys SET base_usd = $2, base_for = $3 WHERE owner_id = $1', [ownerId, base, new Date(monthOf(sub))]);
    }
    await setLimit(held.key_id, base + allowanceFor(sub));
    await db.query('UPDATE included_ai_keys SET stopped_at = NULL, updated_at = now() WHERE owner_id = $1', [ownerId]);
    return true;
  }

  // An ended first month or subscription stops the key where it stands: its
  // limit becomes what it has used, never reset. False when there is no key.
  async function end(ownerId) {
    if (!enabled()) return false;
    const held = (await db.query('SELECT key_id FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!held) return false;
    const key = await keyNow(held.key_id, { fresh: true });
    if (key) await setLimit(held.key_id, Number(key.usage || 0));
    await db.query('UPDATE included_ai_keys SET stopped_at = now(), updated_at = now() WHERE owner_id = $1', [ownerId]);
    return true;
  }

  // Run hourly: the sign-in at NEAR is renewed, a first month that has run
  // out, with no subscription to take over, stops its key, and keys replaced
  // or left by a deleted account are deleted at NEAR. Subscription months
  // follow Polar's own renewals (lib/plus.js).
  async function sweep() {
    if (!enabled()) return 0;
    await settle();
    const ended = (await db.query(
      `SELECT k.owner_id FROM included_ai_keys k
        WHERE k.stopped_at IS NULL AND k.ends_at IS NOT NULL AND k.ends_at <= now()
          AND NOT EXISTS (SELECT 1 FROM plus_subscriptions s WHERE s.owner_id = k.owner_id AND s.status IN ('active', 'trialing', 'past_due'))
        ORDER BY k.ends_at LIMIT 200`)).rows;
    for (const { owner_id: ownerId } of ended) await end(ownerId).catch(e => console.error('[included ai] first month not stopped:', e.message));
    // Keys replaced or left by a deleted account, deleted at NEAR.
    const retired = (await db.query('SELECT key_id FROM retired_ai_keys ORDER BY tries, retired_at LIMIT 200')).rows;
    for (const { key_id: id } of retired) {
      try {
        await drop(id);
        await db.query('DELETE FROM retired_ai_keys WHERE key_id = $1', [id]);
      } catch (error) {
        console.error('[included ai] a retired key is not deleted yet:', error.message);
        await db.query('UPDATE retired_ai_keys SET tries = tries + 1 WHERE key_id = $1', [id]);
      }
    }
    return ended.length;
  }

  // The sign-in at NEAR, renewed as closedhand.com starts and each hour, so
  // one NEAR stopped taking is told to the maintainer before anyone needs a key.
  async function settle() {
    if (enabled()) await session.token().catch(e => console.error('[included ai] NEAR AI sign-in not renewed:', e.message));
  }

  // Every key in the workspace, with what each has used, for the maintainer
  // (lib/misuse.js), read afresh.
  async function allKeys() {
    return [...(await keys({ fresh: true })).values()];
  }
  // This calendar month's spend at NEAR, across every key.
  async function spentThisMonth(now = new Date()) {
    const { org } = await where();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const rows = (await api(`/v1/organizations/${org}/usage/by-model?period=custom&start=${encodeURIComponent(start)}`))?.data || [];
    return cents(rows.reduce((total, r) => total + Number(r.total_cost || 0), 0) / NANO);
  }
  // What is left of the organisation's credit at NEAR, which every key draws
  // on: when it runs out, every first month and every subscriber stops at
  // once. With the days it lasts at the pace of the last 30 days, counted from
  // the first day with any use so a young account's pace isn't spread thin.
  async function credit(now = new Date()) {
    const { org } = await where();
    const start = new Date(now.getTime() - 30 * 86400000).toISOString();
    const [balance, series] = await Promise.all([
      api(`/v1/organizations/${org}/usage/balance`),
      api(`/v1/organizations/${org}/usage/timeseries?granularity=day&start=${encodeURIComponent(start)}`).catch(() => null),
    ]);
    const limits = Array.isArray(balance?.credit_limits) ? balance.credit_limits : null;
    const nanoLeft = balance?.remaining != null ? Number(balance.remaining) : limits ? limits.reduce((t, l) => t + Number(l.available || 0), 0) : NaN;
    const left = nanoLeft / NANO;
    if (!Number.isFinite(left)) return null;
    const rows = (series?.data || []).filter(r => Number(r.cost_usd) > 0);
    const used = rows.reduce((total, r) => total + Number(r.cost_usd), 0);
    if (!(used > 0)) return { left: cents(left), days: null };
    const first = Math.min(...rows.map(r => Date.parse(String(r.date).slice(0, 10) + 'T00:00:00Z')));
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const span = Math.min(30, Math.max(1, Math.round((today - first) / 86400000)));
    return { left: cents(left), days: Math.max(0, Math.floor(left / (used / span))) };
  }

  // closedhand.com's own key, for the insights page's summary of possible
  // misuse (lib/misuse.js): made when first needed, a dollar at most. One
  // left by an earlier start is deleted.
  const OPERATOR_KEY = 'Closedhand insights';
  let operatorKey = null;
  async function forOperator() {
    if (!enabled()) return null;
    if (!operatorKey) operatorKey = (async () => {
      for (const k of await allKeys()) if (k.name === OPERATOR_KEY) await discard(k.id);
      return (await makeKey('insights', 1)).key;
    })().catch(error => { operatorKey = null; throw error; });
    return { key: await operatorKey, model: roles().chat, base: session.base + '/v1' };
  }

  // Which provider and models do which job: the person's computer uses these
  // as given.
  function roles() {
    return { provider: 'near', chat: models[0], background: models[1] || models[0], name: modelName };
  }

  // Deleting an account deletes its key. Its row goes with the account.
  async function forget(ownerId) {
    const held = (await db.query('SELECT key_id FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!held || !enabled()) return;
    await drop(held.key_id).catch(e => console.error('[included ai] could not delete a key:', e.message));
  }

  // How much of the account's fair use is used, as NEAR counts it (a
  // subscriber's this paid month), or null without a key. Never shown as an
  // amount: the account page only says when most of it is used, and the
  // computer is told it so Closedhand can say so in time.
  async function usage(ownerId) {
    if (!enabled()) return null;
    const held = (await db.query('SELECT key_id, base_usd FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!held) return null;
    const key = await keyNow(held.key_id);
    const base = Number(held.base_usd) || 0;
    const limit = Number(key?.limit) - base, used = Number(key?.usage) - base;
    return key && Number.isFinite(limit) && limit > 0 && Number.isFinite(used) ? { limit: cents(limit), used: cents(Math.max(0, used)) } : null;
  }

  // The provider and models in use now, for computers checking whether
  // Closedhand has switched them.
  function current() {
    return enabled() ? roles() : null;
  }

  return { forOwner, hadFreeMonth, forget, offered, current, enabled, collect, subscribe, end, sweep, settle, allKeys, spentThisMonth, credit, forOperator, usage, fairUse };
}

module.exports = { create };
