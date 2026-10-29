// The AI that comes with Closedhand on the person's computer: the key a
// personal URL claim brings is kept sealed and never handed on, it becomes the
// models unless the person set up their own AI account, what is left is read
// from OpenRouter with the key itself, the person is told once when most of it
// is used, and a refusal is said in fixed words. Invented keys and people only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64");
const root = path.join(__dirname, "..");
const policy = require("../lib/model-policy");
const KEY = "sk-or-v1-" + "ab".repeat(32);
const MODELS = { chat: "deepseek/deepseek-v4.1-flash", background: "deepseek/deepseek-v4.1-flash" };
const tick = () => new Promise((r) => setImmediate(r));
async function until(check) { for (let i = 0; i < 50 && !check(); i++) await tick(); }

function load(file, stubs, extra = {}) {
  const mod = { exports: {} };
  const sandbox = { module: mod, exports: mod.exports, console: { log() {}, error() {}, warn() {} }, URL, URLSearchParams, Buffer, AbortSignal, Date, JSON, Math, Promise, setTimeout, setInterval, setImmediate,
    process: { env: { PORT: "3000" } }, ...extra,
    require: (name) => { if (name in stubs) return stubs[name]; throw new Error("unexpected require " + name); } };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox);
  return mod.exports;
}

// The person's settings, changed only the way settings-patch.js changes them.
function settingsStore(initial = {}) {
  const box = { settings: structuredClone(initial) };
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { settings: structuredClone(box.settings) } }), maybeSingle: async () => ({ data: { settings: structuredClone(box.settings) } }) }) }) }) };
  const patch = { patchSettings: async (db, id, { set = {}, unset = [] } = {}) => { Object.assign(box.settings, structuredClone(set)); for (const k of unset) delete box.settings[k]; return box.settings; },
    diff: (before, after) => { const set = {}, unset = []; for (const k of Object.keys(after)) if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) set[k] = after[k]; for (const k of Object.keys(before)) if (!(k in after)) unset.push(k); return { set, unset }; } };
  return { box, supabase, patch };
}

test("a claim's AI key is kept by the claim and never handed on", async () => {
  const received = [], values = {};
  const request = async (url) => ({ ok: true, json: async () => ({ state: "pending", url: "https://alex.closedhand.ai", included_ai: { key: KEY, models: MODELS } }) });
  const registration = load("webapp/phone-registration.js", {
    "node:crypto": crypto,
    "./config": { getConf: async (k) => values[k], setConf: async (p) => Object.assign(values, p) },
    "./crypto-tokens": { encryptString: (x) => "enc:v1:" + x, decryptString: (x) => x?.replace(/^enc:v1:/, "") },
    "./included-ai-setup": { receive: async (x) => received.push(x) },
  }, { fetch: request });
  const data = await registration.claim("ABC234");
  assert.equal(data.included_ai, undefined, "the answer carries no key");
  assert.ok(!JSON.stringify(data).includes(KEY));
  assert.deepEqual(received, [{ key: KEY, models: MODELS }]);
  const microsoft = await registration.claimWithSignIn("microsoft", "id-token");
  assert.equal(microsoft.included_ai, undefined);
  assert.equal(received.length, 2);
});

function setup(store, prepare) {
  return load("webapp/included-ai-setup.js", {
    "./db": { supabase: store.supabase }, "./admin": { getAdminUserId: () => "admin" }, "./settings-patch": store.patch, "./model-policy": policy,
    "./model-config": { prepare, withConfig: (settings, config) => ({ ...settings, model_config: policy.sealConfig(config), llm_provider: "custom" }) },
  }, { fetch: async () => ({ ok: false }) });
}
const prepared = (input) => ({ version: 1, connections: { primary: { provider: "openrouter", backend: "custom", baseUrl: "https://openrouter.ai/api/v1", apiKey: input.primary.apiKey } },
  roles: { chat: { connection: "primary", model: input.model }, background: { connection: "primary", model: input.backgroundModel }, vision: null } });

test("the key becomes the models, sealed, reading images with the same model, support on it too", async () => {
  const store = settingsStore({ preferred_name: "Mira" });
  let asked;
  const ai = setup(store, async (input) => { asked = input; return prepared(input); });
  assert.equal(await ai.receive({ key: KEY, models: MODELS }), true);
  await until(() => store.box.settings.model_config);
  assert.match(store.box.settings.included_api_key, /^enc:v1:/);
  assert.ok(!JSON.stringify(store.box.settings).includes(KEY), "the key is never stored readable");
  assert.equal(store.box.settings.model_config.included, true);
  assert.deepEqual({ provider: asked.primary.provider, model: asked.model, backgroundMode: asked.backgroundMode, visionMode: asked.visionMode }, { provider: "openrouter", model: MODELS.chat, backgroundMode: "same", visionMode: "same" });
  assert.equal(policy.getRole(store.box.settings, "chat").apiKey, KEY, "it opens only where a role is used");
  assert.equal(store.box.settings.preferred_name, "Mira", "nothing else changes");
});

test("pictures and videos go to the model given for them, checked; failing that the chat model, then none", async () => {
  const store = settingsStore({});
  const tried = [];
  const ai = setup(store, async (input) => {
    tried.push([input.visionMode, input.visionModel || null]);
    if (input.visionMode !== "same") throw Object.assign(new Error("The image check did not pass."), { visionNeeded: true });
    return prepared(input);
  });
  assert.equal(await ai.receive({ key: KEY, models: { ...MODELS, vision: "vendor/watch-and-hear" } }), true);
  await until(() => store.box.settings.model_config);
  assert.deepEqual(tried, [["separate", "vendor/watch-and-hear"], ["same", null]], "the one for pictures first, on the same key");
  assert.equal(store.box.settings.included_ai.models.vision, "vendor/watch-and-hear");
  assert.equal(store.box.settings.included_ai.error, undefined);
  const bad = settingsStore({});
  await setup(bad, async (input) => prepared(input)).receive({ key: KEY, models: { ...MODELS, vision: "../etc" } });
  await until(() => bad.box.settings.model_config);
  assert.equal(bad.box.settings.included_ai.models.vision, undefined, "a malformed one is never kept");
});

test("when the image check fails it is used without images, never not at all", async () => {
  const store = settingsStore({});
  const tried = [];
  const ai = setup(store, async (input) => {
    tried.push(input.visionMode);
    if (input.visionMode !== "off") throw Object.assign(new Error("The image check did not pass."), { visionNeeded: true });
    return prepared(input);
  });
  assert.equal(await ai.receive({ key: KEY, models: MODELS }), true);
  await until(() => store.box.settings.model_config);
  assert.deepEqual(tried, ["same", "off"]);
  assert.equal(store.box.settings.model_config.included, true);
  assert.equal(store.box.settings.included_ai.error, undefined);
});

