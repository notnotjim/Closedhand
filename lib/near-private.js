// near-private.js: NEAR AI private inference, for any connection whose
// provider is NEAR AI (cloud-api.near.ai). Vendored byte-identically into
// lib/ and webapp/ (scripts/check-vendored-identical.js); model-wire.js sends
// a NEAR request through complete() instead of fetch.
//
// Nothing is sent to NEAR AI until it has proven, on the very connection the
// request will travel over, that:
//   - its gateway runs in an Intel TDX enclave whose quote verifies against
//     Intel's collateral (@phala/dcap-qvl), at an accepted TCB status, not in
//     debug mode, with the measured configuration and event log it reports;
//   - that quote binds a fresh nonce Closedhand chose and the certificate of
//     this TLS connection, so the connection ends inside the gateway's enclave;
//   - every model enclave offered for the model passes the same quote checks
//     and NVIDIA's GPU attestation (NRAS) for the same nonce.
// Each request is then encrypted end to end to the model enclave's key from
// that proof (NEAR's E2EE v2: X25519, HKDF-SHA256, XChaCha20-Poly1305), with
// tools and tool calls included, so the gateway relays only ciphertext; the
// reply is encrypted to a key made for that one request. Finally the reply's
// signature is checked over the exact bytes sent and received, against the
// signer the proof named. Any check that fails stops the request, and the
// person is told so in one plain sentence; the details go to the log.
//
// Per NEAR's docs (docs.near.ai/cloud/verification): each new connection is
// proven afresh, never with a fingerprint from another connection.

const crypto = require("crypto");
const tls = require("tls");
const https = require("https");
const hexBytes = (v) => Buffer.from(String(v || "").replace(/^0x/i, ""), "hex");
const sha = (alg, ...parts) => { const h = crypto.createHash(alg); for (const p of parts) h.update(p); return h.digest(); };
const parsed = (v) => (typeof v === "string" ? JSON.parse(v) : v);

// --- E2EE v2 ------------------------------------------------------------------

// HChaCha20 (draft-irtf-cfrg-xchacha, 2.2): the subkey for XChaCha20.
const rotl = (v, c) => (v << c) | (v >>> (32 - c));
function hchacha20(key, nonce16) {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(i * 4);
  const qr = (a, b, c, d) => {
    s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 16); s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 8); s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((w, i) => out.writeUInt32LE(s[w], i * 4));
  return out;
}
// XChaCha20-Poly1305: HChaCha20 subkey, then ChaCha20-Poly1305 (IETF) with
// four zero bytes and the nonce's last eight. Returns ciphertext || tag.
function xchachaSeal(key, nonce, plaintext, aad) {
  const c = crypto.createCipheriv("chacha20-poly1305", hchacha20(key, nonce.subarray(0, 16)),
    Buffer.concat([Buffer.alloc(4), nonce.subarray(16, 24)]), { authTagLength: 16 });
  if (aad) c.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}
function xchachaOpen(key, nonce, sealed, aad) {
  if (sealed.length < 16) throw new Error("ciphertext too short");
  const d = crypto.createDecipheriv("chacha20-poly1305", hchacha20(key, nonce.subarray(0, 16)),
    Buffer.concat([Buffer.alloc(4), nonce.subarray(16, 24)]), { authTagLength: 16 });
  if (aad) d.setAAD(aad, { plaintextLength: sealed.length - 16 });
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}

// Ed25519 public key to X25519 (libsodium's crypto_sign_ed25519_pk_to_curve25519):
// u = (1 + y) / (1 - y) mod p.
const P = 2n ** 255n - 19n;
function modpow(b, e) { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
function edToX25519(edPub) {
  if (!Buffer.isBuffer(edPub) || edPub.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  const y = BigInt("0x" + Buffer.from(edPub).reverse().toString("hex")) & ((1n << 255n) - 1n);
  if (y >= P) throw new Error("not an Ed25519 public key");
  const d = (1n - y + P) % P;
  if (d === 0n) throw new Error("not an Ed25519 public key");
  return Buffer.from((((1n + y) * modpow(d, P - 2n)) % P).toString(16).padStart(64, "0"), "hex").reverse();
}

const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const x25519Public = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
const x25519Private = (raw) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });
const ed25519Public = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
const fieldKey = (shared) => Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.alloc(0), "ed25519_encryption", 32));

