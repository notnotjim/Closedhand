// A turn whose LLM fails keeps the person's message, with what Closedhand
// said back, in the conversation. A message once went unanswered when the
// LLM provider timed out twice, and was then gone: "try again" had nothing to
// carry on from, and the /bug report sent next showed nothing of what was
// asked. The reply says the LLM did not answer, not that something went wrong
// in Closedhand. Runs the real ask() for an invented person, with no network
// and no database, and an LLM that fails as each test says.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

process.env.CTX_STRICT = "off";
function stub(name) {
  const fn = function () { return stub(name + "()"); };
  return new Proxy(fn, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined;
      if (key === "__esModule") return false;
      if (key === Symbol.iterator) return function* () {};
      return stub(name + "." + String(key));
    },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
}
const root = path.join(__dirname, "..");
const llmFile = path.join(root, "lib/llm.js"), storageFile = path.join(root, "lib/storage.js");
const seen = { calls: 0, saves: 0, error: null };
const resolve = Module._resolveFilename;
const load = Module._load;
Module._resolveFilename = function (request, parent, ...rest) {
  try { return resolve.call(this, request, parent, ...rest); }
  catch (e) { if (!request.startsWith(".") && !request.startsWith("/")) return "STUB:" + request; throw e; }
};
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (String(resolved).startsWith("STUB:")) return stub(request);
  if (resolved === storageFile) return { ...load.apply(this, arguments), saveStore: () => { seen.saves++; } };
  if (resolved === llmFile) {
    const create = async () => { seen.calls++; throw seen.error; };
    return { ...load.apply(this, arguments), resolveUserModel: () => "test-model", getUserLLMClient: () => ({ client: { messages: { create } }, provider: "custom" }) };
  }
  return load.apply(this, arguments);
};
const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = console.warn = console.error = () => {};
const ctx = require("../lib/context");
const engine = require("../lib/engine");
Object.assign(console, quiet);

async function turn(error, said) {
  seen.calls = 0; seen.saves = 0; seen.error = error;
  ctx.activeUserId = "u-test";
  ctx.activeUserStore = { profile: { display_name: "Sam", settings: { preferred_name: "Sam" }, timezone: "Europe/London" }, connections: {}, facts: {}, userRules: [], goals: [] };
  ctx.store = { conversations: { "u-test": [] }, facts: {}, userRules: [], goals: [] };
  ctx.activePlatform = "web";
  console.log = console.warn = console.error = () => {};
  try { return await engine.ask("u-test", said); }
  finally { Object.assign(console, quiet); }
}

test("a message whose LLM did not answer stays in the conversation with the reply, and is saved", async () => {
  const said = "Put the draft to the florist here so I can check it, then send it to Robin";
  const reply = await turn(Object.assign(new Error("The model provider returned HTTP 504. Check the model, access and balance."), { status: 504 }), said);
  assert.ok(seen.calls >= 1, "the LLM was asked");
  assert.equal(reply, 'I couldn\'t get an answer in time just now. Say "try again" and I\'ll carry on.');
  assert.deepEqual(ctx.store.conversations["u-test"].map((m) => [m.role, m.content]), [["user", said], ["assistant", reply]]);
  assert.equal(seen.saves, 1);
});

test("only a fault in Closedhand itself is said to be on its end", async () => {
  const reply = await turn(new TypeError("Cannot read properties of undefined (reading 'content')"), "What's on Thursday?");
  assert.equal(reply, "Something went wrong on my end. Try again in a moment.");
  assert.equal(ctx.store.conversations["u-test"].at(-1).content, reply);
});