test("a person's own AI account stays; the included key waits beside it", async () => {
  const own = { version: 1, connections: { primary: { provider: "anthropic", backend: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: policy.sealKey("sk-own-key") } }, roles: { chat: { connection: "primary", model: "claude-x" }, background: { connection: "primary", model: "claude-x" }, vision: null } };
  const store = settingsStore({ model_config: own, llm_provider: "anthropic" });
  let checked = false;
  const ai = setup(store, async (input) => { checked = true; return prepared(input); });
  await ai.receive({ key: KEY, models: MODELS });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(checked, false, "their setup is not even checked against");
  assert.deepEqual(store.box.settings.model_config, own);
  assert.match(store.box.settings.included_api_key, /^enc:v1:/);
  // Asked for, it switches, keeping their own setup, key and all.
  assert.equal(await ai.use(), true);
  assert.equal(store.box.settings.model_config.included, true);
  assert.deepEqual(store.box.settings.own_model_config, own, "nothing they entered is lost");
  assert.ok(!JSON.stringify(policy.publicSettings(store.box.settings)).includes(own.connections.primary.apiKey), "the kept key is never shown");
  // And back, in one step, as it was.
  assert.equal(await ai.useOwn(), true);
  assert.equal(store.box.settings.model_config.included, undefined);
  assert.equal(policy.getRole(store.box.settings, "chat").apiKey, "sk-own-key");
  assert.equal(policy.getRole(store.box.settings, "chat").model, own.roles.chat.model);
  assert.equal(await setup(settingsStore({}), async (input) => prepared(input)).useOwn(), false, "nothing kept: their own is set up in Models");
});

test("a check that fails is recorded, so setup asks for an AI account instead of waiting", async () => {
  const store = settingsStore({});
  const ai = setup(store, async () => { throw new Error("The model provider returned HTTP 503."); });
  await ai.receive({ key: KEY, models: MODELS });
  await until(() => store.box.settings.included_ai?.error);
  assert.match(store.box.settings.included_ai.error, /503/);
  assert.equal(store.box.settings.model_config, undefined);
});

test("Closedhand's pick is followed: a changed model is switched to and named", async () => {
  const store = settingsStore({});
  let pick = MODELS, asked = 0;
  const realFetch = global.fetch;
  const ai = load("webapp/included-ai-setup.js", {
    "./db": { supabase: store.supabase }, "./admin": { getAdminUserId: () => "admin" }, "./settings-patch": store.patch, "./model-policy": policy,
    "./model-config": { prepare: async (input) => { asked++; return prepared(input); }, withConfig: (settings, config) => ({ ...settings, model_config: policy.sealConfig(config), llm_provider: "custom" }) },
    "./phone-registration": { includedAiState: async () => ({ models: pick }) },
  }, { fetch: async (url) => ({ ok: true, json: async () => ({ data: { name: url.includes("qwen") ? "Qwen: Qwen3 Next" : "DeepSeek: DeepSeek V4.1 Flash" } }) }) });
  await ai.receive({ key: KEY, models: MODELS });
  await until(() => store.box.settings.model_config);
  assert.equal(store.box.settings.included_ai.name, "DeepSeek V4.1 Flash", "the name people know it by");
  assert.equal(await ai.refresh(), false, "nothing changed, nothing done");
  pick = { chat: "qwen/qwen3-next", background: "qwen/qwen3-next" };
  assert.equal(await ai.refresh(), true);
  assert.equal(store.box.settings.included_ai.name, "Qwen3 Next");
  assert.equal(policy.getRole(store.box.settings, "chat").model, "qwen/qwen3-next", "switched over");
  assert.equal(asked, 2);
  global.fetch = realFetch;
});

test("only an OpenRouter key and a model name are taken", async () => {
  const store = settingsStore({});
  const ai = setup(store, async (input) => prepared(input));
  for (const bad of [null, { key: "sk-ant-x", models: MODELS }, { key: KEY, models: { chat: "../etc" } }, { key: KEY + "\n", models: MODELS }]) assert.equal(await ai.receive(bad), false);
  assert.deepEqual(store.box.settings, {});
});

test("what is left is read from OpenRouter with the person's own key", async () => {
  const included = require("../lib/included-ai");
  const settings = { included_api_key: policy.sealKey(KEY), model_config: { included: true } };
  const seen = [];
  const real = global.fetch;
  global.fetch = async (url, opts) => { seen.push({ url, opts }); return { ok: true, json: async () => ({ data: { limit: 10, usage: 8.5, limit_remaining: 1.5 } }) }; };
  try {
    assert.deepEqual(await included.credit(settings), { limit: 10, used: 8.5, left: 1.5 });
    assert.equal(seen[0].url, "https://openrouter.ai/api/v1/key");
    assert.equal(seen[0].opts.headers.Authorization, "Bearer " + KEY);
    assert.equal(seen[0].opts.headers["X-Title"], "Closedhand");
    global.fetch = async () => ({ ok: false, status: 401 });
    assert.equal(await included.credit(settings), null, "unknown, not zero, when it can't be read");
  } finally { global.fetch = real; }
  assert.equal(included.inUse(settings), true);
  assert.equal(included.inUse({ included_api_key: "x", model_config: { roles: {} } }), false, "their own account, not the included one");
  // Closedhand+ counts this paid month, from the use the key had when it began (the plan's base).
  global.fetch = async () => ({ ok: true, json: async () => ({ data: { limit: 47, usage: 31, limit_remaining: 16 } }) });
  const plus = { ...settings, included_ai: { ...settings.included_ai, plan: { name: "plus", renews_at: "2026-12-15T00:00:00.000Z", base: 27 } } };
  try { assert.deepEqual(await included.credit(plus), { limit: 20, used: 4, left: 16 }); } finally { global.fetch = real; }
});

