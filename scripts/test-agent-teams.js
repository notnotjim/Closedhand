// A team: Closedhand leads, parts with their own jobs run side by side as far
// as the LLM can take, a part that needs another's findings starts once that
// one is done and is handed them, and each part's state is kept on the task
// for a line per agent on the Agents tab. One kind of team whether chat or the
// dashboard started it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function fakeDb(tables = {}) {
  return { tables, from(name) {
    tables[name] ||= []; let action = "select", values, conflict, filters = [], one = false;
    const q = { limit() { return q; }, select() { return q; }, order() { return q; }, single() { one = true; return q; }, maybeSingle() { one = true; return q; },
      update(v) { action = "update"; values = v; return q; }, insert(v) { action = "insert"; values = v; return q; },
      upsert(v, o) { action = "upsert"; values = v; conflict = o.onConflict.split(","); return q; },
      eq(k, v) { filters.push((r) => r[k] === v); return q; }, in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        let rows = tables[name].filter((r) => filters.every((f) => f(r)));
        if (action === "insert") { rows = [structuredClone(values)]; tables[name].push(...rows); }
        if (action === "upsert") {
          let row = tables[name].find((r) => conflict.every((k) => r[k] === values[k]));
          if (row) Object.assign(row, structuredClone(values)); else tables[name].push(row = structuredClone(values)); rows = [row];
        }
        if (action === "update") rows.forEach((r) => Object.assign(r, structuredClone(values)));
        return { data: structuredClone(one ? rows[0] ?? null : rows), error: null };
      }).then(resolve, reject); },
    }; return q;
  } };
}
const db = fakeDb({ agent_tasks: [], task_worker_results: [] });
require.cache[require.resolve("../lib/db")] = { exports: { supabase: db } };
const team = require("../lib/agent-team");
const { makeBudget, withTaskRun } = require("../lib/task-model");
const capacity = require("../lib/llm-capacity");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

const TRIP = [
  { name: "Flights", goal: "Return flights London to Osaka, out 14 Mar, back 18 Mar." },
  { name: "Stays", goal: "A ryokan near Gion for four nights." },
  { name: "Getting around", goal: "From the arrival airport to Gion, and a day trip to Nara.", after: ["Flights"] },
];

function stubParts(found, { delay = 5, fail = [] } = {}) {
  const log = { order: [], goals: {}, peak: 0, now: 0 };
  const runPart = async (userId, goal, platform, chatId, model, limits) => {
    const name = Object.keys(found).find((n) => goal.includes(found[n].marker));
    log.order.push(name); log.goals[name] = goal;
    log.now++; log.peak = Math.max(log.peak, log.now);
    limits.onStep?.("Searching the web");
    await new Promise((r) => setTimeout(r, delay));
    log.now--;
    if (fail.includes(name)) return { error: "The sub-task ran out of budget before reporting." };
    return { findings: found[name].findings };
  };
  return { log, runPart };
}
const FOUND = {
  Flights: { marker: "Return flights", findings: "Landing at Kansai 11:35 on 15 Mar." },
  Stays: { marker: "ryokan", findings: "Shirakawa-an, five minutes from Gion." },
  "Getting around": { marker: "arrival airport", findings: "Haruka express from Kansai." },
};

test("parts wait only for the parts whose findings they need", () => {
  assert.deepEqual(team.teamWaves(TRIP.map((p) => ({ ...p, after: p.after || [] }))), [["Flights", "Stays"], ["Getting around"]]);
  assert.deepEqual(team.teamWaves([{ name: "A", after: ["Nobody"] }, { name: "B", after: [] }]), [["A", "B"]], "a name not in the team is ignored");
  assert.deepEqual(team.teamWaves([{ name: "A", after: ["B"] }, { name: "B", after: ["A"] }]), [["A", "B"]], "a loop of waits is broken");
});

test("a team runs side by side, hands a waiting part the findings it needs and keeps each part's state on the task", async () => {
  capacity.reset();
  db.tables.agent_tasks.push({ id: "task-trip", user_id: "u-team", progress: [] });
  const { log, runPart } = stubParts(FOUND);
  const budget = makeBudget();
  const before = { input: budget.maxInput, output: budget.maxOutput, durationMs: budget.durationMs };
  const out = await withTaskRun({ userId: "u-team", taskId: "task-trip", budget }, () =>
    team.runTeam("u-team", "whatsapp", "chat-1", "task-trip", TRIP, "fixture-model", { atOnce: () => 3, runPart }));
  assert.deepEqual(log.order.slice(0, 2).sort(), ["Flights", "Stays"]);
  assert.equal(log.order[2], "Getting around", "after Flights");
  assert.match(log.goals["Getting around"], /What the rest of the team found that this needs:\nFlights:\nLanding at Kansai 11:35 on 15 Mar\./);
  assert.doesNotMatch(log.goals["Getting around"], /Shirakawa-an/, "only what it waits for");
  const row = db.tables.agent_tasks.find((t) => t.id === "task-trip");
  assert.deepEqual(row.team.map((m) => [m.name, m.status]), [["Flights", "done"], ["Stays", "done"], ["Getting around", "done"]]);
  assert.equal(row.team[2].findings, "Haruka express from Kansai.");
  assert.deepEqual(row.team[2].after, ["Flights"]);
  assert.ok(row.progress.some((p) => p.text === "Flights done"));
  assert.deepEqual(out.results.map((r) => r.name), ["Flights", "Stays", "Getting around"]);
  assert.match(out.note, /show both where they conflict/);
  assert.equal(budget.maxOutput - before.output, 3 * 60000, "each part brings its own share of the allowance");
  assert.equal(budget.durationMs - before.durationMs, 2 * 15 * 60 * 1000, "and each wave its own time");
  assert.deepEqual(out.growth, { input: 3000000, output: 180000, toolCalls: 120, durationMs: 1800000 });
});

