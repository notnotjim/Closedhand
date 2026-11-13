// Starts the relay (relay.js) from its settings, and tells closedhand.com
// each minute which personal URLs have their computer connected, for "last
// online" on the insights page and for releasing names left unused.
//
//   RELAY_DOMAIN          closedhand.ai
//   RELAY_CONTROL_HOST    relay.closedhand.ai, the relay's own name
//   RELAY_CONTROL_KEY     its private key (PEM); the certificate is pinned by computers
//   RELAY_CONTROL_CERT    its certificate (PEM)
//   RELAY_PASS_KEY        closedhand.com's public key for passes (PEM)
//   RELAY_REPORT_URL      https://closedhand.com/jobs/relay-seen
//   RELAY_REPORT_SECRET   shared with closedhand.com for that report
//   PORT_TLS, PORT_HTTP   443 and 80 unless set
//   RELAY_PROXY_PROTOCOL  1 when the host's front door adds a PROXY header on
//                         port 443 (Fly.io), so browsers' addresses are known
const { createRelay } = require('./relay');

const env = process.env;
const need = name => { const v = String(env[name] || '').trim(); if (!v) { console.error(`[relay] ${name} is not set`); process.exit(1); } return v; };
const pem = v => v.replace(/\\n/g, '\n');

const relay = createRelay({
  domain: need('RELAY_DOMAIN'),
  controlHost: need('RELAY_CONTROL_HOST'),
  controlKey: pem(need('RELAY_CONTROL_KEY')),
  controlCert: pem(need('RELAY_CONTROL_CERT')),
  passKey: pem(need('RELAY_PASS_KEY')),
  proxied: env.RELAY_PROXY_PROTOCOL === '1',
  log: (what, host) => console.log(`[relay] ${what} ${host}`),
});
relay.front.listen(Number(env.PORT_TLS || 443), () => console.log('[relay] listening for https'));
relay.plain.listen(Number(env.PORT_HTTP || 80), () => console.log('[relay] listening for http'));

if (env.RELAY_REPORT_URL && env.RELAY_REPORT_SECRET) {
  setInterval(() => {
    fetch(env.RELAY_REPORT_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RELAY_REPORT_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connected: relay.connected() }),
      signal: AbortSignal.timeout(15000),
    }).then(r => (r.ok ? r.json() : null)).then(answer => { if (Array.isArray(answer?.drop)) relay.drop(answer.drop); })
      .catch(e => console.error('[relay] report failed:', e.message));
  }, 60000).unref();
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { relay.close(); process.exit(0); });
