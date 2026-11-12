// NEAR AI private inference (lib/near-private.js): nothing is sent until the
// connection it travels on is proven to end in NEAR AI's enclave, every
// field is encrypted to the proven model key, and a reply is used only when
// its signature checks out. A fake NEAR AI here holds real keys and does the
// real encryption and signing over real HTTPS; only Intel's and NVIDIA's
// verdicts are stood in for.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { execFileSync } = require("node:child_process");
const near = require("../lib/near-private");

const hex = (s) => Buffer.from(s.replace(/\s+/g, ""), "hex");
const sha = (alg, ...parts) => { const h = crypto.createHash(alg); for (const p of parts) h.update(p); return h.digest(); };

test("XChaCha20-Poly1305 and HChaCha20 match the draft's test vectors", () => {
  // draft-irtf-cfrg-xchacha-03, 2.2.1 and A.3.1.
  assert.equal(near.hchacha20(hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"), hex("000000090000004a0000000031415927")).toString("hex"),
    "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc");
  const key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f"), iv = hex("404142434445464748494a4b4c4d4e4f5051525354555657"), aad = hex("50515253c0c1c2c3c4c5c6c7");
  const pt = hex("4c616469657320616e642047656e746c656d656e206f662074686520636c617373206f66202739393a204966204920636f756c64206f6666657220796f75206f6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73637265656e20776f756c642062652069742e");
  const sealed = near.xchachaSeal(key, iv, pt, aad);
  assert.equal(sealed.toString("hex"), "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49");
  assert.deepEqual(near.xchachaOpen(key, iv, sealed, aad), pt);
  const tampered = Buffer.from(sealed); tampered[3] ^= 1;
  assert.throws(() => near.xchachaOpen(key, iv, tampered, aad));
});

test("an Ed25519 key maps to the X25519 key of its secret, and a sealed field opens only for its key", () => {
  for (let i = 0; i < 20; i++) {
    const k = near.clientKeys();
    const xPub = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([hex("302e020100300506032b656e04220420"), k.x25519Secret]), format: "der", type: "pkcs8" }))
      .export({ format: "der", type: "spki" }).subarray(12);
    assert.deepEqual(near.edToX25519(Buffer.from(k.publicHex, "hex")), xPub);
  }
  const me = near.clientKeys(), other = near.clientKeys();
  const field = near.seal("Pick up the dry cleaning on Thursday", Buffer.from(me.publicHex, "hex"));
  assert.equal(near.open(field, me.x25519Secret), "Pick up the dry cleaning on Thursday");
  assert.throws(() => near.open(field, other.x25519Secret));
  assert.equal(Buffer.from(field, "hex").length, 32 + 24 + 36 + 16, "[ephemeral key][nonce][ciphertext + tag]");
});

// --- A fake NEAR AI -------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "near-test-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
const KEY = fs.readFileSync(path.join(dir, "key.pem")), CERT = fs.readFileSync(path.join(dir, "cert.pem"));
const SPKI = sha("sha256", new crypto.X509Certificate(CERT).publicKey.export({ type: "spki", format: "der" }));
const edPair = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519"); return { privateKey, pub: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"), seed: Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url") }; };
const GATEWAY = edPair(), MODEL = edPair();
const xSecret = (seed) => { const s = sha("sha512", seed).subarray(0, 32); s[0] &= 248; s[31] &= 127; s[31] |= 64; return Buffer.from(s); };
const COMPOSE = "services:\n  model:\n    image: example/model@sha256:00";
const MR_CONFIG = Buffer.concat([Buffer.from([1]), sha("sha256", COMPOSE), Buffer.alloc(15)]).toString("hex");
const quote = (fields) => Buffer.from(JSON.stringify(fields)).toString("hex");
const mrOf = (compose) => Buffer.concat([Buffer.from([1]), sha("sha256", compose), Buffer.alloc(15)]).toString("hex");

// An enclave that runs a compose manager (invented images and files): what it
// deploys comes from NEAR's public repository, and its log is quoted.
const digest = (c) => c.repeat(64);
const MANAGED = JSON.stringify({ manifest_version: 2, allowed_envs: ["CHANNEL"], docker_compose_file:
  `services:\n  compose-manager:\n    image: \${MANAGER_IMAGE:-example/compose-manager@sha256:${digest("a")}}\n  launcher:\n    image: example/launcher@sha256:${digest("b")}\n` });
