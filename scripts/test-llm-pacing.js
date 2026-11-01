// An agent's call to the person's LLM never fails for being told to slow
// down: it waits as long as the provider asks and asks again, and a refused
// call costs the task's allowance nothing. A used-up allowance is named, not
// waited for. How many agents run at once comes from what the provider says
// is left, or from its first refusal, never a list of providers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const wire = require("../lib/model-wire");
const capacity = require("../lib/llm-capacity");
const { modelCall, makeBudget, withTaskRun } = require("../lib/task-model");

const headers = (h) => new Headers(h);

test("the limits a provider sends with every reply are read, whichever header family it uses", () => {
  assert.deepEqual(wire.limitsFrom(headers({ "anthropic-ratelimit-requests-limit": "4000", "anthropic-ratelimit-requests-remaining": "3990",
    "anthropic-ratelimit-input-tokens-limit": "2000000", "anthropic-ratelimit-input-tokens-remaining": "1950000" })),
    { requestsLimit: 4000, requestsLeft: 3990, tokensLimit: 2000000, tokensLeft: 1950000 });
  assert.deepEqual(wire.limitsFrom(headers({ "x-ratelimit-limit-requests": "5000", "x-ratelimit-remaining-requests": "4999",
    "x-ratelimit-limit-tokens": "1000000", "x-ratelimit-remaining-tokens": "999000" })),
    { requestsLimit: 5000, requestsLeft: 4999, tokensLimit: 1000000, tokensLeft: 999000 });
  assert.equal(wire.limitsFrom(headers({ "content-type": "application/json" })), null, "a provider that says nothing");
  assert.equal(wire.waitAsked(headers({ "retry-after": "7" })), 7000);
  assert.equal(wire.waitAsked(headers({ "x-ratelimit-reset-requests": "6m0s" })), 360000);
  assert.equal(wire.waitAsked(headers({ "x-ratelimit-reset-tokens": "1.5s" })), 1500);
  assert.equal(wire.waitAsked(headers({ "x-ratelimit-reset-tokens": "250ms" })), 250);
  assert.equal(wire.waitAsked(headers({})), null);
});

async function refusalFor(status, body, h = {}) {
  const real = global.fetch;
  global.fetch = async () => new Response(JSON.stringify(body), { status, headers: h });
  try {
    await wire.request({ backend: "openai", baseUrl: "https://llm.example.test/v1", apiKey: "sk-test-key-0000" }, { model: "fixture-model", messages: [{ role: "user", content: "hi" }] });
    return null;
  } catch (error) { return error; } finally { global.fetch = real; }
}

test("a refusal says whether waiting helps, from what the provider says", async () => {
  const slow = await refusalFor(429, { error: { type: "rate_limit_error", message: "slow down" } }, { "retry-after": "3" });
  assert.equal(slow.waitable, true); assert.equal(slow.retryAfterMs, 3000);
  const spike = await refusalFor(429, { error: { code: "slow_down", message: "ramp" } });
  assert.equal(spike.waitable, true, "a traffic spike clears by itself");
  const hold = await refusalFor(402, { error: { message: "hold", metadata: { reason: "in_flight_budget_exhausted" } } }, { "retry-after": "2" });
  assert.equal(hold.waitable, true, "OpenRouter's hold on credit for running requests is short");
  const cap = await refusalFor(429, { error: { type: "rate_limit_error", details: { error_code: "enforced_spend_limit_reached" }, message: "cap" } });
  assert.equal(cap.allowance, true); assert.equal(cap.waitable, false);
  const quota = await refusalFor(429, { error: { code: "insufficient_quota", message: "quota" } });
  assert.equal(quota.allowance, true);
  const credit = await refusalFor(402, { error: { message: "credit", metadata: { reason: "weight_exceeds_budget", limit_source: "openrouter_credits" } } });
  assert.equal(credit.allowance, true);
  const budget = await refusalFor(403, { error: { message: "budget", metadata: { limit_source: "openrouter_guardrail_budget", resets_at: "2027-03-15T00:00:00Z" } } });
  assert.equal(budget.allowance, true); assert.equal(budget.resetsAt, "2027-03-15T00:00:00Z");
  const usage = await refusalFor(400, { error: { type: "invalid_request_error", message: "You have reached your specified API usage limits." } });
  assert.equal(usage.allowance, true);
  const other = await refusalFor(404, { error: { message: "no such model" } });
  assert.equal(other.waitable, undefined); assert.equal(other.allowance, undefined);
});

const refusing = (times, error) => {
  let calls = 0;
  return { calls: () => calls, messages: { create: async () => {
    calls++;
    if (calls <= times) throw Object.assign(new Error("HTTP 429"), error);
    return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
  } } };
};

