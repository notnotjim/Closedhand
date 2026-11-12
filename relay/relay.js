// The relay between the internet and each person's computer, for personal
// URLs (<name>.closedhand.ai). A browser's connection to a personal URL is
// passed to that person's computer still encrypted: the relay reads only the
// name the browser asks for (sni.js) and holds no key for it, so nobody
// between the browser and the computer, the relay's operator included, can
// read what passes. The encryption ends inside Closedhand on the computer,
// with the computer's own certificate.
//
// Each computer keeps one connection to the relay open from its side (it is
// usually behind a home router), to the relay's own name, which the relay
// does end itself with its own certificate, pinned by the computer. On it the
// computer shows a pass from closedhand.com naming its personal URL and the
// public key the pass is for, and signs the relay's nonce with that key, so a
// pass is useless without the computer it was made for. For each browser
// connection the relay asks for a data connection, the computer opens one
// back with the id it was given, and the relay joins the two.
//
// Port 80 answers Let's Encrypt's checks for a computer's certificate with
// the answers its computer registered (they are public by design), and sends
// everything else to https.
const net = require('net');
const tls = require('tls');
const http = require('http');
const crypto = require('crypto');
const { Duplex } = require('stream');
const { serverName } = require('./sni');

const PERSONAL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HELLO_WITHIN_MS = 10000;
const DIAL_WITHIN_MS = 10000;
const PING_EVERY_MS = 25000;
const MAX_WAITING_PER_NAME = 64;
const MAX_LINE = 16 * 1024;

const b64u = buf => Buffer.from(buf).toString('base64url');

// A pass from closedhand.com: base64url(JSON { h: hostname, k: base64url of
// the computer's raw Ed25519 public key, e: expiry in ms }) "." base64url of
// closedhand.com's Ed25519 signature over the first part.
function readPass(pass, passKey, now = Date.now()) {
  const [body, sig] = String(pass || '').split('.');
  if (!body || !sig) return null;
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(body), passKey, Buffer.from(sig, 'base64url')); } catch (_) { return null; }
  if (!ok) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!claims || typeof claims.h !== 'string' || typeof claims.k !== 'string' || !(claims.e > now)) return null;
  return claims;
}

function rawKey(k) {
  const raw = Buffer.from(k, 'base64url');
  if (raw.length !== 32) throw new Error('not an Ed25519 key');
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}

// Lines of JSON on a socket, at most MAX_LINE each; stops at the first line
// whose handler returns 'raw', leaving the rest of the socket to the caller.
function lines(socket, onLine) {
  let buf = '';
  const onData = chunk => {
    buf += chunk.toString('utf8');
    if (buf.length > MAX_LINE) { socket.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch (_) { socket.destroy(); return; }
      if (onLine(msg) === 'raw') {
        socket.removeListener('data', onData);
        if (buf) socket.unshift(Buffer.from(buf, 'utf8'));
        return;
      }
    }
  };
  socket.on('data', onData);
}
const send = (socket, msg) => { if (!socket.destroyed) socket.write(JSON.stringify(msg) + '\n'); };

// A connection whose first bytes were already read (to learn its name), as a
// stream that gives them again first. TLS reads a plain socket straight from
// the network, so bytes read before it would otherwise be lost.
function replaying(socket, first) {
  const d = new Duplex({
    read() { socket.resume(); },
    write(chunk, enc, cb) { socket.write(chunk, enc, cb); },
    final(cb) { socket.end(); cb(); },
    destroy(err, cb) { socket.destroy(); cb(err); },
  });
  d.push(first);
  socket.on('data', chunk => { if (!d.push(chunk)) socket.pause(); });
  socket.on('end', () => d.push(null));
  socket.on('close', () => d.destroy());
  socket.on('error', () => d.destroy());
  d.remoteAddress = socket.remoteAddress;
  return d;
}