const FILE = (v) => Buffer.from(`services:\n  model:\n    image: example/model@sha256:${digest(String(v))}\n`);
const sha256hex = (b) => sha("sha256", b).toString("hex");
const deploymentsOf = (commits) => [
  { timestamp: "2026-01-02T03:04:05Z", action: "compose_manager_started", container: "compose-manager", image: `example/compose-manager@sha256:${digest("a")}` },
  ...commits.flatMap((commit, i) => [
    { timestamp: `2026-01-0${i + 2}T04:00:00Z`, action: "compose_up", tag: `v${i + 1}`, commit, file: "prod/Example-Model.yaml", file_sha256: sha256hex(FILE(i + 1)), services: ["model"] },
    { timestamp: `2026-01-0${i + 2}T05:00:00Z`, action: "compose_down", tag: `v${i + 1}`, commit, file: "prod/Example-Model.yaml", services: ["model"] },
  ]),
];
// The log as the compose manager quotes it: SHA-256 of its canonical form,
// then the nonce. canonical: written out by hand where a test pins the form.
const logFor = (actions, nonce, { canonical, rtMr3 = "00".repeat(48), quotedNonce = nonce } = {}) => {
  const hash = sha256hex(canonical || JSON.stringify(actions.map((a) => Object.fromEntries(Object.keys(a).sort().map((k) => [k, a[k]])))));
  return { actions, actions_hash: hash, nonce, nonce_source: "client", report_data: hash + quotedNonce,
    quote: quote({ status: "UpToDate", reportData: hash + quotedNonce, mrConfigId: mrOf(MANAGED), rtMr3, tdAttributes: "0000000000000000" }) };
};
const github = { files: new Map(), asked: [], down: false };
const fetchPublished = async (url) => {
  github.asked.push(url);
  if (github.down) throw new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com");
  const bytes = github.files.get(url);
  return bytes ? { status: 200, bytes } : { status: 404 };
};
const publish = (commits) => commits.forEach((commit, i) => github.files.set(`https://raw.githubusercontent.com/nearai/cvm-compose-files/${commit}/prod/Example-Model.yaml`, FILE(i + 1)));