// A key pair for one request: its Ed25519 public key goes to NEAR AI, which
// encrypts the reply to the matching X25519 key; the secret never leaves here.
function clientKeys() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const secret = crypto.createHash("sha512").update(Buffer.from(jwk.d, "base64url")).digest().subarray(0, 32);
  secret[0] &= 248; secret[31] &= 127; secret[31] |= 64;
  return { publicHex: Buffer.from(jwk.x, "base64url").toString("hex"), x25519Secret: Buffer.from(secret) };
}

// One field, for a recipient's Ed25519 public key: hex of
// [ephemeral X25519 public key (32)][nonce (24)][ciphertext + tag].
function seal(text, recipientEdPub) {
  const eph = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(edToX25519(recipientEdPub)) });
  const nonce = crypto.randomBytes(24);
  const ephPub = eph.publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_X25519.length);
  return Buffer.concat([ephPub, nonce, xchachaSeal(fieldKey(shared), nonce, Buffer.from(String(text), "utf8"))]).toString("hex");
}
function open(hex, x25519Secret) {
  if (typeof hex !== "string" || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2) throw new Error("an encrypted field is hex");
  const data = Buffer.from(hex, "hex");
  if (data.length < 32 + 24 + 16) throw new Error("an encrypted field is too short");
  const shared = crypto.diffieHellman({ privateKey: x25519Private(x25519Secret), publicKey: x25519Public(data.subarray(0, 32)) });
  return xchachaOpen(fieldKey(shared), data.subarray(32, 56), data.subarray(56)).toString("utf8");
}

// The request with every sensitive field encrypted, as NEAR AI's E2EE with
// X-Encrypt-All-Fields takes it: message content (text parts joined; a
// picture or sound part is refused, since the field format carries text),
// reasoning, names, refusals, tool calls, tool definitions and tool_choice.
function encryptRequest(body, modelEdPub) {
  const enc = (v) => (typeof v === "string" ? seal(v, modelEdPub) : v);
  const out = { ...body, messages: (body.messages || []).map((m) => {
    const msg = { ...m };
    if (Array.isArray(msg.content)) {
      if (msg.content.some((p) => p && p.type !== "text")) throw Object.assign(new Error("Only text can be sent to this NEAR AI model privately."), { userFacing: true });
      msg.content = msg.content.map((p) => p.text || "").join("\n\n");
    }
    for (const f of ["content", "reasoning_content", "reasoning", "name", "refusal"]) if (typeof msg[f] === "string") msg[f] = enc(msg[f]);
    if (Array.isArray(msg.tool_calls)) msg.tool_calls = msg.tool_calls.map((tc) => ({ ...tc, function: { ...tc.function, name: enc(tc.function?.name), arguments: enc(tc.function?.arguments) } }));
    return msg;
  }) };
  if (Array.isArray(body.tools)) out.tools = body.tools.map((t) => ({ ...t, function: {
    ...t.function, name: enc(t.function?.name), description: enc(t.function?.description),
    ...(t.function?.parameters !== undefined ? { parameters: seal(JSON.stringify(t.function.parameters), modelEdPub) } : {}),
  } }));
  if (body.tool_choice && typeof body.tool_choice === "object" && body.tool_choice.function?.name) {
    out.tool_choice = { ...body.tool_choice, function: { ...body.tool_choice.function, name: enc(body.tool_choice.function.name) } };
  }
  return out;
}
function decryptResponse(json, x25519Secret) {
  const dec = (v) => (typeof v === "string" && v ? open(v, x25519Secret) : v);
  return { ...json, choices: (json.choices || []).map((c) => {
    const msg = { ...(c.message || {}) };
    for (const f of ["content", "reasoning_content", "reasoning", "refusal"]) msg[f] = dec(msg[f]);
    if (Array.isArray(msg.tool_calls)) msg.tool_calls = msg.tool_calls.map((tc) => ({ ...tc, function: { ...tc.function, name: dec(tc.function?.name), arguments: dec(tc.function?.arguments) } }));
    return { ...c, message: msg };
  }) };
}

// --- The proof ------------------------------------------------------------------


// TCB statuses accepted: current, or needing only software hardening or a
// configuration change. Out of date or revoked platforms are refused (the
// verifier itself refuses revoked ones).
const ACCEPTED_TCB = ["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded"];