function createRelay({ domain, controlHost, controlKey, controlCert, passKey, log = () => {}, now = () => Date.now() }) {
  const suffix = '.' + domain;
  const passPublic = typeof passKey === 'string' ? crypto.createPublicKey(passKey) : passKey;
  const computers = new Map(); // hostname -> { socket, challenges: Map(token -> answer) }
  // The newest pass seen for each name: closedhand.com gives the computer
  // that has a personal URL now a newer pass than any before, so a computer
  // it moved away from can't take it back with the one it still holds.
  const newest = new Map(); // hostname -> expiry of the newest pass
  const waiting = new Map(); // stream id -> { host, socket, hello, from, timer }

  // A personal URL: one name under the domain, never the relay's own.
  const personal = name => name !== controlHost && name.endsWith(suffix) && PERSONAL.test(name.slice(0, -suffix.length));

  // The relay's own name: control and data connections from computers.
  const control = tls.createServer({ key: controlKey, cert: controlCert, minVersion: 'TLSv1.3' }, socket => {
    let state = 'start', nonce = null, claims = null, key = null;
    socket.setTimeout(PING_EVERY_MS * 3, () => socket.destroy());
    socket.on('error', () => {});
    lines(socket, msg => {
      if (state === 'start' && msg.hello) {
        claims = readPass(msg.hello.pass, passPublic, now());
        if (!claims || !personal(claims.h) || msg.hello.key !== claims.k) { send(socket, { error: 'pass refused' }); socket.end(); return; }
        if (claims.e < (newest.get(claims.h) || 0)) { send(socket, { error: 'a newer pass holds this name' }); socket.end(); return; }
        try { key = rawKey(claims.k); } catch (_) { socket.destroy(); return; }
        nonce = crypto.randomBytes(32).toString('hex');
        state = 'proving';
        send(socket, { nonce });
        return;
      }
      if (state === 'proving' && typeof msg.proof === 'string') {
        let ok = false;
        try { ok = crypto.verify(null, Buffer.from('closedhand-relay:' + nonce), key, Buffer.from(msg.proof, 'base64url')); } catch (_) { /* refused below */ }
        if (!ok) { send(socket, { error: 'proof refused' }); socket.end(); return; }
        state = 'open';
        const before = computers.get(claims.h);
        if (before) before.socket.destroy();
        const entry = { socket, challenges: new Map(), since: now(), timer: null };
        // A pass ends when it says: the computer renews it on this connection
        // before then (renew, below), or the relay lets it go.
        const until = expires => { clearTimeout(entry.timer); entry.timer = setTimeout(() => socket.destroy(), Math.min(Math.max(0, expires - now()), 2 ** 31 - 1)); };
        entry.until = until;
        until(claims.e);
        newest.set(claims.h, Math.max(newest.get(claims.h) || 0, claims.e));
        computers.set(claims.h, entry);
        socket.on('close', () => { clearTimeout(entry.timer); if (computers.get(claims.h) === entry) computers.delete(claims.h); });
        log('connected', claims.h);
        send(socket, { ok: true, host: claims.h });
        return;
      }
      if (state === 'open') {
        const entry = computers.get(claims.h);
        if (!entry || entry.socket !== socket) return;
        if (typeof msg.renew === 'string') {
          const next = readPass(msg.renew, passPublic, now());
          if (next && next.h === claims.h && next.k === claims.k) { claims = next; entry.until(next.e); newest.set(claims.h, Math.max(newest.get(claims.h) || 0, next.e)); send(socket, { renewed: next.e }); }
          else send(socket, { error: 'renewal refused' });
          return;
        }
        if (msg.challenge && typeof msg.challenge.token === 'string' && typeof msg.challenge.answer === 'string'
          && /^[A-Za-z0-9_-]{8,128}$/.test(msg.challenge.token) && msg.challenge.answer.length <= 512) {
          if (entry.challenges.size < 20) entry.challenges.set(msg.challenge.token, msg.challenge.answer);
        } else if (typeof msg.challengeGone === 'string') entry.challenges.delete(msg.challengeGone);
        return;
      }
      if (state === 'start' && typeof msg.stream === 'string') {
        // A data connection for a browser that is waiting.
        const w = waiting.get(msg.stream);
        if (!w) { socket.destroy(); return; }
        waiting.delete(msg.stream);
        clearTimeout(w.timer);
        state = 'data';
        socket.setTimeout(0);
        socket.write(w.hello);
        w.socket.pipe(socket).pipe(w.socket);
        w.socket.resume();
        const close = () => { w.socket.destroy(); socket.destroy(); };
        w.socket.on('close', close); socket.on('close', close);
        return 'raw';
      }
      socket.destroy();
    });
  });
  control.on('tlsClientError', () => {});

  // Port 443: every connection, read just far enough to learn its name.
  const front = net.createServer(socket => {
    socket.on('error', () => {});
    let buf = Buffer.alloc(0), done = false;
    const timer = setTimeout(() => socket.destroy(), HELLO_WITHIN_MS);
    const onData = chunk => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      const found = serverName(buf);
      if (found.need) return;
      done = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.pause();
      if (found.error) { socket.destroy(); return; }
      if (found.name === controlHost) {
        control.emit('connection', replaying(socket, buf));
        return;
      }
      const entry = personal(found.name) && computers.get(found.name);
      if (!entry) { socket.destroy(); return; }
      const mine = [...waiting.values()].filter(w => w.host === found.name).length;
      if (mine >= MAX_WAITING_PER_NAME) { socket.destroy(); return; }
      const id = b64u(crypto.randomBytes(18));
      const w = { host: found.name, socket, hello: buf, from: socket.remoteAddress, timer: setTimeout(() => { waiting.delete(id); socket.destroy(); }, DIAL_WITHIN_MS) };
      waiting.set(id, w);
      socket.on('close', () => { if (waiting.get(id) === w) { clearTimeout(w.timer); waiting.delete(id); } });
      send(entry.socket, { open: id, from: String(socket.remoteAddress || '').replace(/^::ffff:/, '') });
    };
    socket.on('data', onData);
  });

  // Port 80: Let's Encrypt's checks, and the way to https for everything else.
  const plain = http.createServer((req, res) => {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{8,128})$/.exec(req.url || '');
    if (m) {
      const answer = personal(host) && computers.get(host)?.challenges.get(m[1]);
      if (!answer) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(answer);
      return;
    }
    if (!personal(host) && host !== domain) { res.writeHead(404).end(); return; }
    res.writeHead(301, { Location: 'https://' + host + (String(req.url || '/').startsWith('/') ? req.url : '/') }).end();
  });

  // Ping every computer now and then, so a connection that died quietly is noticed.
  const pinger = setInterval(() => { for (const c of computers.values()) send(c.socket, { ping: now() }); }, PING_EVERY_MS);
  pinger.unref?.();

  return {
    front, plain, control,
    // The personal URLs whose computers are connected now.
    connected: () => [...computers.keys()],
    // Names closedhand.com says belong to nobody now: their computers are let go.
    drop(names) { for (const n of names || []) { const c = computers.get(n); if (c) { c.socket.destroy(); console.log(`[relay] dropped ${n}`); } } },
    close() { clearInterval(pinger); front.close(); plain.close(); for (const c of computers.values()) c.socket.destroy(); for (const w of waiting.values()) w.socket.destroy(); },
  };
}

module.exports = { createRelay, readPass, rawKey };
