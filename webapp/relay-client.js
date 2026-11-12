// This computer's side of the relay (relay/relay.js) that gives Closedhand
// its personal URL. Closedhand keeps one connection open to the relay,
// checking the relay's certificate against the one closedhand.com named, and
// proves with this computer's own key that the pass closedhand.com made for
// its personal URL is its own. For each browser that opens the personal URL
// the relay asks for a connection back; the browser's encrypted bytes arrive
// on it as they left the browser, and the encryption ends here, with this
// computer's certificate (relay-cert.js), so nobody on the way can read them.
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const RETRY_MS = [1000, 5000, 15000, 30000, 60000];
// When a pass from closedhand.com runs out, read from the pass itself.
const passExpiry = pass => { try { return Number(JSON.parse(Buffer.from(String(pass).split('.')[0], 'base64url').toString('utf8')).e) || 0; } catch (_) { return 0; } };

// The SHA-256 of a certificate as the relay presents it, to pin it.
const pinOf = cert => crypto.createHash('sha256').update(cert.raw).digest('base64url');

function dialRelay({ address, controlHost, pin }) {
  const [host, port] = address.split(':');
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: Number(port || 443), servername: controlHost, minVersion: 'TLSv1.3', rejectUnauthorized: false, checkServerIdentity: () => undefined });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(true);
      if (!cert || !cert.raw || pinOf(cert) !== pin) { socket.destroy(); reject(new Error('the relay is not the one closedhand.com named')); return; }
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

function readLines(socket, onLine) {
  let buf = '';
  const onData = chunk => {
    buf += chunk.toString('utf8');
    if (buf.length > 16 * 1024) { socket.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { onLine(JSON.parse(line)); } catch (_) { socket.destroy(); return; }
    }
  };
  socket.on('data', onData);
}
const send = (socket, msg) => { if (socket && !socket.destroyed) socket.write(JSON.stringify(msg) + '\n'); };

// connect({ relay: { address, controlHost, pin }, pass, privateKey, publicKey })
// keeps the connection to the relay up until stop(). Emits 'up' (host),
// 'down' (error) and 'stream' (socket, from): a browser's still-encrypted
// connection, and the address it came from.
function create({ relay, getPass, privateKey, publicKey }) {
  const events = new EventEmitter();
  let control = null, stopped = false, attempt = 0, retryTimer = null, renewTimer = null;
  // A fresh pass on the open connection when half the current one's time is
  // gone, so the personal URL never drops for it.
  function renewLater(pass) {
    clearTimeout(renewTimer);
    const left = passExpiry(pass) - Date.now();
    if (left <= 0) return;
    renewTimer = setTimeout(async () => {
      try { const next = await getPass(); send(control, { renew: next }); renewLater(next); }
      catch (_) { renewTimer = setTimeout(() => renewLater(pass), 60000); renewTimer.unref?.(); }
    }, Math.max(50, Math.min(left / 2, 2 ** 31 - 1)));
    renewTimer.unref?.();
  }
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');

  async function open() {
    if (stopped) return;
    let socket;
    try {
      const pass = await getPass();
      socket = await dialRelay(relay);
      control = socket;
      socket.setKeepAlive(true, 30000);
      await new Promise((resolve, reject) => {
        let up = false;
        socket.once('close', () => { if (!up) reject(new Error('the relay closed the connection')); else { events.emit('down', new Error('the relay connection closed')); retry(); } });
        socket.on('error', () => {});
        readLines(socket, msg => {
          if (msg.nonce) send(socket, { proof: crypto.sign(null, Buffer.from('closedhand-relay:' + msg.nonce), privateKey).toString('base64url') });
          else if (msg.ok) { up = true; attempt = 0; renewLater(pass); events.emit('up', msg.host); resolve(); }
          else if (msg.error) reject(new Error('the relay refused: ' + msg.error));
          else if (msg.ping) send(socket, { pong: msg.ping });
          else if (typeof msg.open === 'string') stream(msg.open, String(msg.from || ''));
        });
        send(socket, { hello: { pass, key: pub } });
      });
    } catch (e) {
      if (socket) socket.destroy();
      control = null;
      events.emit('down', e);
      retry();
    }
  }
  function retry() {
    if (stopped || retryTimer) return;
    control = null;
    const wait = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)];
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, wait);
    retryTimer.unref?.();
  }
  async function stream(id, from) {
    try {
      const socket = await dialRelay(relay);
      socket.write(JSON.stringify({ stream: id }) + '\n');
      events.emit('stream', socket, from);
    } catch (_) { /* the browser's connection closes at the relay */ }
  }

  return Object.assign(events, {
    start() { stopped = false; open(); return events; },
    stop() { stopped = true; clearTimeout(retryTimer); clearTimeout(renewTimer); retryTimer = null; if (control) control.destroy(); control = null; },
    // Let's Encrypt's check for this computer's certificate, answered by the relay.
    challenge(token, answer) { send(control, { challenge: { token, answer } }); },
    challengeGone(token) { send(control, { challengeGone: token }); },
    up: () => !!control,
  });
}

// Browsers' connections, opened here with this computer's certificate and
// handed to Closedhand's web server as ordinary https requests. The address
// each came from goes with it (relayFrom), for sign-in limits and logs.
function terminate({ server, secureContext }) {
  return (socket, from) => {
    socket.on('error', () => {});
    const context = secureContext();
    if (!context) { socket.destroy(); return; }
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: ['http/1.1'] });
    secure.relayFrom = from;
    secure.on('error', () => secure.destroy());
    secure.once('secure', () => server.emit('connection', secure));
  };
}

module.exports = { create, terminate, pinOf, dialRelay };