const fake = { mode: {}, reports: 0, posts: [], signatures: {}, sockets: new Set() };
const server = https.createServer({ key: KEY, cert: CERT, keepAliveTimeout: 30000 }, (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url, "https://localhost");
    const send = (status, body) => { const b = Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); res.writeHead(status, { "Content-Type": "application/json", "Content-Length": b.length }); res.end(b); };
    if (url.pathname === "/v1/attestation/report") {
      fake.reports++;
      const nonce = url.searchParams.get("nonce"), m = fake.mode;
      const quotedNonce = m.wrongNonce ? crypto.randomBytes(32).toString("hex") : nonce;
      const fp = m.otherCert ? crypto.randomBytes(32) : SPKI;
      const gateway = {
        signing_algo: "ed25519", signing_address: GATEWAY.pub.toString("hex"), request_nonce: nonce, tls_cert_fingerprint: fp.toString("hex"),
        intel_quote: quote({ status: m.tcb || "UpToDate", reportData: Buffer.concat([sha("sha256", GATEWAY.pub, fp), Buffer.from(quotedNonce, "hex")]).toString("hex"), mrConfigId: MR_CONFIG, rtMr3: "00".repeat(48), tdAttributes: "0000000000000000" }),
        event_log: "[]", info: { tcb_info: JSON.stringify({ app_compose: COMPOSE }) },
      };
      const model = {
        signing_algo: "ed25519", signing_address: MODEL.pub.toString("hex"), signing_public_key: MODEL.pub.toString("hex"), request_nonce: nonce,
        intel_quote: quote({ status: "UpToDate", reportData: Buffer.concat([MODEL.pub, Buffer.from(nonce, "hex")]).toString("hex"), mrConfigId: m.managed ? mrOf(MANAGED) : MR_CONFIG, rtMr3: "00".repeat(48), tdAttributes: m.debug ? "0100000000000000" : "0000000000000000" }),
        event_log: "[]", info: { tcb_info: { app_compose: m.managed ? MANAGED : COMPOSE } }, nvidia_payload: JSON.stringify({ nonce }),
        ...(m.managed ? { compose_manager_attestation: logFor(deploymentsOf(m.managed), nonce, { rtMr3: m.otherEnclave ? "11".repeat(48) : "00".repeat(48) }) } : {}),
      };
      return send(200, { gateway_attestation: gateway, ...(m.noModels ? {} : { model_attestations: [model] }) });
    }
    if (url.pathname === "/v1/chat/completions") {
      const raw = Buffer.concat(chunks), body = JSON.parse(raw);
      fake.posts.push({ raw, headers: req.headers, socket: req.socket });
      const mine = xSecret(MODEL.seed), toClient = (t) => near.seal(t, Buffer.from(req.headers["x-client-pub-key"], "hex"));
      const said = near.open(body.messages.at(-1).content, mine);
      const message = { role: "assistant", content: toClient("Echo: " + said) };
      if (body.tools) {
        const name = near.open(body.tools[0].function.name, mine), params = JSON.parse(near.open(body.tools[0].function.parameters, mine));
        message.tool_calls = [{ id: "call_1", type: "function", function: { name: toClient(name), arguments: toClient(JSON.stringify({ seen: Object.keys(params.properties) })) } }];
      }
      const resBytes = Buffer.from(JSON.stringify({ id: "chatcmpl-" + fake.posts.length, model: body.model, choices: [{ index: 0, message, finish_reason: body.tools ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
      const signer = fake.mode.gatewaySigns ? GATEWAY : MODEL;
      const text = fake.mode.gatewaySigns ? `${sha("sha256", raw).toString("hex")}:${sha("sha256", resBytes).toString("hex")}` : `${body.model}:${sha("sha256", raw).toString("hex")}:${sha("sha256", resBytes).toString("hex")}`;
      fake.signature = { text, signing_address: signer.pub.toString("hex"), signing_algo: "ed25519", signature_kind: fake.mode.gatewaySigns ? "gateway" : "provider_tee",
        signature: crypto.sign(null, Buffer.from(fake.mode.badSignature ? text + "x" : text), signer.privateKey).toString("hex") };
      fake.signatures["chatcmpl-" + fake.posts.length] = fake.signature;
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": resBytes.length });
      return res.end(resBytes);
    }
    if (url.pathname.startsWith("/v1/signature/")) return fake.mode.noSignature ? send(404, { error: "not found" }) : send(200, fake.signatures[decodeURIComponent(url.pathname.slice("/v1/signature/".length))] || fake.signature);
    send(404, {});
  });
});
let PORT;
const ready = new Promise((r) => server.listen(0, "127.0.0.1", () => { PORT = server.address().port; r(); }));
server.on("connection", (s) => fake.sockets.add(s));
after(() => { for (const s of fake.sockets) s.destroy(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); near.useDeps(null); });

const verifyQuote = async (q) => { const f = JSON.parse(q.toString("utf8")); return { status: f.status, td: { reportData: hex(f.reportData), mrConfigId: hex(f.mrConfigId), rtMr3: hex(f.rtMr3), tdAttributes: hex(f.tdAttributes) } }; };
let gpuVerdict = true;
near.useDeps({ ca: CERT, verifyQuote, attestGpu: async () => gpuVerdict, fetchPublished, signatureWaitMs: 5 });
let keyN = 0;
// A fresh connection per test (its own key), so each test proves its own.
const conn = () => ({ provider: "near", backend: "custom", baseUrl: `https://localhost:${PORT}/v1`, apiKey: "test-key-" + ++keyN });
const MODEL_ID = "deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated";
const reset = (mode = {}) => { fake.mode = mode; fake.reports = 0; fake.posts = []; fake.signatures = {}; gpuVerdict = true; };

test("a request goes only after the proof, fully encrypted, and the reply is decrypted once its signature checks out", async () => {
  await ready; reset();
  const wire = require("../lib/model-wire");
  const c = conn();
  const out = await wire.request(c, { model: MODEL_ID, system: "You are Closedhand.", messages: [{ role: "user", content: "hello from a fixture" }], max_tokens: 50 });
  assert.equal(wire.responseText(out), "Echo: hello from a fixture");
  assert.equal(fake.reports, 1);
  const sent = fake.posts[0];
  assert.doesNotMatch(sent.raw.toString(), /hello from a fixture|You are Closedhand/, "NEAR AI's gateway sees only ciphertext");
  assert.equal(sent.headers["x-model-pub-key"], MODEL.pub.toString("hex"));
  assert.equal(sent.headers["x-encrypt-all-fields"], "true");
  assert.equal(sent.headers["x-encryption-version"], "2");
  assert.equal(sent.headers["x-no-aliasing"], "true");
  // A second request rides the same proven connection, without a new proof.
  await wire.request(c, { model: MODEL_ID, messages: [{ role: "user", content: "again" }], max_tokens: 20 });
  assert.equal(fake.reports, 1);
  assert.equal(fake.posts[1].socket, fake.posts[0].socket, "the same connection the proof travelled on");
});

test("tools, their schemas and the model's tool calls are encrypted both ways", async () => {
  await ready; reset();
  const wire = require("../lib/model-wire");
  const out = await wire.request(conn(), { model: MODEL_ID, messages: [{ role: "user", content: "book it" }], max_tokens: 50,
    tools: [{ name: "book_table", description: "Book a table at a restaurant", input_schema: { type: "object", properties: { venue: { type: "string" }, time: { type: "string" } } } }] });
  assert.doesNotMatch(fake.posts[0].raw.toString(), /book_table|Book a table|venue/);
  const call = out.content.find((b) => b.type === "tool_use");
  assert.equal(call.name, "book_table");
  assert.deepEqual(call.input, { seen: ["venue", "time"] });
});

test("nothing is sent when the proof fails: another nonce, another certificate, debug mode, an old platform, no model enclave or no GPU verdict", async () => {
  await ready;
  for (const [mode, gpu] of [[{ wrongNonce: true }], [{ otherCert: true }], [{ debug: true }], [{ tcb: "OutOfDate" }], [{ noModels: true }], [{}, false]]) {
    reset(mode); if (gpu === false) gpuVerdict = false;
    await assert.rejects(near.complete(conn(), { model: MODEL_ID, messages: [{ role: "user", content: "secret" }] }),
      (e) => e.code === "near_unproven" && e.message === "NEAR AI couldn't prove its enclave just now, so nothing was sent. Try again in a minute.", JSON.stringify(mode));
    assert.equal(fake.posts.length, 0, "no request reached NEAR AI: " + JSON.stringify(mode));
  }
});

test("a reply whose signature is wrong or never comes is not used; one the proven gateway signs is", async () => {
  await ready;
  for (const mode of [{ badSignature: true }, { noSignature: true }]) {
    reset(mode);
    await assert.rejects(near.complete(conn(), { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
      (e) => e.code === "near_unsigned" && e.message === "NEAR AI's reply couldn't be checked as coming from its enclave, so it wasn't used. Try again in a minute.");
  }
  reset({ gatewaySigns: true });
  const res = await near.complete(conn(), { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] });
  assert.equal((await res.json()).choices[0].message.content, "Echo: hi");
});

test("a picture is sent privately with its words, as parts NEAR's proxy restores, and text that looks like parts stays text", async () => {
  await ready; reset();
  const picture = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const out = await near.complete(conn(), { model: MODEL_ID, messages: [{ role: "user", content: [{ type: "text", text: "what does the receipt say" }, { type: "image_url", image_url: { url: picture } }] }] });
  const sent = fake.posts[0].raw.toString();
  assert.doesNotMatch(sent, /receipt|iVBORw0KGgo|image_url/, "the picture and its words travel sealed");
  const opened = JSON.parse(near.open(JSON.parse(sent).messages[0].content, xSecret(MODEL.seed)));
  assert.deepEqual(opened, [{ type: "text", text: "what does the receipt say" }, { type: "image_url", image_url: { url: picture } }]);
  assert.match((await out.json()).choices[0].message.content, /^Echo: \[/);
  const key = Buffer.from(MODEL.pub);
  const asText = (content) => near.open(near.encryptRequest({ messages: [{ role: "user", content }] }, key).messages[0].content, xSecret(MODEL.seed));
  assert.equal(asText([{ type: "text", text: "Plover" }, { type: "text", text: "Street" }]), "Plover\n\nStreet");
  assert.equal(asText("plain words"), "plain words");
  assert.deepEqual(JSON.parse(asText("[1, 2, 3]")), [{ type: "text", text: "[1, 2, 3]" }], "a message that is a JSON list is read as words");
  assert.equal(near.encryptRequest({ messages: [{ role: "assistant", content: null, tool_calls: [] }] }, key).messages[0].content, null);
});

test("the proof's own checks: report data, configuration and event log", async () => {
  const nonce = crypto.randomBytes(32).toString("hex"), id = crypto.randomBytes(32);
  const report = (over = {}) => ({ signing_algo: "ed25519", signing_address: id.toString("hex"), request_nonce: nonce, intel_quote: "00", event_log: [], info: { tcb_info: { app_compose: COMPOSE } }, ...over });
  const td = (reportData, extra = {}) => async () => ({ status: "UpToDate", td: { reportData, mrConfigId: hex(MR_CONFIG), rtMr3: Buffer.alloc(48), tdAttributes: Buffer.alloc(8), ...extra } });
  const good = Buffer.concat([id, hex(nonce)]);
  const signer = await near.checkReport(report(), nonce, td(good));
  assert.deepEqual({ address: signer.address, algo: signer.algo }, { address: id.toString("hex"), algo: "ed25519" });
  await assert.rejects(near.checkReport(report(), nonce, td(Buffer.concat([id, crypto.randomBytes(32)]))), /bind the signer and nonce/);
  await assert.rejects(near.checkReport(report({ info: { tcb_info: { app_compose: COMPOSE + " " } } }), nonce, td(good)), /MRCONFIGID/);
  await assert.rejects(near.checkReport(report({ event_log: [{ imr: 3, event_type: 1, event: "app-id", event_payload: "00" }] }), nonce, td(good)), /RTMR3/);
  const ev = { imr: 3, event_type: 134217729, event: "compose-hash", event_payload: "abcd" };
  const typeLE = Buffer.alloc(4); typeLE.writeUInt32LE(ev.event_type);
  const digest = sha("sha384", typeLE, ":", ev.event, ":", hex(ev.event_payload));
  assert.deepEqual(near.replayRtmr3(JSON.stringify([ev])), sha("sha384", Buffer.alloc(48), digest));
  await assert.rejects(near.checkReport(report({ request_nonce: "00" }), nonce, td(good)), /echoed nonce/);
  assert.deepEqual(near.ACCEPTED_TCB, ["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded"]);
});

test("the sealed hardware runs Managed Models and is no provider people pick: found by its address, named in no list", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  assert.equal(require("../lib/model-policy").BASES.near, "https://cloud-api.near.ai/v1");
  assert.doesNotMatch(read("webapp/public/model-settings.js"), /near:/);
  assert.equal(require("../webapp/provider-names").PROVIDERS.near, undefined);
  assert.doesNotMatch(read("webapp/model-summary.js"), /near\.ai/);
  assert.ok(near.isNear({ provider: "near" }) && near.isNear({ provider: "custom", baseUrl: "https://cloud-api.near.ai/v1" }) && !near.isNear({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" }));
  assert.match(read("lib/model-wire.js"), /near\.isNear\(conn\) \? await near\.complete\(conn, body, \{ signal \}\)/);
});

test("only the NEAR AI models whose privacy can be proven are listed, as they say they read, asked once a day", async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const model = decodeURIComponent(String(url).match(/model=([^&]+)/)[1]);
    asked.push(model);
    if (model === "vendor/enclave-chat") return { ok: true, json: async () => ({ gateway_attestation: {}, model_attestations: [{}] }) };
    if (model === "vendor/no-enclave") return { ok: true, json: async () => ({ gateway_attestation: {}, model_attestations: [] }) };
    return { ok: false, status: 503, body: { cancel: async () => {} } };
  };
  try {
    const conn = { provider: "near", backend: "custom", baseUrl: "https://near.example/v1", apiKey: "invented-key-1" };
    const list = [
      { id: "vendor/enclave-chat", metadata: { input_modalities: ["text", "image"], output_modalities: ["text"], architecture: { inputModalities: ["text", "image"] } } },
      { id: "vendor/no-enclave", metadata: { output_modalities: ["text"] } },
      { id: "other/external-model", metadata: { output_modalities: ["text"] } },
      { id: "vendor/makes-pictures", metadata: { output_modalities: ["image"] } },
      { id: "vendor/hears", metadata: { input_modalities: ["audio"], output_modalities: ["text"] } },
      { id: "vendor/not-ready", metadata: { output_modalities: ["text"], is_ready: false } },
    ];
    const got = await near.provenModels(conn, list);
    assert.deepEqual(got.map((m) => m.id), ["vendor/enclave-chat"]);
    assert.deepEqual(got[0].metadata.input_modalities, ["text", "image"], "pictures are sent privately too");
    assert.deepEqual(asked.sort(), ["other/external-model", "vendor/enclave-chat", "vendor/no-enclave"], "only text models that are ready are asked");
    await near.provenModels(conn, list);
    assert.equal(asked.length, 3, "kept for the day");
    globalThis.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(near.provenModels({ ...conn, apiKey: "invented-key-2" }, list), /Could not check which NEAR AI models are private/);
  } finally { globalThis.fetch = realFetch; }
  assert.match(fs.readFileSync(path.join(__dirname, "../lib/model-wire.js"), "utf8"), /if \(conn\.backend === "custom" && require\("\.\/near-private"\)\.isNear\(conn\)\) return require\("\.\/near-private"\)\.provenModels\(conn, models\);/);
});

test("Intel's collateral is kept per machine and every quote is still checked; a check that fails on kept collateral is redone on fresh", async () => {
  const Module = require("node:module");
  const calls = { fetched: [], verified: 0 }, handed = [];
  const dcap = {
    INTEL_PCS_URL: "https://pcs.example.test", PHALA_PCCS_URL: "https://pccs.example.test",
    constants: { PCK_ID_PCK_CERT_CHAIN: 5 },
    Quote: { parse: (q) => ({ innerCertType: () => 5, rawCertChain: () => Buffer.from("chain of machine " + q[0]) }) },
    getCollateral: async (url, q) => { calls.fetched.push(q[0]); const c = { fresh: true }; handed.push(c); return c; },
    verify: async (q, collateral) => { calls.verified++; if (!collateral.fresh) throw new Error("TCB info expired"); return { status: "UpToDate", report: { asTd10: () => ({ machine: q[0] }) } }; },
  };
  const real = Module._load;
  Module._load = function (request, ...rest) { return request === "@phala/dcap-qvl" ? dcap : real.call(this, request, ...rest); };
  try {
    const a = Buffer.from([0xa1]), b = Buffer.from([0xb2]);
    assert.deepEqual(await near.verifyQuoteDefault(a), { status: "UpToDate", td: { machine: 0xa1 } });
    await near.verifyQuoteDefault(a);
    assert.deepEqual(calls.fetched, [0xa1], "fetched once for one machine");
    assert.equal(calls.verified, 2, "but every quote checked");
    await near.verifyQuoteDefault(b);
    assert.deepEqual(calls.fetched, [0xa1, 0xb2], "another machine has its own");
    handed[0].fresh = false; // machine a's kept collateral has passed Intel's next update
    assert.deepEqual(await near.verifyQuoteDefault(a), { status: "UpToDate", td: { machine: 0xa1 } }, "the proof still passes");
    assert.deepEqual(calls.fetched, [0xa1, 0xb2, 0xa1], "on collateral fetched again");
    await near.verifyQuoteDefault(a);
    assert.deepEqual(calls.fetched, [0xa1, 0xb2, 0xa1], "which is kept in turn");
  } finally { Module._load = real; }
});

test("a new connection to a proven enclave key reuses its proof for a while, ones opened together share one, and warm proves one ahead", async () => {
  await ready; reset();
  const c = conn();
  await near.warm(c, MODEL_ID);
  assert.equal(fake.reports, 1, "warm proved a connection");
  assert.equal(fake.posts.length, 0, "and asked the model nothing");
  for (const s of fake.sockets) s.destroy(); // NEAR AI closes idle connections
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await (await near.complete(c, { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] })).json()).choices[0].message.content, "Echo: hi");
  assert.equal(fake.reports, 1, "a new connection to the same key, no new proof");

  reset();
  const c2 = conn();
  await Promise.all([1, 2, 3].map((i) => near.complete(c2, { model: MODEL_ID, messages: [{ role: "user", content: "q" + i }] }).then((r) => r.json())));
  assert.equal(fake.reports, 1, "three at once, one proof");
  assert.ok(new Set(fake.posts.map((p) => p.socket)).size > 1, "over more than one connection");

  near.useDeps({ ca: CERT, verifyQuote, attestGpu: async () => gpuVerdict, fetchPublished, signatureWaitMs: 5, proofReuseMs: 0 });
  try {
    reset();
    const c3 = conn();
    await near.warm(c3, MODEL_ID);
    for (const s of fake.sockets) s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    await near.complete(c3, { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] });
    assert.equal(fake.reports, 2, "past its time a proof is made again");
  } finally { near.useDeps({ ca: CERT, verifyQuote, attestGpu: async () => gpuVerdict, fetchPublished, signatureWaitMs: 5 }); }
});