test("no more run at once than allowed, and the number is asked again as parts start", async () => {
  capacity.reset();
  db.tables.agent_tasks.push({ id: "task-one", user_id: "u-team", progress: [] });
  const many = ["Alpha", "Bravo", "Charlie", "Delta"].map((n) => ({ name: n, goal: `Check supplier ${n}` }));
  const found = Object.fromEntries(many.map((p) => [p.name, { marker: `supplier ${p.name}`, findings: "ok" }]));
  const { log, runPart } = stubParts(found, { delay: 10 });
  await withTaskRun({ userId: "u-team", taskId: "task-one", budget: makeBudget() }, () =>
    team.runTeam("u-team", "web", "c", "task-one", many, "fixture-model", { atOnce: () => 2, runPart }));
  assert.equal(log.peak, 2);
});

test("a part that can't finish is said, and the parts waiting on it still run", async () => {
  capacity.reset();
  db.tables.agent_tasks.push({ id: "task-fail", user_id: "u-team", progress: [] });
  const { log, runPart } = stubParts(FOUND, { fail: ["Flights"] });
  const out = await withTaskRun({ userId: "u-team", taskId: "task-fail", budget: makeBudget() }, () =>
    team.runTeam("u-team", "web", "c", "task-fail", TRIP, "fixture-model", { atOnce: () => 3, runPart }));
  const row = db.tables.agent_tasks.find((t) => t.id === "task-fail");
  assert.equal(row.team[0].status, "stopped");
  assert.equal(row.team[2].status, "done");
  assert.doesNotMatch(log.goals["Getting around"], /What the rest of the team found/, "nothing to hand on");
  assert.match(out.results[0].error, /ran out of budget/);
  assert.ok(row.progress.some((p) => p.text === "Flights could not finish"));
});

test("a part already done is not done again", async () => {
  capacity.reset();
  db.tables.agent_tasks.push({ id: "task-again", user_id: "u-team", progress: [] });
  const first = stubParts(FOUND);
  await withTaskRun({ userId: "u-team", taskId: "task-again", budget: makeBudget() }, () =>
    team.runTeam("u-team", "web", "c", "task-again", TRIP, "fixture-model", { runPart: first.runPart }));
  const second = stubParts(FOUND);
  await withTaskRun({ userId: "u-team", taskId: "task-again", budget: makeBudget() }, () =>
    team.runTeam("u-team", "web", "c", "task-again", TRIP, "fixture-model", { runPart: second.runPart }));
  assert.deepEqual(second.log.order, [], "saved findings are used again");
});

test("chat's fan-out takes like items or named parts, three at a time at most", async () => {
  capacity.reset();
  const run = async (input) => {
    const asked = team.partsFromInput(input);
    if (asked.error) return asked;
    return team.runTeam("u-team", "web", "c", "task-map", asked.parts, "fixture-model", { runPart: async () => ({ findings: "ok" }), grow: !asked.quick });
  };
  db.tables.agent_tasks.push({ id: "task-map", user_id: "u-team", progress: [] });
  assert.match((await run({ parts: [{ name: "Only", job: "x" }] })).error, /2 or more parts/);
  assert.match((await run({ parts: [{ name: "Same", job: "x" }, { name: "Same", job: "y" }] })).error, /its own name/);
  assert.match((await run({ parts: Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, job: "x" })) })).error, /caps at 8/);
  assert.match((await run({ items: ["one"], prompt: "Check {item}" })).error, /2 or more items/);
  await withTaskRun({ userId: "u-team", taskId: "task-map", budget: makeBudget() }, () => run({ items: ["Northwind supplies", "Hollis & Vane"], prompt: "Check {item}'s delivery times", label: "supplier checks" }));
  const row = db.tables.agent_tasks.find((t) => t.id === "task-map");
  assert.deepEqual(row.team.map((m) => m.name), ["Northwind supplies", "Hollis & Vane"], "like items show as a team too");
  assert.equal(row.team[0].job, "Check Northwind supplies's delivery times");
  const src = read("lib/agents.js");
  assert.match(src, /atOnce: \(size\) => Math\.min\(team\.MAP_CONCURRENCY, capacity\.atOnce\(k, size\)\)/, "three at most, fewer when the LLM can take fewer");
  assert.equal(team.MAP_CONCURRENCY, 3);
});

test("the lead gets its own time back from a team, kept across a restart", () => {
  const src = read("lib/agents.js");
  assert.match(src, /if \(Date\.now\(\) - startTime > AGENT_TIMEOUT_MS \+ teamMs\) \{/);
  assert.match(src, /let teamMs = resumeState\?\.runtime\?\.teamMs \|\| 0;/);
  assert.match(src, /team\.growBudget\(budget, task\.runtime\?\.teamGrowth\);/);
  const b = makeBudget();
  team.growBudget(b, { input: 1, output: 2, toolCalls: 3, durationMs: 4 });
  assert.equal(b.maxOutput, 100002); assert.equal(b.durationMs, 15 * 60 * 1000 + 4);
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /after: \{ type: "array", items: \{ type: "string" \}, description: "Names of parts whose findings this part needs/);
  assert.match(read("migrations/080_agent_teams.sql"), /ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS team jsonb;/);
  const server = read("webapp/server.js");
  assert.match(server, /select\(withTeam \? fields \+ ", team" : fields\)/, "the Agents tab gets each task's team");
  assert.match(server, /if \(results\.some\(\(r\) => r\.error && \/\\bteam\\b\/\.test/, "and still loads before the bot has added the column");
});