function replayRtmr3(eventLog) {
  let rtmr3 = Buffer.alloc(48);
  for (const event of parsed(eventLog) || []) {
    if (event.imr !== 3) continue;
    const type = Buffer.alloc(4);
    type.writeUInt32LE(event.event_type);
    const digest = sha("sha384", type, ":", Buffer.from(String(event.event), "utf8"), ":", hexBytes(event.event_payload));
    if (event.digest && !hexBytes(event.digest).equals(digest)) throw new Error(`event ${event.event} does not match its digest`);
    rtmr3 = sha("sha384", rtmr3, digest);
  }
  return rtmr3;
}

// One NEAR report (the gateway's or a model's), per NEAR's quote, nonce and
// signer rules. `td` comes from the verified quote, never from the HTTP fields.
async function checkReport(report, nonceHex, verifyQuote, peerSpkiHex) {
  if (!report || report.signing_algo !== "ed25519") throw new Error("the report is not for ed25519");
  const { status, td } = await verifyQuote(hexBytes(report.intel_quote));
  if (!ACCEPTED_TCB.includes(status)) throw new Error(`TCB status ${status} is not accepted`);
  if (Buffer.from(td.tdAttributes)[0] & 1) throw new Error("the enclave is in debug mode");
  const identity = hexBytes(report.signing_address);
  if (identity.length !== 32) throw new Error("the signing identity is not an Ed25519 key");
  const fingerprint = report.tls_cert_fingerprint;
  if (peerSpkiHex !== undefined && String(fingerprint || "").toLowerCase() !== peerSpkiHex.toLowerCase()) throw new Error("the TLS certificate is not the one the enclave holds");
  const bound = fingerprint ? sha("sha256", identity, hexBytes(fingerprint)) : Buffer.concat([identity, Buffer.alloc(32 - identity.length)]);
  if (!Buffer.from(td.reportData).equals(Buffer.concat([bound, hexBytes(nonceHex)]))) throw new Error("the quote does not bind the signer and nonce");
  if (String(report.request_nonce || "").toLowerCase() !== nonceHex.toLowerCase()) throw new Error("the echoed nonce differs");
  const compose = parsed(report.info?.tcb_info)?.app_compose;
  if (typeof compose !== "string") throw new Error("the measured configuration is missing");
  if (!Buffer.from(td.mrConfigId).equals(Buffer.concat([Buffer.from([1]), sha("sha256", Buffer.from(compose, "utf8")), Buffer.alloc(15)]))) throw new Error("MRCONFIGID does not match the configuration");
  if (!replayRtmr3(report.event_log).equals(Buffer.from(td.rtMr3))) throw new Error("the event log does not match RTMR3");
  return { address: identity.toString("hex"), algo: "ed25519" };
}

// The whole proof for one connection: gateway bound to this TLS connection,
// and every model enclave offered for the model, GPUs included.
async function checkEvidence(body, nonceHex, peerSpkiHex, deps) {
  const gateway = await checkReport(body.gateway_attestation, nonceHex, deps.verifyQuote, peerSpkiHex);
  const candidates = body.model_attestations || [];
  if (!candidates.length) throw new Error("no model enclave was offered");
  const models = [];
  for (const m of candidates) {
    const signer = await checkReport(m, nonceHex, deps.verifyQuote);
    const gpu = parsed(m.nvidia_payload);
    if (!gpu || String(gpu.nonce || "").toLowerCase() !== nonceHex.toLowerCase()) throw new Error("GPU evidence is missing or for another nonce");
    if (!(await deps.attestGpu(gpu))) throw new Error("NVIDIA did not attest the GPU");
    const pub = hexBytes(m.signing_public_key);
    if (pub.length !== 32) throw new Error("the model key is not an Ed25519 key");
    models.push({ ...signer, publicKey: pub });
  }
  return { gateway, models, modelKey: models[0].publicKey };
}

