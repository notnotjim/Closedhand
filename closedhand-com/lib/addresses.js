// Personal URLs (name.closedhand.ai). A copy of Closedhand asks for an
// address, its owner confirms it here after signing in and is shown a code,
// and the code typed into that copy finishes the request. The name is picked
// here (names.js) unless an older copy asks for one it chose; the owner can
// rename it later. Nothing is built for an address: the copy takes it at the
// relay (relay/relay.js) with a pass from here for its own key, and proves it
// answers at the new address before the address is marked ready. Only
// routing records live here.
//
// A copy that has just connected mail through Closedhand's own Google or
// Microsoft app can claim in one step instead (claim-google, claim-microsoft):
// it passes on that sign-in, which is checked against the provider's keys.
// Or it is used anonymously (claim-anonymous): paid for first in crypto, the
// account is made with an account number (account-number.js), shown once.
//
// The sign-in that claims a personal URL is the owner's Closedhand account.
// Only its email is kept, with the address, and deleting it
// forgets the sign-in and the address (deleteAccount).
//
// A claim also hands the claiming computer the AI that comes with Closedhand,
// a key of its own at the Managed Models provider (included-ai.js), when one can be given.
const crypto = require('node:crypto');
const { encryptString, decryptString } = require('./crypto-tokens');
const { equal } = require('./session');
const { randomName, cleanName } = require('./names');
const { verifyPassedSignIn } = require('./passed-sign-in');
const { PROVIDERS } = require('./signin');
const { ownerFor, addSignIn, signInsOf, anonymousOwner, isAnonymous } = require('./owners');
const accountNumber = require('./account-number');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Names a person could mistake for a Closedhand or mail service address.
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'account', 'accounts', 'auth', 'login', 'mail', 'smtp', 'support', 'status', 'cloud', 'dashboard', 'closedhand',
  'autodiscover', 'autoconfig', 'mta-sts', 'webmail', 'imap', 'pop', 'mx', 'ns1', 'ns2', 'sso', 'id', 'help', 'security', 'docs', 'relay', 'assist',
  'billing', 'pay', 'secure', 'static', 'cdn', 'blog', 'open', 'keep', 'setup']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
// Codes leave out characters that are easy to misread (0 and O, 1, I and L).
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join('');
const MAX_CODE_TRIES = 5;
// The most personal URLs one report from the relay may name (server.js lets
// its body be large enough for them).
const MAX_REPORTED = 20000;

function validHostname(hostname) {
  if (typeof hostname !== 'string' || !hostname.endsWith('.closedhand.ai')) return false;
  const name = hostname.slice(0, -'.closedhand.ai'.length);
  // "xx--" is how lookalike international names are written, so it is out.
  return /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(name) && !/^..--/.test(name) && !RESERVED.has(name);
}

// The computer's own public key, as the relay reads it: the 32 bytes of an
// Ed25519 key in base64url, written the one way they can be.
function computerKey(key) {
  return typeof key === 'string' && key.length === 43 && Buffer.from(key, 'base64url').toString('base64url') === key;
}
// A pass for the relay (readPass in relay/relay.js): the personal URL, the
// computer's own key and when the pass ends, signed with closedhand.com's
// key. It is no use without the computer's private key, which the relay has
// sign a nonce, and it lasts a day, so the computer asks for a new one daily.
const PASS_MS = 24 * 3600000;
function passFor(hostname, key, passKey, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ h: hostname, k: key, e: now + PASS_MS })).toString('base64url');
  return body + '.' + crypto.sign(null, Buffer.from(body), passKey).toString('base64url');
}

// The copy's answer to the connection check is a few dozen bytes; stop
// reading long before a large one could matter.
async function smallJson(response, max = 2048) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return null; }
}

