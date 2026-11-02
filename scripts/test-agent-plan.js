// New agent: the plan Closedhand reads from one description (webapp/server.js
// /api/agents/plan), and what routines needed to work as the plan says: a
// schedule that starts within the minute, the person's own time zone, and the
// skills a task gets. The LLM and database are stand-ins; invented jobs only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const server = read("webapp/server.js");

// The plan route, run with a stand-in LLM that answers with `reply`.
async function plan(text, reply, { projects = [] } = {}) {
  const src = server.slice(server.indexOf("const PLAN_SYSTEM = "), server.indexOf("// Finish it: a task paused because"));
  let handler = null, asked = null;
  const ctx = {
    app: { post: (_, fn) => { handler = fn; } }, console,
    getUserIdFromRequest: () => "u1", scanModelFor: async () => ({ model: "stand-in" }), personZone: async () => "Asia/Tokyo",
    watchKinds: { choices: () => [{ id: "email", label: "Emails", timed: false }, { id: "calendar", label: "Calendar events", timed: true }] },
    supabase: { from: () => { const q = { select: () => q, eq: () => q, then: (done) => done({ data: projects }) }; return q; } },
    require: (m) => (m === "./model-wire" ? { request: async (model, params) => { asked = params; return { content: [{ type: "text", text: reply }] }; } } : require(m)),
    AbortSignal, Date, JSON, Math, Number, String, Array,
  };
  vm.runInNewContext(src, ctx);
  let out = null, code = 200;
  const keep = (b) => { out = JSON.parse(JSON.stringify(b)); };
  await handler({ body: { text } }, { status: (c) => { code = c; return { json: keep }; }, json: keep });
  return { out, code, asked };
}

test("the plan: when it runs, read from the words", async () => {
  const weekly = await plan("Every weekday at 7, brief me on today's meetings.", '{"name": "Weekday meeting brief", "when": "schedule", "cron": "0 7 * * 1-5", "schedule_words": "Every weekday at 7am", "team": [], "acts": false}');
  assert.deepEqual(weekly.out.when, { kind: "schedule", cron: "0 7 * * 1-5", words: "Every weekday at 7am" });
  assert.equal(weekly.out.name, "Weekday meeting brief");
  assert.match(weekly.asked.system, /It is now .+ where they are \(Asia\/Tokyo\)\./, "dates and times are read where the person is");
  const once = await plan("On 20 November at 9am, check my post.", '{"name": "Post check", "when": "schedule", "cron": null, "once_at": "2026-11-20T09:00"}');
  assert.deepEqual(once.out.when, { kind: "once", at: "2026-11-20T09:00" });
  const before = await plan("An hour before each flight, tell me the gate.", '{"name": "Gate", "when": "event", "event_kind": "calendar", "event_condition": "a flight", "event_timing": "before", "offset_minutes": 60}');
  assert.deepEqual(before.out.when, { kind: "event", source: "calendar", condition: "a flight", timing: "before", offset: 60, once: false });
  const mail = await plan("When an invoice email arrives, file it.", '{"name": "Invoices", "when": "event", "event_kind": "email", "event_condition": "an invoice", "event_timing": "before", "offset_minutes": 30}');
  assert.deepEqual(mail.out.when, { kind: "event", source: "email", condition: "an invoice", timing: "arrives", offset: 0, once: false }, "mail has no time of its own to run before");
  assert.deepEqual((await plan("Book a table for Friday.", '{"when": "ask"}')).out.when, { kind: "ask" });
  assert.deepEqual((await plan("Find hotels.", '{"when": "schedule", "cron": "every day"}')).out.when, { kind: "now" }, "a timetable it cannot read starts now");
});

test("the plan: a team only when worth one, acting only when asked, a project only when named", async () => {
  const one = await plan("Find three hotels near the station.", '{"name": "Hotels", "when": "now", "team": [{"name": "Hotels", "part": "Find three hotels"}], "acts": false}');
  assert.deepEqual(one.out.team, [], "one agent is Closedhand on its own");
  const three = await plan("Plan a weekend: flights, a flat and places to eat.", '{"name": "Weekend", "when": "now", "team": [{"name": "Flights", "part": "Find flights"}, {"name": "Flat", "part": "Find a flat"}, {"name": "Food", "part": "Places to eat"}], "acts": false}');
  assert.equal(three.out.team.length, 3);
  assert.equal((await plan("Book it.", '{"when": "now", "acts": true}')).out.acts, true);
  const proj = await plan("For the flat move: find a van.", '{"when": "now", "project": "flat move"}', { projects: [{ id: "p2", name: "Flat move", emoji: "📦" }] });
  assert.deepEqual(proj.out.project, { id: "p2", name: "Flat move", emoji: "📦" });
  assert.equal((await plan("Find a van.", '{"when": "now", "project": "Something else"}', { projects: [{ id: "p2", name: "Flat move", emoji: "📦" }] })).out.project, null);
  const broken = await plan("Find me three hotels near Kyoto station.", "no json here");
  assert.deepEqual(broken.out, { name: "Find me three hotels", when: { kind: "now" }, team: [], acts: false, project: null, urgent: false, read: true }, "anything unread starts now, on its own, to change by hand");
  assert.equal((await plan("ab", "{}")).code, 400);
  assert.match(server, /team: most jobs need none: when the job is one piece of work, or each step needs the one before it, Closedhand does it alone, so \[\]\./);
  assert.match(server, /Telling or sending them the answer is not acting\./, "\"send me the gate\" is not acting for them");
});

test("a routine's schedule starts within the minute and stops when paused, never all at once on a database hiccup", () => {
  const auto = read("lib/automations.js");
  assert.match(auto, /async function reconcileAutomationCrons\(\) \{\n\s*const scheduled = await getActiveScheduledAutomations\(\);\n\s*if \(!scheduled\) return null;/);
  assert.match(auto, /for \(const id of Object\.keys\(_automationCrons\)\) if \(!seen\.has\(id\)\) \{ unregisterCron\(id\); delete _registeredAs\[id\]; \}/);
  assert.match(auto, /setInterval\(\(\) => reconcileAutomationCrons\(\)\.catch\(/);
  assert.match(read("lib/automations-store.js"), /console\.error\("Failed to get scheduled automations:", error\.message\);\n\s*return null;/);
});

test("a routine is given the skills a task is: added and learned ones too, with no picker", () => {
  const auto = read("lib/automations.js");
  assert.match(auto, /await require\("\.\/user-skills"\)\.warmUserSkills\(userId\)/);
  assert.match(auto, /getSkillsForPrompt\(userStore, automation\.task_prompt\) \+ require\("\.\/user-skills"\)\.getUserSkillsBlock\(userId, automation\.task_prompt\)/);
  assert.doesNotMatch(read("webapp/views/dashboard.html"), /renderSkillsPicker|_selectedSkills/);
});
