// The AI that comes with Closedhand. When an account claims its personal URL,
// closedhand.com makes it a key of its own at the LLM provider Closedhand
// Managed Models run on, and hands it, once, to the computer that claimed.
// That computer then talks to the provider directly, so no message ever
// passes through here; what stays here is the provider's id for the key and
// when its free 14 days end.
//
// The provider is one setting (INCLUDED_AI_PROVIDER): NEAR AI's private
// inference (lib/included-ai-near.js), or OpenRouter's per-account keys
// (lib/included-ai-openrouter.js), kept so Managed Models can move back.
// Both make, read, limit and delete keys the same way; everything else here
// is the same for either. Computers follow the provider closedhand.com names.
//
// A key's limit is a lifetime total, never reset by the provider. An account
// has one key: claiming again makes a new key with whatever was left and the
// same end date, and deletes the old one.
//
// The start is 14 free days (INCLUDED_AI_TRIAL_DAYS) with a ceiling of their
// own (INCLUDED_AI_TRIAL_USD); the hourly sweep stops the key when they are
// over, unless a subscription has taken over. They are given once per
// person, ever (starter_grants keeps a one-way fingerprint of the sign-in,
// also after the account is deleted), and to at most a few people per
// internet connection a month, so nobody can collect them by making account
// after account. How many start is never a reason to refuse anyone:
// lib/capacity.js tells the maintainer in time to raise the limits instead.
//
// Closedhand picks the models (INCLUDED_AI_MODELS) and can change them
// without a release: each computer asks for the current pick every hour
// (current) and switches itself over.
// Once the person has had the free days, from a connection that has had them
// often, without the provider's settings, or with the provider unreachable,
// the claim goes on without a key and setup asks for an LLM provider instead.
//
// The subscription (lib/plus.js) continues it: a subscriber's key gets a
// month's fair use (INCLUDED_AI_FAIR_USE_USD) for each month, from the day of
// the month they subscribed (as Polar renews it; a subscription paid every 6
// or 12 months has a month's fair use for each month of its period), and
// another for a month they paid to carry on past it. What the month before left unused
// carries into a paid month as it begins, up to one month's fair use, so
// nobody holds more than two months; the Terms say so, nothing else does. A
// subscriber is never held to the free days' limits; one whose account has
// no key gets one the next time their computer asks (collect), and an ended
// subscription stops the key.
//
// Paying ahead in crypto (lib/ahead.js) is the same in every way but how it
// is paid: each month of a plan has the same fair use, from the day the plan
// began, carrying on past it the same, and a plan that ends stops the key. A
// plan running stands in for a subscription wherever one is asked about.
//
// The maintainer's own account (lib/maintainer.js) has Managed Models with no
// charge and no Polar: the same monthly fair use as a subscriber, renewing on
// the first of each month with the same carry-over, never free days, and never
// stopped by the sweep or a subscription ending, whatever Polar says.
const crypto = require('crypto');
const { isMaintainer } = require('./maintainer');
const { monthIn, fairUseMonth } = require('./months');

