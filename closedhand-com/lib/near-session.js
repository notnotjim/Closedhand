// closedhand.com's sign-in at NEAR AI, with which Closedhand Managed Models'
// keys are made, limited and deleted (lib/included-ai.js). NEAR gives no key
// for that, only a person's sign-in: a refresh token (rt_...) that buys a
// short-lived access token, and is replaced by a new one each time it is
// used. The maintainer hands over the first (NEAR_REFRESH_TOKEN); after that
// the current one is kept here, sealed (crypto-tokens.js), and saved before
// the access token it bought is used, so a replaced one is never lost.
// Handing over a different one starts again from it. When NEAR refuses the
// one kept, or it is about to end, the maintainer is told once
// (operator-notices.js); keys already given keep working meanwhile.
const crypto = require('crypto');
const { encryptString, decryptString } = require('./crypto-tokens');

// NEAR says these routes are moving to another address it has yet to name.
const BASE = 'https://cloud-api.near.ai';
// A sign-in lasts a week from when NEAR last replaced it, and closedhand.com
// renews it every hour, so an end this near means renewing stopped moving it on.
const NEAR_END = 2 * 86400000;

function create({ db, env = process.env, request = fetch, notices = null }) {
  const base = String(env.NEAR_API_BASE || BASE).trim().replace(/\/+$/, '');
  const seed = String(env.NEAR_REFRESH_TOKEN || '').trim();
  const seedHash = seed && crypto.createHash('sha256').update(seed).digest('hex');
  // NEAR ties a sign-in to the browser that made it: each renewal must say it
  // comes from that browser (NEAR_USER_AGENT, its user agent as it signed in).
  const agent = String(env.NEAR_USER_AGENT || '').trim();
  const configured = () => seed.startsWith('rt_') && agent.length > 0;
  let access = null, pending = null;

  // When an access token stops working: its own expiry, else in five minutes.
  function until(jwt) {
    try {
      const exp = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')).exp;
      if (Number.isFinite(exp)) return exp * 1000;
    } catch (_) { /* not a JWT: the fallback */ }
    return Date.now() + 5 * 60000;
  }

  // The refresh token to use now: the one kept, unless none is kept yet or a
  // different one was handed over since (only a hash of that is kept).
  async function current() {
    const row = (await db.query('SELECT refresh_token, seed_hash FROM near_session WHERE id = 1')).rows[0];
    if (row && row.seed_hash === seedHash) return decryptString(row.refresh_token, 'the NEAR AI sign-in');
    await db.query(
      `INSERT INTO near_session (id, refresh_token, seed_hash) VALUES (1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET refresh_token = EXCLUDED.refresh_token, seed_hash = EXCLUDED.seed_hash,
           expires_at = NULL, failed_at = NULL, warned_for = NULL, updated_at = now()`,
      [encryptString(seed), seedHash]);
    return seed;
  }

  // Told once each time NEAR stops taking the sign-in, until one works again;
  // by closedhand.com itself, not a tool run beside it, which can't tell.
  async function refused() {
    if (!notices) return;
    const first = await db.query('UPDATE near_session SET failed_at = now() WHERE id = 1 AND failed_at IS NULL RETURNING id');
    if (first.rowCount) {
      await notices.queue('Closedhand: NEAR AI no longer accepts closedhand.com\'s sign-in, so new Managed Models keys and changes to fair use are on hold. Keys already given keep working. Sign in at cloud.near.ai again and set its new sign-in as NEAR_REFRESH_TOKEN on Railway.');
    }
  }
  // Told once, in its last two days, if renewing does not move the end on;
  // told again only after an end that moved on comes near.
  async function ending(at) {
    if (!notices || !Number.isFinite(at)) return;
    if (at - Date.now() > NEAR_END) {
      await db.query('UPDATE near_session SET warned_for = NULL WHERE id = 1 AND warned_for IS NOT NULL');
      return;
    }
    const first = await db.query('UPDATE near_session SET warned_for = $1 WHERE id = 1 AND warned_for IS NULL RETURNING id', [new Date(at)]);
    if (first.rowCount) {
      const day = new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
      await notices.queue(`Closedhand: closedhand.com's sign-in at NEAR AI ends on ${day}. Sign in at cloud.near.ai again and set its new sign-in as NEAR_REFRESH_TOKEN on Railway before then, or new Managed Models keys stop.`);
    }
  }

  async function renew(again = false) {
    const token = await current();
    let response;
    try {
      response = await request(base + '/v1/users/me/access-tokens', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'User-Agent': agent }, signal: AbortSignal.timeout(15000) });
    } catch (_) {
      throw new Error('NEAR AI could not be reached to renew its sign-in');
    }
    if (response.status === 401 || response.status === 403) {
      // Another process (a tool run beside the service) may have just
      // renewed it: the one it saved is tried once before giving up.
      if (!again && (await current()) !== token) return renew(true);
      await refused();
    }
    if (!response.ok) throw Object.assign(new Error(`NEAR AI answered ${response.status} to renewing its sign-in`), { status: response.status });
    const body = await response.json().catch(() => null);
    if (typeof body?.access_token !== 'string' || typeof body?.refresh_token !== 'string' || !body.refresh_token) throw new Error('NEAR AI did not renew its sign-in');
    const ends = Date.parse(body.refresh_token_expiration);
    await db.query('UPDATE near_session SET refresh_token = $1, expires_at = $2, failed_at = NULL, updated_at = now() WHERE id = 1',
      [encryptString(body.refresh_token), Number.isFinite(ends) ? new Date(ends) : null]);
    await ending(ends);
    access = { token: body.access_token, until: until(body.access_token) - 60000 };
    return access.token;
  }

  // An access token for NEAR's routes, renewed when it has run out; one
  // renewal at a time, which every caller waits for.
  async function token() {
    if (access && access.until > Date.now()) return access.token;
    if (!pending) pending = renew().finally(() => { pending = null; });
    return pending;
  }
  // One NEAR stopped taking before its time is not used again.
  function forget() { access = null; }

  return { base, agent, configured, token, forget };
}

module.exports = { create };
