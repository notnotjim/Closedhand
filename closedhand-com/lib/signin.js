// Sign in with Google or Microsoft, keeping only the account's email.
// (Microsoft also needs "profile": it carries the address of accounts
// that have no email claim. The name it brings is never kept.)
// The provider's permanent account ID decides who someone is (owners.js).
const crypto = require('node:crypto');
const navigation = require('../public/entry-navigation');
const { findOwner, ownerFor, findAnonymous } = require('./owners');
const accountNumber = require('./account-number');
const { connection } = require('./included-ai');

const PERSONAL_ACCOUNTS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const PROVIDERS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email',
    extra: { prompt: 'select_account', access_type: 'online', include_granted_scopes: 'false' },
    // Google's ID never changes; its verified address may claim an owner
    // carried over from the old service (owners.js).
    identity(claims, clientId) {
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== clientId) return null;
      if (typeof claims.sub !== 'string' || !claims.sub) return null;
      return { provider: 'google', subject: claims.sub, email: claims.email || null, emailVerified: claims.email_verified === true };
    },
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid profile email',
    extra: { prompt: 'select_account' },
    // The directory plus the account's ID within it, which no organisation
    // can reassign. The email shown is whatever the account reports.
    identity(claims, clientId) {
      if (claims.aud !== clientId || !uuid.test(claims.tid || '')) return null;
      if (claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`) return null;
      const id = uuid.test(claims.oid || '') ? claims.oid : (typeof claims.sub === 'string' && claims.sub ? 'sub:' + claims.sub : null);
      if (!id) return null;
      return { provider: 'microsoft', subject: claims.tid + ':' + id, email: claims.email || claims.preferred_username || null, emailVerified: false,
        personal: claims.tid === PERSONAL_ACCOUNTS_TENANT };
    },
  },
};

// The ID token comes straight from the provider's token endpoint over TLS, in
// answer to a code only this service could redeem, so its claims are read
// without fetching signing keys (OpenID Connect Core 3.1.3.7).
function claimsOf(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); }
  catch (_) { return null; }
}

function register(app, { db, sessions, baseUrl, clients, request = fetch, pepper = '' }) {
  const available = key => !!(clients[key]?.id && clients[key]?.secret);

  app.get('/auth/:provider', (req, res) => {
    const key = req.params.provider, provider = PROVIDERS[key];
    const back = navigation.signInReturn(req.query.return_to);
    if (!provider || !available(key)) return res.redirect(navigation.signInError(back));
    const verifier = crypto.randomBytes(32).toString('base64url');
    const pending = { provider: key, state: crypto.randomBytes(24).toString('base64url'), nonce: crypto.randomBytes(24).toString('base64url'), verifier, back };
    sessions.startSignIn(res, pending);
    const params = new URLSearchParams({
      client_id: clients[key].id,
      redirect_uri: `${baseUrl}/auth/${key}/callback`,
      response_type: 'code',
      scope: provider.scope,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...provider.extra,
    });
    // A sign-in that follows straight on from connecting mail on the person's
    // computer names that same account, so the provider skips its picker.
    const hint = req.query.login_hint;
    if (typeof hint === 'string' && hint.length <= 320 && /^[^\s@<>"']+@[^\s@<>"']+$/.test(hint)) {
      params.set('login_hint', hint);
      params.delete('prompt');
    }
    res.redirect(provider.authorize + '?' + params);
  });

  app.get('/auth/:provider/callback', async (req, res) => {
    const key = PROVIDERS[req.params.provider] ? req.params.provider : 'unknown', provider = PROVIDERS[key];
    let back = '/open';
    const fail = why => {
      console.error(`[signin] ${key} sign-in did not finish: ${String(why).replace(/[^\x20-\x7e]/g, '?').slice(0, 120)}`);
      if (!res.headersSent) res.redirect(navigation.signInError(back));
    };
    try {
      const pending = sessions.pendingSignIn(req);
      sessions.finishSignIn(res);
      back = navigation.signInReturn(pending?.back);
      if (!provider || !available(key) || !pending || pending.provider !== key) return fail('no sign-in under way');
      if (typeof req.query.state !== 'string' || req.query.state !== pending.state) return fail('state mismatch');
      if (req.query.error || typeof req.query.code !== 'string') return fail(req.query.error || 'no code');
      const response = await request(provider.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: req.query.code, redirect_uri: `${baseUrl}/auth/${key}/callback`,
          client_id: clients[key].id, client_secret: clients[key].secret, code_verifier: pending.verifier,
        }),
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      const tokens = await response.json();
      if (!response.ok || !tokens.id_token) return fail('token exchange ' + response.status);
      const claims = claimsOf(tokens.id_token);
      if (!claims || claims.nonce !== pending.nonce || !(claims.exp * 1000 > Date.now())) return fail('ID token rejected');
      const identity = provider.identity(claims, clients[key].id);
      if (!identity) return fail('identity rejected');
      // Signing in to find a Closedhand never makes an account: a sign-in
      // with none goes back saying so. Claiming a personal URL is where an
      // account begins; confirming Closedhand's email address only finds the
      // account it belongs with, so a Google sign-in there never makes a
      // second one beside an account made with an account number.
      const finding = /^\/(open|account|carry-on|subscribe|assistant-email\/confirm)(?=[?#]|$)/.test(back);
      const owner = finding ? await findOwner(db, identity) : await ownerFor(db, identity);
      if (!owner) return res.redirect(navigation.noAccount(back, key));
      sessions.signIn(res, owner);
      res.redirect(back);
    } catch (e) {
      fail(e.message);
    }
  });

  // Signing in with an account number (an account made without an email).
  // It only finds an account, never makes one, and is looked up by its keyed
  // fingerprint, so how long that takes says nothing about the number. After
  // five wrong tries from one internet connection, or for one number, each
  // further try waits longer: a minute, then two, four and so on up to an
  // hour. A wrong number and a waiting one are told apart only by the wait.
  const tries = new Map();
  const waiting = key => Math.max(0, (tries.get(key)?.until || 0) - Date.now());
  const missed = key => {
    const t = tries.get(key) || { failed: 0 };
    t.failed++; t.at = Date.now();
    t.until = t.failed >= 5 ? Date.now() + Math.min(3600000, 60000 * 2 ** (t.failed - 5)) : 0;
    tries.set(key, t);
  };
  app.post('/auth/number', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin !== baseUrl) return res.status(403).json({ error: 'Open this on closedhand.com.' });
    if (tries.size > 10000) for (const [key, t] of tries) if (Date.now() - t.at > 86400000) tries.delete(key);
    const number = accountNumber.clean(req.body?.number);
    const place = 'connection:' + (connection(req.ip) || '?');
    const which = number && pepper.length >= 16 ? accountNumber.fingerprint(number, pepper) : null;
    const wait = Math.max(waiting(place), which ? waiting('number:' + which) : 0);
    if (wait) return res.status(429).json({ error: `Too many tries. Please wait ${Math.ceil(wait / 60000)} ${wait > 60000 ? 'minutes' : 'minute'} and try again.` });
    try {
      const owner = which ? await findAnonymous(db, which) : null;
      if (!owner) {
        missed(place);
        if (which) missed('number:' + which);
        return res.status(400).json({ error: "That account number didn't work. Check the number and try again." });
      }
      tries.delete(place); tries.delete('number:' + which);
      sessions.signIn(res, owner);
      res.json({ signedIn: true });
    } catch (e) {
      console.error('[signin] account number:', e.message);
      res.status(503).json({ error: 'Could not sign you in just now. Please try again.' });
    }
  });

  app.post('/logout', (req, res) => { sessions.signOut(res); res.redirect(req.query.return_to ? navigation.signInReturn(req.query.return_to) : '/'); });

  return { available };
}

module.exports = { register, PROVIDERS, claimsOf };
