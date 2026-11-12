// The relay for personal URLs (relay/) and this computer's side of it
// (webapp/relay-client.js), run together: a browser's connection reaches the
// computer through the relay still encrypted, the relay never sees a readable
// byte of it, only the computer a pass was made for can take a personal URL,
// and Let's Encrypt's checks are answered for the computer. Invented names
// and keys only.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const http = require('node:http'), https = require('node:https'), tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const { createRelay } = require('../relay/relay');
const { serverName } = require('../relay/sni');
const relayClient = require('../webapp/relay-client');

const DOMAIN = 'closedhand.test', CONTROL = 'relay.closedhand.test', NAME = 'amber-fox-42.closedhand.test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
const ssl = (...args) => execFileSync('openssl', args, { stdio: 'ignore' });
const at = f => path.join(dir, f);
// The relay's own certificate, pinned by computers; and a CA and a
// certificate for the personal URL standing in for Let's Encrypt's.
ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', at('control.key'), '-out', at('control.crt'), '-days', '1', '-subj', '/CN=' + CONTROL);
ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', at('ca.key'), '-out', at('ca.crt'), '-days', '1', '-subj', '/CN=Test CA');
ssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', at('site.key'), '-out', at('site.csr'), '-subj', '/CN=' + NAME);
fs.writeFileSync(at('san.ext'), `subjectAltName=DNS:${NAME}\n`);
ssl('x509', '-req', '-in', at('site.csr'), '-CA', at('ca.crt'), '-CAkey', at('ca.key'), '-CAcreateserial', '-out', at('site.crt'), '-days', '1', '-extfile', at('san.ext'));
const read = f => fs.readFileSync(at(f));

// closedhand.com's key for passes, and each computer's own key.
const issuer = crypto.generateKeyPairSync('ed25519');
const computer = crypto.generateKeyPairSync('ed25519');
const rawPub = k => k.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
function pass({ h = NAME, key = computer.publicKey, e = Date.now() + 3600000, by = issuer.privateKey } = {}) {
  const body = Buffer.from(JSON.stringify({ h, k: rawPub(key), e })).toString('base64url');
  return body + '.' + crypto.sign(null, Buffer.from(body), by).toString('base64url');
}

// What the relay's process sees: every byte from browsers, and every byte
// computers send it inside its own connection.
const seen = [];
const relay = createRelay({ domain: DOMAIN, controlHost: CONTROL, controlKey: read('control.key'), controlCert: read('control.crt'), passKey: issuer.publicKey });
relay.front.on('connection', s => s.on('data', d => seen.push(Buffer.from(d))));
relay.control.on('secureConnection', s => s.on('data', d => seen.push(Buffer.from(d))));
let FRONT, PLAIN;
const ready = Promise.all([
  new Promise(r => relay.front.listen(0, '127.0.0.1', () => { FRONT = relay.front.address().port; r(); })),
  new Promise(r => relay.plain.listen(0, '127.0.0.1', () => { PLAIN = relay.plain.address().port; r(); })),
]);
const pin = relayClient.pinOf(new crypto.X509Certificate(read('control.crt')));
const clients = [];
after(() => { for (const c of clients) c.stop(); relay.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// The computer: Closedhand's web server, reached only through the relay.
const site = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => res.end(JSON.stringify({ from: req.socket.relayFrom, secure: !!req.socket.encrypted, body })));
});
function startComputer({ key = computer, getPass = async () => pass({ key: key.publicKey }), relayPin = pin } = {}) {
  const c = relayClient.create({ relay: { address: '127.0.0.1:' + FRONT, controlHost: CONTROL, pin: relayPin }, getPass, privateKey: key.privateKey, publicKey: key.publicKey });
  c.on('stream', relayClient.terminate({ server: site, secureContext: () => tls.createSecureContext({ key: read('site.key'), cert: read('site.crt') }) }));
  clients.push(c);
  return c;
}
const once = (em, ev) => new Promise(r => em.once(ev, (...a) => r(a)));
function browse(name = NAME, body = '') {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: FRONT, servername: name, ca: read('ca.crt'), path: '/', method: body ? 'POST' : 'GET', agent: false }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test("the name is read from a browser's first bytes, and nothing else", () => {
  const hello = [];
  const server = tls.createServer({ key: read('site.key'), cert: read('site.crt') });
  server.emit = () => true;
  const sock = tls.connect({ servername: NAME, socket: new (require('node:stream').Duplex)({ read() {}, write(chunk, enc, cb) { hello.push(chunk); cb(); } }) });
  sock.on('error', () => {});
  const first = Buffer.concat(hello);
  assert.deepEqual(serverName(first), { name: NAME });
  assert.deepEqual(serverName(first.subarray(0, 20)), { need: true }, 'waits for the rest');
  assert.ok(serverName(Buffer.from('GET / HTTP/1.1\r\n\r\n')).error, 'not TLS: refused');
  sock.destroy();
});

