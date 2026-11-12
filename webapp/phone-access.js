// The personal URL. Closedhand keeps a connection open to the relay
// (relay-client.js) with a pass from closedhand.com for this computer's own
// key, holds its own certificate for the address (relay-cert.js), and
// answers the browsers that open it with the dashboard. Their encryption ends
// here, so nobody between, the relay included, can read what passes.
const crypto = require("crypto");
const { getConf, getConfStrict, setConf } = require("./config");
const { encryptString, decryptString } = require("./crypto-tokens");
const relayClient = require("./relay-client");
const relayCert = require("./relay-cert");

let server = null, client = null, cert = null, url = null, wanted = false, state = "off", lastError = null;
let retryTimer = null, renewTimer = null, healthTimer = null, generation = 0, pairingUrl = null;
// Keep an old publication from landing after a disable or restart clears it.
let writes = Promise.resolve();
function save(patch) {
  writes = writes.catch(() => {}).then(() => setConf(patch));
  return writes;
}
function sealed(value) {
  const result = encryptString(value);
  if (!result?.startsWith("enc:v1:")) throw new Error("Your personal URL needs encrypted storage. Check Closedhand’s settings.");
  return result;
}
async function requirePassword() {
  if (!process.env.ADMIN_PASSWORD && !(await getConf("DASHBOARD_PASSWORD_HASH"))) {
    throw new Error("Choose a dashboard password on the setup page before claiming your personal URL.");
  }
}
// This computer's own key for the relay, made once and kept sealed: a pass
// from closedhand.com is good only with it.
async function identity() {
  let pem = decryptString(await getConf("PHONE_RELAY_KEY"));
  if (!pem) {
    pem = crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
    await setConf({ PHONE_RELAY_KEY: sealed(pem) });
  }
  const privateKey = crypto.createPrivateKey(pem), publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, raw: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url") };
}
// The certificate and its key, kept sealed.
const certStore = {
  read: async () => { try { return JSON.parse(decryptString(await getConf("PHONE_TLS")) || "null"); } catch (_) { return null; } },
  write: async (value) => { await setConf({ PHONE_TLS: sealed(JSON.stringify(value)) }); },
};
// The web server browsers' connections are handed to once opened (server.js).
function useServer(s) { server = s; }

function stopClient() {
  clearInterval(renewTimer); clearInterval(healthTimer); renewTimer = healthTimer = null;
  const c = client; client = null;
  if (c) c.stop();
}
function later(fn, ms) { clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (wanted) void fn(); }, ms); retryTimer.unref?.(); }

async function start() {
  if (client || state === "starting") return;
  const run = ++generation;
  state = "starting"; url = null; lastError = null;
  try {
    await save({ PHONE_ACCESS_URL: null });
    await requirePassword();
    const registration = require("./phone-registration");
    const me = await identity();
    const permanent = await registration.connection({ key: me.raw });
    if (run !== generation || !wanted) return;
    if (!permanent) {
      const confirmed = registration.status().ownershipConfirmed;
      state = confirmed ? "provisioning" : "pairing";
      const nextPairingUrl = confirmed ? null : pairingUrl || await registration.begin();
      if (run !== generation || !wanted) return;
      pairingUrl = nextPairingUrl;
      later(start, 5000);
      return;
    }
    pairingUrl = null;
    const host = new URL(permanent.url).hostname;
    let first = permanent.pass;
    const c = relayClient.create({
      relay: permanent.relay,
      // The pass just made first; then a fresh one each time one is needed.
      getPass: async () => {
        if (first) { const pass = first; first = null; return pass; }
        const next = await registration.connection({ key: me.raw });
        if (!next) throw new Error("This personal URL is no longer this computer’s.");
        return next.pass;
      },
      privateKey: me.privateKey, publicKey: me.publicKey,
    });
    client = c;
    cert = relayCert.create({ store: certStore, relay: c });
    c.on("stream", (socket, from) => {
      if (!server) { socket.destroy(); return; }
      relayClient.terminate({ server, secureContext: () => cert.context() })(socket, from);
    });
    c.on("up", () => { if (client === c) void ready(c, permanent, host, run); });
    c.on("down", () => { if (client === c && state === "on") { state = "starting"; lastError = "Reconnecting your personal URL."; } });
    c.start();
  } catch (e) {
    if (run !== generation) return;
    state = "error"; lastError = e.message;
    console.error("[Phone]", lastError);
    // While it is wanted, keep trying: a database or network hiccup at the
    // wrong moment must not leave the personal URL off until a restart.
    if (wanted && !client) later(start, 15000);
  }
}