// Intel's quote check, with collateral from Intel's PCS (signed by Intel, so
// Phala's PCCS serves only if Intel's is out of reach).
async function fetchCollateral(dcap, quote) {
  try { return await dcap.getCollateral(dcap.INTEL_PCS_URL, quote); }
  catch (e) {
    if (!/fetch|network|ENOTFOUND|ECONN|ETIMEDOUT|timeout|HTTP/i.test(String(e.message))) throw e;
    return dcap.getCollateral(dcap.PHALA_PCCS_URL, quote);
  }
}
// The collateral (Intel's revocation lists, TCB info and quoting enclave
// identity) is the same for every quote from one machine, and fetching it
// was half of each new connection's proof: about 3 of 6 seconds, paid again
// whenever NEAR AI had closed an idle connection. Kept an hour per machine,
// by the certificate chain in its quotes. Every quote is still checked in
// full against it; one that fails is checked again on freshly fetched
// collateral, so an expired list is never the reason a proof fails.
const COLLATERAL_FOR_MS = 3600 * 1000;
const collaterals = new Map();
async function verifyQuoteDefault(quote) {
  const dcap = require("@phala/dcap-qvl");
  const now = () => Math.floor(Date.now() / 1000);
  let machine = null;
  try {
    const parsedQuote = dcap.Quote.parse(quote);
    if (parsedQuote.innerCertType() === dcap.constants.PCK_ID_PCK_CERT_CHAIN) machine = sha("sha256", Buffer.from(parsedQuote.rawCertChain())).toString("hex");
  } catch { /* fetched for this quote alone */ }
  const kept = machine && collaterals.get(machine);
  let verified = null;
  if (kept && Date.now() - kept.at < COLLATERAL_FOR_MS) {
    try { verified = await dcap.verify(quote, kept.collateral, now()); } catch { collaterals.delete(machine); }
  }
  if (!verified) {
    const collateral = await fetchCollateral(dcap, quote);
    verified = await dcap.verify(quote, collateral, now());
    if (machine) collaterals.set(machine, { at: Date.now(), collateral });
  }
  const td = verified.report.asTd10();
  if (!td) throw new Error("the quote is not a TDX quote");
  return { status: verified.status, td };
}
async function attestGpuDefault(payload) {
  const res = await fetch("https://nras.attestation.nvidia.com/v3/attest/gpu", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return false;
  const out = await res.json().catch(() => null);
  const jwt = Array.isArray(out) && Array.isArray(out[0]) && out[0][0] === "JWT" ? out[0][1] : null;
  if (typeof jwt !== "string") return false;
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"))["x-nvidia-overall-att-result"] === true; }
  catch { return false; }
}

// --- Transport ------------------------------------------------------------------

// One HTTP/1.1 exchange on a raw TLS socket, leaving it open and clean for the
// request that follows: the proof and the request travel on one connection.
function exchange(socket, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0), head = null, need = null, chunks = [], done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); socket.removeListener("data", onData); socket.removeListener("error", onError); socket.removeListener("close", onClose); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error("the proof took too long")), timeoutMs);
    const onError = (e) => finish(e);
    const onClose = () => finish(new Error("the connection closed during the proof"));
    function parse() {
      if (!head) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
        const status = Number((lines[0].match(/^HTTP\/1\.1 (\d{3})/) || [])[1]);
        const headers = {};
        for (const l of lines.slice(1)) { const i = l.indexOf(":"); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
        head = { status, headers };
        buf = buf.subarray(end + 4);
        if (/close/i.test(headers.connection || "")) return finish(new Error("the gateway would close the proven connection"));
        if (headers["content-length"] !== undefined) need = Number(headers["content-length"]);
        else if (!/chunked/i.test(headers["transfer-encoding"] || "")) return finish(new Error("the proof has no length"));
      }
      if (need !== null) {
        if (buf.length < need) return;
        if (buf.length > need) return finish(new Error("unexpected bytes after the proof"));
        return finish(null, { ...head, body: buf });
      }
      for (;;) { // chunked
        const eol = buf.indexOf("\r\n");
        if (eol < 0) return;
        const size = parseInt(buf.subarray(0, eol).toString("latin1"), 16);
        if (!Number.isFinite(size)) return finish(new Error("a malformed chunk"));
        if (size === 0) {
          const end = buf.indexOf("\r\n\r\n", eol);
          if (end < 0) return;
          if (buf.length > end + 4) return finish(new Error("unexpected bytes after the proof"));
          return finish(null, { ...head, body: Buffer.concat(chunks) });
        }
        if (buf.length < eol + 2 + size + 2) return;
        chunks.push(buf.subarray(eol + 2, eol + 2 + size));
        buf = buf.subarray(eol + 2 + size + 2);
      }
    }
    function onData(d) { buf = Buffer.concat([buf, d]); try { parse(); } catch (e) { finish(e); } }
    socket.on("data", onData); socket.once("error", onError); socket.once("close", onClose);
    socket.write(request);
  });
}