test("a browser reaches the computer through the relay, encrypted end to end, and the relay sees nothing readable", async () => {
  await ready;
  const c = startComputer();
  const [host] = await once(c.start(), 'up');
  assert.equal(host, NAME);
  const secret = 'Mira booked the 14:05 to Kestrel Point ' + crypto.randomBytes(8).toString('hex');
  const got = await browse(NAME, secret);
  assert.equal(got.body, secret, 'the computer read it');
  assert.equal(got.secure, true, 'over TLS that ended on the computer');
  assert.equal(got.from, '127.0.0.1', "with the browser's address");
  const all = Buffer.concat(seen);
  assert.equal(all.indexOf(secret), -1, 'the relay never saw it');
  assert.equal(all.indexOf('Kestrel Point'), -1);
  assert.equal(all.indexOf('"body"'), -1, 'nor the reply');
  assert.deepEqual(relay.connected(), [NAME]);
  c.stop();
});

test("only the computer a pass was made for can take its personal URL", async () => {
  await ready;
  const other = crypto.generateKeyPairSync('ed25519');
  const forged = crypto.generateKeyPairSync('ed25519');
  const refused = async (opts, why) => {
    const c = startComputer(opts);
    const [err] = await once(c.start(), 'down');
    assert.match(String(err.message), /refused|closed/, why);
    c.stop();
  };
  await refused({ key: other, getPass: async () => pass() }, "someone else's pass, without its key");
  await refused({ getPass: async () => pass({ by: forged.privateKey }) }, 'a pass closedhand.com did not sign');
  await refused({ getPass: async () => pass({ e: Date.now() - 1000 }) }, 'an expired pass');
  await refused({ getPass: async () => pass({ h: 'relay.closedhand.test' }) }, "the relay's own name");
  await refused({ getPass: async () => pass({ h: 'amber-fox-42.elsewhere.test' }) }, 'a name outside the domain');
  const c = startComputer({ relayPin: 'not-the-relay' });
  const [err] = await once(c.start(), 'down');
  assert.match(err.message, /not the one closedhand.com named/, 'a computer only talks to the relay it was told of');
  c.stop();
});

test("Let's Encrypt's check is answered for the computer, and plain http goes to https", async () => {
  await ready;
  const c = startComputer();
  await once(c.start(), 'up');
  c.challenge('tok3n-abcdef', 'tok3n-abcdef.thumbprint');
  await new Promise(r => setTimeout(r, 50));
  const get = (host, p) => new Promise(resolve => http.get({ host: '127.0.0.1', port: PLAIN, path: p, headers: { Host: host } }, res => {
    let t = ''; res.on('data', d => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, body: t, location: res.headers.location }));
  }));
  assert.deepEqual(await get(NAME, '/.well-known/acme-challenge/tok3n-abcdef'), { status: 200, body: 'tok3n-abcdef.thumbprint', location: undefined });
  assert.equal((await get('quiet-isle-07.closedhand.test', '/.well-known/acme-challenge/tok3n-abcdef')).status, 404, "only for that computer's own name");
  assert.equal((await get(NAME, '/dashboard')).location, `https://${NAME}/dashboard`);
  c.challengeGone('tok3n-abcdef');
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await get(NAME, '/.well-known/acme-challenge/tok3n-abcdef')).status, 404, 'gone once done');
  c.stop();
});

test("a name whose computer isn't connected is closed, not answered", async () => {
  await ready;
  await assert.rejects(browse('quiet-isle-07.closedhand.test'));
});
