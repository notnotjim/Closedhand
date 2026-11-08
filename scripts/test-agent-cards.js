// The dashboard lists work started from chats while it still needs a look:
// running, waiting on the person, or finished without a sure delivery. A
// delivered answer is in the chat, and its page under Pages, so it is not
// repeated. Each finished card says how the run ended in the person's
// terms, the same way the chat did: the first line of the answer, or why it
// could not finish. The quality check's notes are Closedhand's own working
// and never shown.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const dashboard = read("webapp/views/dashboard.html");
const fn = (name) => { const s = dashboard.indexOf(`function ${name}(`); return dashboard.slice(s, dashboard.indexOf("\n    }\n", s) + 6); };
const box = {};
vm.runInNewContext(["runWord", "runOutcome", "couldNotFinish", "stepText"].map(fn).join("\n") +
  "\nthis.runWord = runWord; this.runOutcome = runOutcome; this.stepText = stepText;", box);

test("a run that answered says Completed, and its line gives how the answer starts", () => {
  const a = { status: "partial", result: "## Newcastle and the top four\n**About a 6% chance** of the top five.\n[[next]]\nDetail." };
  assert.equal(box.runOutcome(a), "Newcastle and the top four", "the pill carries the word; the line does not repeat it");
  assert.equal(box.runWord(a), "Completed", "the check's verdict is not the person's business");
  assert.equal(box.runOutcome({ status: "completed", result: "x".repeat(200) }).length < 130, true);
});