// An HTTPS agent for one connection and model whose every new connection is
// proven before Node's HTTP client may use it.
//
// A proof is bound to the gateway's TLS key, which its enclave holds and never
// lets out, so a later connection that ends at the same key ends in the same
// proven enclave. It reuses that proof for PROOF_REUSE_MS: NEAR AI closes a
// connection after about a minute idle, and proving each new one took 3 to 8
// seconds of every reply that followed a pause. Connections opening while a
// proof for their key is under way wait for it rather than run their own. A
// reply that fails its checks forgets the agent's proofs (complete below).
const PROOF_REUSE_MS = 10 * 60 * 1000;
class ProvenAgent extends https.Agent {
  constructor(state) { super({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4, scheduling: "lifo" }); this.state = state; this.evidence = new WeakMap(); this.proofs = new Map(); }
  prove(socket, spki) {
    const { host, apiKey, model, deps } = this.state;
    const kept = this.proofs.get(spki);
    if (kept && (kept.pending || Date.now() - kept.at < (deps.proofReuseMs ?? PROOF_REUSE_MS))) return kept.pending || Promise.resolve(kept.evidence);
    const nonce = crypto.randomBytes(32).toString("hex");
    const q = new URLSearchParams({ model, provider: "near", signing_algo: "ed25519", include_tls_fingerprint: "true", nonce });
    const pending = exchange(socket, `GET ${this.state.prefix}/attestation/report?${q} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${apiKey}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nx-no-aliasing: true\r\nConnection: keep-alive\r\n\r\n`, deps.proofTimeoutMs || 60000)
      .then((res) => {
        if (res.status !== 200) throw Object.assign(new Error(`the proof request returned HTTP ${res.status}`), { status: res.status });
        return checkEvidence(JSON.parse(res.body.toString("utf8")), nonce, spki, deps);
      })
      .then((evidence) => { this.proofs.set(spki, { at: Date.now(), evidence }); return evidence; },
        (e) => { this.proofs.delete(spki); throw e; });
    this.proofs.set(spki, { pending });
    return pending;
  }
  createConnection(options, callback) {
    const { host, port, deps } = this.state;
    let called = false;
    const cb = (err, s) => { if (!called) { called = true; callback(err, s); } };
    const socket = tls.connect({ host, port, servername: host, ALPNProtocols: ["http/1.1"], ...(deps.ca ? { ca: deps.ca } : {}) });
    const failed = (e) => cb(e);
    socket.once("error", failed);
    socket.once("secureConnect", async () => {
      try {
        const cert = socket.getPeerCertificate(true);
        if (!cert || !cert.raw) throw new Error("no certificate");
        const spki = sha("sha256", new crypto.X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" })).toString("hex");
        this.evidence.set(socket, await this.prove(socket, spki));
        socket.removeListener("error", failed);
        cb(null, socket);
      } catch (e) {
        socket.destroy();
        cb(e);
      }
    });
  }
}

const UNPROVEN = "NEAR AI couldn't prove its enclave just now, so nothing was sent. Try again in a minute.";
const UNSIGNED = "NEAR AI's reply couldn't be checked as coming from its enclave, so it wasn't used. Try again in a minute.";
const states = new Map();
function stateFor(conn, model, deps) {
  const url = new URL(conn.baseUrl);
  const key = [url.origin, url.pathname, crypto.createHash("sha256").update(String(conn.apiKey || "")).digest("hex"), model].join("|");
  let st = states.get(key);
  if (!st || st.deps !== deps) {
    st = { host: url.hostname, port: Number(url.port) || 443, prefix: url.pathname.replace(/\/+$/, ""), apiKey: conn.apiKey, model, deps };
    st.agent = new ProvenAgent(st);
    states.set(key, st);
  }
  return st;
}

function send(st, options, build) {
  return new Promise((resolve, reject) => {
    const req = https.request({ agent: st.agent, host: st.host, port: st.port, servername: st.host, ...options });
    let sent = null;
    req.once("socket", (socket) => {
      const evidence = st.agent.evidence.get(socket);
      if (!evidence) return req.destroy(new Error("an unproven connection"));
      try { sent = build ? build(evidence) : null; } catch (e) { return req.destroy(e); }
      if (sent?.headers) for (const [k, v] of Object.entries(sent.headers)) req.setHeader(k, v);
      req.end(sent?.bytes);
    });
    req.once("response", (res) => {
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(parts), evidence: st.agent.evidence.get(req.socket), sent }));
      res.once("error", reject);
    });
    req.once("error", reject);
    if (options.signal) options.signal.addEventListener("abort", () => req.destroy(options.signal.reason || new Error("aborted")), { once: true });
  });
}

