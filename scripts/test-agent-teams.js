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

// A team made on the dashboard: one task, Closedhand leading with the goal
// above, the agents its parts; no cap of five, a note from the sixth.
test("the dashboard makes one task for a team, each agent named or numbered from 1", () => {
  const server = read("webapp/server.js");
  const fn = server.slice(server.indexOf("const TEAM_MAX = 20;"), server.indexOf("// Which note the form shows from the sixth agent"));
  const ctx = {}; require("node:vm").runInNewContext(fn + "; this.teamMembers = teamMembers;", ctx);
  assert.equal(ctx.teamMembers(undefined).length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.teamMembers([{ name: "Flights", part: "Return flights" }, { name: "", part: "A ryokan near Gion" }, { name: "flights", part: "Trains" }]))),
    [{ name: "Flights", part: "Return flights" }, { name: "Agent 2", part: "A ryokan near Gion" }, { name: "flights (2)", part: "Trains" }]);
  assert.equal(ctx.teamMembers([{ name: "A", part: "x" }]).error, "Say what each agent should do.");
  assert.equal(ctx.teamMembers(Array.from({ length: 21 }, () => ({ part: "look it up" }))).error, "A team can have up to 20 agents.");
  assert.equal(ctx.teamMembers(Array.from({ length: 12 }, () => ({ part: "look it up" }))).length, 12, "past five is fine");
  assert.match(server, /\.\.\.\(members\.length \? \{ team: members\.map\(\(m\) => \(\{ name: m\.name, job: m\.part, after: \[\], status: "waiting"/);
  assert.match(server, /\.\.\.\(members\.length \? \{ teamSource: "dashboard" \} : \{\}\)/);
  assert.match(server, /app\.get\("\/api\/team-note"/, "not under /api/agents/:id, which would take it");
  assert.match(server, /res\.json\(\{ kind: managed \? "managed" : local \? "local" : "provider", low, left \}\);/);
  assert.match(server, /never sending, paying or booking/, "suggested parts only look things up");
  const redo = server.slice(server.indexOf('app.post("/api/agents/:id/redo"'), server.indexOf("// AUTOMATIONS"));
  assert.match(redo, /task_worker_results"\)\.delete\(\)\.eq\("user_id", userId\)\.eq\("task_id", task\.id\)\.eq\("item_key", member\.key\)/, "only that agent's findings go");
  assert.match(redo, /status: "pending", messages: \[\]/);
  assert.match(redo, /teamDone: false/);
  assert.match(redo, /task\.runtime\?\.teamSource !== "dashboard"/);
});

test("Closedhand plans which agent waits for which, runs the team as fast as the LLM allows, then leads with what they found", () => {
  const src = read("lib/agents.js");
  assert.match(src, /if \(!resumeState && Array\.isArray\(task\.team\) && task\.team\.length && runtime\.teamSource === "dashboard" && !runtime\.teamDone\) \{/);
  assert.match(src, /atOnce: \(size\) => capacity\.atOnce\(k, size\),\n\s+partLimits: team\.TEAM_PART_LIMITS,/, "no cap of three for a team made by hand");
  const shared = read("lib/agent-team.js");
  assert.match(shared, /const TEAM_BRIEF = "You lead a team the person set up on their dashboard\./);
  assert.match(shared, /show both where two disagree and you cannot settle it, say plainly which part did not finish/);
  assert.match(shared, /Reply ONLY with JSON: \{\\"after\\": \{\\"<agent name>\\": \[\\"<agent name>\\", \.\.\.\]\}\}/);
  assert.match(src, /const after = await team\.planTeam\(goal, members, userId, userStore, model\);/);
  assert.match(read("lib/agent-team.js"), /m\.key = itemKey;/, "each agent's saved findings can be found again for Redo");
});

test("the form: named agents, Suggest agents, one start, and the note from the sixth in the LLM's own terms", () => {
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /<a href="#" class="team-add" id="auto-suggest-agents" onclick="event\.preventDefault\(\);suggestAgents\(\)">Suggest agents<\/a>/);
  assert.doesNotMatch(dash, /if \(box\.children\.length >= 4\) return;/, "no cap of five");
  const fn = dash.slice(dash.indexOf("    function renumberTeam() {"), dash.indexOf("    // Suggest agents:"));
  const notes = {};
  for (const kind of ["provider", "managed", "local"]) {
    const ctx = { _teamNoteKind: kind }; require("node:vm").runInNewContext(fn + "; this.bigTeamNote = bigTeamNote;", ctx);
    notes[kind] = ctx.bigTeamNote(6);
  }
  assert.equal(notes.provider, "A team of 6 does the work of 6 agents at once, so it uses your LLM provider's limits and adds to its bill about 6 times as fast as one agent. Closedhand runs as many at once as your LLM can take; the rest wait their turn.");
  assert.equal(notes.managed, "A team of 6 does the work of 6 agents at once, so it uses this month's fair use about 6 times as fast as one agent. Closedhand runs as many at once as your LLM can take; the rest wait their turn.");
  assert.equal(notes.local, "A team of 6 does the work of 6 agents on the computer running your model. How many it can work on at once depends on that computer's memory and how the model is served, and the rest wait their turn.");
  assert.match(fn, /\(count >= 6 \? ' ' \+ bigTeamNote\(count\) : ''\)/);
  assert.match(fn, /n\.placeholder = 'Agent ' \+ \(i \+ 1\);/);
  assert.match(dash, /members: members\.length \? members : undefined \}\) \}\);/, "one task for the whole team");
});

test("a team's card: a line per agent, Working in green, waiting for whom, what it found, Redo once done", () => {
  const dash = read("webapp/views/dashboard.html");
  const fn = dash.slice(dash.indexOf("    function teamLines(a, team, going) {"), dash.indexOf("    function toggleTeamLine(row) {"));
  const why = dash.slice(dash.indexOf("    function couldNotFinish(error) {"), dash.indexOf("    // Runs from before the check's notes"));
  const ctx = { escapeHtml: (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") };
  require("node:vm").runInNewContext(why + fn + "; this.teamLines = teamLines;", ctx);
  const team = [
    { name: "Flights", status: "done", findings: "Landing at Kansai 11:35 on 15 Mar." },
    { name: "Stays", status: "working", last: "Searching the web" },
    { name: "Getting around", status: "waiting", after: ["Flights", "Stays"] },
  ];
  const going = ctx.teamLines({ id: "t1", runtime: { teamSource: "dashboard" } }, team, true);
  assert.match(going, /<span class="tm-state on">Working<\/span>/);
  assert.match(going, /Waiting for Stays/, "only the ones it still waits for");
  assert.match(going, /<div class="tm-full" hidden onclick="event\.stopPropagation\(\)">Landing at Kansai 11:35 on 15 Mar\.<\/div>/);
  assert.match(going, /Then Closedhand puts them together and sends one answer\./);
  assert.doesNotMatch(going, />Redo</, "no Redo while it works");
  const done = ctx.teamLines({ id: "t1", runtime: { teamSource: "dashboard" } }, [{ name: "Bank", status: "stopped", error: "The LLM said its allowance is used up." }, { name: "Bills", status: "waiting" }], false);
  assert.match(done, /Your LLM's allowance ran out\./);
  assert.match(done, /Did not start/);
  assert.match(done, />Redo</);
  assert.doesNotMatch(ctx.teamLines({ id: "t2", runtime: {} }, team.slice(0, 1), false), />Redo</, "a team from chat is redone by asking in chat");
  assert.match(dash, /\(team \? 'Team of ' \+ team\.length : 'Task'\)/);
});

// A routine can be a team, and a job set to start once (on a date, or the
// first time something happens) waits under Waiting to start, not Routines.
test("a routine keeps its agents and runs them first, keeping their state on the run", () => {
  assert.match(read("migrations/081_team_routines.sql"), /ALTER TABLE automations ADD COLUMN IF NOT EXISTS members jsonb;\nALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS team jsonb;/);
  const runner = read("lib/automations.js");
  assert.match(runner, /if \(!resumeRow\?\.messages\?\.length && Array\.isArray\(config\.members\) && config\.members\.length\) \{/);
  assert.match(runner, /store: \{ save: \(updates\) => updateRun\(runId, updates\), read: \(\) => getRun\(runId\) \},/, "kept on the routine's run");
  assert.match(runner, /if \(Date\.now\(\) - startTime > timeoutMs \+ teamMs\) \{/, "the team's time is not the run's");
  assert.match(read("lib/agents.js"), /dropConfirmation, runMapSub, pauseForAllowance, retryPaused \};/);
  const server = read("webapp/server.js");
  const create = server.slice(server.indexOf('app.post("/api/automations"'), server.indexOf('app.put("/api/automations/:id"'));
  assert.match(create, /const members = teamMembers\(req\.body\.members\);/);
  assert.match(create, /\.\.\.\(members\.length \? \{ members \} : \{\}\),/);
  assert.match(server, /if \(changes\.members !== undefined\) \{\n\s+const members = teamMembers\(changes\.members\);/);
  assert.match(server, /select\(withMembers \? routineFields \+ ", members" : routineFields\)/, "routines carry their agents, and still load before the column exists");
  assert.match(server, /\(withTeam \? ", team" : ""\)/, "a routine's runs carry their team's state");
  assert.match(read("lib/agent-team.js"), /const store = opts\.store \|\| \{ save: \(updates\) => updateTask\(parentTaskId, updates\), read: \(\) => getTask\(parentTaskId\) \};/);
});

test("set for a date it runs once and is done; it waits under Waiting to start until then", async () => {
  const server = read("webapp/server.js");
  const fn = server.slice(server.indexOf("function watchFields(body, now = Date.now()) {"), server.indexOf("\n}\n", server.indexOf("function watchFields(body, now = Date.now()) {")) + 2);
  const ctx = { watchKinds: { kindOf: () => null, choices: () => [], WHEN: ["arrives"] } };
  require("node:vm").runInNewContext(fn + "; this.watchFields = watchFields;", ctx);
  assert.equal(ctx.watchFields({ trigger_type: "scheduled", trigger_cron: "0 9 15 3 *", run_once: true }).fields.run_once, true);
  assert.equal(ctx.watchFields({ trigger_type: "scheduled", trigger_cron: "0 8 * * 1" }).fields.run_once, false, "a repeating one repeats");
  assert.equal(ctx.watchFields({ trigger_type: "manual", run_once: true }).fields.run_once, false);
  const runner = read("lib/automations.js");
  assert.match(runner, /if \(automation\.run_once\) \{\n\s+unregisterCron\(automation\.id\);\n\s+const \{ error \} = await require\("\.\/db"\)\.supabase\.from\("automations"\)\.update\(\{ status: "done", fired_at: new Date\(\)\.toISOString\(\)/);
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /<div class="mc-section-label">Waiting to start<\/div>\n\s+<p class="section-desc">Set for a date, or for the first time something happens\. Each moves to Working now when it starts\.<\/p>/);
  assert.match(dash, /var waiting = routines\.filter\(function \(a\) \{ return a\.run_once && a\.status === 'active' && !a\.fired_at; \}\);\n\s+var repeating = routines\.filter\(function \(a\) \{ return !a\.run_once; \}\);/);
  assert.ok(dash.indexOf('id="agents-waiting"') < dash.indexOf('<div class="mc-section-label">Working now</div>'), "first, before Working now");
  assert.match(dash, /<option value="once">Once, on a date…<\/option>/);
  assert.match(dash, /triggerCron = when\.getMinutes\(\) \+ ' ' \+ when\.getHours\(\) \+ ' ' \+ when\.getDate\(\) \+ ' ' \+ \(when\.getMonth\(\) \+ 1\) \+ ' \*';/);
  assert.match(dash, /trigger_timezone: onceOnDate \? Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone : undefined,/, "in the time the person typed it");
  assert.match(dash, /if \(when\.getTime\(\) <= Date\.now\(\) \+ 60000\) \{ errEl\.textContent = 'Choose a time that is still to come\.';/);
});

test("the form makes a team for any kind, and a routine that is a team says so", () => {
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /<div id="auto-team"><\/div>\n\s+<div class="team-links">/, "not only for Now");
  assert.match(dash, /<p class="team-note" id="auto-team-note" hidden><\/p>/);
  assert.match(dash, /members: members,\n/, "a routine saves its agents");
  assert.match(dash, /\(Array\.isArray\(a\.members\) \? a\.members : \[\]\)\.forEach\(function \(m\) \{ addTeamAgent\(m\.name, m\.part\); \}\);/, "and opens with them");
  assert.match(dash, /'Team of ' \+ a\.members\.length \+ ': ' \+ a\.members\.map\(function \(m\) \{ return m\.name; \}\)\.join\(', '\)/);
  assert.match(dash, /\(Array\.isArray\(r\.team\) && r\.team\.length \? teamLines\(r, r\.team, r\.live\) : ''\)/, "a routine's run has a line per agent");
  assert.match(read("lib/agent-team.js"), /Do not describe the team or how the work went \(who found what, that the parts agree\) unless a part did not finish or two disagree\./);
});

// A task set in chat for a date waits under Waiting to start and runs as a
// task; a reminder stays on Upcoming; starter teams open the form filled in.
test("chat says whether a schedule is a reminder or a task, and a task runs as one when it fires", () => {
  assert.match(read("migrations/082_schedule_kind.sql"), /ALTER TABLE schedules ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'reminder';/);
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /kind: \{\n\s+type: "string",\n\s+enum: \["reminder", "task"\],/);
  assert.match(read("lib/tools/handlers.js"), /eventAt, toolInput\.kind === "task" \? "task" : "reminder"\);/);
  assert.match(read("user-store.js"), /select\("user_id, name, cron_expression, task, chat_id, run_once, timezone, kind"\)/);
  const sched = read("lib/scheduling.js");
  assert.match(sched, /if \(still && \(still\.enabled === false \|\| still\.archived_at\)\) \{/, "cancelled from the dashboard, not run");
  assert.match(sched, /if \(schedule\.kind === "task"\) \{\n\s+await require\("\.\/agents"\)\.startAgent\(targetUserId, deliverPlatform, targetChatId, schedule\.prompt, null\);/);
  assert.match(sched, /\.\.\.\(once \? \{ enabled: false, archived_at: new Date\(\)\.toISOString\(\) \} : \{\}\)/, "retired only when set for once");
  const server = read("webapp/server.js");
  assert.match(server, /select\(withKind \? fields \+ ", kind" : fields\)/);
  assert.match(server, /app\.delete\("\/api\/reminders\/:name"/);
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /rows = rows\.filter\(function \(r\) \{ return !\(r\.kind === 'task' && !r\.repeats\); \}\);/, "Upcoming keeps reminders");
  assert.match(dash, /esc\('Task \\u00b7 starts ' \+ \(r\.next_at \? dayAndTime\(r\.next_at\) : \(r\.next_run \|\| 'on its date'\)\) \+ ' \\u00b7 set in chat'\)/);
  assert.match(dash, /askFirst\(btn\.closest\('\.auto-card-actions'\) \|\| btn, \{ text: 'Cancel this\? It won\\u2019t run\.', yes: 'Cancel it' \}\)/);
});

test("starter teams join the routine templates, only for what is connected, and open with their agents", () => {
  const dash = read("webapp/views/dashboard.html");
  for (const name of ["Monday money check", "Meeting prep", "Friday inbox sweep"]) assert.ok(dash.includes(`name: '${name}',`), name);
  assert.match(dash, /needs: \['simplefin', 'lunchflow'\],/, "either bank");
  assert.match(dash, /\[\]\.concat\(need\)\.some\(function \(n\) \{ return connected\.indexOf\(n\) !== -1; \}\)/);
  assert.match(dash, /\(t\.members \|\| \[\]\)\.forEach\(function \(m\) \{ addTeamAgent\(m\.name, m\.part\); \}\);/);
  assert.match(dash, /\(t\.members \? 'Team of ' \+ t\.members\.length \+ ' \\u00b7 ' : ''\)/);
  const order = dash.match(/var TEMPLATE_ORDER = \[([^\]]+)\]/)[1];
  for (const id of ["money-check", "meeting-prep", "inbox-sweep"]) assert.ok(order.includes(`'${id}'`), id);
});

// When the LLM's allowance is used up nothing can run until it is back: the
// team stops cleanly, the task pauses with its work kept, says so once, and
// carries on by itself.
test("a used-up allowance stops the team cleanly: no new parts, the stopped one waits to run again", async () => {
  capacity.reset();
  db.tables.agent_tasks.push({ id: "task-dry", user_id: "u-team", progress: [] });
  const started = [];
  const runPart = async (userId, goal) => {
    started.push(goal);
    if (goal.includes("ryokan")) throw Object.assign(new Error("The LLM said its allowance is used up."), { code: "ALLOWANCE_USED", resetsAt: "2027-03-15T00:00:00Z" });
    return { findings: "ok" };
  };
  const parts = [{ name: "Stays", goal: "A ryokan near Gion" }, { name: "Flights", goal: "Return flights" }, { name: "Trains", goal: "Rail passes" }];
  let unhandled = 0; const count = () => unhandled++;
  process.on("unhandledRejection", count);
  await assert.rejects(withTaskRun({ userId: "u-team", taskId: "task-dry", budget: makeBudget() }, () =>
    team.runTeam("u-team", "web", "c", "task-dry", parts, "fixture-model", { atOnce: () => 1, runPart })), (e) => e.code === "ALLOWANCE_USED" && e.resetsAt === "2027-03-15T00:00:00Z");
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", count);
  assert.equal(unhandled, 0);
  assert.equal(started.length, 1, "nothing else starts once it has run out");
  const row = db.tables.agent_tasks.find((t) => t.id === "task-dry");
  assert.equal(row.team[0].status, "waiting", "it runs again when the allowance is back");
});

test("the task pauses, says so once, carries on by itself, and gives up only after two days", () => {
  const src = read("lib/agents.js");
  assert.match(src, /if \(error\.code === "ALLOWANCE_USED"\) return pauseForAllowance\(taskId, userId, platform, chatId, error\);/);
  assert.match(src, /const ALLOWANCE_RETRY_MS = 30 \* 60 \* 1000;\nconst ALLOWANCE_GIVE_UP_MS = 2 \* 24 \* 60 \* 60 \* 1000;/);
  assert.match(src, /status: "blocked", error: "The LLM said its allowance is used up\.",/);
  assert.match(src, /allowance: \{ since, nextTry, resetsAt, told: true \}/);
  assert.match(src, /if \(was\?\.told\) return;/, "said once");
  assert.match(src, /const why = managed \? "this month's Managed Models use has reached its fair-use limit" : "your LLM provider says its allowance is used up";/);
  assert.match(src, /I've paused "\$\{name\}": \$\{why\}\. What it has done so far is kept, and it carries on by itself \$\{when\}\./);
  assert.match(src, /setInterval\(retryPaused, 60000\)\.unref\(\);/);
  assert.match(src, /if \(!\(next <= Date\.now\(\)\)\) continue;/);
  const server = read("webapp/server.js");
  assert.match(server, /app\.post\("\/api\/agents\/:id\/carry-on"/);
  assert.match(server, /if \(\/:free\$\/\.test\(String\(conn\.model \|\| ""\)\) && free/);
  const dash = read("webapp/views/dashboard.html");
  const fn = dash.slice(dash.indexOf("    function runWord(a) {"), dash.indexOf("    // Runs from before the check's notes") > 0 ? dash.indexOf("    function runOutcome(a) {") + 2000 : 0);
  assert.match(dash, /if \(a\.status === 'blocked' && a\.runtime && a\.runtime\.allowance\) return 'Paused';/);
  assert.match(dash, /'Your LLM\\'s allowance ran out\. What it has done is kept, and it carries on by itself '/);
  assert.match(dash, />Carry on<\/button>/);
  assert.match(dash, /This month\\'s Managed Models use is close to its fair-use limit, so a team may pause partway\. It carries on by itself when there\\'s more\./);
  assert.ok(fn.length > 0);
});
