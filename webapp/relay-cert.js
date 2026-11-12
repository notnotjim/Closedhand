// This computer's own certificate for its personal URL, from Let's Encrypt,
// made and renewed here: its private key is made on this computer and never
// leaves it, so a browser's encrypted connection can only be opened here
// (relay-client.js). Let's Encrypt checks the request by fetching an answer
// over the personal URL, which the relay gives for this computer alone.
//
// A certificate is renewed once two thirds of its life has passed, so a
// renewal that fails has a third of it left to try again. Let's Encrypt asks
// for no email, and none is given.
const acme = require('acme-client');
const tls = require('tls');

const RENEW_AT = 2 / 3;

// store: { read() -> { accountKey, key, cert, host } | null, write(value) }, sealed by its caller.
// relay: { challenge(token, answer), challengeGone(token) }.
function create({ store, relay, directoryUrl = acme.directory.letsencrypt.production, now = () => Date.now(), Client = acme.Client, settleMs = 1000 }) {
  let current = null, context = null, working = null;

  function info(cert) {
    const i = acme.crypto.readCertificateInfo(cert);
    return { from: new Date(i.notBefore).getTime(), until: new Date(i.notAfter).getTime(), names: [i.domains.commonName, ...(i.domains.altNames || [])] };
  }
  // Whether a certificate covers host and is still good (valid), or not due
  // for renewal yet either (fresh).
  function check(saved, host) {
    if (!saved || !saved.cert || !saved.key || saved.host !== host) return { valid: false, fresh: false };
    try {
      const { from, until, names } = info(saved.cert);
      const covers = names.includes(host) && now() >= from;
      return { valid: covers && now() < until, fresh: covers && now() < from + (until - from) * RENEW_AT };
    } catch (_) { return { valid: false, fresh: false }; }
  }
  const fresh = (saved, host) => check(saved, host).fresh;
  function use(saved) {
    current = saved;
    context = tls.createSecureContext({ key: saved.key, cert: saved.cert, minVersion: 'TLSv1.2' });
  }

  async function obtain(host) {
    const before = await store.read();
    const accountKey = before?.accountKey || (await acme.crypto.createPrivateEcdsaKey('P-256')).toString();
    const key = (await acme.crypto.createPrivateEcdsaKey('P-256')).toString();
    const [, csr] = await acme.crypto.createCsr({ commonName: host, altNames: [host] }, key);
    const client = new Client({ directoryUrl, accountKey });
    const cert = await client.auto({
      csr,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      challengeCreateFn: async (authz, challenge, answer) => { relay.challenge(challenge.token, answer); await new Promise(r => setTimeout(r, settleMs)); },
      challengeRemoveFn: async (authz, challenge) => { relay.challengeGone(challenge.token); },
    });
    const saved = { host, accountKey, key, cert: String(cert) };
    await store.write(saved);
    return saved;
  }

  // A certificate for host that is not due for renewal: the saved one, or a
  // new one from Let's Encrypt. One request at a time.
  async function ensure(host) {
    if (current && fresh(current, host)) return current;
    if (working) return working;
    working = (async () => {
      const saved = await store.read();
      const state = check(saved, host);
      if (state.fresh) { use(saved); return saved; }
      // Due for renewal but still good: used meanwhile, so a renewal that
      // fails leaves the personal URL working on the one it has.
      if (state.valid) use(saved);
      const next = await obtain(host);
      use(next);
      return next;
    })().finally(() => { working = null; });
    return working;
  }

  return {
    ensure,
    // What a browser's connection is opened with, or null before there is a certificate.
    context: () => context,
    // When the certificate in use runs out, for status and the daily check.
    until: () => (current ? info(current.cert).until : null),
  };
}

module.exports = { create, RENEW_AT };