// A copy of Closedhand signs its requests with "Bearer <install id>.<secret>".
// It is known by its secret alone: the ID it states proves nothing, so
// knowing a copy's ID never lets anyone take its place.
function installation(req) {
  const match = /^Bearer ([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  return match ? { secret: match[2], secret_hash: hash(match[2]) } : null;
}

// A ticket carries a naming request from the copy to its owner's browser.
// It names the copy (by the hash of its secret, never the secret) and the
// address asked for, and is good for thirty minutes.
function ticketFor(request, secret, now = Date.now()) {
  const text = Buffer.from(JSON.stringify({ ...request, version: 4, expires: now + 30 * 60000 })).toString('base64url');
  return text + '.' + crypto.createHmac('sha256', secret).update('phone-pair:' + text).digest('hex');
}
function readTicket(ticket, secret) {
  if (typeof ticket !== 'string' || ticket.length > 1000) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) return null;
  if (!equal(parts[1], crypto.createHmac('sha256', secret).update('phone-pair:' + parts[0]).digest('hex'))) return null;
  try {
    const t = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return t.version === 4 && /^[a-f0-9]{64}$/.test(t.secret_hash) && validHostname(t.hostname) && typeof t.expires === 'number' &&
      (t.auto === undefined || t.auto === true) ? t : null;
  } catch (_) { return null; }
}

class Refusal extends Error {}

// A name is taken when an address has it, or when it is somebody else's
// old name or held name that has not been released yet. A held name with
// no owner (its account was deleted) is nobody's, so it is taken for all.
async function nameTaken(db, hostname, ownerId = null) {
  const found = await db.query(
    `SELECT 1 FROM addresses WHERE hostname = $1
     UNION ALL SELECT 1 FROM retired_names WHERE hostname = $1 AND owner_id IS DISTINCT FROM $2::uuid
     UNION ALL SELECT 1 FROM held_names WHERE hostname = $1 AND owner_id IS DISTINCT FROM $2::uuid LIMIT 1`,
    [hostname, ownerId]);
  return found.rowCount > 0;
}
// The name held for an owner whose address was released for lack of use,
// which they get back when they set Closedhand up again.
async function heldName(db, ownerId) {
  const found = await db.query(
    `SELECT h.hostname FROM held_names h WHERE h.owner_id = $1
       AND NOT EXISTS (SELECT 1 FROM addresses a WHERE a.hostname = h.hostname)
     ORDER BY h.created_at DESC LIMIT 1`, [ownerId]);
  return found.rows[0]?.hostname || null;
}
// A free name for a new address. Nearly always the first try: there are
// over a hundred thousand.
async function freeName(db) {
  for (let i = 0; i < 20; i++) {
    const hostname = randomName() + '.closedhand.ai';
    if (validHostname(hostname) && !(await nameTaken(db, hostname))) return hostname;
  }
  throw new Error('No free name found');
}

// Give an owner's personal URL to the copy that typed in their code. Under
// one lock, so two owners can never take the same name, one owner never gets
// two addresses, and the address limit is exact. An owner's existing address
// moves to the new copy: the old one is no longer given passes for it, and
// the new one proves it answers there, as for a new address. The old one is
// remembered (replaced_copies), so it is told and stops running Closedhand:
// one Closedhand runs for an account.
async function reserve(pool, { ownerId, secretHash, hostname, limit }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(490048)');
    const mine = (await client.query('SELECT * FROM addresses WHERE owner_id = $1 FOR UPDATE', [ownerId])).rows[0];
    const copy = (await client.query('SELECT id FROM addresses WHERE secret_hash = $1', [secretHash])).rows[0];
    if (copy && copy.id !== mine?.id) throw new Refusal('This computer already has a personal URL on another account.');
    let row;
    if (mine) {
      if (mine.hostname !== hostname) throw new Refusal('This account already has a personal URL, ' + mine.hostname + '.');
      if (mine.secret_hash === secretHash) row = mine;
      else {
        row = (await client.query(
          "UPDATE addresses SET secret_hash = $2, state = 'pending', updated_at = now() WHERE id = $1 RETURNING *", [mine.id, secretHash])).rows[0];
        await client.query('INSERT INTO replaced_copies (secret_hash, owner_id) VALUES ($1, $2) ON CONFLICT (secret_hash) DO UPDATE SET owner_id = EXCLUDED.owner_id, replaced_at = now()', [mine.secret_hash, ownerId]);
      }
      await client.query('DELETE FROM replaced_copies WHERE secret_hash = $1', [secretHash]);
    } else {
      if (await nameTaken(client, hostname, ownerId)) throw new Refusal('That personal URL is already taken. Choose another name.');
      // Working addresses and fresh reservations count.
      const live = await client.query("SELECT count(*)::int AS n FROM addresses WHERE activated_at IS NOT NULL OR created_at > now() - interval '24 hours'");
      if (live.rows[0].n >= limit) throw new Refusal('Personal URLs are full for now. Try again later.');
      row = (await client.query(
        'INSERT INTO addresses (id, owner_id, secret_hash, hostname) VALUES ($1, $2, $3, $4) RETURNING *',
        [crypto.randomUUID(), ownerId, secretHash, hostname])).rows[0];
      await client.query('DELETE FROM held_names WHERE hostname = $1 AND owner_id = $2', [hostname, ownerId]);
    }
    await client.query('COMMIT');
    return row;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Renaming. The old name is kept for this address, reserved to the owner,
// who can take it back, so an old bookmark never opens somebody else's
// computer; six months after the rename it is released for anyone to take.
// Each old name is held that long, so three in thirty days is the most.
// Coming back to one of your own old names holds nothing new, so it doesn't
// count.
const RENAMES_PER_MONTH = 3;
async function rename(pool, { secretHash, hostname }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(490048)');
    const row = (await client.query('SELECT * FROM addresses WHERE secret_hash = $1 FOR UPDATE', [secretHash])).rows[0];
    if (!row) throw new Refusal('This computer does not have a personal URL yet.');
    if (!row.activated_at) throw new Refusal('Your personal URL is still being set up. Try again once it opens.');
    if (row.hostname === hostname) { await client.query('COMMIT'); return row; }
    if (await nameTaken(client, hostname, row.owner_id)) throw new Refusal('That name is taken. Try another.');
    const recent = (await client.query(
      "SELECT count(*)::int AS n FROM retired_names WHERE address_id = $1 AND created_at > now() - interval '30 days'", [row.id])).rows[0].n;
    if (recent >= RENAMES_PER_MONTH) throw new Refusal('You can change your personal URL three times in thirty days. Try again later.');
    await client.query('DELETE FROM retired_names WHERE hostname = $1 AND owner_id = $2', [hostname, row.owner_id]);
    await client.query('DELETE FROM held_names WHERE hostname = $1 AND owner_id = $2', [hostname, row.owner_id]);
    await client.query(
      "INSERT INTO retired_names (hostname, owner_id, address_id, release_at) VALUES ($1, $2, $3, now() + interval '6 months')",
      [row.hostname, row.owner_id, row.id]);
    // This copy takes the new name at the relay with a pass for it, and
    // proves it answers there, as for a new address.
    const updated = (await client.query(
      "UPDATE addresses SET hostname = $2, state = 'pending', updated_at = now() WHERE id = $1 RETURNING *", [row.id, hostname])).rows[0];
    await client.query('COMMIT');
    return updated;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Letting an owner's address go, when their account is deleted or the
// address has gone unused. Its name, and any old names, are held for six
// months: for the owner (holdFor) or, after a deletion, for nobody. The
// address goes at once, so its computer is free to start again straight away.
async function letGo(client, ownerId, holdFor) {
  const hold = (sql, values) => client.query(
    `INSERT INTO held_names (hostname, owner_id, release_at) ${sql}
     ON CONFLICT (hostname) DO UPDATE SET owner_id = EXCLUDED.owner_id, release_at = GREATEST(held_names.release_at, EXCLUDED.release_at)`, values);
  const row = (await client.query('DELETE FROM addresses WHERE owner_id = $1 RETURNING *', [ownerId])).rows[0];
  // A name that never opened anything has no bookmarks to protect.
  if (row?.activated_at) await hold("VALUES ($1, $2::uuid, now() + interval '6 months')", [row.hostname, holdFor]);
  // Old names keep their own release dates.
  await hold('SELECT hostname, $2::uuid, release_at FROM retired_names WHERE owner_id = $1', [ownerId, holdFor]);
  await client.query('DELETE FROM retired_names WHERE owner_id = $1', [ownerId]);
  return row || null;
}
async function locked(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(490048)');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
// Deleting a Closedhand account: the sign-in is forgotten, and nothing left
// here links its names to anyone.
async function deleteAccount(pool, ownerId) {
  return locked(pool, async client => {
    const row = await letGo(client, ownerId, null);
    await client.query('DELETE FROM owners WHERE id = $1', [ownerId]);
    return { hostname: row?.hostname || null };
  });
}
// Addresses whose computer has not connected for this many days are let go,
// their names held for their owners (who get them back by setting up again).
async function releaseIdle(pool, days) {
  const idle = (await pool.query(
    'SELECT owner_id FROM addresses WHERE activated_at IS NOT NULL AND last_seen_at < now() - make_interval(days => $1) LIMIT 20', [days])).rows;
  for (const { owner_id: ownerId } of idle) {
    await locked(pool, async client => {
      // Checked again under the lock, in case it came back.
      const still = await client.query(
        'SELECT 1 FROM addresses WHERE owner_id = $1 AND last_seen_at < now() - make_interval(days => $2)', [ownerId, days]);
      if (still.rowCount) await letGo(client, ownerId, ownerId);
    });
  }
  return idle.length;
}

// The Terms as they stand (views/terms.html, its "Last updated" day): what
// an account agreed to when its claim says the person ticked the box.
const TERMS_VERSION = '2026-11-06';
async function agreed(db, ownerId, body) {
  if (body?.acceptedTerms === true) await db.query('UPDATE owners SET terms_version = $2, terms_accepted_at = now() WHERE id = $1', [ownerId, TERMS_VERSION]);
}

function register(app, { db, sessions, secret, baseUrl, env = process.env, request = fetch, includedAi = require('./included-ai').create({ db, env, request }), plus = null, ahead = null, notices = null }) {
  const { planFor } = require('./plan');
  const enabled = () => env.PHONE_ENROLLMENT_ENABLED === '1';
  // A claim's answer, with the included AI's key when one is given, and
  // whether the account is one made with an account number, so the computer
  // never passes a Google or Microsoft sign-in on to it.
  const claimed = async (row, ownerId, req) => {
    const included = await includedAi.forOwner(ownerId, { ip: req.ip });
    return { state: row.state, url: 'https://' + row.hostname, ...(included ? { included_ai: included } : {}), ...(await isAnonymous(db, ownerId) ? { anonymous: true } : {}) };
  };
  // The maintainer hears of each account's first personal URL through their
  // own Closedhand (lib/operator-notices.js), which no other account can
  // collect: who signed up (the sign-in's email and provider, all that is
  // kept) and the URL they took.
  const announce = async (first, ownerId, row) => {
    if (!first || !notices) return;
    const who = (await db.query('SELECT email, provider FROM owners WHERE id = $1', [ownerId])).rows[0] || {};
    const n = (await db.query('SELECT count(*)::int AS n FROM addresses')).rows[0].n;
    const by = { google: 'Google', microsoft: 'Microsoft' }[who.provider] || who.provider || 'a sign-in';
    const signUp = who.provider === 'anonymous' ? 'new sign-up with an account number, no email,' : `new sign-up, ${who.email || 'no email'} (${by}),`;
    await notices.queue(`Closedhand: ${signUp} took ${row.hostname}. ${n} ${n === 1 ? 'person has' : 'people have'} a personal URL now.`)
      .catch(e => console.error('[operator] notice:', e.message));
  };
  const limit = Number.parseInt(env.ADDRESS_LIMIT || '100', 10);
  // Requests a minute from one address (the tests raise it).
  const perMinute = Number.parseInt(env.ADDRESS_RATE_PER_MINUTE || '120', 10);
  const hits = new Map();
  let total = 0, resetAt = 0;
  // Switching new personal URLs off never stops anyone deleting their
  // account, nor the personal URLs already working (connection, connected).
  const UNAVAILABLE = 'Personal URLs are not available right now. You can still use Closedhand on the computer running it.';
  const wrap = (fn, { always = false } = {}) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!always && !enabled()) return res.status(503).json({ error: UNAVAILABLE });
    const now = Date.now();
    if (now > resetAt) { hits.clear(); total = 0; resetAt = now + 60000; }
    const key = req.ip || '?', count = (hits.get(key) || 0) + 1;
    hits.set(key, count);
    // Only requests let through count towards the overall cap, so one busy
    // address cannot use it up for everyone else.
    if (count > perMinute || total >= 10 * perMinute) return res.status(429).json({ error: 'Please wait a minute and try again.' });
    total++;
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof Refusal) return res.status(409).json({ error: e.message });
      console.error('[addresses]', req.path, e.message);
      res.status(503).json({ error: 'Could not finish setting up your personal URL. Please try again.' });
    }
  };
  async function owned(req) {
    const copy = installation(req);
    if (!copy) return null;
    const row = (await db.query('SELECT * FROM addresses WHERE secret_hash = $1', [copy.secret_hash])).rows[0];
    return row ? { row, copy } : null;
  }

  app.post('/api/phone-enrollment/register', wrap(async (req, res) => {
    const copy = installation(req), { name, confirm } = req.body || {};
    if (!copy) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    // Copies from before confirmation codes could never finish.
    if (confirm !== 'code') return res.status(400).json({ error: 'Update Closedhand on your computer, then choose your personal URL again.' });
    // Asked without a name, the address gets one picked here.
    if (name === undefined || name === null || name === '') {
      return res.json({ ticket: ticketFor({ secret_hash: copy.secret_hash, hostname: await freeName(db), auto: true }, secret) });
    }
    const hostname = typeof name === 'string' ? name + '.closedhand.ai' : '';
    if (!validHostname(hostname)) {
      return res.status(400).json({ error: 'Use 3 to 32 lowercase letters, numbers or hyphens. Start with a letter and end with a letter or number.' });
    }
    res.json({ ticket: ticketFor({ secret_hash: copy.secret_hash, hostname }, secret) });
  }));

  // What the confirmation page shows. Progress, and the code while it is
  // waiting to be typed in, are revealed only to the owner who confirmed;
  // an expired ticket can still show its owner a finished request, but can
  // never approve anything. "move" means this owner's address currently
  // opens another copy.
  app.post('/api/phone-enrollment/details', wrap(async (req, res) => {
    const t = readTicket(req.body?.ticket, secret);
    if (!t) return res.status(400).json({ error: 'This claim link is not valid. Start again in Closedhand.' });
    const answer = { url: 'https://' + t.hostname, state: 'unconfirmed' };
    const owner = sessions.owner(req);
    if (owner) {
      const mine = (await db.query('SELECT * FROM addresses WHERE owner_id = $1', [owner])).rows[0];
      // A picked name gives way to the address the owner already has, or to
      // the name held for them.
      const hostname = t.auto ? mine?.hostname || await heldName(db, owner) || t.hostname : t.hostname;
      answer.url = 'https://' + hostname;
      if (mine && mine.hostname === hostname && mine.secret_hash === t.secret_hash) answer.state = mine.state;
      else {
        if (mine?.hostname === hostname) answer.move = true;
        const waiting = (await db.query('SELECT code, hostname FROM approvals WHERE secret_hash = $1 AND owner_id = $2 AND expires_at > now()' + (t.auto ? '' : ' AND hostname = $3'),
          t.auto ? [t.secret_hash, owner] : [t.secret_hash, owner, t.hostname])).rows[0];
        const code = waiting && decryptString(waiting.code);
        if (code) Object.assign(answer, { state: 'awaiting-code', code, url: 'https://' + waiting.hostname });
      }
    }
    if (t.expires <= Date.now() && answer.state === 'unconfirmed') return res.status(400).json({ error: 'This claim link expired. Start again in Closedhand.' });
    res.json(answer);
  }));

  // The owner confirms. Nothing changes yet: they are shown a code, and only
  // the copy that asked can finish by typing it in (see claim). Anything the
  // code could not fix is refused now.
  app.post('/api/phone-enrollment/approve', wrap(async (req, res) => {
    const owner = sessions.owner(req), t = readTicket(req.body?.ticket, secret);
    if (!owner) return res.status(401).json({ error: 'Sign in to claim this personal URL.' });
    if (req.headers.origin !== baseUrl) return res.status(403).json({ error: 'Open this claim page on closedhand.com.' });
    if (!t || t.expires <= Date.now()) return res.status(400).json({ error: 'This claim link expired. Start again in Closedhand.' });
    const mine = (await db.query('SELECT * FROM addresses WHERE owner_id = $1', [owner])).rows[0];
    // A picked name gives way to the owner's own address, or the name held
    // for them, or to another free one if somebody took it in the meantime.
    let hostname = t.hostname;
    if (t.auto) hostname = mine ? mine.hostname : await heldName(db, owner) || ((await nameTaken(db, hostname, owner)) ? await freeName(db) : hostname);
    const url = 'https://' + hostname;
    if (mine && mine.hostname !== hostname) {
      throw new Refusal('This account already has a personal URL, ' + mine.hostname + '. To use it with this computer, choose ' + mine.hostname.split('.')[0] + ' in Closedhand.');
    }
    if (mine && mine.secret_hash === t.secret_hash) return res.json({ state: mine.state, url });
    if (!mine && (await nameTaken(db, hostname, owner))) throw new Refusal('That personal URL is already taken. Choose another name.');
    const copy = (await db.query('SELECT owner_id FROM addresses WHERE secret_hash = $1', [t.secret_hash])).rows[0];
    if (copy && copy.owner_id !== owner) throw new Refusal('This computer already has a personal URL on another account.');
    const code = newCode(), sealed = encryptString(code);
    if (!sealed?.startsWith('enc:v1:')) throw new Error('Encryption unavailable');
    await db.query('DELETE FROM approvals WHERE expires_at < now()');
    // Confirming again replaces the waiting code.
    await db.query(
      `INSERT INTO approvals (secret_hash, owner_id, hostname, code, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 minutes')
       ON CONFLICT (secret_hash) DO UPDATE SET owner_id = EXCLUDED.owner_id, hostname = EXCLUDED.hostname,
         code = EXCLUDED.code, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = now()`,
      [t.secret_hash, owner, hostname, sealed]);
    res.json({ state: 'awaiting-code', url, code, ...(mine ? { move: true } : {}) });
  }));

  // The copy types in the code its owner was shown. Each try is counted
  // before the code is compared, so trying many at once gains nothing.
  app.post('/api/phone-enrollment/claim', wrap(async (req, res) => {
    const copy = installation(req);
    if (!copy) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    const code = String(req.body?.code || '').toUpperCase().replace(/[\s-]/g, '');
    const waiting = (await db.query(
      'UPDATE approvals SET attempts = attempts + 1 WHERE secret_hash = $1 AND expires_at > now() AND attempts < $2 RETURNING *',
      [copy.secret_hash, MAX_CODE_TRIES])).rows[0];
    if (!waiting) return res.status(409).json({ error: 'Claim your personal URL on closedhand.com first. It then shows the code to type here.' });
    if (!/^[A-Z0-9]{6}$/.test(code) || !equal(code, decryptString(waiting.code) || '')) {
      if (waiting.attempts < MAX_CODE_TRIES) return res.status(400).json({ error: 'That code does not match. Check the code on closedhand.com and try again.' });
      await db.query('DELETE FROM approvals WHERE secret_hash = $1 AND code = $2', [copy.secret_hash, waiting.code]);
      return res.status(400).json({ error: 'That code did not match, so it no longer works. Claim it again on closedhand.com for a new code.' });
    }
    // One use: only the request that removes it goes on.
    const used = await db.query('DELETE FROM approvals WHERE secret_hash = $1 AND code = $2 RETURNING owner_id, hostname', [copy.secret_hash, waiting.code]);
    if (!used.rowCount) return res.status(409).json({ error: 'Claim your personal URL on closedhand.com first. It then shows the code to type here.' });
    const a = used.rows[0];
    const first = !(await db.query('SELECT 1 FROM addresses WHERE owner_id = $1', [a.owner_id])).rowCount;
    const row = await reserve(db, { ownerId: a.owner_id, secretHash: copy.secret_hash, hostname: a.hostname, limit });
    await agreed(db, a.owner_id, req.body);
    await announce(first, a.owner_id, row);
    res.json(await claimed(row, a.owner_id, req));
  }));

  // A copy that just connected mail through Closedhand's own Google or
  // Microsoft app passes on that sign-in and claims in one step: the
  // provider's signature stands in for signing in here, and the copy's own
  // secret for the code. Closedhand's apps are the ones the copies sign in
  // through, never closedhand.com's own sign-in app. An address the owner
  // already uses on another computer is never moved this way; the copy is
  // told to claim it on the confirmation page.
  const passedApps = {
    google: { ids: env.GOOGLE_ASSOCIATED_CLIENT_IDS, own: env.GOOGLE_CLIENT_ID, valid: /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/, name: 'Google' },
    microsoft: { ids: env.MICROSOFT_ASSOCIATED_APP_IDS, own: env.MICROSOFT_CLIENT_ID, valid: uuid, name: 'Microsoft' },
  };
  for (const [provider, apps] of Object.entries(passedApps)) {
    app.post('/api/phone-enrollment/claim-' + provider, wrap(async (req, res) => {
      const copy = installation(req), { idToken } = req.body || {};
      if (!copy) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
      const ids = String(apps.ids || '').split(',').map(s => s.trim()).filter(id => apps.valid.test(id) && id !== apps.own);
      const claims = ids.length ? await verifyPassedSignIn(provider, idToken, { appIds: ids, request }) : null;
      const identity = claims && PROVIDERS[provider].identity(claims, claims.aud);
      if (!identity) return res.status(400).json({ error: `The ${apps.name} sign-in could not be checked. Claim your personal URL with the button instead.` });
      // A computer whose personal URL belongs to an account made with an
      // account number keeps that account free of any sign-in: nothing is
      // made or kept for this one.
      const theirs = (await db.query('SELECT owner_id FROM addresses WHERE secret_hash = $1', [copy.secret_hash])).rows[0];
      if (theirs && await isAnonymous(db, theirs.owner_id)) return res.json({ state: 'unconfirmed', claimHere: true });
      const owner = await ownerFor(db, identity);
      const mine = (await db.query('SELECT * FROM addresses WHERE owner_id = $1', [owner])).rows[0];
      if (mine && mine.secret_hash === copy.secret_hash) return res.json(await claimed(mine, owner, req));
      if (mine || theirs) return res.json({ state: 'unconfirmed', claimHere: true });
      const row = await reserve(db, { ownerId: owner, secretHash: copy.secret_hash, hostname: await heldName(db, owner) || await freeName(db), limit });
      await agreed(db, owner, req.body);
      await announce(true, owner, row);
      res.json(await claimed(row, owner, req));
    }));

    // Another Google or Microsoft account connected on a computer that
    // already holds a personal URL: it signs in to that same account from
    // now on, so whichever the person connected at setup works. Checked as a
    // claim is (the provider's signature, the computer's own secret); a
    // sign-in that is another account's stays with it.
    app.post('/api/phone-enrollment/sign-in-' + provider, wrap(async (req, res) => {
      const copy = installation(req), { idToken } = req.body || {};
      if (!copy) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
      const ids = String(apps.ids || '').split(',').map(s => s.trim()).filter(id => apps.valid.test(id) && id !== apps.own);
      const claims = ids.length ? await verifyPassedSignIn(provider, idToken, { appIds: ids, request }) : null;
      const identity = claims && PROVIDERS[provider].identity(claims, claims.aud);
      if (!identity) return res.status(400).json({ error: `The ${apps.name} sign-in could not be checked.` });
      const held = (await db.query('SELECT owner_id FROM addresses WHERE secret_hash = $1', [copy.secret_hash])).rows[0];
      if (!held) return res.status(409).json({ error: 'This computer has no personal URL yet.' });
      if (await isAnonymous(db, held.owner_id)) return res.status(409).json({ error: 'Your Closedhand account uses an account number, so no Google or Microsoft sign-in is added.' });
      res.json({ signIn: await addSignIn(db, held.owner_id, identity) });
    }));
  }

  // Using Closedhand anonymously is paid for first, in crypto (lib/ahead.js).
  // The computer asks with the months it chose and gets the payment page;
  // the claim waits here, with no account, until the invoice settles. Then
  // the account (made with an account number), its personal URL and its plan
  // are made together, and the computer collects the number once by asking
  // again with the secret only it holds. The number is kept here only sealed
  // and only until then; afterwards only its fingerprint. An invoice that
  // expires discards the claim, and a claim never paid goes after a day.
  const dropOld = () => db.query("DELETE FROM anonymous_pending WHERE (state = 'waiting' AND created_at < now() - interval '1 day') OR (state = 'paid' AND created_at < now() - interval '30 days')");
  app.post('/api/phone-enrollment/claim-anonymous', wrap(async (req, res) => {
    const copy = installation(req), { months } = req.body || {};
    if (!copy) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    if (req.body?.acceptedTerms !== true) return res.status(400).json({ error: 'Agree to the Terms and Privacy policy first.' });
    if (!ahead?.cryptoOn() || String(env.TOKEN_ENCRYPTION_KEY || '').length < 16) return res.status(503).json({ error: 'Using Closedhand anonymously isn\u2019t available just now. Please try again later.' });
    if (!ahead.CRYPTO_MONTHS.includes(months)) return res.status(400).json({ error: 'Choose 3, 6 or 9 months.' });
    if ((await db.query('SELECT 1 FROM addresses WHERE secret_hash = $1', [copy.secret_hash])).rowCount) throw new Refusal('This computer already has a personal URL.');
    const live = (await db.query("SELECT count(*)::int AS n FROM addresses WHERE activated_at IS NOT NULL OR created_at > now() - interval '24 hours'")).rows[0].n;
    if (live >= limit) throw new Refusal('Personal URLs are full for now. Try again later.');
    await dropOld();
    // Asking again starts over: one waiting claim a computer.
    await db.query("DELETE FROM anonymous_pending WHERE secret_hash = $1 AND state = 'waiting'", [copy.secret_hash]);
    const id = crypto.randomUUID();
    await db.query('INSERT INTO anonymous_pending (id, secret_hash, months, terms_version) VALUES ($1, $2, $3, $4)', [id, copy.secret_hash, months, TERMS_VERSION]);
    let invoice;
    try { invoice = await ahead.invoiceForClaim(id, months); }
    catch (e) { await db.query('DELETE FROM anonymous_pending WHERE id = $1', [id]); throw e; }
    await db.query('UPDATE anonymous_pending SET invoice_id = $2 WHERE id = $1', [id, invoice.id]);
    res.json({ state: 'waiting', url: invoice.url });
  }));
  // Where the claim stands: waiting (read back from BTCPay at most every 20
  // seconds, in case its webhook went astray), none (never asked, or the
  // invoice lapsed), or made, which is answered once, with the number.
  app.get('/api/phone-enrollment/claim-anonymous', wrap(async (req, res) => {
    const copy = installation(req);
    if (!copy) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    await dropOld();
    const mine = () => db.query('SELECT * FROM anonymous_pending WHERE secret_hash = $1 ORDER BY created_at DESC LIMIT 1', [copy.secret_hash]).then(r => r.rows[0]);
    let row = await mine();
    if (row?.state === 'waiting' && row.invoice_id && ahead && (!row.checked_at || Date.now() - new Date(row.checked_at).getTime() > 20000)) {
      await db.query('UPDATE anonymous_pending SET checked_at = now() WHERE id = $1', [row.id]);
      await ahead.settled(row.invoice_id).catch(e => console.error('[addresses] anonymous claim read back:', e.message));
      row = await mine();
    }
    if (!row) return res.json({ state: 'none' });
    if (row.state !== 'paid') return res.json({ state: 'waiting' });
    const taken = (await db.query("DELETE FROM anonymous_pending WHERE id = $1 AND state = 'paid' RETURNING owner_id, number", [row.id])).rows[0];
    const number = taken && decryptString(taken.number);
    if (!number) return res.json({ state: 'none' });
    const address = (await db.query('SELECT * FROM addresses WHERE owner_id = $1', [taken.owner_id])).rows[0];
    res.json({ ...(address ? await claimed(address, taken.owner_id, req) : { state: 'unconfirmed', anonymous: true }), accountNumber: accountNumber.grouped(number) });
  }, { always: true }));
  // The invoice settled: the account, its personal URL and its plan, made
  // once. A claim no longer waiting (its invoice lapsed first) makes nothing;
  // a late payment is for support, as the Terms say.
  async function claimPaid(claimId, months, paid) {
    const taken = (await db.query("UPDATE anonymous_pending SET state = 'making' WHERE id = $1 AND state = 'waiting' RETURNING *", [claimId])).rows[0];
    if (!taken) {
      if (!(await db.query('SELECT 1 FROM anonymous_pending WHERE id = $1', [claimId])).rowCount) console.error('[addresses] a payment for an anonymous claim no longer waiting: ' + paid.id);
      return 'no claim waiting';
    }
    const number = accountNumber.make();
    const owner = await anonymousOwner(db, accountNumber.fingerprint(number, String(env.TOKEN_ENCRYPTION_KEY || '')));
    try {
      if (taken.terms_version) await db.query('UPDATE owners SET terms_version = $2, terms_accepted_at = $3 WHERE id = $1', [owner, taken.terms_version, taken.created_at]);
      let row = null;
      // Paid for, so made even past the limit on personal URLs (checked when asked).
      try { row = await reserve(db, { ownerId: owner, secretHash: taken.secret_hash, hostname: await freeName(db), limit: Infinity }); }
      catch (e) { if (!(e instanceof Refusal)) throw e; console.error('[addresses] a paid anonymous account without a personal URL:', e.message); }
      await ahead.grant(owner, months, paid);
      await db.query("UPDATE anonymous_pending SET state = 'paid', owner_id = $2, number = $3 WHERE id = $1", [claimId, owner, encryptString(number)]);
      if (row) await announce(true, owner, row);
      return 'made an anonymous account, paid ahead ' + months + ' months';
    } catch (e) {
      // BTCPay sends the webhook again; the claim waits for it.
      await deleteAccount(db, owner).catch(() => {});
      await db.query("UPDATE anonymous_pending SET state = 'waiting' WHERE id = $1", [claimId]);
      throw e;
    }
  }
  ahead?.onPendingClaim({
    paid: claimPaid,
    lapsed: async invoiceId => (await db.query("DELETE FROM anonymous_pending WHERE invoice_id = $1 AND state = 'waiting'", [invoiceId])).rowCount ? 'claim let go' : 'not used',
  });

  // Which provider and models Closedhand Managed Models use now. A computer
  // with its key asks every hour and switches itself over when they change.
  // It is also told its plan (lib/plan.js: its free 14 days, a subscription,
  // ended or none) and how much of the plan's fair use is used (a NEAR key
  // can't read that itself), a subscriber whose account holds no key yet gets
  // one here, once, to seal, and the maintainer's own Closedhand collects
  // their notices.
  app.get('/api/phone-enrollment/included-ai', wrap(async (req, res) => {
    if (!installation(req)) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    const found = await owned(req);
    const ownerId = found?.row.owner_id || null;
    const plan = await planFor(db, env, ownerId, undefined, includedAi);
    // A subscriber's key, or the maintainer's, collected once; the maintainer's
    // is also kept to its month here.
    const key = ['plus', 'maintainer', 'ahead'].includes(plan.name) ? await includedAi.collect(ownerId) : null;
    const usage = ['plus', 'first-month', 'maintainer', 'ahead'].includes(plan.name) ? await includedAi.usage(ownerId).catch(() => null) : null;
    const told = notices ? await notices.collect(ownerId) : [];
    // What the subscription costs where the computer is, so Closedhand can say when asked.
    const prices = plus ? await plus.prices(req.headers['cf-ipcountry']).catch(() => null) : null;
    res.json({ models: includedAi.current(), plan, ...(usage ? { usage } : {}), ...(prices ? { prices } : {}), ...(key ? { key: key.key } : {}), ...(told.length ? { notices: told } : {}) });
  }, { always: true }));

  // The copy renames its address. It is known by its secret, like every
  // request from it; the name is tidied first, as the copy shows it.
  app.post('/api/phone-enrollment/rename', wrap(async (req, res) => {
    const copy = installation(req);
    if (!copy) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    const hostname = cleanName(req.body?.name) + '.closedhand.ai';
    if (!validHostname(hostname)) {
      return res.status(400).json({ error: 'Use 3 to 32 letters, numbers or hyphens, starting with a letter. A few names, like admin and mail, are kept back.' });
    }
    const row = await rename(db, { secretHash: copy.secret_hash, hostname });
    res.json({ state: row.state, url: 'https://' + row.hostname });
  }));

  // The relay the computers take their personal URLs at, as closedhand.com
  // names it to them: where to reach it, its own name and the fingerprint
  // of its certificate (so no other server can pose as it), and the key
  // passes are signed with.
  function relaySettings() {
    const address = String(env.RELAY_ADDRESS || '').trim(), controlHost = String(env.RELAY_CONTROL_HOST || '').trim(), pin = String(env.RELAY_PIN || '').trim();
    let passKey = null;
    try { passKey = crypto.createPrivateKey(String(env.RELAY_PASS_PRIVATE_KEY || '').replace(/\\n/g, '\n')); } catch (_) { /* not set */ }
    if (!/^[a-z0-9.-]+:\d{1,5}$/.test(address) || !/^[a-z0-9.-]+$/.test(controlHost) || !/^[A-Za-z0-9_-]{43}$/.test(pin) || passKey?.asymmetricKeyType !== 'ed25519') return null;
    return { address, controlHost, pin, passKey };
  }

  // What the computer needs to take its personal URL at the relay: a pass
  // for it and the computer's own key, and the relay to show it to. A
  // computer whose address is not yet active then proves it answers there
  // (connected); an active one asks again before its pass runs out. Answered
  // even with new personal URLs switched off, as a pass lasts a day and the
  // personal URLs already working need the next one.
  app.post('/api/phone-enrollment/connection', wrap(async (req, res) => {
    const key = req.body?.key;
    if (!computerKey(key)) return res.status(400).json({ error: 'Update Closedhand on your computer and try again.' });
    const found = await owned(req);
    if (!found) {
      // A computer whose address moved to another of its owner's computers:
      // Closedhand runs there now, and stops here.
      const copy = installation(req);
      const now = copy && (await db.query('SELECT a.hostname FROM replaced_copies r JOIN addresses a ON a.owner_id = r.owner_id WHERE r.secret_hash = $1', [copy.secret_hash])).rows[0];
      return res.json(now ? { state: 'replaced', url: 'https://' + now.hostname } : { state: 'unconfirmed' });
    }
    const { row } = found;
    const relay = relaySettings();
    if (!relay) {
      console.error('[addresses] RELAY_ADDRESS, RELAY_CONTROL_HOST, RELAY_PIN and RELAY_PASS_PRIVATE_KEY are not all set');
      return res.status(503).json({ error: UNAVAILABLE });
    }
    res.json({ state: row.state === 'active' ? 'active' : 'connecting', url: 'https://' + row.hostname, pass: passFor(row.hostname, key, relay.passKey),
      relay: { address: relay.address, controlHost: relay.controlHost, pin: relay.pin } });
  }, { always: true }));

  // The copy says it is connected. Check by asking it, through the relay at
  // its address, to sign a fresh challenge with the secret only it holds.
  app.post('/api/phone-enrollment/connected', wrap(async (req, res) => {
    const found = await owned(req);
    if (!found) return res.status(409).json({ error: 'Your personal URL is not ready yet.' });
    const { row, copy } = found;
    const nonce = crypto.randomBytes(32).toString('hex');
    let proof = null;
    try {
      const response = await request('https://' + row.hostname + '/.well-known/closedhand-installation?nonce=' + nonce, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      proof = response.ok ? (await smallJson(response))?.proof : null;
    } catch (_) { /* not reachable yet */ }
    const expected = crypto.createHmac('sha256', copy.secret).update('closedhand-address:' + nonce).digest('hex');
    if (!equal(proof, expected)) return res.status(409).json({ error: 'Waiting for this computer to connect. Please try again shortly.' });
    // Only for the name it answered at: a rename meanwhile waits for its own proof.
    const updated = await db.query(
      "UPDATE addresses SET state = 'active', activated_at = COALESCE(activated_at, now()), last_seen_at = now(), updated_at = now() WHERE id = $1 AND secret_hash = $2 AND hostname = $3 RETURNING id",
      [row.id, row.secret_hash, row.hostname]);
    if (!updated.rowCount) throw new Error('Address changed while connecting');
    res.json({ state: 'active' });
  }, { always: true }));

  // A Closedhand account is the Google or Microsoft sign-in that confirmed a
  // personal URL, and it holds that personal URL and nothing else. The
  // computer the URL opens can see which sign-in it is, and can delete the
  // account (Settings in Closedhand); so can the owner here, signed in.
  // My Account in its dashboard shows the account whole: its sign-ins, the
  // plan, this month's fair use as a share and the subscription.
  app.get('/api/phone-enrollment/account', wrap(async (req, res) => {
    const found = await owned(req);
    const person = found && (await db.query('SELECT provider, email FROM owners WHERE id = $1', [found.row.owner_id])).rows[0];
    if (!person) return res.json({ account: null });
    const details = await detailsOf(found.row.owner_id, req.headers['cf-ipcountry'], { card: true });
    res.json({ account: { provider: person.provider, email: person.email, url: 'https://' + found.row.hostname, ...details } });
  }, { always: true }));
  // The subscription in My Account, for the computer whose personal URL it is:
  // Polar's checkout and card form, framed on that personal URL only,
  // cancelling or keeping it, and what was paid with its invoices.
  const forPlus = (method, path, fn) => app[method]('/api/phone-enrollment/plus/' + path, wrap(async (req, res) => {
    const found = await owned(req);
    if (!found) return res.status(401).json({ error: 'Claim your personal URL first.' });
    if (!plus?.enabled()) return res.status(503).json({ error: 'Subscribing is not available yet.' });
    try { await fn(found.row.owner_id, 'https://' + found.row.hostname, req, res); }
    catch (e) {
      console.error('[plus] my account:', e.message);
      res.status(503).json({ error: 'Could not reach the payment service just now. Please try again.' });
    }
  }));
  // Paying, each way: the subscription (every month, or every 6 or 12), paying
  // ahead in crypto (lib/ahead.js), or carrying on past this month's fair use
  // the way the plan is paid. A payment that charges at once needs the box
  // ticked first.
  forPlus('post', 'checkout', async (ownerId, origin, req, res) => {
    const owner = (await db.query('SELECT id, email FROM owners WHERE id = $1', [ownerId])).rows[0];
    const now = await plus.state(ownerId);
    const agreed = req.body?.agreed === true;
    const crypto = async (what) => {
      if (!ahead) return res.status(503).json({ error: 'Paying in crypto is not available just now.' });
      try { return res.json({ url: await ahead.checkout(owner, { ...what, agreed }) }); }
      catch (e) { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); throw e; }
    };
    if (req.body?.kind === 'extend') {
      if (now.ahead_until) return crypto({ extend: true });
      if (!now.active) return res.status(409).json({ error: 'Carrying on past fair use is part of the subscription.' });
      if (now.extended) return res.status(409).json({ error: 'You can already carry on to the end of this month.' });
      if (!agreed) return res.status(400).json({ error: plus.AGREE });
      return res.json({ url: await plus.extend(owner, origin) });
    }
    if (req.body?.kind === 'ahead') return crypto({ months: req.body.months });
    if (now.active) return res.status(409).json({ error: 'You already have the Closedhand subscription.' });
    if (now.ahead_until) return res.status(409).json({ error: 'Your account is paid ahead in crypto, so there is no subscription by card to start.' });
    const every = Number(req.body?.months || 1);
    const why = await plus.cannotSubscribe(owner, every, agreed);
    if (why) return res.status(400).json({ error: why });
    res.json({ url: await plus.checkout(owner, origin, every) });
  });
  forPlus('post', 'card', async (ownerId, origin, req, res) => {
    const session = await plus.cardSession(ownerId);
    if (!session) return res.status(409).json({ error: 'You don’t have the Closedhand subscription.' });
    res.json(session);
  });
  forPlus('post', 'cancel', async (ownerId, origin, req, res) => {
    const now = await plus.setCancel(ownerId, req.body?.cancel === true);
    if (!now) return res.status(409).json({ error: 'You don’t have the Closedhand subscription.' });
    res.json({ plus: now });
  });
  forPlus('get', 'payments', async (ownerId, origin, req, res) => {
    res.json({ payments: await plus.payments(ownerId) });
  });
  forPlus('get', 'invoice', async (ownerId, origin, req, res) => {
    const url = await plus.invoice(ownerId, req.query.id);
    if (!url) return res.status(404).json({ error: 'That invoice is not ready yet. Please try again shortly.' });
    res.json({ url });
  });
  app.post('/api/phone-enrollment/account/delete', wrap(async (req, res) => {
    if (!installation(req)) return res.status(401).json({ error: 'Closedhand could not be recognised. Update it on your computer and try again.' });
    const found = await owned(req);
    // Nothing on closedhand.com is linked to this computer: nothing to delete.
    if (!found) return res.json({ deleted: false });
    if (plus) await plus.forget(found.row.owner_id);
    await includedAi.forget(found.row.owner_id);
    await deleteAccount(db, found.row.owner_id);
    res.json({ deleted: true });
  }, { always: true }));
  app.post('/api/account/delete', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const owner = sessions.owner(req);
    if (!owner) return res.status(401).json({ error: 'Sign in to delete your Closedhand account.' });
    if (req.headers.origin !== baseUrl) return res.status(403).json({ error: 'Open this on closedhand.com.' });
    try {
      if (plus) await plus.forget(owner);
      await includedAi.forget(owner);
      await deleteAccount(db, owner);
      sessions.signOut(res);
      res.json({ deleted: true });
    } catch (e) {
      console.error('[addresses] delete account:', e.message);
      res.status(503).json({ error: 'Could not delete your account. Please try again.' });
    }
  });

  // An account's sign-ins, the plan, how much of this month's fair use is
  // used, as a share for one bar and never an amount, and the subscription
  // with its prices where the person is.
  async function detailsOf(owner, country, { card: withCard = false } = {}) {
    // An account made with an account number pays in crypto only: a card
    // would tie it to a name. It is told no card prices or ways to pay by
    // card, and Managed Models are there for it whenever crypto is.
    if (await isAnonymous(db, owner)) return anonymousDetails(owner);
    const plusState = plus ? await plus.state(owner) : null;
    const plusPrices = plusState?.available ? await plus.prices(country) : null;
    // A subscription every 6 or 12 months: its own price, for what resuming would charge.
    if (plusPrices && plusState.every) plusPrices.every = (await plus.longerPrices(country)).find(o => o.months === plusState.every)?.price || null;
    // The card only for My Account, which shows it: closedhand.com's own pages
    // ask for the account on every view, and each card read opens a Polar session.
    const card = withCard && plusState?.active ? await plus.cardOnFile(owner).catch(() => null) : null;
    const plan = await planFor(db, env, owner, undefined, includedAi);
    const running = ['first-month', 'plus', 'maintainer', 'ahead'].includes(plan.name);
    // The other ways to pay where the person is, for an account without a
    // subscription by card: the subscription every 6 or 12 months (not beside
    // a plan paid in crypto), and paying ahead in crypto, with carrying on in
    // crypto while such a plan runs.
    const open = plusState?.available && plan.name !== 'maintainer' && !plusState.active;
    const longer = open && !plusState.ahead_until ? await plus.longerPrices(country) : [];
    const coins = open && ahead ? ahead.options() : {};
    const ways = { ...(longer.length ? { longer } : {}), ...(coins.crypto?.length ? { crypto: coins.crypto, ...(plusState.ahead_until ? { crypto_extend: coins.extend } : {}) } : {}) };
    const usage = running ? await includedAi.usage(owner).catch(() => null) : null;
    const used = usage ? Math.round(Math.min(1, Math.max(0, usage.used / usage.limit)) * 100) / 100 : null;
    return { signIns: await signInsOf(db, owner), ...(plusState ? { plus: { ...plusState, ...(plusPrices ? { prices: plusPrices } : {}), ...(card ? { card } : {}), ...ways } } : {}), ...(plan.name ? { plan } : {}), ...(used !== null ? { used } : {}) };
  }

  async function anonymousDetails(owner) {
    const plan = await planFor(db, env, owner, undefined, includedAi);
    const running = ['plus', 'ahead'].includes(plan.name);
    const plusState = plus ? await plus.state(owner) : null;
    const coins = ahead?.cryptoOn() ? ahead.options() : {};
    const crypto = coins.crypto?.length ? { crypto: coins.crypto, ...(plusState?.ahead_until ? { crypto_extend: coins.extend } : {}) } : {};
    const p = plusState ? { active: false, extended: plusState.extended, nearly: plusState.nearly, ...(plusState.ahead_until ? { ahead_until: plusState.ahead_until } : {}) } : null;
    const usage = running ? await includedAi.usage(owner).catch(() => null) : null;
    const used = usage ? Math.round(Math.min(1, Math.max(0, usage.used / usage.limit)) * 100) / 100 : null;
    return { anonymous: true, signIns: [], ...(p ? { plus: { ...p, available: !!crypto.crypto, ...crypto } } : {}), ...(plan.name ? { plan } : {}), ...(used !== null ? { used } : {}) };
  }

  // Who is signed in here, and their personal URL: "url" once it works (to
  // open it), "address" while it exists at all (for the account page).
  app.get('/api/account', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const owner = sessions.owner(req);
      let url = null, address = null, email = null, provider = null, person = null, emailVerified = false;
      if (owner) {
        person = (await db.query('SELECT provider, email, email_verified FROM owners WHERE id = $1', [owner])).rows[0];
        if (person) ({ provider, email } = person), emailVerified = person.email_verified === true;
        const row = person && (await db.query('SELECT hostname, state FROM addresses WHERE owner_id = $1', [owner])).rows[0];
        if (row && validHostname(row.hostname)) address = row.hostname;
        if (row?.state === 'active' && validHostname(row.hostname)) url = 'https://' + row.hostname;
      }
      // A sign-in whose account was deleted is no sign-in at all.
      const offered = enabled() && await includedAi.offered({ ip: req.ip });
      const details = person ? await detailsOf(owner, req.headers['cf-ipcountry']) : { signIns: [] };
      // The uncensored LLM Closedhand provides, by the name people know it by.
      const model = includedAi.current()?.name || null;
      res.json({ signedIn: !!person, provider, email, emailVerified, url, address, available: enabled(), includedAi: offered, ...(offered ? { includedAiModel: includedAi.current().chat } : {}), ...(model ? { model } : {}), ...details });
    } catch (e) {
      console.error('[addresses] account:', e.message);
      res.status(503).json({ error: 'Could not look up your account. Please try again.' });
    }
  });

  // Tidying up, each hour (server.js). A reservation that has not worked
  // within a day is released, and names held or retired are freed when their
  // six months are up. Unused addresses are let go, but only while the
  // relay's reports are current (relay-seen, below), so a relay that stops
  // reporting can never make every address look unused. A sign-in that
  // holds nothing, a day on, is forgotten: an account exists only while it
  // has a personal URL (or a name held for it), or while a subscription or a
  // plan paid ahead runs, so neither ever outlives its account.
  const idleDays = Number.parseInt(env.ADDRESS_IDLE_DAYS || '90', 10);
  async function sweep() {
    await db.query("DELETE FROM addresses WHERE activated_at IS NULL AND created_at < now() - interval '24 hours'");
    await db.query('DELETE FROM held_names WHERE release_at <= now()');
    await db.query('DELETE FROM retired_names WHERE release_at <= now()');
    if ((await db.query("SELECT 1 FROM relay_seen WHERE seen_at > now() - interval '3 hours'")).rowCount) await releaseIdle(db, idleDays);
    await db.query(
      `DELETE FROM owners o WHERE o.updated_at < now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM addresses a WHERE a.owner_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM retired_names r WHERE r.owner_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM held_names h WHERE h.owner_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM approvals p WHERE p.owner_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM plus_subscriptions s WHERE s.owner_id = o.id AND s.status IN ('active', 'trialing', 'past_due'))
         AND NOT EXISTS (SELECT 1 FROM ahead_plans p WHERE p.owner_id = o.id AND p.ended_at IS NULL AND p.ends_at > now())`);
  }

  // The relay's report, each minute, of the personal URLs whose computer is
  // connected to it now (relay/main.js): when each was last online, for the
  // insights page and for letting unused ones go. Only hostnames reach here,
  // never anything about their owners. It carries its own secret, and
  // switching new personal URLs off never stops it.
  app.post('/jobs/relay-seen', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!env.RELAY_REPORT_SECRET || !equal(req.headers.authorization, 'Bearer ' + env.RELAY_REPORT_SECRET)) return res.status(401).json({ error: 'Unauthorised' });
    const connected = req.body?.connected;
    if (!Array.isArray(connected) || connected.length > MAX_REPORTED) return res.status(400).json({ error: 'Invalid report' });
    try {
      const names = [...new Set(connected.filter(validHostname))];
      const seen = names.length ? (await db.query("UPDATE addresses SET last_seen_at = now() WHERE state = 'active' AND hostname = ANY($1::text[])", [names])).rowCount : 0;
      // Current only when it finds a computer connected: a relay reporting
      // nobody, broken or just restarted, leaves every address as it was.
      if (seen) await db.query('INSERT INTO relay_seen (id, seen_at) VALUES (true, now()) ON CONFLICT (id) DO UPDATE SET seen_at = EXCLUDED.seen_at');
      // A name still connected at the relay that belongs to nobody now (let
      // go, renamed, its account deleted): the relay drops it at once rather
      // than when its pass runs out.
      const known = names.length ? new Set((await db.query('SELECT hostname FROM addresses WHERE hostname = ANY($1::text[])', [names])).rows.map(r => r.hostname)) : new Set();
      res.json({ seen, drop: names.filter(n => !known.has(n)) });
    } catch (e) {
      console.error('[addresses] relay report:', e.message);
      res.status(503).json({ error: 'Report unavailable' });
    }
  });

  return { sweep };
}

module.exports = { TERMS_VERSION, register, reserve, rename, deleteAccount, releaseIdle, heldName, nameTaken, freeName, ticketFor, readTicket, installation, validHostname, computerKey, passFor, Refusal };