test("a connection that stalls, in its handshake or its proof, is given up in time instead of waiting for good", async () => {
  await ready; reset();
  const net = require("node:net");
  const held = [];
  const silent = net.createServer((s) => held.push(s)); // takes the connection, never answers the handshake
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  const quick = (extra = {}) => near.useDeps({ ca: CERT, verifyQuote, attestGpu: async () => gpuVerdict, fetchPublished, signatureWaitMs: 5, proofTimeoutMs: 100, ...extra });
  try {
    quick();
    const stalled = { ...conn(), baseUrl: `https://localhost:${silent.address().port}/v1` };
    const t = Date.now();
    await assert.rejects(near.complete(stalled, { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] }));
    assert.ok(Date.now() - t < 3000, "given up, not left waiting");
    // A proof whose checks never end is given up too, and a later connection proves afresh.
    let hang = true;
    quick({ verifyQuote: (q) => hang ? new Promise(() => {}) : verifyQuote(q) });
    reset();
    const c = conn();
    await assert.rejects(near.complete(c, { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] }), /prove its enclave/);
    hang = false;
    assert.equal((await (await near.complete(c, { model: MODEL_ID, messages: [{ role: "user", content: "again" }] })).json()).choices[0].message.content, "Echo: again");
  } finally {
    for (const s of held) s.destroy();
    silent.close();
    near.useDeps({ ca: CERT, verifyQuote, attestGpu: async () => gpuVerdict, fetchPublished, signatureWaitMs: 5 });
  }
});
test("a NEAR AI model's quick support jobs skip thinking through its chat template; its replies think as the model does", () => {
  const policy = require("../lib/model-policy");
  const cap = policy.capabilities(conn(), MODEL_ID, { input_modalities: ["text"] });
  assert.equal(cap.reasoning, "template");
  assert.deepEqual(policy.effortOptions(cap, "fast"), { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(policy.effortOptions(cap, "default"), {});
  assert.equal(cap.vision, false, "and it takes text only");
});

// What a model enclave has deployed (checkDeployments): where it runs NEAR's
// compose manager, every deployment in its quoted log is a file published in
// NEAR's public repository, byte for byte, asked for only once.
test("a model enclave's deployments must all be NEAR's published files, the log bound to its quote", async () => {
  const nonce = crypto.randomBytes(32).toString("hex");
  const commits = [crypto.randomBytes(20).toString("hex"), crypto.randomBytes(20).toString("hex")];
  const report = (log, compose = MANAGED) => ({ info: { tcb_info: { app_compose: compose } }, compose_manager_attestation: log });
  const deps = { verifyQuote, fetchPublished };
  github.asked = [];
  publish(commits);
  const measured = await near.checkDeployments(report(logFor(deploymentsOf(commits), nonce)), nonce, deps);
  assert.equal(typeof measured, "string", "the log's quote measurements, to match against the model's");
  assert.equal(github.asked.length, 2, "each version asked for once, however often the log names it");
  await near.checkDeployments(report(logFor(deploymentsOf(commits), nonce)), nonce, deps);
  assert.equal(github.asked.length, 2, "a version found once is not asked for again");

  // The canonical form, as compose-manager writes it: keys sorted, no spaces.
  const one = [{ timestamp: "2026-01-02T04:00:00Z", action: "compose_up", tag: "v1", commit: commits[0], file: "prod/Example-Model.yaml", file_sha256: sha256hex(FILE(1)), services: ["model", "proxy"] }];
  const canonical = `[{"action":"compose_up","commit":"${commits[0]}","file":"prod/Example-Model.yaml","file_sha256":"${sha256hex(FILE(1))}","services":["model","proxy"],"tag":"v1","timestamp":"2026-01-02T04:00:00Z"}]`;
  assert.equal(typeof await near.checkDeployments(report(logFor(one, nonce, { canonical })), nonce, deps), "string");

  const fresh = () => crypto.randomBytes(20).toString("hex");
  const unpublished = [fresh()];
  await assert.rejects(near.checkDeployments(report(logFor(deploymentsOf(unpublished), nonce)), nonce, deps), /not in NEAR's public repository/);
  const changed = [fresh()];
  github.files.set(`https://raw.githubusercontent.com/nearai/cvm-compose-files/${changed[0]}/prod/Example-Model.yaml`, FILE(9));
  await assert.rejects(near.checkDeployments(report(logFor(deploymentsOf(changed), nonce)), nonce, deps), /differs from NEAR's published file/);

  const tampered = logFor(deploymentsOf(commits), nonce);
  tampered.actions = tampered.actions.slice(0, -2);
  await assert.rejects(near.checkDeployments(report(tampered), nonce, deps), /does not match its hash/);
  await assert.rejects(near.checkDeployments(report(logFor(deploymentsOf(commits), nonce, { quotedNonce: crypto.randomBytes(32).toString("hex") })), nonce, deps), /bind the log and nonce/);
  await assert.rejects(near.checkDeployments(report(logFor(deploymentsOf(commits), crypto.randomBytes(32).toString("hex"))), nonce, deps), /another nonce/);
  await assert.rejects(near.checkDeployments(report(undefined), nonce, deps), /gave no log/);
  const byTag = MANAGED.replace(`example/launcher@sha256:${digest("b")}`, "example/launcher:latest");
  await assert.rejects(near.checkDeployments(report(logFor(deploymentsOf(commits), nonce), byTag), nonce, deps), /not fixed by its digest/);
  const settable = MANAGED.replace('"allowed_envs":["CHANNEL"]', '"allowed_envs":["CHANNEL","MANAGER_IMAGE"]');
  await assert.rejects(near.checkDeployments(report(logFor(deploymentsOf(commits), nonce), settable), nonce, deps), /can be changed at deployment/);
  const loose = deploymentsOf(commits); loose[0] = { ...loose[0], image: "example/compose-manager:latest" };
  await assert.rejects(near.checkDeployments(report(logFor(loose, nonce)), nonce, deps), /own image/);
  assert.equal(await near.checkDeployments({ info: { tcb_info: { app_compose: COMPOSE } } }, nonce, deps), null, "an enclave with no compose manager runs only what its measured configuration says");

  // GitHub out of reach is no evidence: the proof goes ahead, said once, and the next asks again.
  const later = [fresh()];
  github.down = true; github.asked = [];
  const warned = [], warn = console.warn; console.warn = (line) => warned.push(line);
  try {
    assert.equal(typeof await near.checkDeployments(report(logFor(deploymentsOf(later), nonce)), nonce, deps), "string");
    assert.equal(typeof await near.checkDeployments(report(logFor(deploymentsOf(later), nonce)), nonce, deps), "string");
  } finally { console.warn = warn; github.down = false; }
  assert.equal(github.asked.length, 2, "asked again on the next proof");
  assert.equal(warned.length, 1, "said once");
  await assert.rejects(near.checkDeployments(report(logFor(deploymentsOf(later), nonce)), nonce, deps), /not in NEAR's public repository/, "and refused once GitHub answers that it isn't there");
});

test("nothing is sent to a model enclave that deployed an unpublished file, or whose log comes from another enclave", async () => {
  await ready;
  const commits = [crypto.randomBytes(20).toString("hex")];
  publish(commits);
  reset({ managed: commits });
  const res = await near.complete(conn(), { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] });
  assert.equal((await res.json()).choices[0].message.content, "Echo: hi", "all published: sent as before");
  for (const mode of [{ managed: [crypto.randomBytes(20).toString("hex")] }, { managed: commits, otherEnclave: true }]) {
    reset(mode);
    await assert.rejects(near.complete(conn(), { model: MODEL_ID, messages: [{ role: "user", content: "secret" }] }), (e) => e.code === "near_unproven", JSON.stringify(mode));
    assert.equal(fake.posts.length, 0, "no request reached NEAR AI");
  }
});
