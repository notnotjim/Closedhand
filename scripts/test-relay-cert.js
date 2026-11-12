// This computer's own certificate for its personal URL (webapp/relay-cert.js):
// made here with a key that never leaves, answered through the relay,
// renewed once two thirds of its life has passed, and kept in use while a
// renewal fails. Let's Encrypt is stood in for by a test authority that signs
// what is asked. Invented names only.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const relayCert = require('../webapp/relay-cert');

const NAME = 'amber-fox-42.closedhand.test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cert-'));
const at = f => path.join(dir, f);
after(() => fs.rmSync(dir, { recursive: true, force: true }));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', at('ca.key'), '-out', at('ca.crt'), '-days', '30', '-subj', '/CN=Test CA'], { stdio: 'ignore' });

// Let's Encrypt, stood in for: checks the answer through the relay, then signs the request for 3 days.
function authority({ fail = false } = {}) {
  const seen = { orders: 0, accounts: new Set() };
  class Client {
    constructor({ accountKey }) { seen.accounts.add(accountKey); }
    async auto({ csr, challengeCreateFn, challengeRemoveFn, termsOfServiceAgreed, challengePriority }) {
      assert.equal(termsOfServiceAgreed, true);
      assert.deepEqual(challengePriority, ['http-01']);
      seen.orders++;
      if (fail) throw new Error('Let\'s Encrypt is unreachable');
      await challengeCreateFn({}, { token: 'tok3n-' + seen.orders }, 'tok3n-' + seen.orders + '.thumbprint');
      await challengeRemoveFn({}, { token: 'tok3n-' + seen.orders });
      fs.writeFileSync(at('req.csr'), csr);
      fs.writeFileSync(at('san.ext'), `subjectAltName=DNS:${NAME}\n`);
      execFileSync('openssl', ['x509', '-req', '-in', at('req.csr'), '-CA', at('ca.crt'), '-CAkey', at('ca.key'), '-CAcreateserial', '-out', at('out.crt'), '-days', '3', '-extfile', at('san.ext')], { stdio: 'ignore' });
      return fs.readFileSync(at('out.crt'), 'utf8');
    }
  }
  return { Client, seen };
}
function memoryStore() {
  let value = null;
  return { read: async () => value && JSON.parse(JSON.stringify(value)), write: async v => { value = v; }, peek: () => value };
}
const answers = () => { const said = []; return { said, challenge: (t, a) => said.push(['challenge', t, a]), challengeGone: t => said.push(['gone', t]) }; };

test("a certificate is made here, answered through the relay, and kept", async () => {
  const store = memoryStore(), relay = answers(), { Client, seen } = authority();
  const cert = relayCert.create({ store, relay, Client, settleMs: 0 });
  assert.equal(cert.context(), null, 'nothing to open connections with before it');
  await cert.ensure(NAME);
  assert.ok(cert.context(), 'then browsers can be answered');
  assert.deepEqual(relay.said, [['challenge', 'tok3n-1', 'tok3n-1.thumbprint'], ['gone', 'tok3n-1']], 'the answer went through the relay and was taken back');
  const saved = store.peek();
  assert.match(saved.key, /BEGIN PRIVATE KEY|BEGIN EC PRIVATE KEY/, 'its private key, made here');
  assert.equal(saved.host, NAME);
  // A restart uses the saved one; asking again while it is fresh asks nobody.
  const again = relayCert.create({ store, relay, Client, settleMs: 0 });
  await again.ensure(NAME);
  await again.ensure(NAME);
  assert.equal(seen.orders, 1, 'no second request while it is fresh');
});

test("it is renewed after two thirds of its life, with the same account, and a failed renewal keeps the one in use", async () => {
  const store = memoryStore(), relay = answers();
  const first = authority();
  await relayCert.create({ store, relay, Client: first.Client, settleMs: 0 }).ensure(NAME);
  const until = relayCert.create({ store, relay, Client: first.Client, settleMs: 0 });
  await until.ensure(NAME);
  const end = until.until(), oldCert = store.peek().cert;
  // Two and a half days into three: due, but still good.
  const later = () => end - 12 * 3600 * 1000;
  const down = authority({ fail: true });
  const renewing = relayCert.create({ store, relay, Client: down.Client, settleMs: 0, now: later });
  await assert.rejects(renewing.ensure(NAME), /unreachable/);
  assert.ok(renewing.context(), 'the old one still answers browsers');
  const up = authority();
  const renewed = relayCert.create({ store, relay, Client: up.Client, settleMs: 0, now: later });
  await renewed.ensure(NAME);
  assert.equal(up.seen.orders, 1, 'renewed');
  assert.notEqual(store.peek().cert, oldCert, 'a new certificate, kept');
  assert.equal([...up.seen.accounts][0], store.peek().accountKey, 'the same Let\'s Encrypt account');
  // A different name (after a rename) gets its own certificate.
  const other = authority();
  await relayCert.create({ store, relay, Client: other.Client, settleMs: 0 }).ensure('quiet-isle-07.closedhand.test').catch(() => {});
  assert.equal(other.seen.orders, 1, 'a new name, a new certificate');
});