const BACKENDS = { near: './included-ai-near', openrouter: './included-ai-openrouter' };
const cents = n => Math.round(n * 100) / 100;

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
  const choice = String(env.INCLUDED_AI_PROVIDER || 'near').trim().toLowerCase();
  const keys = BACKENDS[choice] ? require(BACKENDS[choice]).create({ db, env, request, notices }) : null;
  const fairUse = Number(env.INCLUDED_AI_FAIR_USE_USD || 20);
  const trialUsd = Number(env.INCLUDED_AI_TRIAL_USD || 12);
  const trialDays = Number(env.INCLUDED_AI_TRIAL_DAYS || 14);
  // Ten, so an office or a household sharing one connection all get theirs,
  // while one connection can't collect it again and again.
  const perConnection = Number(env.INCLUDED_AI_PER_CONNECTION || 10);
  const pepper = String(env.TOKEN_ENCRYPTION_KEY || '');
  const fingerprint = (kind, text) => crypto.createHmac('sha256', pepper).update('included-ai-' + kind + ':' + text).digest('hex');
  const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  const models = keys ? list(env.INCLUDED_AI_MODELS || keys.defaults.models) : [];
  // The chat model's name as the person reads it in Settings and setup.
  const modelName = keys ? String(env.INCLUDED_AI_MODEL_NAME || keys.defaults.name).trim().slice(0, 80) : '';
  // Pictures and videos go to a model of their own where the provider has
  // one; else the vision language model on the person's computer reads them.
  const visionModel = keys && keys.defaults.vision ? String(env.INCLUDED_AI_VISION_MODEL ?? keys.defaults.vision).trim() : '';
  const enabled = () => !!keys && keys.configured() && pepper.length >= 16 && fairUse > 0 && trialUsd > 0 && trialDays > 0 && models.length > 0;

  // Deletes a key at the provider now; one that can't be deleted yet waits in
  // retired_ai_keys for the hourly sweep, so it never stays live unlisted.
  async function discard(id) {
    try {
      await keys.drop(id);
      await db.query('DELETE FROM retired_ai_keys WHERE key_id = $1', [id]);
    } catch (error) {
      console.error('[included ai] a key waits to be deleted:', error.message);
      await db.query('INSERT INTO retired_ai_keys (key_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]).catch(() => {});
    }
  }
  const makeKey = (ownerId, usd) => keys.makeKey('Closedhand ' + ownerId, usd);
  const maintainer = ownerId => isMaintainer(db, env, ownerId);

  // The maintainer's months run from the first of each calendar month (UTC).
  const calendarMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // The maintainer's key, made now: a month of fair use. Claiming again makes
  // a new one that carries on from the key held, as a subscriber's does.
  async function keyForMaintainer(ownerId) {
    const held = (await db.query('SELECT * FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    const oldId = held && held.key_id;
    const old = held && held.maintainer ? await keys.keyNow(oldId, { fresh: true }) : null;
    const month = old && held.base_for ? Number(old.limit) - (Number(held.base_usd) || 0) : fairUse;
    const left = old ? Math.max(0, Number(old.limit) - Number(old.usage)) : fairUse;
    const made = await makeKey(ownerId, left);
    const base = cents(left - month), since = old && held.base_for ? new Date(held.base_for) : calendarMonth(), carry = old ? Number(held.carry_usd) || 0 : 0;
    const saved = held
      ? await db.query('UPDATE included_ai_keys SET key_id = $2, base_usd = $3, base_for = $5, carry_usd = $6, maintainer = true, stopped_at = NULL, updated_at = now() WHERE owner_id = $1 AND key_id = $4 RETURNING owner_id',
        [ownerId, made.id, base, oldId, since, carry])
      : await db.query('INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, base_usd, base_for, maintainer) VALUES ($1, $2, 0, 0, $3, true) ON CONFLICT (owner_id) DO NOTHING RETURNING owner_id',
        [ownerId, made.id, since]);
    if (!saved.rowCount) { await discard(made.id); return null; }
    if (oldId) await discard(oldId);
    return { key: made.key, models: roles() };
  }

  // The maintainer's key held to this month: as the month begins, the same
  // fair use from the use it has now, with the same carry-over. A key from
  // before closedhand.com knew whose it was starts its first month now.
  async function maintainerMonth(ownerId, held) {
    const key = await keys.keyNow(held.key_id, { fresh: true });
    if (!key) {
      await db.query('DELETE FROM included_ai_keys WHERE owner_id = $1 AND key_id = $2', [ownerId, held.key_id]);
      return;
    }
    const month = calendarMonth();
    if (held.maintainer && !held.stopped_at && held.base_for && new Date(held.base_for).getTime() === month.getTime()) return;
    const { base, carry } = await beginMonth(ownerId, held, key, month);
    await keys.setLimit(held.key_id, base + fairUse + carry);
    await db.query('UPDATE included_ai_keys SET maintainer = true, stopped_at = NULL, updated_at = now() WHERE owner_id = $1', [ownerId]);
  }

  // The one-way fingerprint of the account's sign-in, which starter_grants keeps.
  async function personOf(ownerId) {
    const who = (await db.query('SELECT provider, subject FROM owners WHERE id = $1', [ownerId])).rows[0];
    return fingerprint('person', who && who.subject ? who.provider + ':' + who.subject : 'owner:' + ownerId);
  }

  // Whether this person has had their free days of Managed Models: given to
  // this account, or to their sign-in on an account before.
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
      if (await maintainer(ownerId)) return await keyForMaintainer(ownerId);
      const held = (await db.query('SELECT * FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
      const sub = await subscription(ownerId);
      if (held) {
        // Claiming again (another computer, or setup run again) makes a new
        // key that carries on from the one held: what it used stays used.
        const oldId = held.key_id;
        if (!sub && (held.stopped_at || !held.ends_at || new Date(held.ends_at) <= new Date())) return null;
        const old = await keys.keyNow(oldId, { fresh: true });
        // What is left now goes to the new key. A subscriber keeps their key
        // for the months to come even with nothing left this month; their new
        // key's base is set so this month's fair use counts the same.
        const month = old && held.base_for ? Number(old.limit) - (Number(held.base_usd) || 0) : sub ? allowanceFor(sub) + (Number(held.carry_usd) || 0) : 0;
        const left = old ? Math.max(0, Number(old.limit) - Number(old.usage)) : (sub ? month : 0);
        if (!sub && !(left > 0.01)) return null;
        const made = await makeKey(ownerId, left);
        const base = sub ? cents(left - month) : held.base_usd;
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
      const refused = (await db.query('SELECT 1 FROM starter_grants WHERE person_hash = $1', [person])).rowCount ? 'this sign-in has had them'
        : await full(place);
      if (refused) {
        console.log('[included ai] no free days given: ' + refused);
        return null;
      }
      // Held first, so two claims at once can't both have it.
      const given = await db.query(
        'INSERT INTO starter_grants (person_hash, network_hash, granted_usd) VALUES ($1, $2, $3) ON CONFLICT (person_hash) DO NOTHING RETURNING id',
        [person, place, trialUsd]);
      if (!given.rowCount) return null;
      let made;
      try { made = await makeKey(ownerId, trialUsd); }
      catch (error) { await db.query('DELETE FROM starter_grants WHERE id = $1', [given.rows[0].id]); throw error; }
      const saved = await db.query(
        'INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, ends_at) VALUES ($1, $2, $3, now() + make_interval(days => $4)) ON CONFLICT (owner_id) DO NOTHING RETURNING owner_id',
        [ownerId, made.id, trialUsd, trialDays]);
      if (!saved.rowCount) { await discard(made.id); return null; }
      return { key: made.key, models: roles() };
    } catch (error) {
      console.error('[included ai] no key made:', error.message);
      return null;
    }
  }

  // Why no free days can go to this connection now, or null when they can.
  async function full(place) {
    if (place && Number((await db.query(
      "SELECT count(*) AS n FROM starter_grants WHERE network_hash = $1 AND granted_at >= now() - interval '30 days'", [place])).rows[0].n) >= perConnection) {
      return 'this connection has had them ' + perConnection + ' times in 30 days';
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
  // access through a failed payment it is still retrying), else its plan paid
  // ahead while it runs, in the same shape. current_period_start is the day
  // this month of fair use began: a monthly subscription's paid month, the
  // month of a longer one's period, or of a plan by the day it began. Null
  // when neither.
  async function subscription(ownerId) {
    const sub = (await db.query(
      "SELECT status, current_period_start, current_period_end, every_months, extended_for FROM plus_subscriptions WHERE owner_id = $1 AND status IN ('active', 'trialing', 'past_due')", [ownerId])).rows[0];
    if (sub) return { status: sub.status, current_period_start: fairUseMonth(sub)?.from || null, extended_for: sub.extended_for };
    const plan = (await db.query('SELECT starts_at, extended_for FROM ahead_plans WHERE owner_id = $1 AND starts_at <= now() AND ends_at > now() AND ended_at IS NULL', [ownerId])).rows[0];
    return plan ? { status: 'active', current_period_start: monthIn(plan.starts_at).from, extended_for: plan.extended_for, ahead: true } : null;
  }
  // The month of fair use a subscription is in, by the day it began.
  const monthOf = sub => (sub.current_period_start ? new Date(sub.current_period_start).getTime() : 0);
  // This month's fair use: another month's when the person paid to carry on in it.
  const allowanceFor = sub => fairUse * (sub.extended_for && new Date(sub.extended_for).getTime() === monthOf(sub) ? 2 : 1);

  // A subscriber's key, made now: no free-days limits apply. Saved first, so two
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

  // A key for a subscriber whose account holds none (the free days were never
  // given, or the subscription came first), handed once to their computer
  // when it next asks. Null for anyone else. Never throws.
  async function collect(ownerId) {
    if (!enabled()) return null;
    try {
      const held = (await db.query('SELECT * FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
      if (await maintainer(ownerId)) {
        // The maintainer's account: a key of its own, or the one it holds
        // kept to this month, which its computer already has.
        if (!held) return await keyForMaintainer(ownerId);
        await maintainerMonth(ownerId, held);
        return null;
      }
      const sub = await subscription(ownerId);
      // No longer the maintainer's: the usual rules again, from what it used.
      if (held && held.maintainer) {
        await db.query('UPDATE included_ai_keys SET maintainer = false WHERE owner_id = $1', [ownerId]);
        if (sub) await subscribe(ownerId); else await end(ownerId);
        return null;
      }
      if (!sub || held) return null;
      return await keyForSubscriber(ownerId, sub);
    } catch (error) {
      console.error('[included ai] no key collected:', error.message);
      return null;
    }
  }

  // A month that has just begun (a subscriber's or the maintainer's): from the
  // use the key has now, with what the period before left unused carried in,
  // up to one month's fair use. A key stopped at the end of a period kept what
  // it left (end).
  async function beginMonth(ownerId, held, key, month) {
    const used = Number(key.usage || 0);
    const unused = held.stopped_at ? Number(held.left_usd) || 0 : Math.max(0, Number(key.limit) - used);
    const base = cents(used), carry = cents(Math.min(fairUse, unused));
    await db.query('UPDATE included_ai_keys SET base_usd = $2, base_for = $3, carry_usd = $4, left_usd = NULL WHERE owner_id = $1', [ownerId, base, month, carry]);
    return { base, carry };
  }

  // The held key set to what the subscription gives this paid month: the
  // use it had when the month began, plus the month's fair use (another
  // month's when the person paid to carry on), plus what the period before
  // left unused, up to one month's fair use. A month that has just begun
  // starts from the use the key has now, so whatever came before never counts
  // against it, and the whole fair use is there from the moment they pay. A
  // renewal Polar is still retrying a card for gives no new month: the last
  // one's limit stands until it is paid. False when the account holds no key
  // yet (its computer collects one).
  async function subscribe(ownerId) {
    if (!enabled()) return false;
    // The maintainer's months are their own, whatever Polar says.
    if (await maintainer(ownerId)) return true;
    const sub = await subscription(ownerId);
    const held = (await db.query('SELECT * FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!sub || !held) return false;
    const key = await keys.keyNow(held.key_id, { fresh: true });
    if (!key) {
      // Gone at the provider: the row goes too, and their computer collects a new key.
      await db.query('DELETE FROM included_ai_keys WHERE owner_id = $1 AND key_id = $2', [ownerId, held.key_id]);
      return false;
    }
    let base = Number(held.base_usd) || 0, carry = Number(held.carry_usd) || 0;
    if (!held.base_for || new Date(held.base_for).getTime() !== monthOf(sub)) {
      if (sub.status === 'past_due' && held.base_for) return true;
      ({ base, carry } = await beginMonth(ownerId, held, key, new Date(monthOf(sub))));
    }
    await keys.setLimit(held.key_id, base + allowanceFor(sub) + carry);
    await db.query('UPDATE included_ai_keys SET stopped_at = NULL, updated_at = now() WHERE owner_id = $1', [ownerId]);
    return true;
  }

  // Ended free days or an ended subscription stop the key where it stands:
  // its limit becomes what it has used, never reset, and what it left unused
  // is kept for a subscription that comes later. False when there is no key.
  async function end(ownerId) {
    if (!enabled()) return false;
    if (await maintainer(ownerId)) return true;
    // A plan paid ahead runs on whatever else ends.
    if ((await subscription(ownerId))?.ahead) return subscribe(ownerId);
    const held = (await db.query('SELECT key_id, stopped_at FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!held) return false;
    const key = await keys.keyNow(held.key_id, { fresh: true });
    const left = key && !held.stopped_at ? cents(Math.max(0, Number(key.limit) - Number(key.usage || 0))) : null;
    if (key) await keys.setLimit(held.key_id, Number(key.usage || 0));
    await db.query('UPDATE included_ai_keys SET stopped_at = now(), left_usd = COALESCE($2, left_usd), updated_at = now() WHERE owner_id = $1', [ownerId, left]);
    return true;
  }

  // Run hourly: the provider is settled (NEAR's sign-in renewed, OpenRouter's
  // guardrail brought up to date), free days that have run out, with no
  // subscription to take over, stop their key, and keys replaced or left by a
  // deleted account are deleted at the provider. Subscription months follow
  // Polar's own renewals (lib/plus.js).
  async function sweep() {
    if (!enabled()) return 0;
    await settle();
    const ended = (await db.query(
      `SELECT k.owner_id FROM included_ai_keys k
        WHERE k.stopped_at IS NULL AND k.ends_at IS NOT NULL AND k.ends_at <= now()
          AND NOT EXISTS (SELECT 1 FROM plus_subscriptions s WHERE s.owner_id = k.owner_id AND s.status IN ('active', 'trialing', 'past_due'))
          AND NOT EXISTS (SELECT 1 FROM ahead_plans p WHERE p.owner_id = k.owner_id AND p.ended_at IS NULL AND p.ends_at > now())
        ORDER BY k.ends_at LIMIT 200`)).rows;
    for (const { owner_id: ownerId } of ended) await end(ownerId).catch(e => console.error('[included ai] free days not stopped:', e.message));
    // Keys replaced or left by a deleted account, deleted at the provider.
    const retired = (await db.query('SELECT key_id FROM retired_ai_keys ORDER BY tries, retired_at LIMIT 200')).rows;
    for (const { key_id: id } of retired) {
      try {
        await keys.drop(id);
        await db.query('DELETE FROM retired_ai_keys WHERE key_id = $1', [id]);
      } catch (error) {
        console.error('[included ai] a retired key is not deleted yet:', error.message);
        await db.query('UPDATE retired_ai_keys SET tries = tries + 1 WHERE key_id = $1', [id]);
      }
    }
    return ended.length;
  }

  // As closedhand.com starts and each hour, so a provider that stopped
  // working is told to the maintainer before anyone needs a key.
  async function settle() {
    if (enabled()) await keys.settle().catch(e => console.error(`[included ai] ${keys.label} not settled:`, e.message));
  }

  // Every key at the provider, with what each has used, for the maintainer
  // (lib/misuse.js), read afresh.
  const allKeys = () => keys.allKeys();
  // This calendar month's spend at the provider, across every key.
  const spentThisMonth = now => keys.spentThisMonth(now);
  // What is left of the credit every key draws on: when it runs out, every
  // free period and every subscriber stops at once.
  const credit = now => keys.credit(now);

  // This month's spend at the provider, apart, for the insights page: the
  // maintainer's own use with keys closedhand.com did not make (not Managed
  // Models at all), the maintainer's own Managed Models (their accounts' keys
  // and closedhand.com's own), and everyone else's.
  const MADE = /^Closedhand (?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|insights)$/;
  async function spendSplit(ownerIds = [], now = new Date()) {
    const [total, all, held] = await Promise.all([spentThisMonth(now), allKeys(),
      ownerIds.length ? db.query('SELECT key_id FROM included_ai_keys WHERE owner_id = ANY($1::uuid[])', [ownerIds]) : { rows: [] }]);
    const ownIds = all.filter(k => !MADE.test(k.name)).map(k => k.id);
    const youIds = [...held.rows.map(r => r.key_id), ...all.filter(k => k.name === OPERATOR_KEY).map(k => k.id)];
    const [own, you] = await Promise.all([keys.spentByKeys(ownIds, now), keys.spentByKeys(youIds, now)]);
    return { total, own, you, others: cents(Math.max(0, total - own - you)) };
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
      return (await keys.makeKey(OPERATOR_KEY, 1, { monthly: true })).key;
    })().catch(error => { operatorKey = null; throw error; });
    return { key: await operatorKey, model: roles().chat, base: keys.chat.base, headers: keys.chat.headers, label: keys.label };
  }

  // Which provider and models do which job: the person's computer uses these
  // as given.
  function roles() {
    return { provider: keys.provider, chat: models[0], background: models[1] || models[0], ...(visionModel ? { vision: visionModel } : {}), name: modelName };
  }

  // Deleting an account deletes its key. Its row goes with the account.
  async function forget(ownerId) {
    const held = (await db.query('SELECT key_id FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!held || !enabled()) return;
    await keys.drop(held.key_id).catch(e => console.error('[included ai] could not delete a key:', e.message));
  }

  // How much of the account's fair use is used, as the provider counts it (a
  // subscriber's this paid month), or null without a key. Never shown as an
  // amount: the account page only says when most of it is used, and the
  // computer is told it so Closedhand can say so in time.
  async function usage(ownerId) {
    if (!enabled()) return null;
    const held = (await db.query('SELECT key_id, base_usd FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
    if (!held) return null;
    const key = await keys.keyNow(held.key_id);
    const base = Number(held.base_usd) || 0;
    const limit = Number(key?.limit) - base, used = Number(key?.usage) - base;
    return key && Number.isFinite(limit) && limit > 0 && Number.isFinite(used) ? { limit: cents(limit), used: cents(Math.max(0, used)) } : null;
  }

  // The provider and models in use now, for computers checking whether
  // Closedhand has switched them.
  function current() {
    return enabled() ? roles() : null;
  }

  return { forOwner, hadFreeMonth, forget, offered, current, enabled, collect, subscribe, end, sweep, settle, allKeys, spentThisMonth, spendSplit, credit, forOperator, usage, fairUse, trialUsd, trialDays, label: keys ? keys.label : null, topUp: keys ? keys.topUp : null };
}

module.exports = { create };
