// A turn whose LLM fails keeps the person's message, with what Closedhand
// said back, in the conversation. A message once went unanswered when the
// LLM provider timed out twice, and was then gone: "try again" had nothing to
// carry on from, and the /bug report sent next showed nothing of what was
// asked. Runs the real ask() for an invented person, with no network and no
// database, and an LLM that answers HTTP 504.
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
const seen = { calls: 0, saves: 0 };
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
    const create = async () => { seen.calls++; throw Object.assign(new Error("The model provider returned HTTP 504. Check the model, access and balance."), { status: 504 }); };
    return { ...load.apply(this, arguments), resolveUserModel: () => "test-model", getUserLLMClient: () => ({ client: { messages: { create } }, provider: "custom" }) };
  }
  return load.apply(this, arguments);
};
const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = console.warn = console.error = () => {};
const ctx = require("../lib/context");
const engine = require("../lib/engine");
Object.assign(console, quiet);

test("a message whose LLM failed stays in the conversation with the reply, and is saved", async () => {
  ctx.activeUserId = "u-test";
  ctx.activeUserStore = { profile: { display_name: "Sam", settings: { preferred_name: "Sam" }, timezone: "Europe/London" }, connections: {}, facts: {}, userRules: [], goals: [] };
  ctx.store = { conversations: { "u-test": [] }, facts: {}, userRules: [], goals: [] };
  ctx.activePlatform = "web";
  console.log = console.warn = console.error = () => {};
  let reply;
  try { reply = await engine.ask("u-test", "Put the draft to the florist here so I can check it, then send it to Robin"); }
  finally { Object.assign(console, quiet); }
  assert.ok(seen.calls >= 1, "the LLM was asked");
  assert.equal(reply, "Something went wrong on my end. Try again in a moment.");
  assert.deepEqual(ctx.store.conversations["u-test"].map((m) => [m.role, m.content]), [
    ["user", "Put the draft to the florist here so I can check it, then send it to Robin"],
    ["assistant", reply],
  ]);
  assert.equal(seen.saves, 1);
});