// Connected to the relay: make sure of the certificate (the first one takes
// a few seconds from Let's Encrypt), have closedhand.com check this computer
// answers at the address, then publish it.
let certWait = 0;
async function ready(c, permanent, host, run) {
  try {
    await cert.ensure(host);
    if (client !== c || run !== generation) return;
    if (permanent.verify) { await require("./phone-registration").confirm(permanent); permanent.verify = false; }
    await save({ PHONE_ACCESS_URL: permanent.url });
    if (client !== c) return;
    url = permanent.url; state = "on"; lastError = null; certWait = 0;
    console.log(`[Phone] dashboard reachable at ${url}`);
    // The certificate renews itself when due, checked twice a day.
    clearInterval(renewTimer);
    renewTimer = setInterval(() => { cert.ensure(host).catch((e) => console.error("[Phone] certificate renewal:", e.message)); }, 12 * 3600 * 1000);
    renewTimer.unref?.();
    watch(c);
  } catch (e) {
    if (client !== c) return;
    state = "starting"; lastError = "Waiting to verify this computer’s address.";
    console.error("[Phone]", e.message);
    // Let's Encrypt allows only a few failed checks an hour: wait longer each time.
    const wait = [60000, 5 * 60000, 15 * 60000, 30 * 60000][Math.min(certWait++, 3)];
    setTimeout(() => { if (client === c && wanted) void ready(c, permanent, host, run); }, wait).unref?.();
  }
}
// Checked from outside each minute, the way a phone reaches it: three misses
// in a row and the connection is made again.
function watch(c) {
  clearInterval(healthTimer);
  let checking = false, failures = 0;
  healthTimer = setInterval(async () => {
    if (client !== c || !url || checking) return;
    checking = true;
    try {
      const response = await fetch(url + "/health", { signal: AbortSignal.timeout(10000) });
      const health = response.ok ? await response.json() : null;
      if (health?.status !== "ok" || health?.service !== "closedhand-webapp") throw new Error("Your personal URL is unreachable");
      failures = 0;
    } catch (_) {
      if (client !== c) return;
      if (++failures >= 3) {
        lastError = "Your personal URL stopped responding. Reconnecting.";
        stopClient(); url = null; state = "off";
        save({ PHONE_ACCESS_URL: null }).catch(() => {});
        later(start, 5000);
      }
    } finally { checking = false; }
  }, 60000);
  healthTimer.unref?.();
}

async function enable() {
  await requirePassword();
  await save({ PHONE_ACCESS: "1", PHONE_ACCESS_MODE: "managed" });
  wanted = true;
  await start();
}
async function disable() {
  wanted = false; ++generation;
  clearTimeout(retryTimer);
  stopClient();
  url = null; state = "off"; lastError = null; pairingUrl = null;
  await save({ PHONE_ACCESS: null, PHONE_ACCESS_URL: null });
}
// After a rename: drop the connection at the old name and connect again, so
// this computer takes the new one with a pass and a certificate for it.
async function reconnect() {
  if (!wanted) return;
  ++generation;
  clearTimeout(retryTimer);
  stopClient();
  url = null; state = "off"; lastError = null; pairingUrl = null;
  await start();
}
function status() {
  return { enabled: wanted, state, url, error: lastError, mode: "managed", permanent: true, pairingUrl,
    ...(wanted ? require("./phone-registration").status() : {}) };
}
// Quitting the app stops the connection without turning off the saved
// preference, so the same address resumes on the next launch.
function shutdown() {
  wanted = false; ++generation;
  clearTimeout(retryTimer);
  stopClient();
}
async function boot() {
  try {
    // A setting that could not be read is not "off": read strictly, and try again shortly.
    wanted = String(await getConfStrict("PHONE_ACCESS")) === "1";
    if (wanted) await start();
    else await save({ PHONE_ACCESS_URL: null });
  } catch (e) {
    console.error("[Phone] Could not restore phone access, trying again in 10 seconds:", e.message);
    setTimeout(() => { void boot(); }, 10000);
  }
}
module.exports = { enable, disable, reconnect, status, boot, shutdown, useServer };
