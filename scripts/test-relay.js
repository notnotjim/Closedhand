// The relay for personal URLs (relay/) and this computer's side of it
// (webapp/relay-client.js), run together: a browser's connection reaches the
// computer through the relay still encrypted, the relay never sees a readable
// byte of it, only the computer a pass was made for can take a personal URL,
// and Let's Encrypt's checks are answered for the computer. Invented names
// and keys only.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const http = require('node:http'), https = require('node:https'), tls = require('node:tls'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { createRelay } = require('../relay/relay');
const { serverName } = require('../relay/sni');
const { proxyHeader } = require('../relay/proxy');
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
function startComputer({ key = computer, getPass = async () => pass({ key: key.publicKey }), relayPin = pin, port = FRONT } = {}) {
  const c = relayClient.create({ relay: { address: '127.0.0.1:' + port, controlHost: CONTROL, pin: relayPin }, getPass, privateKey: key.privateKey, publicKey: key.publicKey });
  c.on('stream', relayClient.terminate({ server: site, secureContext: () => tls.createSecureContext({ key: read('site.key'), cert: read('site.crt') }) }));
  clients.push(c);
  return c;
}
const once = (em, ev) => new Promise(r => em.once(ev, (...a) => r(a)));
function browse(name = NAME, body = '', port = FRONT) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, servername: name, ca: read('ca.crt'), path: '/', method: body ? 'POST' : 'GET', agent: false }, res => {
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

test("a pass is renewed on the open connection before it ends, and the relay lets a computer go when its pass does", async () => {
  await ready;
  let fresh = 0;
  const renewing = startComputer({ getPass: async () => pass({ e: Date.now() + (fresh++ ? 3600000 : 400) }) });
  await once(renewing.start(), 'up');
  await new Promise(r => setTimeout(r, 700));
  assert.ok(relay.connected().includes(NAME), 'still connected past its first pass');
  assert.ok(fresh >= 2, 'with a fresh one from closedhand.com');
  renewing.stop();
  await new Promise(r => setTimeout(r, 50));
  let first = true;
  const stale = startComputer({ getPass: async () => { if (first) { first = false; return pass({ h: 'stale-owl-11.closedhand.test', e: Date.now() + 400 }); } throw new Error('closedhand.com unreachable'); } });
  await once(stale.start(), 'up');
  const [err] = await once(stale, 'down');
  assert.match(err.message, /closed/, 'let go when its pass ended');
  stale.stop();
});

test("a computer a personal URL moved away from can't take it back with its older pass, and a name that belongs to nobody is let go", async () => {
  await ready;
  const moved = crypto.generateKeyPairSync('ed25519');
  // The new computer has the newer pass; the old one still holds an older one.
  const fresh = startComputer({ key: moved, getPass: async () => pass({ key: moved.publicKey, e: Date.now() + 7200000 }) });
  await once(fresh.start(), 'up');
  const old = startComputer({ getPass: async () => pass({ e: Date.now() + 3600000 }) });
  const [err] = await once(old.start(), 'down');
  assert.match(err.message, /newer pass/, 'refused');
  old.stop();
  assert.deepEqual(relay.connected(), [NAME], 'the new computer keeps it');
  relay.drop([NAME]);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(relay.connected(), [], 'let go when closedhand.com says it belongs to nobody');
  fresh.stop();
  assert.match(fs.readFileSync(path.join(__dirname, '../relay/main.js'), 'utf8'), /relay\.drop\(answer\.drop\)/, "closedhand.com's answer to each report is acted on");
});

test("behind a front door that says where each connection came from (Fly.io's PROXY header), the computer gets the browser's address", async () => {
  // The header, read on its own.
  const v1 = Buffer.from('PROXY TCP4 203.0.113.9 10.0.0.1 51000 443\r\n');
  assert.deepEqual(proxyHeader(v1), { from: '203.0.113.9', length: v1.length });
  assert.deepEqual(proxyHeader(v1.subarray(0, 12)), { need: true });
  const v2 = (fam, src) => {
    const addr = fam === 0x11 ? Buffer.concat([Buffer.from(src), Buffer.from([10, 0, 0, 1]), Buffer.from([0xc7, 0x38, 0x01, 0xbb])]) : Buffer.concat([src, Buffer.alloc(16), Buffer.from([0xc7, 0x38, 0x01, 0xbb])]);
    const head = Buffer.from('0d0a0d0a000d0a515549540a2100', 'hex'); head[13] = fam;
    const len = Buffer.alloc(2); len.writeUInt16BE(addr.length);
    return Buffer.concat([head, len, addr]);
  };
  assert.deepEqual(proxyHeader(v2(0x11, [198, 51, 100, 7])), { from: '198.51.100.7', length: 28 });
  assert.equal(proxyHeader(v2(0x21, Buffer.from('20010db8000000000000000000000042', 'hex'))).from, '2001:db8:0:0:0:0:0:42');
  const local = Buffer.from('0d0a0d0a000d0a515549540a20000000', 'hex');
  assert.deepEqual(proxyHeader(local), { from: null, length: 16 }, "the front door's own check");
  assert.deepEqual(proxyHeader(v2(0x11, [198, 51, 100, 7]).subarray(0, 20)), { need: true });
  assert.ok(proxyHeader(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00])).error, 'a browser straight in, with no header: refused');

  // A relay behind a stand-in for Fly's front door, which adds the header.
  const behind = createRelay({ domain: DOMAIN, controlHost: CONTROL, controlKey: read('control.key'), controlCert: read('control.crt'), passKey: issuer.publicKey, proxied: true });
  await new Promise(r => behind.front.listen(0, '127.0.0.1', r));
  const door = net.createServer(c => {
    const up = net.connect(behind.front.address().port, '127.0.0.1', () => { up.write(v2(0x11, [198, 51, 100, 7])); c.pipe(up).pipe(c); });
    c.on('error', () => up.destroy()); up.on('error', () => c.destroy());
  });
  await new Promise(r => door.listen(0, '127.0.0.1', r));
  const c = startComputer({ port: door.address().port });
  await once(c.start(), 'up');
  const got = await browse(NAME, 'hello', door.address().port);
  assert.equal(got.body, 'hello');
  assert.equal(got.from, '198.51.100.7', "the browser's address, from the header");
  assert.equal(got.secure, true);
  await assert.rejects(browse(NAME, '', behind.front.address().port), 'a connection without the header is closed');
  c.stop(); behind.close(); door.close();
});