const DEFAULT_DEPS = { verifyQuote: verifyQuoteDefault, attestGpu: attestGpuDefault };
// Tests give stand-ins for Intel's and NVIDIA's checks, a certificate to trust
// and shorter waits; nothing else ever changes these.
let deps = DEFAULT_DEPS;
function useDeps(d) { deps = d ? { ...DEFAULT_DEPS, ...d } : DEFAULT_DEPS; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A chat completion, privately. Resolves to a fetch-like response whose json()
// is the decrypted, verified reply; rejects with a plain sentence when the
// proof or the reply's signature fails.
async function complete(conn, body, { signal } = {}) {
  const model = body.model;
  if (signal?.aborted) throw signal.reason;
  const st = stateFor(conn, model, deps);
  const auth = { Authorization: "Bearer " + conn.apiKey, "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity" };
  let result;
  try {
    result = await send(st, { method: "POST", path: st.prefix + "/chat/completions", headers: auth, signal }, (evidence) => {
      const keys = clientKeys();
      const bytes = Buffer.from(JSON.stringify(encryptRequest({ ...body, stream: false }, evidence.modelKey)), "utf8");
      return { bytes, keys, headers: {
        "Content-Length": bytes.length, "X-Signing-Algo": "ed25519", "X-Client-Pub-Key": keys.publicHex,
        "X-Model-Pub-Key": evidence.modelKey.toString("hex"), "X-Encryption-Version": "2", "X-Encrypt-All-Fields": "true", "x-no-aliasing": "true",
      } };
    });
  } catch (e) {
    if (e.userFacing) throw Object.assign(new Error(e.message), { status: 400, code: "near_text_only" });
    if (signal?.aborted) throw signal.reason;
    st.agent.proofs.clear();
    console.warn(`[near] not sent: ${String(e.message).slice(0, 200)}`);
    throw Object.assign(new Error(UNPROVEN), { status: 503, code: "near_unproven" });
  }
  const headers = { get: (n) => result.headers[String(n).toLowerCase()] ?? null };
  if (result.status < 200 || result.status >= 300) {
    // Errors come back in the clear; model-wire reads them as for any provider.
    return { ok: false, status: result.status, headers, json: async () => JSON.parse(result.raw.toString("utf8") || "{}") };
  }
  let reply;
  try {
    const json = JSON.parse(result.raw.toString("utf8"));
    await checkSignature(st, json.id, model, result.sent.bytes, result.raw, result.evidence, signal);
    reply = decryptResponse(json, result.sent.keys.x25519Secret);
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    st.agent.proofs.clear();
    console.warn(`[near] reply not used: ${String(e.message).slice(0, 200)}`);
    throw Object.assign(new Error(UNSIGNED), { status: 502, code: "near_unsigned" });
  }
  return { ok: true, status: result.status, headers, json: async () => reply };
}

// A connection opened and proven ahead of a request, so a reply does not wait
// for the proof: nothing goes but the proof and a request for the model list.
async function warm(conn, model) {
  const st = stateFor(conn, model, deps);
  await send(st, { method: "GET", path: st.prefix + "/models", headers: { Authorization: "Bearer " + conn.apiKey, Accept: "application/json", "Accept-Encoding": "identity" } });
}

// The reply's signature, over the exact bytes sent and received, by the
// signer the proof named: the model enclave's, or the gateway's when it is
// the one that signs. Unavailable for a short while is retried, then refused.
async function checkSignature(st, chatId, model, requestBytes, responseBytes, evidence, signal) {
  if (!chatId) throw new Error("the reply has no id to check");
  let sig = null;
  for (let attempt = 0; attempt < 6 && !sig; attempt++) {
    if (attempt) await wait((deps.signatureWaitMs ?? 500) * attempt);
    const q = new URLSearchParams({ signing_algo: "ed25519" });
    const res = await send(st, { method: "GET", path: `${st.prefix}/signature/${encodeURIComponent(chatId)}?${q}`, headers: { Authorization: "Bearer " + st.apiKey, Accept: "application/json", "Accept-Encoding": "identity" }, signal });
    if (res.status === 404) continue;
    if (res.status !== 200) throw new Error(`the signature request returned HTTP ${res.status}`);
    const got = JSON.parse(res.raw.toString("utf8"));
    if (got && typeof got.text === "string" && !got.error_code) sig = got;
  }
  if (!sig) throw new Error("no signature for the reply");
  const hashes = `${sha("sha256", requestBytes).toString("hex")}:${sha("sha256", responseBytes).toString("hex")}`;
  let expected, signer;
  if (sig.signature_kind === "provider_tee") {
    expected = `${model}:${hashes}`;
    const matches = evidence.models.filter((m) => m.algo === sig.signing_algo && m.address === String(sig.signing_address || "").replace(/^0x/i, "").toLowerCase());
    if (matches.length !== 1) throw new Error("the signer is not one proven model enclave");
    signer = matches[0];
  } else if (sig.signature_kind === "gateway") {
    expected = hashes;
    if (evidence.gateway.algo !== sig.signing_algo || evidence.gateway.address !== String(sig.signing_address || "").replace(/^0x/i, "").toLowerCase()) throw new Error("the signer is not the proven gateway");
    signer = evidence.gateway;
  } else throw new Error("the signature names no known signer");
  if (sig.text !== expected) throw new Error("the signature covers other bytes");
  const sigBytes = hexBytes(sig.signature);
  if (sigBytes.length !== 64) throw new Error("the signature is not an Ed25519 signature");
  if (!crypto.verify(null, Buffer.from(sig.text, "utf8"), ed25519Public(Buffer.from(signer.address, "hex")), sigBytes)) throw new Error("the signature does not verify");
}

// Which of NEAR AI's models can be proven, for the list people choose from:
// those whose attestation report names a model enclave. Models NEAR passes on
// to other companies run outside one ("TEE attestation is not supported for
// external providers"), and an enclave model whose proof fails is left out
// too; complete() above would refuse either. Text models NEAR marks ready are
// asked, eight at a time, once a day per key.
const PROVEN_FOR_MS = 24 * 3600 * 1000;
const proven = new Map();
async function provenModels(conn, models) {
  const id = crypto.createHash("sha256").update(conn.baseUrl + "|" + String(conn.apiKey || "")).digest("hex");
  let known = proven.get(id);
  if (!known || Date.now() - known.at > PROVEN_FOR_MS) { known = { at: Date.now(), ok: new Map() }; proven.set(id, known); }
  const text = models.filter((m) => {
    const into = m.metadata?.input_modalities, out = m.metadata?.output_modalities;
    return (!Array.isArray(into) || into.includes("text")) && (!Array.isArray(out) || out.includes("text")) && m.metadata?.is_ready !== false;
  });
  const todo = text.filter((m) => !known.ok.has(m.id));
  let asked = 0;
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async (m) => {
      try {
        const res = await fetch(`${conn.baseUrl}/attestation/report?model=${encodeURIComponent(m.id)}&signing_algo=ed25519`,
          { headers: { Authorization: "Bearer " + conn.apiKey }, signal: AbortSignal.timeout(15000), redirect: "error" });
        const body = res.ok ? await res.json() : null;
        if (!res.ok) await res.body?.cancel?.().catch(() => {});
        known.ok.set(m.id, Array.isArray(body?.model_attestations) && body.model_attestations.length > 0);
        asked++;
      } catch { /* not kept: asked again next time */ }
    }));
  }
  if (todo.length && !asked) throw Object.assign(new Error("Could not check which NEAR AI models are private just now. Try again in a minute."), { status: 503 });
  // Text only, whatever the model can see: what is sent privately is text
  // (encryptRequest), so pictures go to the image model chosen beside it.
  return text.filter((m) => known.ok.get(m.id)).map((m) => ({ ...m, metadata: { ...m.metadata, input_modalities: ["text"],
    architecture: m.metadata.architecture ? { ...m.metadata.architecture, input_modalities: ["text"], inputModalities: ["text"] } : undefined } }));
}

// Whether a connection goes to NEAR AI: by name, or by its address.
function isNear(conn) {
  if (conn?.provider === "near") return true;
  try { return new URL(conn?.baseUrl).hostname === "cloud-api.near.ai"; } catch { return false; }
}

module.exports = { isNear, complete, warm, provenModels, useDeps, verifyQuoteDefault, hchacha20, xchachaSeal, xchachaOpen, edToX25519, clientKeys, seal, open, encryptRequest, decryptResponse, replayRtmr3, checkReport, checkEvidence, ACCEPTED_TCB };