test("a run that could not finish says why in plain words, never the check's note", () => {
  assert.equal(box.runWord({ status: "partial", error: "No answer was produced." }), "Couldn't finish");
  assert.equal(box.runOutcome({ status: "partial", error: "No answer was produced." }), "Something went wrong partway through.");
  assert.equal(box.runOutcome({ status: "failed", error: "fetch failed" }), "The connection to the LLM provider kept dropping.");
  assert.equal(box.runOutcome({ status: "failed", error: "This task reached its work allowance." }), "It reached the work allowance for one task.");
  assert.equal(box.runOutcome({ status: "failed", error: "This task reached its time allowance." }), "It ran out of time.");
  assert.equal(box.runWord({ status: "cancelled" }), "Stopped");
  assert.equal(box.runOutcome({ status: "cancelled" }), "Stopped before it finished.");
  assert.equal(box.stepText("Quality check sent it back for another pass: No answer was produced."), "Improving the answer before sending it");
  assert.equal(box.stepText("Searching the web"), "Searching the web");
  assert.doesNotMatch(dashboard, /escapeHtml\(String\(a\.error\)\)/, "the raw error is never printed");
  assert.match(read("lib/agents.js"), /\{ text: "Improving the answer before sending it", time:/);
  assert.doesNotMatch(read("lib/agents.js"), /Quality check sent it back/);
});

test("tasks handed over in chat: going or waiting, and a finished one only until its answer is sent", () => {
  const server = read("webapp/server.js");
  assert.match(server, /const LIVE_RUN_STATUSES = \["running", "pending", "awaiting_confirmation", "blocked"\];/, "a task paused for its LLM's allowance waits under Working now");
  assert.match(server, /const UNSENT = \["pending", "waiting", "uncertain"\];/);
  assert.match(server, /const lists = \[runs\(\)\.in\("status", LIVE_RUN_STATUSES\), runs\(\)\.in\("status", DONE_RUN_STATUSES\)\.in\("delivery_status", UNSENT\)\.gte\("created_at", cutoff\)\];/, "a delivered task leaves; one that may not have reached its chat stays a week");
  assert.match(server, /\.select\("id, automation_id, status, progress, output_summary, error, started_at, completed_at, delivery_status" \+/, "a job set for once, likewise");
  assert.match(dashboard, /\.concat\(onceRuns\.filter\(function \(r\) \{ return !r\.live && unsent\(r\); \}\)/);
  assert.match(server, /const fields = "id, goal, title, status, model, result, progress, tools_used, error, created_at, completed_at, result_edited_at, runtime, delivery_status, platform";/, "and where it answered, for the card to say");
  assert.doesNotMatch(server, /\/api\/agents[^\n]*archived|req\.query\.archived === "1" && req\.query\.count === "1"\) \{\n\s*const \{ count, error \} = await supabase\.from\("agent_tasks"\)/, "no archive of delivered runs");
  assert.doesNotMatch(dashboard, /toggleArchivedRuns|_archivedRunCount|\/api\/agents\?archived=1/);
  assert.match(dashboard, /var late = finished && a\.result && place && a\.delivery_status && a\.delivery_status !== 'sent' && a\.completed_at && Date\.now\(\) - new Date\(a\.completed_at\)\.getTime\(\) > 2 \* 60000;/, "a late delivery");
  assert.match(dashboard, /escapeHtml\('This may not have reached ' \+ answerPlace\(a, true\) \+ ', so its answer is here\. ' \+ String\(detail\)\)/, "says why");
  assert.match(dashboard, /function archiveRow\(toggle, count, open\) \{\n\s*if \(!count\) return '';/, "Pages keeps its Archived row");
  assert.match(dashboard, /var metaHtml = escapeHtml\(whoIsOn\('Task', team\) \+ ' \\u00b7 ' \+ \(finished \? doneAt : String\(detail\)\)\);/, "a task says what it is, who is on it and how it stands");
  assert.doesNotMatch(dashboard, /answered in|The note is in/, "a finished one shown has not reached its chat");
  assert.match(dashboard, /function whoIsOn\(kind, team\) \{ return kind \+ ', ' \+ \(team && team\.length \? 'a team of ' \+ team\.length : 'one agent'\); \}/);
  assert.doesNotMatch(dashboard, /auto-status-pill|&#9632; Stop|&#8595; PDF|&#9654; Run|&#9208; Pause/, "no stock pills, no glyph buttons");
  assert.match(dashboard, />Closedhand working for you in the background: tasks you hand it in chat or start here, and routines that run on their own\.</, "the tab says what it holds");
});

test("the Agents tab holds Closedhand working for you: what is working now, the routines, what finished; what it made is on Pages", () => {
  assert.match(dashboard, /<button class="tab" data-tab="agents" onclick="switchTab\('agents'\)">Agents<\/button>/);
  const agents = dashboard.slice(dashboard.indexOf('id="tab-agents"'), dashboard.indexOf('id="tab-upcoming"'));
  assert.match(agents, /<div class="agents-head list-head"><div class="mc-section-label">Tasks<\/div><button type="button" class="goals-new" onclick="openNewAgent\(\)">\+ New agent<\/button><\/div>[\s\S]*<div class="agents-head list-head"><div class="mc-section-label">Routines<\/div><\/div>/, "two lists, + New agent on the first");
  assert.equal((agents.match(/class="mc-section-label"/g) || []).length, 2, "Tasks and Routines, nothing else: waiting is a task's state and a team is who does the work");
  assert.doesNotMatch(agents, /Done lately|Kept here|Waiting to start|>Teams<|New team/);
  assert.doesNotMatch(dashboard, /\+ New routine/, "a routine is made from New agent too");
  assert.doesNotMatch(agents, />Resources<|id="files-section"|id="datasets-section"|skills-library|<svg/, "no Resources, and no sleeping figure: the templates say what to do");
  assert.doesNotMatch(dashboard, /id="files-section"|function loadFiles/, "no list of files on Pages: what Closedhand makes is a page");
  assert.doesNotMatch(dashboard, /id="datasets-section"|function loadDatasets/, "a table is a page in the list, not a section of its own");
  assert.match(dashboard, /if \(tabName === 'pages'\) \{\n\s*loadPages\(\);/);
  assert.match(dashboard, /const resolved = window\.location\.hash\.replace\('#', ''\);/, "#agents opens it; no old names");
  assert.doesNotMatch(dashboard, /'workers'|=== 'schedules'|#tasks|data-tab="tasks"|id="tab-tasks"|Schedules/);
  assert.match(read("lib/dashboard-links.js"), /async function dashboardUrl\(platform, section = "agents"\)/);
});

test("Upcoming says what, what kind and when; what already happened folds under Past", () => {
  const fns = vm.runInNewContext([fn("reminderTitle")].join("\n") + "\n({ reminderTitle })", {});
  assert.equal(fns.reminderTitle("plumber-visit-14mar"), "Plumber visit 14mar", "an old slug reads as words");
  assert.equal(fns.reminderTitle("Renew the car insurance"), "Renew the car insurance");
  assert.equal(fns.reminderTitle(""), "Reminder");
  assert.match(dashboard, /upcomingRow\(\{ icon: UPCOMING_ICON\.reminder, title: reminderTitle\(r\.name\), kind: r\.repeats \? 'Reminder, ' \+ r\.repeats : 'Reminder', when: r\.next_at \? FlightTime\.time\(r\.next_at, where\) : '' \}\)/, "the note Closedhand left itself is not shown");
  assert.doesNotMatch(dashboard, /esc\(r\.task/, "no reminder prompt on the dashboard");
  assert.doesNotMatch(dashboard, /_showPastReminders|Show \d+ that already ran|that already ran<\/a>/);
  assert.match(dashboard, /<button type="button" class="mc-section-label archive-row" id="past-toggle" aria-expanded="false" aria-controls="past-body" onclick="toggleFold\('past'\)">Past <span class="count" id="past-count"><\/span><span class="chevron-down"><\/span><\/button>/, "Past is a heading row like Archived");
  assert.match(dashboard, /<button type="button" class="mc-section-label archive-row" id="cancelled-toggle" aria-expanded="false" aria-controls="cancelled-body" onclick="toggleFold\('cancelled'\)">Cancelled plans <span class="count" id="cancelled-count"><\/span><span class="chevron-down"><\/span><\/button>/, "and so is Cancelled plans");
  assert.match(dashboard, /<div id="past-body" hidden>\n\s*<div id="reminders-past"><\/div>\n\s*<div id="recent-flights"><\/div>/, "reminders that ran and flights flown, folded away");
  assert.match(read("lib/tools/definitions.js"), /What it is for, in a few plain words, as the person sees it under Upcoming on the dashboard: 'Plumber visit', 'Renew the car insurance'\. Not a slug\./);
});

test("Closedhand's agents: a one-off job is a task, one that repeats a routine, the same words everywhere a person reads (AGENTS.md)", () => {
  const agents = dashboard.slice(dashboard.indexOf('id="tab-agents"'), dashboard.indexOf('id="tab-upcoming"'));
  assert.doesNotMatch(agents, /Saved agents|Saved Agents|Agents at work|mc-metric|auto-summary/);
  assert.match(agents, /<p class="section-desc">What Closedhand does on its own, on a timetable or when something happens\.<\/p>/);
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /Create a routine: an agent the person sets up once that runs on a schedule, when something happens, or when they ask\. Call it a routine when you talk about it\./);
  assert.match(defs, /`Setting up a routine: \$\{q\}` : "Setting up a routine"/, "the web chat's progress line says routine too");
  assert.match(read("lib/tools/handlers.js"), /"Routine '" \+ auto\.name \+ "' saved\. It shows under Routines on the Agents tab\."/);
  const rules = read("AGENTS.md");
  assert.match(rules, /Closedhand's agents are it working for the person, on the dashboard's Agents tab: a one-off job\n\s*handed over in chat is a "task", and one that repeats on a timetable or when something happens is\n\s*a "routine"\./);
  assert.doesNotMatch(rules, /Never "agent" in what people read/);
  assert.match(read("lib/engine.js"), /Sections: #upcoming \(bookings, flights and reminders, soonest first\), #agents \(tasks working or waiting, and routines\),/);
});

test("a routine says what it does, when it runs, how it last ran and whether it is on; a run says how it went", () => {
  const line = (sig) => { const a = dashboard.indexOf("    " + sig); return dashboard.slice(a, dashboard.indexOf("\n", a)); };
  const code = ["function renderAutomationCard(a)", "function renderRoutineRun(r)", "function dayAndTime(iso)"].map((sig) => {
    const a = dashboard.indexOf("    " + sig);
    return dashboard.slice(a, dashboard.indexOf("\n    }\n", a) + 6);
  }).join("\n") + "\n" + ["function isTeam(a)", "function routineWhen(a)", "function whoIsOn(kind, team)", "var LIVE_EMBER"].map(line).join("\n");
  const ctx = { esc: (t) => String(t), truncatePrompt: (t) => String(t), watchLine: () => "When an email from the bank arrives", TRASH_ICON: "[bin]" };
  vm.runInNewContext(code + "\nthis.card = renderAutomationCard; this.run = renderRoutineRun;", ctx);
  const at = (days, h) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const on = ctx.card({ id: "r1", name: "Morning briefing", description: "Your day's calendar and the weather.", status: "active", trigger_type: "scheduled", trigger_human_schedule: "Every morning at 08:00", next_at: at(1, 8), last_run: { status: "success", at: at(0, 8) } });
  assert.match(on, /Every morning at 08:00 · next tomorrow at 08:00 · last ran today at 08:00/);
  assert.match(on, /<input type="checkbox" checked onchange="setRoutineOn\('r1', this\)"/);
  assert.match(on, />Run now<\/button>[\s\S]*>Edit<\/button>[\s\S]*\[bin\]/);
  // A team names its agents in its line, and its bin says team.
  const team = ctx.card({ id: "t1", name: "Monday money check", status: "active", trigger_type: "scheduled", trigger_human_schedule: "Every Monday at 09:00", members: [{ name: "Bank", part: "x" }, { name: "Bills", part: "y" }] });
  assert.match(team, /Routine, a team of 2: Bank, Bills · Every Monday at 09:00/);
  assert.match(team, /title="Delete this team" aria-label="Delete this team" data-what="team"/);
  assert.match(on, /Routine, one agent · Every morning at 08:00/);
  // Running, its card goes live: an ember, the live line, each agent's line.
  ctx.teamLines = (r, t) => "[lines " + t.map((m) => m.name).join(",") + "]";
  const live = ctx.card({ id: "t2", name: "Monday money check", status: "active", trigger_type: "scheduled", trigger_human_schedule: "Every Monday at 09:00", members: [{ name: "Bank" }, { name: "Bills" }],
    liveRun: { id: "u7", started_at: at(0, 9), team: [{ name: "Bank", status: "working" }, { name: "Bills", status: "waiting" }] } });
  assert.match(live, /class="auto-card routine-card live"/);
  assert.match(live, /class="live-ember"/);
  assert.match(live, /started today at 09:00/);
  assert.match(live, /\[lines Bank,Bills\]/);
  assert.doesNotMatch(live, /Run now/, "not again while it runs");
  const off = ctx.card({ id: "r2", name: "Weekly review", status: "paused", trigger_type: "scheduled", trigger_human_schedule: "Every Friday at 17:00", last_run: { status: "failed", at: at(-2, 17) } });
  assert.match(off, /routine-card off/);
  assert.match(off, /Every Friday at 17:00 · off · last run could not finish, /);
  assert.match(off, /<input type="checkbox" onchange=/, "off, and can be turned on");
  const manual = ctx.card({ id: "r3", name: "Expenses", status: "idle", trigger_type: "manual" });
  assert.match(manual, /When you ask, or press Run now/);
  assert.doesNotMatch(manual, /type="checkbox"/, "nothing to switch on: it runs when asked");
  const ended = ctx.card({ id: "r4", name: "Parcel watch", status: "expired", trigger_type: "event" });
  assert.match(ended, /When an email from the bank arrives · ended/);
  assert.doesNotMatch(ended, /Run now|type="checkbox"/);
  const going = ctx.run({ id: "u1", name: "Inbox sort", live: true, started_at: at(0, 9), progress: [JSON.stringify({ text: "Reading 12 new emails" })] });
  assert.match(going, /Task, one agent · Reading 12 new emails · started today at 09:00/, "a job set for once is a task");
  assert.match(going, /class="live-ember"/, "an ember while it works");
  const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();
  const done = ctx.run({ id: "u2", name: "Inbox sort", live: false, status: "success", started_at: ago(3), completed_at: ago(1), output_summary: "Two urgent:\n the landlord and the dentist." });
  assert.match(done, /Task, one agent · finished [^<]*<\/div>/);
  assert.doesNotMatch(done, /sent to|emailed/i, "here only while its answer is on its way");
  assert.match(done, /<div class="done-line">Two urgent: the landlord and the dentist\.<\/div>/, "kept here only: its answer's first line");
  assert.match(done, /<div class="auto-card done-card" onclick="viewAutoRun\('u2'\)">/, "and it opens its answer");
  assert.doesNotMatch(done, /live-ember/);
  const late = (sends) => ctx.run({ id: "u4", name: "Inbox sort", live: false, status: "success", started_at: ago(12), completed_at: ago(10), sends, output_summary: "Two urgent." });
  assert.match(late(["chat_platforms", "dashboard"]), /<div class="done-line">This may not have reached your chat apps, so its answer is here\.<\/div>/, "still unsent after two minutes, as a task says it");
  assert.match(late(["email"]), /This may not have reached your inbox, so its answer is here\./);
  const failed = ctx.run({ id: "u3", name: "Inbox sort", live: false, status: "failed", started_at: at(0, 6) });
  assert.doesNotMatch(failed, /viewAutoRun/, "nothing to open when it could not finish");
  assert.match(failed, /<div class="done-line failed">Couldn’t finish\.<\/div>/);
  // A routine's card says how its last run this week went, and opens its answer.
  const ran = ctx.card({ id: "r5", name: "Morning briefing", status: "active", trigger_type: "scheduled", trigger_human_schedule: "Every morning at 08:00", lastRunShown: { id: "u9", status: "success", completed_at: at(0, 8) } });
  assert.match(ran, /<div class="routine-last">Last ran today at 08:00 · <button type="button" class="quiet-link" onclick="viewAutoRun\('u9'\)">Open the answer<\/button><\/div>/);
  assert.match(ctx.card({ id: "r7", name: "Morning briefing", status: "active", trigger_type: "manual", lastRunShown: { id: "u6", status: "success", completed_at: at(0, 8), output_summary: "Two meetings and rain after 3pm." } }), /Last ran today at 08:00: Two meetings and rain after 3pm · <button/, "with its answer's opening line");
  assert.doesNotMatch(ran, /last ran today/, "said once");
  assert.match(ctx.card({ id: "r6", name: "Weekly review", status: "active", trigger_type: "scheduled", trigger_human_schedule: "Every Friday at 17:00", lastRunShown: { id: "u8", status: "failed", started_at: at(0, 17) } }), /<div class="routine-last failed">Last run couldn’t finish, today at 17:00\.<\/div>/);
});

test("templates are routines that repeat, shown only for what is connected; effort is the engine's own words", () => {
  const a = dashboard.indexOf("    var TEMPLATE_ORDER"), b = dashboard.indexOf("    function drawAgentTemplates()");
  const t = dashboard.indexOf("    var WORKER_TEMPLATES = {"), u = dashboard.indexOf("\n    };\n", t) + 7;
  const ctx = { window: {} };
  vm.runInNewContext(dashboard.slice(t, u) + dashboard.slice(a, b) + "\nthis.shown = shownTemplates;", ctx);
  assert.equal(ctx.shown().join(" "), "morning-briefing smart-morning weekly-review inbox-triage competitor-monitor");
  ctx.window._connectionsCache = [{ service: "shopify" }];
  assert.ok(ctx.shown().includes("shopify-sales"), "Shopify sales once Shopify is connected");
  assert.doesNotMatch(dashboard, /'research-analyst'|'data-cruncher'|Research a topic|Work through data/, "a one-off job is asked for in chat");
  assert.doesNotMatch(dashboard, /'sonnet'|'haiku'|'opus'/, "no provider's model names");
  assert.match(dashboard, /_selectedModel = t\.model \|\| 'default';/, "a starting point keeps its effort, said in the engine's words");
  assert.match(dashboard, /var ids = shownTemplates\(\)\.filter\(function \(id\) \{ return !!WORKER_TEMPLATES\[id\]\.members === \(_mode === 'team'\); \}\);/, "the starting points under the box are the same ones, a team's in a new team");
  const auto = read("lib/automations.js");
  assert.match(auto, /const tierOf = \(key\) => \(\["fast", "default", "strong"\]\.includes\(key\) \? key : "default"\);/);
  assert.doesNotMatch(auto, /TIER_MAP|"sonnet"|"haiku"|"opus"/);
  assert.match(read("webapp/server.js"), /task_model: \["fast", "default", "strong"\]\.includes\(task_model\) \? task_model : "default",/);
});

test("a repeating reminder is under Upcoming at its next time, saying how often", () => {
  const server = read("webapp/server.js");
  const a = server.indexOf("function reminderRepeats"), b = server.indexOf('\napp.get("/api/reminders"', a);
  const repeats = new Function(server.slice(a, b) + "; return reminderRepeats;")();
  const cases = { "0 20 * * 0": "every Sun", "0 8 * * *": "every day", "0 8 * * 1-5": "weekdays", "0 9 * * 1,3": "every Mon, Wed", "30 7 1 * *": "every month on the 1st", "0 9 22 * *": "every month on the 22nd", "0 9 28 7 *": "every year on 28 Jul", "*/30 * * * *": "every 30 minutes", "0 */3 * * *": "every 3 hours", "5 4 * 2 *": "repeats" };
  for (const [cron, want] of Object.entries(cases)) assert.equal(repeats(cron), want, cron);
  assert.match(server, /const live = rows\.filter\(\(r\) => r\.enabled\)\.map\(\(r\) => \{/, "repeating ones are no longer left out");
  assert.match(server, /repeats: oneOff\(r\) \? null : reminderRepeats\(r\.cron_expression\)/);
});

test("Upcoming is one timeline: every kind under the same date headings, soonest first", () => {
  const FlightTime = require("../webapp/public/flight-time.js");
  const start = dashboard.indexOf("    var _upcoming = {"), end = dashboard.indexOf("    function updateUpcomingEmpty() {", start);
  const el = { innerHTML: "" };
  const ctx = { FlightTime, esc: (t) => String(t), document: { getElementById: (id) => (id === "upcoming-list" ? el : null) }, updateUpcomingEmpty() {} };
  vm.runInNewContext(dashboard.slice(start, end) + "\nthis.setUpcoming = setUpcoming; this.upcomingItem = upcomingItem;", ctx);
  const tz = { tz: "Europe/Lisbon" };
  ctx.setUpcoming("flights", [ctx.upcomingItem("2027-03-13T14:20:00Z", tz, "[flight]")]);
  ctx.setUpcoming("reminders", [ctx.upcomingItem("2027-03-12T09:15:00Z", tz, "[reminder]"), ctx.upcomingItem("2027-03-13T08:00:00Z", tz, "[reminder 2]")]);
  const headings = el.innerHTML.match(/<div class="flights-date-header">[^<]*/g).map((h) => h.replace(/<[^>]*>/, ""));
  assert.deepEqual(headings, ["Fri 12 Mar 2027", "Sat 13 Mar 2027"], "a reminder's date is a heading like a flight's, with its year when it is not this one");
  const soon = { innerHTML: "" };
  const ctx2 = { FlightTime, esc: (t) => String(t), document: { getElementById: (id) => (id === "upcoming-list" ? soon : null) }, updateUpcomingEmpty() {} };
  vm.runInNewContext(dashboard.slice(start, end) + "\nthis.setUpcoming = setUpcoming; this.upcomingItem = upcomingItem;", ctx2);
  const now = Date.now(), here = { tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
  ctx2.setUpcoming("reminders", [ctx2.upcomingItem(new Date(now + 60000).toISOString(), here, "[soon]"), ctx2.upcomingItem(new Date(now + 86400000).toISOString(), here, "[tomorrow]")]);
  assert.match(soon.innerHTML, /<div class="flights-date-header">Today<span class="flights-away">\w{3} \d{1,2} \w{3,4}<\/span><\/div>\[soon\]<div class="flights-date-header">Tomorrow<span class="flights-away">/, "today and tomorrow by name, then the date, no year");
  assert.ok(el.innerHTML.indexOf("[reminder]") < el.innerHTML.indexOf("[reminder 2]") && el.innerHTML.indexOf("[reminder 2]") < el.innerHTML.indexOf("[flight]"), "in time order across kinds, under one heading per day");
  assert.doesNotMatch(dashboard, /id="reminders-list"|id="flights-list"|id="bookings-list"|id="goal-checkins-list"/, "one list, not four");
});

test("a hotel stay is a check-in row, a line each day between saying which night it is, and a check-out row", () => {
  const FlightTime = require("../webapp/public/flight-time.js");
  const timeline = dashboard.slice(dashboard.indexOf("    var _upcoming = {"), dashboard.indexOf("    function updateUpcomingEmpty() {"));
  const stays = dashboard.slice(dashboard.indexOf("    function localDay("), dashboard.indexOf("    function flightEntry(f) {"));
  const el = { innerHTML: "" };
  const ctx = { FlightTime, esc: (t) => String(t), escHtml: (t) => String(t), updateUpcomingEmpty() {}, UPCOMING_ICON: { checkout: "", hotel: "", x: "" },
    fmtBookingTime: (iso, tz) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }),
    document: { getElementById: (id) => (id === "upcoming-list" ? el : null) } };
  vm.runInNewContext(fn("upcomingEntry") + fn("stayName") + timeline + stays + "\nthis.setUpcoming = setUpcoming; this.upcomingItem = upcomingItem; this.stayOf = stayOf; this.checkoutEntry = checkoutEntry; this.stayName = stayName;", ctx);
  const seoul = { tz: "Asia/Seoul" };
  const hotel = { id: "h1", kind: "hotel", title: "Hotel Aurora Seoul, 3 nights", status: "confirmed", timezone: "Asia/Seoul", starts_at: "2027-11-08T06:00:00Z", ends_at: "2027-11-11T02:00:00Z" };
  const stay = ctx.stayOf(hotel);
  assert.equal(stay.name, "Hotel Aurora Seoul", "the row says how many nights, so the name does not");
  const checkIn = Object.assign(ctx.upcomingItem(hotel.starts_at, seoul, "[check in]"), { stay });
  const checkOut = Object.assign(ctx.upcomingItem(hotel.ends_at, seoul, ctx.checkoutEntry(hotel, stay)), { stayEnd: "h1" });
  ctx.setUpcoming("flights", [ctx.upcomingItem("2027-11-08T00:10:00Z", { tz: "Asia/Tokyo" }, "[flight out]"), ctx.upcomingItem("2027-11-11T06:05:00Z", seoul, "[flight back]")]);
  ctx.setUpcoming("reminders", [ctx.upcomingItem("2027-11-11T02:00:00Z", seoul, "[same minute]")]);
  ctx.setUpcoming("bookings", [checkIn, checkOut, ctx.upcomingItem("2027-11-09T02:00:00Z", seoul, "[implant]"),
    ctx.upcomingItem("2027-11-10T10:30:00Z", seoul, "[dinner]"), ctx.upcomingItem("2027-11-11T01:30:00Z", seoul, "[follow-up]")]);
  const html = el.innerHTML;
  const at = (s) => html.indexOf(s);
  assert.ok(at("[flight out]") < at("[check in]"), "the flight there comes before the stay");
  assert.doesNotMatch(html, /class="stay"|stay-inside/, "no bracket");
  assert.match(html, /Tue 9 Nov 2027<\/div><div class="up-stay"><span>Staying at <b>Hotel Aurora Seoul<\/b>, night 2 of 3<\/span><span class="up-nights" aria-hidden="true"><i class="on"><\/i><i class="on"><\/i><i><\/i><\/span><\/div>\[implant\]/, "each day between says which night it is, a dot a night");
  assert.match(html, /Wed 10 Nov 2027<\/div><div class="up-stay"><span>Staying at <b>Hotel Aurora Seoul<\/b>, night 3 of 3/);
  const lastDay = html.slice(at("Thu 11 Nov 2027"));
  assert.doesNotMatch(lastDay, /up-stay/, "the check-out day has its check-out row instead");
  assert.match(lastDay, /\[follow-up\][\s\S]*Check out of Hotel Aurora Seoul[\s\S]*End of a 3-night stay[\s\S]*\[same minute\][\s\S]*\[flight back\]/, "the check-out comes before anything at the same minute, and what follows is after the stay");
  // A stay under way: its check-in row is gone, its nights still said.
  const el2 = { innerHTML: "" };
  ctx.document = { getElementById: (id) => (id === "upcoming-list" ? el2 : null) };
  ctx.setUpcoming("flights", []); ctx.setUpcoming("reminders", []);
  ctx.setUpcoming("bookings", [Object.assign(ctx.upcomingItem(hotel.starts_at, seoul, ""), { stay }), checkOut, ctx.upcomingItem("2027-11-09T02:00:00Z", seoul, "[implant]")]);
  assert.match(el2.innerHTML, /^<div class="flights-date-header">Tue 9 Nov 2027<\/div><div class="up-stay">/, "no heading for the day it began");
  assert.equal(ctx.stayOf({ ...hotel, status: "cancelled" }), null, "a cancelled stay is no stay");
  assert.equal(ctx.stayOf({ ...hotel, ends_at: null }), null, "nor is one with no check-out");
  assert.equal(ctx.stayOf({ ...hotel, kind: "restaurant" }), null, "only a hotel is a stay");
});

test("flights and bookings go to Cancelled plans the same way, from the same quiet x, and come back with Put back", () => {
  assert.match(dashboard, /x: b\.over \? null : "cancelPlan\('bookings', '" \+ escAttribute\(b\.id\) \+ "'\)",/);
  assert.match(dashboard, /x: f\._key && !status\.past \? "cancelPlan\('flights', '" \+ escAttribute\(f\._key\) \+ "'\)" : null,/);
  assert.match(dashboard, /title="Not going ahead\? Take it off" aria-label="Not going ahead\? Take it off"/);
  assert.doesNotMatch(dashboard, /confirmBookingRemove|confirmFlightRemove|Remove this booking from Upcoming for good/, "nothing is deleted, so nothing asks first");
  assert.match(dashboard, /restore: "restorePlan\('bookings', '" \+ escAttribute\(b\.id\) \+ "'\)"/);
  assert.match(dashboard, /restore: f\.cancelled && f\._key \? "restorePlan\('flights', '" \+ escAttribute\(f\._key\) \+ "'\)" : null/, "a flight the airline cancelled cannot be put back");
  const server = read("webapp/server.js");
  assert.doesNotMatch(server, /app\.delete\("\/api\/(bookings|flights)\//);
  assert.match(server, /app\.post\("\/api\/bookings\/:id\/:action\(cancel\|restore\)"/);
  assert.match(server, /app\.post\("\/api\/flights\/:key\/:action\(cancel\|restore\)"/);
  assert.match(server, /if \(req\.params\.action === "cancel"\) marked = \{ \.\.\.flight, supersededBy: "removed", supersededAt: at, cancelled: \{ by: "you", at \} \};/, "kept and marked, so the scan that found it does not add it again");
  assert.match(server, /else \{ delete details\.cancelled; details\.kept = at; \}/, "put back, and not taken off again for what was already said");
  assert.match(server, /if \(!\/\^flight-\[A-Za-z0-9-\]\+\$\/\.test\(key\)\) return res\.status\(400\)/, "only a flight's own key");
  // How each one is known, in the words the person approved.
  const why = new Function("shortDay", dashboard.slice(dashboard.indexOf("    function cancelledWhy("), dashboard.indexOf("    function cancelledEntry(")) + "; return cancelledWhy;")(() => "Sun 8 Nov");
  assert.equal(why({ by: "you", at: "2026-11-08T10:00:00Z", in: "WhatsApp" }), "You told Closedhand it's off, in WhatsApp on Sun 8 Nov.");
  assert.equal(why({ by: "you", at: "2026-11-08T10:00:00Z" }), "You took it off on Sun 8 Nov.");
  assert.equal(why({ by: "closedhand", why: "Tasca Verde emailed on Sat 7 Nov that the table is cancelled." }), "Tasca Verde emailed on Sat 7 Nov that the table is cancelled.");
  assert.equal(why(null, "Example Air"), "Example Air cancelled this flight.");
});

test("Upcoming is its own tab, second, and every link to what is coming up opens it", () => {
  assert.match(dashboard, /data-tab="connections"[^\n]*>Connections<\/button>\n\s*<button class="tab" data-tab="upcoming" onclick="switchTab\('upcoming'\)">Upcoming<\/button>\n\s*<button class="tab" data-tab="agents"/);
  const upcoming = dashboard.slice(dashboard.indexOf('id="tab-upcoming"'), dashboard.indexOf("<!-- Settings Tab Content -->"));
  assert.match(upcoming, /<p class="goals-intro">Your bookings, flights and reminders from everything you've connected, soonest first\.<\/p>/);
  assert.match(upcoming, /<div id="upcoming-list"><\/div>[\s\S]*<div id="cancelled-section" hidden>[\s\S]*<div id="past-section" hidden>/);
  const agents = dashboard.slice(dashboard.indexOf('id="tab-agents"'), dashboard.indexOf('id="tab-upcoming"'));
  assert.doesNotMatch(agents, /upcoming-list|past-section/, "not on Agents");
  assert.match(dashboard, /if \(tabName === 'upcoming'\) loadUpcoming\(\);/);
  assert.match(dashboard, /\{ tab: 'upcoming', text: 'Upcoming is what is coming up:/, "the tour shows it");
  assert.match(dashboard, /\.flights-away \{ color: var\(--dim\);/, "the date beside Today, in a neutral colour: the accent is Closedhand's");
  assert.doesNotMatch(dashboard.slice(dashboard.indexOf("var UPCOMING_ICON"), dashboard.indexOf("function updateUpcomingEmpty")), /&#\d{4,6};&#65039;|\\u\{1F|'\\u23F0'/, "line icons, no emoji");
  assert.match(read("lib/flights-scheduler.js"), /dashboardUrl\(link\.platform, "upcoming"\)/);
  assert.match(read("lib/flights.js"), /dashboardUrl\(link\.platform, "upcoming"\)/);
  assert.equal((read("lib/tools/handlers.js").match(/dashboardUrl\(toolInput\._platform \|\| ctx\.activePlatform, "upcoming"\)/g) || []).length, 2);
  assert.match(read("webapp/views/index.html"), /hash === '#upcoming' \? 'Upcoming'/);
});

test("a reminder about an appointment shows the appointment's time, and when it will remind beside it", async () => {
  const FlightTime = require("../webapp/public/flight-time.js");
  const timeline = dashboard.slice(dashboard.indexOf("    var _upcoming = {"), dashboard.indexOf("    function updateUpcomingEmpty() {"));
  const reminders = fn("upcomingEntry") + fn("upcomingRow") + dashboard.slice(dashboard.indexOf("    function reminderTitle(name) {"), dashboard.indexOf("    async function loadFlights() {"));
  const els = { "upcoming-list": { innerHTML: "" }, "reminders-past": { innerHTML: "" } };
  const rows = [
    { name: "Plumber visit", next_at: "2027-03-12T07:30:00Z", event_at: "2027-03-12T09:00:00Z", timezone: "Europe/Lisbon", repeats: null },
    { name: "Water the plants", next_at: "2027-03-13T18:00:00Z", timezone: "Europe/Lisbon", repeats: "every Sat" },
  ];
  const ctx = { FlightTime, console, esc: (t) => String(t), escHtml: (t) => String(t), shortDay: () => "", updateUpcomingEmpty() {}, UPCOMING_ICON: { reminder: "", done: "" },
    document: { getElementById: (id) => els[id] || null },
    fetch: async () => ({ ok: true, json: async () => rows }) };
  vm.runInNewContext(timeline + reminders + "\nthis.loadReminders = loadReminders;", ctx);
  await ctx.loadReminders();
  const html = els["upcoming-list"].innerHTML;
  assert.match(html, /<div class="up-time">09:00<\/div><div class="up-body"><div class="up-title"><span class="up-icon"><\/span><span class="up-name">Plumber visit<\/span><\/div><div class="up-sub">Reminder at 07:30<\/div>/, "the event's time, the reminder's under it");
  assert.match(html, /<div class="up-time">18:00<\/div><div class="up-body"><div class="up-title"><span class="up-icon"><\/span><span class="up-name">Water the plants<\/span><\/div><div class="up-sub">Reminder, every Sat<\/div>/, "a plain reminder still shows when it fires");
  assert.match(read("migrations/056_reminder_event_time.sql"), /ALTER TABLE schedules ADD COLUMN IF NOT EXISTS event_at timestamptz;/);
  assert.match(read("lib/tools/definitions.js"), /event_at: \{\n\s*type: "string",\n\s*description: "When the reminder is about something at a set time/);
  assert.match(read("user-store.js"), /run_once: runOnce, timezone, platform, event_at: eventAt, kind: kind === "task" \? "task" : "reminder" \}/);
});

test("New agent: one description, then the plan as one sentence; a team led by Closedhand is one task; it answers in the chat chosen", async () => {
  const form = dashboard.slice(dashboard.indexOf('id="auto-create-modal"'), dashboard.indexOf('<!-- Note Modal -->'));
  assert.match(form, /<h3 id="auto-modal-title">What should the agent do\?<\/h3>/);
  assert.match(form, /<p class="plan-line" id="auto-plan-line" aria-live="polite"><\/p>/);
  for (const part of ['id="plan-name"', 'id="plan-when"', 'id="plan-where"', 'id="plan-project"'])
    assert.ok(form.includes(part), "a part of the plan: " + part);
  assert.match(dashboard, /line\.innerHTML = tok\('name', name\) \+ ' ' \+ tok\('when', whenWords\(\)\)/);
  // New agent makes one agent: saved on its own or added to a team, never a
  // team inside it ("Add an agent" inside New agent read as a loop). A team's
  // window has its agents, a card each, the tile that adds one last.
  assert.match(form, /<div class="agents-row" id="auto-agents-row" hidden>\n\s*<div class="agents-row-head"><h4>Agents<\/h4><button type="button" class="quiet-link" id="auto-suggest-agents" onclick="suggestAgents\(\)">Suggest agents<\/button><\/div>\n\s*<p class="agents-row-note">Closedhand coordinates these agents and sends you one answer\.<\/p>\n\s*<div class="team-strip">\n\s*<div id="auto-team"><\/div>\n\s*<div id="auto-team-add"><\/div>/);
  assert.doesNotMatch(form, /team-agent lead|on its own/);
  assert.match(dashboard, /document\.getElementById\('auto-agents-row'\)\.hidden = !team;/, "agents only in a team's window");
  assert.match(form, /<button type="button" class="quiet-link" id="auto-back-btn" onclick="composerBack\(\)">Cancel<\/button>\n\s*<button type="button" class="btn-quiet" id="auto-to-team" hidden onclick="openPick\(\)">Add to a team<\/button>\n\s*<button type="button" class="cta" id="auto-save-btn" onclick="composerGo\(\)">Next<\/button>/, "one main action, the team a secondary one");
  assert.match(dashboard, /document\.getElementById\('auto-to-team'\)\.hidden = !\(_mode === 'agent' && _planned && !editing\);/);
  assert.match(dashboard, /team: \['What should the team do\?', /);
  assert.match(dashboard, /line\.innerHTML = tok\('name', name\) \+ ' joins ' \+ /, "an agent for a team runs when the team runs");
  assert.match(dashboard, /fetch\('\/api\/agents\/plan', \{ method: 'POST'/, "Closedhand reads the plan from the words");
  assert.match(dashboard, /if \(!editingRoutine\(\)\) rows\.push\(\{ kind: 'now', label: 'Now', note: 'Once, starting straight away' \}\);/, "Now first, beside the routine choices");
  assert.doesNotMatch(dashboard, /if \(box\.children\.length >= 4\) return;/, "no cap of five");
  assert.match(dashboard, /name: name,\n\s*description: prompt\.substring\(0, 200\),/, "a routine keeps the name as given");

  // The start step, run: the agents in the plan are one team, one task.
  const a = dashboard.indexOf("    function teamFromForm()");
  const e = dashboard.indexOf("    function emptyPart()");
  const code = dashboard.slice(e, dashboard.indexOf("\n", e)) + "\n" + dashboard.slice(a, dashboard.indexOf("\n    }\n", dashboard.indexOf("    async function startTasks()")) + 6);
  const needs = [];
  const el = (value) => ({ value, style: {}, textContent: "", disabled: false });
  const ids = { "auto-prompt-input": el("Find flights from Osaka to Seoul on 8 Nov, direct only"), "auto-name-input": el("Seoul flights"), "auto-create-error": el(""), "auto-save-btn": el("") };
  const team = (name, part) => ({ querySelector: (sel) => (sel === ".team-goal" ? { value: part } : { value: name }) });
  const posts = [], toasts = [];
  let rows = [team("Hotels", "Hotels near the clinic, under ¥20,000"), team("", "Trains from the airport"), team("", "")];
  const ctx = { document: { getElementById: (id) => ids[id], querySelectorAll: () => rows }, _answerIn: "whatsapp_linked", _places: [{ id: "whatsapp_linked", name: "WhatsApp" }],
    fetch: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({}) }; }, goLabel() {},
    closeCreateAutomationModal() {}, showToast: (m) => toasts.push(m), loadAgents() {}, needsField: (field, text) => needs.push({ field, text }),
    needsPart: () => needs.push({ text: "Say what this agent should do." }), needsAgent: () => needs.push({ text: "Add an agent to the team." }), _mode: "agent", _planProject: "" };
  vm.runInNewContext(code + "\nthis.startTasks = startTasks;", ctx);
  await ctx.startTasks();
  assert.equal(posts.length, 1, "one task for the team");
  assert.equal(JSON.stringify(posts[0].body), JSON.stringify({ answer_in: "whatsapp_linked", goal: "Find flights from Osaka to Seoul on 8 Nov, direct only", title: "Seoul flights",
    members: [{ name: "Hotels", part: "Hotels near the clinic, under ¥20,000" }, { name: "", part: "Trains from the airport" }] }), "an empty extra agent is left out, and the limits are in the words");
  assert.deepEqual(toasts, ["Team started. It answers in WhatsApp."]);
  rows = []; posts.length = 0; toasts.length = 0;
  await ctx.startTasks();
  assert.equal(posts[0].body.members, undefined, "one agent alone is a task");
  assert.deepEqual(toasts, ["Started. It answers in WhatsApp."]);
  rows = [team("Hotels", "x")]; posts.length = 0;
  await ctx.startTasks();
  assert.equal(posts.length, 0);
  // What is still needed is said at the field itself, not at the foot of the form.
  assert.equal(needs.at(-1).text, "Say what this agent should do.");
  ids["auto-prompt-input"].value = ""; rows = [];
  await ctx.startTasks();
  assert.deepEqual(needs.at(-1), { field: ids["auto-prompt-input"], text: "Say what it should do." });
  assert.equal(ids["auto-create-error"].textContent, "", "nothing at the foot");
  // A team with no agents is not a team.
  ids["auto-prompt-input"].value = "Plan a weekend in Porto"; ctx._mode = "team"; posts.length = 0;
  await ctx.startTasks();
  assert.equal(posts.length, 0);
  assert.equal(needs.at(-1).text, "Add an agent to the team.");
});

test("Add to a team: an agent joins one of the person's teams, or a new team made with it", async () => {
  const a = dashboard.indexOf("    async function addToTeam()");
  const code = dashboard.slice(a, dashboard.indexOf("\n    }\n", a) + 6);
  const el = (value) => ({ value, style: {}, textContent: "", disabled: false, checked: false });
  const ids = { "auto-name-input": el("Train times"), "auto-prompt-input": el("Check my trains to work and tell me if one is late."), "auto-acts-box": el(""),
    "auto-create-error": el(""), "auto-save-btn": el(""), "auto-new-team-name": el(""), "auto-pick-list": el("") };
  const sent = [], toasts = [], needs = [];
  const ctx = { document: { getElementById: (id) => ids[id] }, needsField: (f, t) => needs.push(t), goLabel() {}, closeCreateAutomationModal() {}, showToast: (m) => toasts.push(m),
    loadAgents: async () => {}, justAdded() {}, routineBody: () => ({ name: "Train times", trigger_type: "scheduled", members: [] }),
    fetch: async (url, opts) => { sent.push({ url, method: opts.method, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ id: "t9" }) }; },
    _pickTeam: null, _teamList: [{ id: "t1", name: "Monday money check", members: [{ name: "Bank", part: "What went out." }] }] };
  vm.runInNewContext(code + "\nthis.addToTeam = addToTeam;", ctx);
  await ctx.addToTeam();
  assert.deepEqual(needs, ["Choose a team."]);
  ctx._pickTeam = "t1";
  await ctx.addToTeam();
  assert.deepEqual(sent[0], { url: "/api/automations/t1", method: "PUT", body: { members: [{ name: "Bank", part: "What went out." }, { name: "Train times", part: "Check my trains to work and tell me if one is late." }] } }, "added after the agents it has");
  assert.deepEqual(toasts, ["Train times added to Monday money check."]);
  ctx._pickTeam = "new"; sent.length = 0;
  await ctx.addToTeam();
  assert.equal(needs.at(-1), "Name the team.");
  ids["auto-new-team-name"].value = "Commute"; ids["auto-acts-box"].checked = true;
  await ctx.addToTeam();
  assert.deepEqual(sent[0], { url: "/api/automations", method: "POST", body: { name: "Commute", trigger_type: "scheduled", members: [{ name: "Train times", part: "Check my trains to work and tell me if one is late.", acts: true }] } }, "a new team takes the agent's plan and the agent");
  assert.match(dashboard, /var trigger = _when\.kind === 'once' \|\| _when\.kind === 'custom' \? 'scheduled' : _when\.kind === 'now' \? 'manual' : _when\.kind;/, "starting now, kept as a team, runs when you ask");
});

test("a working task can be told something", () => {
  assert.match(dashboard, /onclick="event\.stopPropagation\(\);openTell\(this, \\'' \+ a\.id \+ '\\'\)">Tell it something<\/button>'/);
  assert.match(dashboard, /fetch\('\/api\/agents\/' \+ id \+ '\/note', \{ method: 'POST'/);
  assert.match(dashboard, /else if \(res && res\.status === 409\) \{ box\.remove\(\); showToast\('It finished before that reached it\. Its answer is on its card\.', true\); loadAgents\(\); \}/, "a note too late says the task finished and shows it");
  assert.match(dashboard, /if \(tab === 'agents' && !document\.querySelector\('\.agent-tell'\)\) loadAgents\(\);/, "the list waits while something is being typed");
});

// A task waiting for an answer sits under Working now; it showed a bin that
// could not delete it (only finished runs delete) where every other working
// card has Stop.
test("a task waiting for an answer stops like any working task, never deletes", () => {
  assert.match(dashboard, /: a\.status === 'awaiting_confirmation'\n\s+\? '<button class="agent-del" title="Stop this task"[^\n]*stopAgentRun\(\\'' \+ a\.id \+ '\\', this, true\)">Stop<\/button>'/);
  assert.match(dashboard, /showToast\(waiting \? 'Stopped\. Its question in the chat no longer needs an answer\.' :/);
  const server = read("webapp/server.js");
  const stop = server.slice(server.indexOf('app.post("/api/agents/:id/stop"'), server.indexOf('app.delete("/api/agents/:id"'));
  assert.match(stop, /\.in\("status", \["running", "pending", "awaiting_confirmation"\]\)/);
  assert.doesNotMatch(server, /\/api\/agents\/:id\/cancel/, "one way to stop a task");
});

// On a phone a booking's or flight's status and its x wrapped onto a line of
// their own at the bottom left; they stay top right, the route beneath.
test("on a phone each Upcoming row keeps its time column and x, and its details sit under the title", () => {
  const phone = dashboard.slice(dashboard.indexOf("    /* === Upcoming === */"), dashboard.indexOf("    /* === Location & Weather Widget === */"));
  assert.match(phone, /@media \(max-width: 600px\) \{\n\s+\.up-item, \.up-gone \{ grid-template-columns: 3\.25rem minmax\(0, 1fr\) 2rem;/);
  assert.match(phone, /\.up-end-word \{ display: none; \}\n\s+\.up-end-arrow \{ display: inline; \}/, "\"lands 15:55\" is \"\u2192 15:55\" on a phone");
  assert.match(phone, /\.up-sub, \.up-facts, \.up-route, \.up-from, \.up-body \.source-docs \{ padding-left: 0; \}/);
  assert.match(phone, /\.source-doc \{ min-height: 2\.25rem;/, "an email or file is big enough to tap");
  assert.equal((dashboard.match(/upcoming-card-row|upcoming-card-main|class="upcoming-row"/g) || []).length, 0, "one row shape for everything");
});