test("what Closedhand says about Managed Models follows the plan, own provider first, never money", () => {
  const included = require("../lib/included-ai");
  const link = "https://alex.closedhand.ai/dashboard#settings";
  const first = { name: "first-month", ends_at: "2026-03-21T10:00:00.000Z", email: false };
  assert.equal(included.endingText(first, link, false, "Europe/London"),
    "Closedhand Managed Models, the LLM I've been using since you set me up, stays on until 21 March. After that, connect your own LLM provider in the dashboard (https://alex.closedhand.ai/dashboard#settings) (free ones work too), or keep Managed Models with Closedhand+.");
  assert.match(included.endingText({ ...first, email: true }, link, false, "Europe/London"), /with Closedhand\+, which also gives Closedhand's own email with no monthly limit\.$/);
  assert.match(included.endingText({ ...first, ends_at: "2026-03-21T23:30:00.000Z" }, link, false, "Asia/Tokyo"), /until 22 March\./, "the day where the person is");
  assert.equal(included.nearlyUsedText(first, link, false),
    "You've used most of the fair use of Closedhand Managed Models. To carry on without a break, connect your own LLM provider in the dashboard (https://alex.closedhand.ai/dashboard#settings) (free ones work too), or get Closedhand+ at closedhand.com/plus.");
  assert.equal(included.nearlyUsedText({ name: "plus" }, "/dashboard#settings", true),
    "You've used most of this month's fair use of Closedhand+. To carry on without a break, [carry on to the end of the month](https://closedhand.com/carry-on), or connect your own LLM provider in the [dashboard](/dashboard#settings).");
  assert.doesNotMatch(included.nearlyUsedText({ name: "plus", extended: true }, link, false), /end of the month at/, "never offered twice in a month");
  assert.equal(included.usedUpText(first, link, false, "Europe/London"),
    "You've reached the fair use of Closedhand Managed Models, so I can't reply for now. Connect your own LLM provider in the dashboard (https://alex.closedhand.ai/dashboard#settings) (free ones work too) and I'll carry on, or get Closedhand+ at closedhand.com/plus.");
  assert.equal(included.usedUpText({ name: "plus", renews_at: "2026-12-15T00:00:00.000Z" }, link, false, "Europe/London"),
    "You've reached this month's fair use of Closedhand+, so I can't reply until 15 December. Carry on to the end of the month at closedhand.com/carry-on, or connect your own LLM provider in the dashboard (https://alex.closedhand.ai/dashboard#settings).", "back on the day it renews, not the 1st");
  assert.equal(included.usedUpText({ name: "plus", ends_at: "2026-12-15T00:00:00.000Z", extended: true }, link, false, "Europe/London"),
    "You've reached this month's fair use of Closedhand+, so I can't reply for now. Connect your own LLM provider in the dashboard (https://alex.closedhand.ai/dashboard#settings) to carry on.", "cancelled, still in its paid month: the same words, with no renewal to name");
  assert.equal(included.usedUpText({ name: "plus", ends_at: "2026-12-15T00:00:00.000Z" }, link, false, "Europe/London"),
    "You've reached this month's fair use of Closedhand+, so I can't reply for now. Carry on to the end of the month at closedhand.com/carry-on, or connect your own LLM provider in the dashboard (https://alex.closedhand.ai/dashboard#settings).");
  assert.match(included.usedUpText({ name: "plus", renews_at: "2026-12-15T00:00:00.000Z", extended: true }, link, false, "Europe/London"), /until 15 December\. .* to carry on before then\.$/);
  assert.match(included.usedUpText({ name: "ended", was: "plus" }, link, false), /^Your Closedhand\+ has ended, so I can't reply for now\. .* or subscribe again at closedhand\.com\/plus\.$/);
  assert.match(included.usedUpText({ name: "ended", was: "first-month" }, link, false), /^Closedhand Managed Models has ended, so I can't reply for now\. .* or keep Managed Models with Closedhand\+ at closedhand\.com\/plus\.$/);
  assert.equal(included.usedUpText({ name: "ended" }, link, false), included.usedUpText({ name: "ended", was: "first-month" }, link, false), "unknown: the first month's words");
  assert.equal(included.usedUpText(undefined, link, false), included.usedUpText(first, link, false), "no plan known yet: as a first month");
  assert.equal(included.period(first), "first-month:2026-03-21T10:00:00.000Z");
  assert.equal(included.period({ name: "plus", renews_at: "2026-04-15T00:00:00.000Z" }), "plus:2026-04-15T00:00:00.000Z", "one warning per paid month");
  assert.equal(included.period({ name: "plus", renews_at: "2026-04-15T00:00:00.000Z", extended: true }), "plus:2026-04-15T00:00:00.000Z:extended");
  assert.equal(included.period({ name: "ended" }), null);
  assert.match(included.accountProblemText(402, null, false), /needs payment or more credit.*dashboard's Settings\.$/);
  assert.match(included.accountProblemText(401, null, false), /rejected Closedhand's API key/);
  const all = [included.endingText(first, null, false), included.nearlyUsedText(first, null, false), included.nearlyUsedText({ name: "plus" }, null, false),
    included.usedUpText(first, null, false), included.usedUpText({ name: "plus" }, null, false), included.usedUpText({ name: "ended", was: "plus" }, null, false),
    included.usedUpText({ name: "ended" }, null, false), included.accountProblemText(402, null, false), included.accountProblemText(401, null, false)];
  for (const text of all) assert.doesNotMatch(text, /\bAI\b(?! key)/, "the LLM is the LLM, never 'AI': " + text);
  for (const text of all.slice(0, 7)) assert.doesNotMatch(text, /\$|%|credit|tokens?\b|free until|trial/i, "no money, shares, tokens or trial words: " + text);
  // Their own provider is offered first wherever a Managed Models message offers both.
  for (const text of all.slice(0, 7)) {
    const own = text.indexOf("your own LLM provider"), plus = text.search(/Closedhand\+ at|with Closedhand\+|end of the month at|subscribe again/);
    if (own >= 0 && plus >= 0 && !/Closedhand\+\. To carry on|Closedhand\+, so I can't/.test(text)) assert.ok(own < plus, "own provider first: " + text);
  }
});

// The bot's half-hourly job (included-credit.js) over a settings store.
function messages(store, usage) {
  const included = require("../lib/included-ai");
  const told = [], notices = [];
  const job = load("lib/included-credit.js", {
    "./included-ai": { ...included, credit: async () => ({ limit: 20, used: usage.now, left: 20 - usage.now }) },
    "./admin": { getAdminUserId: () => "admin" },
    "../user-store": { UserStore: { load: async () => ({ profile: { settings: structuredClone(store.box.settings) } }) } },
    "./connection-alert": {
      notifyAboutAi: async (id, s, textFor) => { told.push(textFor("https://alex.closedhand.ai/dashboard#settings", false)); return true; },
      notifyFromClosedhand: async (id, s, text) => { notices.push(text); return true; },
    },
    "./timezone": { getUserTimezone: () => "Europe/London" },
    "./db": { supabase: store.supabase }, "./settings-patch": store.patch,
  });
  return { job, told, notices };
}

test("a first month: most of the fair use is said once, and its end once, in its last week", async () => {
  const ends = new Date(Date.now() + 10 * 86400000).toISOString();
  const store = settingsStore({ included_api_key: policy.sealKey(KEY), model_config: { included: true }, included_ai: { models: MODELS, plan: { name: "first-month", ends_at: ends, email: false } } });
  const usage = { now: 14 };
  const { job, told } = messages(store, usage);
  assert.equal(await job.check(), 0, "70% used, ten days left: nothing said");
  usage.now = 16.5;
  assert.equal(await job.check(), 1);
  assert.match(told[0], /^You've used most of the fair use of Closedhand Managed Models\./);
  assert.equal(await job.check(), 0, "said once");
  store.box.settings.included_ai.plan.ends_at = new Date(Date.now() + 6.5 * 86400000).toISOString();
  store.box.settings.included_told.nearly = "first-month:" + store.box.settings.included_ai.plan.ends_at;
  assert.equal(await job.check(), 1);
  assert.match(told[1], /^Closedhand Managed Models, the LLM I've been using since you set me up, stays on until \d{1,2} [A-Z][a-z]+\. After that, connect your own LLM provider/);
  assert.equal(await job.check(), 0, "the end is said once");
  assert.equal(told.length, 2);
});

test("Closedhand+: most of the fair use is said once a month, and again after carrying on", async () => {
  const store = settingsStore({ included_api_key: policy.sealKey(KEY), model_config: { included: true }, included_ai: { models: MODELS, plan: { name: "plus", renews_at: "2026-04-01T00:00:00.000Z", email: true } } });
  const usage = { now: 17 };
  const { job, told } = messages(store, usage);
  assert.equal(await job.check(), 1);
  assert.match(told[0], /^You've used most of this month's fair use of Closedhand\+\. To carry on without a break, carry on to the end of the month at closedhand\.com\/carry-on/);
  assert.equal(await job.check(), 0);
  store.box.settings.included_ai.plan.extended = true;
  assert.equal(await job.check(), 1, "a new ceiling, a new notice");
  assert.doesNotMatch(told[1], /end of the month at/);
  // On their own LLM provider nothing about Managed Models is said.
  store.box.settings.model_config = { included: false };
  store.box.settings.included_told = {};
  assert.equal(await job.check(), 0);
});

test("notices closedhand.com sent this account go out once, whatever LLM is in use", async () => {
  const store = settingsStore({ model_config: { roles: {} }, included_notices: [{ id: "first-months-75", text: "Free first months this month are at 75% of what you set." }] });
  const { job, notices } = messages(store, { now: 0 });
  assert.equal(await job.check(), 1);
  assert.deepEqual(notices, ["Free first months this month are at 75% of what you set."]);
  assert.deepEqual(store.box.settings.included_notices_sent, ["first-months-75"]);
  assert.equal(await job.check(), 0, "never twice");
  assert.equal(notices.length, 1);
});

test("when the AI account refuses, the chat says so in fixed words instead of 'something went wrong'", () => {
  const engine = fs.readFileSync(path.join(root, "lib/engine.js"), "utf8");
  assert.match(engine, /error\.status === 402 \|\| error\.status === 401/);
  assert.match(engine, /if \(refused\) return aiAccountRefused\(refused\);/);
  // OpenRouter refuses a key past its own limit with 403: that is used up too.
  assert.match(engine, /const refused = error\.code === "key_limit" \? 402 :/);
  for (const f of ["lib/model-wire.js", "webapp/model-wire.js"]) assert.match(fs.readFileSync(path.join(root, f), "utf8"), /response\.status === 403 && \(detail\.error\?\.metadata\?\.limit_source === "openrouter_key_limit" \|\| \/key limit\/i\.test\(said\)\)\) error\.code = "key_limit"/);
  assert.match(engine, /if \(included\.inUse\(settings\)\) return status === 402 \? included\.usedUpText\(settings\.included_ai\?\.plan, link, web, require\("\.\/timezone"\)\.getUserTimezone\(ctx\.activeUserStore\)\)/);
  // OpenRouter credits the traffic to Closedhand, in both copies.
  for (const f of ["lib/model-wire.js", "webapp/model-wire.js"]) assert.match(fs.readFileSync(path.join(root, f), "utf8"), /"HTTP-Referer": "https:\/\/closedhand\.com", "X-Title": "Closedhand"/);
  // Every direct call to an LLM endpoint names Closedhand too, so none shows
  // on OpenRouter as an unknown app.
  const { appHeaders } = require(path.join(root, "lib/model-wire"));
  assert.deepEqual(appHeaders("https://openrouter.ai/api/v1/embeddings"), { "HTTP-Referer": "https://closedhand.com", "X-Title": "Closedhand" });
  assert.deepEqual(appHeaders("https://api.deepinfra.com/v1/openai/embeddings"), {});
  for (const f of ["lib/services/usi.js", "webapp/rag-processor.js"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    const calls = src.match(/"Authorization": `Bearer \$\{(?:machineryKey\(\)|embedKey\(\)|DEEPINFRA_API_KEY)\}`[^}]*\}/g) || [];
    assert.ok(calls.length >= 3, f);
    for (const c of calls) assert.match(c, /\.\.\.appHeaders\(/, f + ": " + c);
  }
  assert.match(fs.readFileSync(path.join(root, "lib/provider-search.js"), "utf8"), /\.\.\.headers, \.\.\.appHeaders\(url\)/);
});

test("Closedhand speaks as itself: it names its LLM only when asked, explains how it is built, never speaks as the LLM", () => {
  const engine = fs.readFileSync(path.join(root, "lib/engine.js"), "utf8");
  assert.match(engine, /your LLM is one part of you\. Never speak as it or claim its name, maker or knowledge cutoff\./);
  assert.match(engine, /Name your LLM only if \$\{userName\} asks: "I'm \$\{botName\}\. My LLM right now is/);
  assert.match(engine, /Never show or repeat an API key, token or password, theirs or yours \(the Managed Models key too\)/);
  assert.match(engine, /About Closedhand the company, say only what closedhand\.com publishes \(Closedhand\+ and Always on too\); for its own costs, users or systems, point to support@closedhand\.com\./);
  assert.match(engine, /Always on, in My Account on the dashboard, moves all of you to a server in \$\{userName\}'s own Railway account/, "it can explain Always on");
  assert.match(engine, /Closedhand\+ \(\$\{prices\.plus \? prices\.plus \+ " a month" : "a monthly subscription"\}\) keeps them going/, "and Closedhand+, with its price");
  assert.match(engine, /let prompt = identityLines\(\) \+ builtLines\(\) \+/, "how it is built goes in the full prompt only");
  assert.match(engine, /HOW YOU ARE BUILT \(public: Closedhand is open source/);
  assert.match(engine, /Managed Models requests go from this computer through OpenRouter only to LLM providers that keep nothing sent and don't train on it/, "asked what happens to what it sends, it knows");
  for (const page of ["webapp/views/setup.html", "webapp/views/dashboard.html"]) assert.match(fs.readFileSync(path.join(root, page), "utf8"), /Managed Models only ever uses LLM providers that do not store or train on your data or conversations\./, page);
  assert.match(fs.readFileSync(path.join(root, "closedhand-com/public/account.js"), "utf8"), /They run through OpenRouter, only on LLM providers that do not store or train on your data or conversations\./, "the Closedhand+ blurb says it too");
  assert.match(engine, /if \(pick && settings\.model_config\?\.included\) return `\$\{settings\.included_ai\?\.name \|\| pick\.model\} \(Closedhand Managed Models/);
  assert.doesNotMatch(engine, /technical architecture/, "how it is built is not a secret");
  assert.doesNotMatch(engine, /closedhand\.com never sees/, "remote dashboard pages pass through the relay");
});

function refresher(store, answer) {
  return load("webapp/included-ai-setup.js", {
    "./db": { supabase: store.supabase }, "./admin": { getAdminUserId: () => "admin" }, "./settings-patch": store.patch, "./model-policy": policy,
    "./model-config": { prepare: async (input) => prepared(input), withConfig: (settings, config) => ({ ...settings, model_config: policy.sealConfig(config), llm_provider: "custom" }) },
    "./phone-registration": { includedAiState: async () => answer.now },
  }, { fetch: async () => ({ ok: true, json: async () => ({ data: { name: "DeepSeek: DeepSeek V4.1 Flash" } }) }) });
}

test("each hour: the plan is kept, a waiting key is taken sealed, and notices are kept once for the bot", async () => {
  const store = settingsStore({});
  const notice = { id: "first-months-75", text: "Free first months this month are at 75% of what you set." };
  const answer = { now: { models: MODELS, plan: { name: "plus", renews_at: "2026-04-01T00:00:00Z", email: true, base: 12.5, ignored: "x" }, prices: { plus: "$10", extend: "$8" }, key: KEY, notices: [notice, { id: "bad id!", text: "x" }] } };
  const ai = refresher(store, answer);
  assert.equal(await ai.refresh(), true);
  await until(() => store.box.settings.model_config);
  assert.match(store.box.settings.included_api_key, /^enc:v1:/);
  assert.ok(!JSON.stringify(store.box.settings).includes(KEY), "the key is never stored readable");
  assert.equal(store.box.settings.model_config.included, true, "set up as a claim's key is");
  assert.deepEqual(store.box.settings.included_ai.plan, { name: "plus", email: true, renews_at: "2026-04-01T00:00:00.000Z", base: 12.5 }, "the base this paid month counts from is kept");
  assert.deepEqual(store.box.settings.included_ai.prices, { plus: "$10", extend: "$8" }, "what Closedhand+ costs, to say when asked");
  assert.deepEqual(store.box.settings.included_notices, [notice], "only well-formed notices");
  // The same answer again, without a key: nothing new.
  answer.now = { models: MODELS, plan: answer.now.plan, prices: answer.now.prices, notices: [notice] };
  assert.equal(await ai.refresh(), false);
  assert.equal(store.box.settings.included_notices.length, 1, "kept once");
  // Sent by the bot: let go, and never kept again.
  store.box.settings.included_notices_sent = [notice.id];
  assert.equal(await ai.refresh(), true);
  assert.deepEqual(store.box.settings.included_notices, []);
  assert.equal(await ai.refresh(), false);
  // An ended plan remembers what it was; a plan closedhand.com names oddly changes nothing.
  answer.now = { models: MODELS, plan: { name: "ended", email: false } };
  assert.equal(await ai.refresh(), true);
  assert.deepEqual(store.box.settings.included_ai.plan, { name: "ended", email: false, was: "plus" });
  answer.now = { models: MODELS, plan: { name: "free" } };
  assert.equal(await ai.refresh(), false);
  assert.equal(store.box.settings.included_ai.plan.name, "ended");
  // A computer that never asked for a personal URL asks nothing.
  answer.now = null;
  assert.equal(await ai.refresh(), false);
  assert.match(fs.readFileSync(path.join(root, "webapp/included-ai-setup.js"), "utf8"), /setInterval\(run, 60 \* 60 \* 1000\)/, "every hour");
  assert.match(fs.readFileSync(path.join(root, "webapp/phone-registration.js"), "utf8"), /if \(!\(await getConf\('PHONE_INSTALL_ID'\)\)\) return null;\n  return \(await call\('included-ai', 'GET'\)\) \|\| null;/);
});

// The dashboard's Settings line for Managed Models, run as the page runs it.
// Settings' plan row (dashboard.html renderIncludedPlan), drawn into a stand-in page.
function settingsPlan() {
  const page = fs.readFileSync(path.join(root, "webapp/views/dashboard.html"), "utf8");
  const start = page.indexOf("    function accountLink(");
  const end = page.indexOf("    var includedState = null, llmStep = null;");
  assert.ok(start > 0 && end > start);
  const els = {};
  const el = (id) => (els[id] ||= { id, hidden: false, textContent: "", className: "", replaceChildren(...parts) { this.textContent = parts.map((p) => typeof p === "string" ? p : `[${p.textContent}](${p.href})`).join(""); } });
  const box = { document: { createElement: () => ({ style: {} }), getElementById: el }, Date, out: null };
  vm.runInNewContext(page.slice(start, end) + "\nout = renderIncludedPlan;", box);
  return (data) => {
    box.out(data);
    const word = els["included-ai-plan-status"];
    return { name: els["included-ai-plan-name"].textContent, status: word.hidden ? null : `${word.textContent} (${word.className})`, said: els["included-ai-plan"].textContent, resume: !els["included-ai-resume"].hidden };
  };
}

test("Settings shows the person's own plan as a row apart from what Managed Models are: its status word, what it means, and Resume once cancelled", () => {
  const plan = settingsPlan();
  const day = (days) => new Date(Date.now() + days * 86400000).toISOString();
  const link = " Your plan and this month's use are in [My Account](#account).";
  assert.deepEqual(plan({ state: "in-use", plan: { name: "plus", ends_at: "2026-11-27T14:19:56.000Z" } }), { name: "Your Closedhand+ subscription", status: "Cancelled (plan-status cancelled)",
    said: "Continues until 27 November, then ends. After that Closedhand needs your own LLM provider to reply." + link, resume: true }, "cancelled but running: red, what it means, and the way back");
  assert.deepEqual(plan({ state: "available", plan: { name: "plus" } }), { name: "Your Closedhand+ subscription", status: "Active (plan-status on)", said: "Closedhand Managed Models come with it." + link, resume: false });
  assert.equal(plan({ plan: { name: "first-month", ends_at: day(20) } }).said, "Closedhand Managed Models come with it." + link, "the first month's end only in its last week");
  assert.match(plan({ plan: { name: "first-month", ends_at: day(5) } }).said, /^Closedhand Managed Models come with it, until \d+ \w+\./);
  assert.equal(plan({ plan: { name: "first-month" } }).status, null);
  assert.equal(plan({ state: "in-use", plan: { name: "ended", was: "plus" } }).status, "Ended (plan-status over)", "an ended plan is said here too: Closedhand stops answering with it");
  const page = fs.readFileSync(path.join(root, "webapp/views/dashboard.html"), "utf8");
  assert.doesNotMatch(page, /shareText|usage-included|of your free use left|free until/i);
  const server = fs.readFileSync(path.join(root, "webapp/server.js"), "utf8");
  const route = server.slice(server.indexOf('app.get("/api/included-ai"'), server.indexOf('app.post("/api/included-ai/use"'));
  assert.doesNotMatch(route, /credit|nearly/, "nothing about use: it is in My Account");
  assert.match(server, /await require\("\.\/included-ai-setup"\)\.refresh\(\)/, "cancelling or resuming shows at once");
  assert.match(page, /onclick="setPlusCancel\(false, this\)">Resume<\/button>/, "Resume as in My Account");
});

test("Usage never names the LLMs of Managed Models, and shows their use without prices, tokens or costs", () => {
  const page = fs.readFileSync(path.join(root, "webapp/views/dashboard.html"), "utf8");
  assert.match(page, /if \(usageManaged\) \{ el\.innerHTML = ''; return; \}/, "no prices to enter");
  assert.match(page, /if \(r\.model && r\.model !== 'managed' && r\.model !== 'unknown' && models\.indexOf\(r\.model\) === -1\) models\.push\(r\.model\);/, "never priced");
  assert.match(page, /rows\.forEach\(function \(r\) \{\n\s*if \(r\.model === 'managed'\) return;/, "never costed");
  assert.match(fs.readFileSync(path.join(root, "webapp/server.js"), "utf8"), /const own = \[\.\.\.new Set\(rows\.map\(\(r\) => r\.model\)\.filter\(\(m\) => m && m !== "managed" && m !== "unknown"\)\)\];/, "never looked up");
  assert.match(page, /const amount = r => usageManaged \? r\.calls : r\.tokens_in \+ r\.tokens_out;/, "counted by how often, not tokens");
  const tiles = page.slice(page.indexOf("if (usageManaged) return '<div class=\"usage-tile\">'"), page.indexOf("return '<div class=\"usage-tile\">' +\n          '<div class=\"t-name\">"));
  assert.ok(tiles.length > 0);
  assert.doesNotMatch(tiles, /fmtTokens|t-cost|fmtCost/);
  assert.match(page, /function modelLabel\(m\) \{ return m === 'managed' \? 'Closedhand Managed Models' : m; \}/);
  assert.equal((page.match(/escapeHtml\(modelLabel\((k|m)\)\)/g) || []).length, 2, "by that name in every key and tip");
  assert.match(page, /\{ label: modelLabel\(k\), color:/);
  assert.match(page, /const own = rows\.filter\(r => r\.model !== 'managed'\);/, "insights only on their own LLM provider's use");
  assert.match(page, /const head = \['Day', 'Kind of work', 'Model', 'Calls'\]\.concat\(managed \? \[\] : \['Tokens in', 'Tokens out', 'Cost in USD \(about\)'\]\);/, "the export has no tokens or cost on Managed Models");
});

test("subscribing in My Account moves Closedhand onto Managed Models at once, once the key is here", () => {
  const server = fs.readFileSync(path.join(root, "webapp/server.js"), "utf8");
  const route = server.slice(server.indexOf('app.post("/api/plus/welcome"'), server.indexOf('// A model\'s price per million tokens'));
  assert.match(route, /for \(let i = 0; i < 8; i\+\+\) \{\n\s*await setup\.refresh\(\)\.catch\(\(\) => \{\}\);/, "collected now, not within the hour");
  assert.match(route, /if \(settings\.included_api_key && settings\.included_ai\?\.plan\?\.name === "plus"\) \{\n\s*if \(!settings\.model_config\?\.included\) await setup\.use\(\);/, "only onto what was paid for");
  assert.ok(server.indexOf('app.post("/api/plus/welcome"') > server.indexOf("// --- The gate: everything registered below needs the session"), "behind the login gate");
});

test("use on Managed Models is recorded by that name alone, whichever LLMs carried it", async () => {
  const recorded = [];
  let settings = { model_config: { included: true, roles: { chat: { model: "maker/big-model" }, background: { model: "maker/small-model" } } }, included_ai: { models: { chat: "maker/big-model", vision: "maker/eye-model" } } };
  const stand = (name, exports) => { const id = require.resolve(name); const was = require.cache[id]; require.cache[id] = { id, filename: id, loaded: true, exports }; return () => { if (was) require.cache[id] = was; else delete require.cache[id]; }; };
  const restore = [
    stand("../lib/db", { isDbConfigured: () => true, supabase: {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings } }) }) }) }),
      rpc: async (name, args) => { recorded.push([args.p_feature, args.p_model]); return {}; },
    } }),
    stand("../lib/admin", { getAdminUserId: () => "00000000-0000-4000-8000-000000000001" }),
  ];
  const usage = require("../lib/usage");
  try {
    usage.recordUsage("chat", "maker/big-model", { input_tokens: 10, output_tokens: 2 });
    usage.recordUsage("machinery", "maker/small-model", { input_tokens: 10, output_tokens: 2 });
    usage.recordUsage("vision", "maker/eye-model", { input_tokens: 10, output_tokens: 2 });
    usage.recordUsage("embeddings", "local:embedder", { input_tokens: 10, output_tokens: 0 });
    await usage.flushUsage();
    assert.deepEqual(recorded, [["chat", "managed"], ["machinery", "managed"], ["vision", "managed"], ["embeddings", "local:embedder"]]);
    recorded.length = 0;
    settings = { model_config: { roles: { chat: { model: "maker/big-model" } } } };
    usage.recordUsage("chat", "maker/big-model", { input_tokens: 10, output_tokens: 2 });
    await usage.flushUsage();
    assert.deepEqual(recorded, [["chat", "maker/big-model"]], "their own LLM provider's, by its name");
  } finally {
    for (const undo of restore) undo();
  }
});

// Closedhand Managed Models are shown by that name with what they are, in
// setup and Settings alike: Closedhand picks the best LLM for each job from
// any provider. Which LLM it is right now is said in chat when asked, so the
// page has no hover naming it (and no lookup feeding one).
test("Managed Models say what they are, and which LLM is said in chat when asked", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const line = "Closedhand picks the best LLM for each job, from any provider, and switches when a better one is out.";
  for (const f of ["webapp/views/setup.html", "webapp/views/dashboard.html"]) {
    const page = read(f);
    assert.ok(page.includes(line), f);
    assert.doesNotMatch(page, /llmHint\(/, `${f}: no hover naming the LLM`);
  }
  assert.doesNotMatch(read("webapp/public/llm-hint.js"), /window\.llmHint\b/);
  assert.doesNotMatch(read("webapp/setup-state.js"), /modelIncludedName/);
  assert.doesNotMatch(read("webapp/server.js"), /model: settings\.included_ai\?\.name/);
  assert.match(read("lib/engine.js"), /\(Closedhand Managed Models, which Closedhand picks, through OpenRouter\)/, "chat still names it when asked");
});

test("a model's price is the one the company it is used with charges, from OpenRouter's public list, read once a day", async () => {
  const prices = require("../webapp/model-prices");
  const list = { data: [
    { id: "~deepseek/deepseek-flash-latest", pricing: { prompt: "0.000000022", completion: "0.00000121" } },
    { id: "deepseek/deepseek-v4-flash", created: 100, pricing: { prompt: "0.00000004", completion: "0.0000004" } },
    { id: "deepseek/deepseek-v4.1-flash-1017", created: 200, pricing: { prompt: "0.00000001", completion: "0.0000001" } },
    { id: "deepseek/deepseek-v4.1-flash:batch", created: 300, pricing: { prompt: "0.00000005", completion: "0.00000015" } },
    { id: "anthropic/claude-sonnet-4.5", created: 50, pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" } },
    { id: "meta-llama/llama-free", pricing: { prompt: "0", completion: "0" } },
  ] };
  const endpoints = {
    "deepseek/deepseek-v4.1-flash-1017": [{ provider_name: "Cheap Host", pricing: { prompt: "0.00000001", completion: "0.0000001" } }, { provider_name: "DeepSeek", pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003" } }],
    "anthropic/claude-sonnet-4.5": [{ provider_name: "Anthropic", pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" } }],
  };
  const asked = [];
  const request = async (url) => {
    asked.push(url);
    assert.match(url, /^https:\/\/openrouter\.ai\/api\/v1\/models(\/[a-z0-9.-]+\/[a-z0-9.-]+\/endpoints)?$/, "only public lists, nothing about the person");
    const m = url.match(/models\/(.+)\/endpoints$/);
    return { ok: true, json: async () => (m ? { data: { endpoints: endpoints[m[1]] || [] } } : list) };
  };
  const got = await prices.pricesFor({ "deepseek-flash": "api.deepseek.com", "claude-sonnet-4-5": "api.anthropic.com", "anthropic/claude-sonnet-4.5": "openrouter.ai", "llama-free": null, "my-finetune": "llm.example.com" }, request);
  assert.deepEqual(got["deepseek-flash"], { in: 0.15, out: 0.6, cached: 0.003, listed: "deepseek/deepseek-v4.1-flash-1017", by: "DeepSeek" }, "DeepSeek's own price for its newest Flash, not the cheapest host's");
  assert.deepEqual(got["claude-sonnet-4-5"], { in: 3, out: 15, cached: 0.3, listed: "anthropic/claude-sonnet-4.5", by: "Anthropic" }, "a provider's own spelling");
  assert.equal(got["anthropic/claude-sonnet-4.5"].by, "OpenRouter", "an OpenRouter model at OpenRouter: its price there");
  assert.deepEqual(got["llama-free"], { in: 0, out: 0, cached: 0, listed: "meta-llama/llama-free", by: null }, "free is a price too");
  assert.equal(got["my-finetune"], undefined, "not listed: no price, never a guess");
  assert.ok(!asked.some((u) => u.includes(":batch")), "never a batch variant's price");
  const more = await prices.pricesFor({ "claude-sonnet-4-5": "anthropic", "llama3.2": "ollama", "qwen3": "host.docker.internal:11434" }, request);
  assert.equal(more["claude-sonnet-4-5"].by, "Anthropic", "a connection with no address: the provider's name in Settings");
  assert.deepEqual([more["llama3.2"].local, more["llama3.2"].in, more.qwen3.local], [true, 0, true], "on the person's own computer: no charge per token");
  for (const [host, company] of Object.entries({ "api.deepinfra.com": "DeepInfra", "api.groq.com": "Groq", "api.x.ai": "xAI", "api.moonshot.ai": "Moonshot AI", "generativelanguage.googleapis.com": "Google AI Studio" })) {
    assert.equal(prices.COMPANIES[host], company, "every provider in Settings has its company: " + host);
  }
  const reads = asked.length;
  await prices.pricesFor({ "deepseek-flash": "api.deepseek.com" }, request);
  assert.equal(asked.length, reads, "read once a day");
});

test("each call's cached tokens and any reported cost are kept beside its tokens", async () => {
  const recorded = [];
  const stand = (name, exports) => { const id = require.resolve(name); const was = require.cache[id]; require.cache[id] = { id, filename: id, loaded: true, exports }; return () => { if (was) require.cache[id] = was; else delete require.cache[id]; }; };
  const restore = [
    stand("../lib/db", { isDbConfigured: () => true, supabase: {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings: {} } }) }) }) }),
      rpc: async (name, args) => { recorded.push(args); return {}; },
    } }),
    stand("../lib/admin", { getAdminUserId: () => "00000000-0000-4000-8000-000000000001" }),
  ];
  try {
    const usage = require("../lib/usage");
    usage.recordUsage("chat", "claude-sonnet-4-5", { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 });
    usage.recordUsage("chat", "deepseek-flash", { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 800, input_includes_cache: true });
    usage.recordUsage("enrichment", "deepseek-flash", { prompt_tokens: 500, completion_tokens: 5, prompt_cache_hit_tokens: 400 });
    usage.recordUsage("chat", "openai/gpt-5", { input_tokens: 200, output_tokens: 10, input_includes_cache: true, cost_usd: 0.0021 });
    await usage.flushUsage();
    const of = (feature, model) => recorded.find((r) => r.p_feature === feature && r.p_model === model);
    assert.deepEqual([of("chat", "claude-sonnet-4-5").p_tokens_in, of("chat", "claude-sonnet-4-5").p_tokens_cached], [1050, 900], "Anthropic counts cache reads and writes apart: all of it was sent");
    assert.deepEqual([of("chat", "deepseek-flash").p_tokens_in, of("chat", "deepseek-flash").p_tokens_cached], [1000, 800]);
    assert.deepEqual([of("enrichment", "deepseek-flash").p_tokens_in, of("enrichment", "deepseek-flash").p_tokens_cached], [500, 400], "DeepSeek's own word for it");
    assert.deepEqual([of("chat", "openai/gpt-5").p_cost_usd, of("chat", "openai/gpt-5").p_costed_calls], [0.0021, 1], "what the provider said it cost");
    assert.equal(of("chat", "deepseek-flash").p_costed_calls, 0);
  } finally { for (const undo of restore) undo(); }
  const wire = fs.readFileSync(path.join(root, "lib/model-wire.js"), "utf8");
  assert.match(wire, /cache_read_input_tokens: openaiResponse\.usage\?\.prompt_tokens_details\?\.cached_tokens \|\| openaiResponse\.usage\?\.prompt_cache_hit_tokens \|\| 0,\n\s*input_includes_cache: true,/);
  assert.match(wire, /cost_usd: typeof openaiResponse\.usage\?\.cost === "number" \? openaiResponse\.usage\.cost : null,/);
  assert.match(fs.readFileSync(path.join(root, "migrations/078_token_usage_cost.sql"), "utf8"), /DROP FUNCTION IF EXISTS public\.record_token_usage\(uuid, date, text, text, integer, bigint, bigint\);/, "one function, so named calls are never ambiguous");
});

// Usage, run as the page runs it: a month on the person's own LLM provider
// with a few days on Managed Models in it still shows their own provider's
// tokens and spend, with the Managed Models use as a count beside it. It used
// to switch the whole month to counting calls.
test("a few days on Managed Models never hides a month of the person's own LLM provider", async () => {
  const vm = require("node:vm");
  const page = fs.readFileSync(path.join(root, "webapp/views/dashboard.html"), "utf8");
  const code = page.slice(page.indexOf("    var usageManaged = false, usageAll = [];"), page.indexOf("    // Managed Models by that name alone"));
  const run = async (rows, inUse) => {
    const els = {}, rendered = [];
    const ctx = vm.createContext({
      usageDays: 30, usageRows: [], usagePrices: {}, usageListed: {},
      document: { getElementById: (id) => (els[id] = els[id] || { style: {}, textContent: "" }) },
      fetch: async (url) => ({ json: async () => (url.startsWith("/api/usage/summary") ? { rows } : { state: inUse ? "in-use" : "available" }) }),
      usageCost: (rs) => (rs.some((r) => r.model === "managed") ? NaN : rs.reduce((n, r) => n + r.tokens_in / 1e6, 0)),
      renderUsage: (rs) => rendered.push(rs.map((r) => r.model)),
      renderUsagePrices: () => {},
    });
    vm.runInContext(code + "\nthis.loadUsage = loadUsage; this.isManaged = () => usageManaged;", ctx);
    await ctx.loadUsage();
    return { sub: els["usage-sub"].textContent, rendered: rendered[0], managed: ctx.isManaged() };
  };
  const day = (model, calls, tokens) => ({ day: "2026-10-20", feature: "chat", model, calls, tokens_in: tokens, tokens_out: 0, tokens_cached: 0, cost_usd: 0, costed_calls: 0 });
  const mixed = await run([day("deepseek-flash", 900, 25_000_000), day("managed", 50, 138_000)], false);
  assert.equal(mixed.managed, false, "tokens and spend, not a count of calls");
  assert.deepEqual(mixed.rendered, ["deepseek-flash"], "the chart and tiles are their own provider's");
  assert.equal(mixed.sub, "About $25.00 with your LLM provider over these 30 days, and 50 calls on Closedhand Managed Models.");
  const onManaged = await run([day("deepseek-flash", 900, 25_000_000), day("managed", 50, 138_000)], true);
  assert.equal(onManaged.managed, true, "on Managed Models now, how often");
  assert.equal(onManaged.sub, "What Closedhand has been doing.");
  const onlyManaged = await run([day("managed", 50, 138_000)], false);
  assert.equal(onlyManaged.managed, true, "nothing of their own in the window: how often");
});

test("Settings, Models has a way to Usage in My Account", () => {
  const page = fs.readFileSync(path.join(root, "webapp/views/dashboard.html"), "utf8");
  const models = page.slice(page.indexOf('<div class="choice-cards alone" id="llm-options">'), page.indexOf('<div class="my-account-way"><a class="deep" href="#account" onclick="openMyAccount(); return false;">My Account</a></div>'));
  assert.match(models, /<div class="llm-usage-way"><button type="button" class="quiet-link" onclick="openUsage\(\)">See usage in My Account<\/button><\/div>/, "a quiet link, not a second button beside My Account");
  assert.match(page, /function openUsage\(\) \{\n\s*openMyAccount\(\);[\s\S]{0,500}document\.querySelector\('#tab-account \.my-usage'\)\.scrollIntoView/);
});

test("Closedhand+'s free first month: offered in chat to an account that never had it, and shown with the day it ends and the price after", () => {
  const { endingText, nearlyUsedText, usedUpText } = require("../lib/included-ai");
  const ending = { name: "first-month", ends_at: "2026-11-20T00:00:00Z", plus_trial: true };
  assert.match(endingText(ending, null, false, "UTC"), /connect your own LLM provider in the dashboard's Settings \(free ones work too\), or keep Managed Models with Closedhand\+\. Its first month is free, at closedhand\.com\/plus\.$/, "their own LLM provider first, then the free month");
  assert.doesNotMatch(endingText({ ...ending, plus_trial: undefined }, null, false, "UTC"), /free,|is free/, "had Closedhand+ before: no free month");
  assert.match(nearlyUsedText(ending, null, false), /or get Closedhand\+, first month free, at closedhand\.com\/plus\.$/);
  assert.match(usedUpText({ name: "ended", was: "first-month", plus_trial: true }, null, false, "UTC"), /or keep Managed Models with Closedhand\+, first month free, at closedhand\.com\/plus\.$/);

  const plan = settingsPlan();
  assert.deepEqual(plan({ state: "in-use", price: "$10", plan: { name: "plus", trial: true, renews_at: "2026-12-01T12:00:00Z" } }),
    { name: "Your Closedhand+ subscription", status: "Free month (plan-status on)", said: "Your free month runs until 1 December, then Closedhand+ renews at $10 a month unless you cancel. Your plan and this month's use are in [My Account](#account).", resume: false });
  assert.equal(plan({ state: "in-use", plan: { name: "plus", trial: true, ends_at: "2026-12-01T12:00:00Z" } }).said.split(". ")[0], "Your free month runs until 1 December, then Closedhand+ ends and nothing is charged", "cancelled in its free month: nothing is charged");

  const setup = fs.readFileSync(path.join(root, "webapp/included-ai-setup.js"), "utf8");
  assert.match(setup, /if \(plan\.name === "plus" && plan\.trial === true\) out\.trial = true;\n\s*if \(plan\.name !== "plus" && plan\.plus_trial === true\) out\.plus_trial = true;/, "the computer keeps both, each only where it fits");
  const page = fs.readFileSync(path.join(root, "webapp/views/dashboard.html"), "utf8");
  assert.match(page, /\$\("my-plus-get"\)\.textContent = p\.free_month \? "Get Closedhand\+ \\u00b7 first month free"/);
  assert.match(page, /else if \(p\.active && p\.trial\) \{ status\("Free month", "on"\);/);
});

// Usage's rows go out as a CSV file to keep, not a long table to unfold.
test("Usage exports its rows as CSV: tokens and cost for their own LLM provider, Managed Models by name and how often", () => {
  const vm = require("node:vm");
  const page = fs.readFileSync(path.join(root, "webapp/views/dashboard.html"), "utf8");
  assert.doesNotMatch(page, /View as table/);
  assert.match(page, /tableEl\.innerHTML = '<button type="button" class="quiet-link" onclick="exportUsage\(\)">Export as CSV<\/button>';/);
  const code = page.slice(page.indexOf("    function exportUsageCsv(rows, managed) {"), page.indexOf("    function exportUsage() {"));
  const ctx = vm.createContext({
    usageCost: (rs) => (rs[0].model === "deepseek-flash" ? rs[0].tokens_in * 0.3 / 1e6 : null),
    usageFeatureMeta: (f) => ({ label: { chat: "Chat", recall: "Recall" }[f] || "Other" }),
    modelLabel: (m) => (m === "managed" ? "Closedhand Managed Models" : m),
  });
  vm.runInContext(code + "\nthis.csv = exportUsageCsv;", ctx);
  const row = (day, feature, model, calls, tin) => ({ day, feature, model, calls, tokens_in: tin, tokens_out: 1000 });
  const mixed = ctx.csv([row("2026-10-20", "chat", "deepseek-flash", 900, 2_000_000), row("2026-10-27", "chat", "managed", 30, 90_000), row("2026-10-20", "recall", "deepseek-flash", 300, 400_000)], false);
  assert.equal(mixed, [
    "Day,Kind of work,Model,Calls,Tokens in,Tokens out,Cost in USD (about)",
    "2026-10-27,Chat,Closedhand Managed Models,30,,,",
    "2026-10-20,Chat,deepseek-flash,900,2000000,1000,0.6000",
    "2026-10-20,Recall,deepseek-flash,300,400000,1000,0.1200",
    "",
  ].join("\r\n"), "Managed Models rows carry no tokens or cost");
  assert.equal(ctx.csv([row("2026-10-27", "chat", "managed", 30, 90_000)], true), "Day,Kind of work,Model,Calls\r\n2026-10-27,Chat,Closedhand Managed Models,30\r\n");
  assert.match(page, /new Blob\(\[exportUsageCsv\(usageAll, usageManaged\)\]/, "the whole window, Managed Models days too, though the page shows their own provider's");
});