test("a call told to slow down waits and asks again, and the refusals cost nothing", async () => {
  capacity.reset();
  const budget = makeBudget();
  const startedAt = budget.startedAt;
  const client = refusing(2, { status: 429, waitable: true, retryAfterMs: 5 });
  const reply = await withTaskRun({ userId: "u-pace", budget }, () => modelCall(client, { model: "fixture-model", messages: [], max_tokens: 100 }, { pace: true }));
  assert.equal(reply.content[0].text, "done");
  assert.equal(client.calls(), 3);
  assert.equal(budget.input, 10, "only the call that was answered counts");
  assert.equal(budget.output, 5);
  assert.ok(budget.startedAt >= startedAt + 10, "time spent waiting goes back to the task");
});

test("a used-up allowance is named, with when it comes back, and not waited for", async () => {
  capacity.reset();
  const client = refusing(5, { status: 403, allowance: true, resetsAt: "2027-03-15T00:00:00Z" });
  await assert.rejects(withTaskRun({ userId: "u-pace", budget: makeBudget() }, () => modelCall(client, { model: "fixture-model", messages: [] }, { pace: true })),
    (e) => e.code === "ALLOWANCE_USED" && e.resetsAt === "2027-03-15T00:00:00Z");
  const dash = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "webapp", "views", "dashboard.html"), "utf8");
  const said = dash.slice(dash.indexOf("function couldNotFinish("), dash.indexOf("function stepText("));
  const ctx = {}; require("node:vm").runInNewContext(said + "; this.f = couldNotFinish;", ctx);
  assert.equal(ctx.f("The LLM said its allowance is used up."), "your LLM's allowance ran out", "not the task's own work allowance");
  assert.equal(ctx.f("The LLM kept asking to slow down."), "your LLM kept asking it to slow down");
  assert.equal(ctx.f("This task reached its work allowance. Keep the findings gathered so far."), "it reached the work allowance for one task");
  assert.equal(client.calls(), 1);
});

test("a provider that keeps refusing ends the call in the end, named", async () => {
  capacity.reset();
  const client = refusing(100, { status: 429, waitable: true, retryAfterMs: 0 });
  await assert.rejects(withTaskRun({ userId: "u-pace", budget: makeBudget() }, () => modelCall(client, { model: "fixture-model", messages: [] }, { pace: true })),
    (e) => e.code === "PROVIDER_BUSY");
  assert.equal(client.calls(), 13);
});

test("stopping the task stops the wait", async () => {
  capacity.reset();
  const controller = new AbortController();
  const client = refusing(1, { status: 429, waitable: true, retryAfterMs: 30000 });
  const call = withTaskRun({ userId: "u-pace", budget: makeBudget(), signal: controller.signal }, () => modelCall(client, { model: "fixture-model", messages: [] }, { pace: true }));
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(call, (e) => e.code === "TASK_STOPPED");
});

test("no reply while others ran on the same model means fewer at once, and it asks again", async () => {
  capacity.reset();
  const k = capacity.key("u-local", "local-model");
  capacity.begin(k); capacity.begin(k); capacity.begin(k);
  let calls = 0;
  const client = { messages: { create: (_, opts) => {
    calls++;
    if (calls === 1) return new Promise(() => {});
    return Promise.resolve({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  } } };
  const reply = await withTaskRun({ userId: "u-local", budget: makeBudget() }, () => modelCall(client, { model: "local-model", messages: [] }, { timeoutMs: 5, pace: true }));
  assert.equal(reply.content[0].text, "ok");
  assert.equal(capacity.atOnce(k, 6), 2, "three were running, so two from now");
});

test("a check inside a chat turn is never held up waiting: only background work is paced", async () => {
  capacity.reset();
  const client = refusing(1, { status: 429, waitable: true, retryAfterMs: 0 });
  await assert.rejects(withTaskRun({ userId: "u-chat", budget: makeBudget() }, () => modelCall(client, { model: "fixture-model", messages: [] }, { timeoutMs: 6000 })),
    (e) => e.status === 429);
  assert.equal(client.calls(), 1);
  assert.match(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "lib", "agent-context.js"), "utf8"), /modelCall\(client, \{ \.\.\.params, messages \}, \{ pace: true, \.\.\.options \}\)/, "every background agent call is paced");
});

test("how many run at once comes from the provider's limits, then its refusals, never more than the team", () => {
  capacity.reset();
  const k = capacity.key("u-size", "fixture-model");
  assert.equal(capacity.atOnce(k, 6), 6, "a provider that says nothing: all of them");
  capacity.observe(k, { tokensLimit: 2000000, requestsLimit: 4000 }, 30000);
  assert.equal(capacity.atOnce(k, 6), 6);
  assert.equal(capacity.atOnce(k, 20), 13, "0.8 of 2M tokens a minute over 4 calls of 30k each");
  capacity.observe(k, { tokensLimit: 1000000, requestsLimit: 40 }, 30000);
  assert.equal(capacity.atOnce(k, 20), 6, "whichever limit is tighter: 0.8 of 40 requests over 4 a minute is 8, of tokens 6");
  for (let i = 0; i < 5; i++) capacity.begin(k);
  capacity.refused(k);
  assert.equal(capacity.atOnce(k, 20), 4, "one fewer than were running");
  assert.equal(capacity.atOnce(k, 20, Date.now() + capacity.EASE_MS + 1000), 5, "eased by one each half hour without another");
});
