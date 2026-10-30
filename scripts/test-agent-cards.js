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

test("tasks handed over in chat: going or waiting under Working now, finished this week under Done lately", () => {
  const server = read("webapp/server.js");
  assert.match(server, /const LIVE_RUN_STATUSES = \["running", "pending", "awaiting_confirmation"\];/);
  assert.match(server, /const lists = \[runs\(\)\.in\("status", LIVE_RUN_STATUSES\), runs\(\)\.in\("status", DONE_RUN_STATUSES\)\.gte\("created_at", cutoff\)\];/, "a delivered task stays a week, under Done lately");
  assert.match(server, /select\("id, goal, title, status, model, result, progress, tools_used, error, created_at, completed_at, result_edited_at, runtime, delivery_status"\)/);
  assert.doesNotMatch(server, /\/api\/agents[^\n]*archived|req\.query\.archived === "1" && req\.query\.count === "1"\) \{\n\s*const \{ count, error \} = await supabase\.from\("agent_tasks"\)/, "no archive of delivered runs");
  assert.doesNotMatch(dashboard, /toggleArchivedRuns|_archivedRunCount|\/api\/agents\?archived=1/);
  assert.match(dashboard, /a\.delivery_status !== 'sent' &&\n\s*a\.completed_at && Date\.now\(\) - new Date\(a\.completed_at\)\.getTime\(\) > 2 \* 60000\) \{\n\s*detail = 'This may not have reached the chat you asked in, so it stays here\. ' \+ detail;/, "a late delivery says why");
  assert.match(dashboard, /function archiveRow\(toggle, count, open\) \{\n\s*if \(!count\) return '';/, "Pages keeps its Archived row");
  assert.match(dashboard, /escapeHtml\('Task \\u00b7 ' \+ \(running \|\| asked \? '' : sentenceCase\(runWord\(a\)\) \+ ' \\u00b7 '\) \+ String\(detail\)\)/, "a task says what it is and how it stands, in words");
  assert.doesNotMatch(dashboard, /auto-status-pill|&#9632; Stop|&#8595; PDF|&#9654; Run|&#9208; Pause/, "no stock pills, no glyph buttons");
  assert.match(dashboard, />Closedhand working for you: tasks you hand it here or in chat, and routines that run on their own\.</, "the tab says what it holds");
});

test("the Agents tab holds Closedhand working for you: what is working now, the routines, what finished; what it made is on Pages", () => {
  assert.match(dashboard, /<button class="tab" data-tab="agents" onclick="switchTab\('agents'\)">Agents<\/button>/);
  const agents = dashboard.slice(dashboard.indexOf('id="tab-agents"'), dashboard.indexOf('id="tab-upcoming"'));
  assert.match(agents, /<button type="button" class="goals-new" onclick="openNewAgent\(\)">\+ New agent<\/button>[\s\S]*<div class="mc-section-label">Working now<\/div>[\s\S]*>Routines<\/div>[\s\S]*>Done lately<\/div>/, "one way to start one at the top, then in that order");
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
  assert.match(dashboard, /<button type="button" class="mc-section-label archive-row" id="past-toggle" aria-expanded="false" aria-controls="past-body" onclick="togglePast\(\)">Past <span class="count" id="past-count"><\/span><span class="chevron-down"><\/span><\/button>/, "Past is a heading row like Archived");
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
  assert.match(read("lib/engine.js"), /Sections: #upcoming \(bookings, flights and reminders, soonest first\), #agents \(tasks working now, routines, what finished lately\),/);
});

test("a routine says what it does, when it runs, how it last ran and whether it is on; a run says how it went", () => {
  const code = ["function renderAutomationCard(a)", "function renderRoutineRun(r)", "function dayAndTime(iso)"].map((sig) => {
    const a = dashboard.indexOf("    " + sig);
    return dashboard.slice(a, dashboard.indexOf("\n    }\n", a) + 6);
  }).join("\n");
  const ctx = { esc: (t) => String(t), truncatePrompt: (t) => String(t), watchLine: () => "When an email from the bank arrives", TRASH_ICON: "[bin]" };
  vm.runInNewContext(code + "\nthis.card = renderAutomationCard; this.run = renderRoutineRun;", ctx);
  const at = (days, h) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const on = ctx.card({ id: "r1", name: "Morning briefing", description: "Your day's calendar and the weather.", status: "active", trigger_type: "scheduled", trigger_human_schedule: "Every morning at 08:00", next_at: at(1, 8), last_run: { status: "success", at: at(0, 8) } });
  assert.match(on, /Every morning at 08:00 · next tomorrow at 08:00 · last ran today at 08:00/);
  assert.match(on, /<input type="checkbox" checked onchange="setRoutineOn\('r1', this\)"/);
  assert.match(on, />Run now<\/button>[\s\S]*>Edit<\/button>[\s\S]*\[bin\]/);
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
  assert.match(ctx.run({ id: "u1", name: "Inbox sort", live: true, started_at: at(0, 9), progress: [JSON.stringify({ text: "Reading 12 new emails" })] }), /Routine · Reading 12 new emails · started today at 09:00/);
  const done = ctx.run({ id: "u2", name: "Inbox sort", live: false, status: "success", started_at: at(-1, 9), completed_at: at(-1, 9), output_summary: "Two urgent:\n the landlord and the dentist." });
  assert.match(done, /Routine · Done · yesterday at 09:00 · Two urgent: the landlord and the dentist\./);
  assert.match(done, /viewAutoRun\('u2'\)">Open<\/button>/);
  assert.doesNotMatch(ctx.run({ id: "u3", name: "Inbox sort", live: false, status: "failed", started_at: at(0, 6) }), /Open/, "nothing to open when it could not finish");
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
  assert.match(dashboard, /data-model="fast"[\s\S]*data-model="default"[\s\S]*data-model="strong"/);
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
  assert.deepEqual(headings, [FlightTime.dateLabel("2027-03-12T09:15:00Z", tz), FlightTime.dateLabel("2027-03-13T14:20:00Z", tz)], "a reminder's date is a heading like a flight's");
  assert.ok(el.innerHTML.indexOf("[reminder]") < el.innerHTML.indexOf("[reminder 2]") && el.innerHTML.indexOf("[reminder 2]") < el.innerHTML.indexOf("[flight]"), "in time order across kinds, under one heading per day");
  assert.doesNotMatch(dashboard, /id="reminders-list"|id="flights-list"|id="bookings-list"|id="goal-checkins-list"/, "one list, not four");
});

test("a hotel stay holds what happens while you are there: check-in on top, each night said, check-out below", () => {
  const FlightTime = require("../webapp/public/flight-time.js");
  const timeline = dashboard.slice(dashboard.indexOf("    var _upcoming = {"), dashboard.indexOf("    function updateUpcomingEmpty() {"));
  const stays = dashboard.slice(dashboard.indexOf("    function localDay("), dashboard.indexOf("    // Flights and bookings Closedhand found are removed"));
  const el = { innerHTML: "" };
  const ctx = { FlightTime, esc: (t) => String(t), escHtml: (t) => String(t), updateUpcomingEmpty() {}, UPCOMING_ICON: { checkout: "" },
    fmtBookingTime: (iso, tz) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }),
    document: { getElementById: (id) => (id === "upcoming-list" ? el : null) } };
  vm.runInNewContext(timeline + stays + "\nthis.setUpcoming = setUpcoming; this.upcomingItem = upcomingItem; this.stayOf = stayOf; this.renderCheckoutCard = renderCheckoutCard;", ctx);
  const seoul = { tz: "Asia/Seoul" };
  const hotel = { id: "h1", kind: "hotel", title: "Hotel Aurora Seoul, 3 nights", status: "confirmed", timezone: "Asia/Seoul", starts_at: "2027-11-08T06:00:00Z", ends_at: "2027-11-11T02:00:00Z" };
  const checkIn = Object.assign(ctx.upcomingItem(hotel.starts_at, seoul, "[check in]"), { stay: ctx.stayOf(hotel) });
  const checkOut = Object.assign(ctx.upcomingItem(hotel.ends_at, seoul, ctx.renderCheckoutCard(hotel)), { stayEnd: "h1" });
  ctx.setUpcoming("flights", [ctx.upcomingItem("2027-11-08T00:10:00Z", { tz: "Asia/Tokyo" }, "[flight out]"), ctx.upcomingItem("2027-11-11T06:05:00Z", seoul, "[flight back]")]);
  ctx.setUpcoming("reminders", [ctx.upcomingItem("2027-11-11T02:00:00Z", seoul, "[same minute]")]);
  ctx.setUpcoming("bookings", [checkIn, checkOut, ctx.upcomingItem("2027-11-09T02:00:00Z", seoul, "[implant]"),
    ctx.upcomingItem("2027-11-10T10:30:00Z", seoul, "[dinner]"), ctx.upcomingItem("2027-11-11T01:30:00Z", seoul, "[follow-up]")]);
  const html = el.innerHTML;
  const at = (s) => html.indexOf(s);
  assert.ok(at("[flight out]") < at('<div class="stay">[check in]<div class="stay-inside">'), "the flight there comes before the stay");
  const inside = html.slice(at('<div class="stay-inside">'), at("Check out"));
  for (const s of ["[implant]", "[dinner]", "[follow-up]"]) assert.ok(inside.includes(s), s + " is inside the stay");
  assert.match(inside, /night 2 of 3[\s\S]*\[implant\][\s\S]*last night[\s\S]*\[dinner\][\s\S]*check-out day[\s\S]*\[follow-up\]/, "each day says which night it is");
  assert.match(html, /<\/div><div class="flight-card">[\s\S]*Check out<\/span><div[^>]*>Hotel Aurora Seoul, 3 nights \u00b7 by 11:00<\/div>[\s\S]*?<\/div><\/div>\[same minute\]/, "the check-out closes the stay, before anything at the same minute");
  assert.ok(at("[same minute]") < at("[flight back]"), "and what follows it is after the stay");
  assert.equal(ctx.stayOf({ ...hotel, status: "cancelled" }), null, "a cancelled stay is a plain card");
  assert.equal(ctx.stayOf({ ...hotel, ends_at: null }), null, "so is one with no check-out");
  assert.equal(ctx.stayOf({ ...hotel, kind: "restaurant" }), null, "only a stay holds things");
  assert.match(dashboard, /\.stay::before \{ content: ''; position: absolute; left: 1\.3125rem;/, "a line down from the check-in card's icon");
});

test("flights and bookings found for you are removed the same way, from the same x, and both ask first", () => {
  assert.match(dashboard, /onclick="confirmBookingRemove\(this, \\'' \+ b\.id \+ '\\'\)"/);
  assert.match(dashboard, /onclick="confirmFlightRemove\(this, '\$\{escHtml\(f\._key\)\}'\)"/);
  assert.match(dashboard, /askFirst\(btn, \{ text: 'Remove this booking from Upcoming for good\?', yes: 'Remove' \}\)/);
  assert.match(dashboard, /askFirst\(btn, \{ text: 'Remove this flight\? Closedhand stops tracking it\.', yes: 'Remove' \}\)/);
  assert.doesNotMatch(dashboard, /onclick="removeBooking\(/, "nothing removes without asking");
  const server = read("webapp/server.js");
  assert.match(server, /app\.delete\("\/api\/flights\/:key"/);
  assert.match(server, /const marked = \{ \.\.\.flight, supersededBy: "removed", supersededAt: new Date\(\)\.toISOString\(\) \};/, "kept and marked, so the scan that found it does not add it again");
  assert.match(server, /if \(!\/\^flight-\[A-Za-z0-9-\]\+\$\/\.test\(key\)\) return res\.status\(400\)/, "only a flight's own key");
});

test("Upcoming is its own tab, second, and every link to what is coming up opens it", () => {
  assert.match(dashboard, /data-tab="connections"[^\n]*>Connections<\/button>\n\s*<button class="tab" data-tab="upcoming" onclick="switchTab\('upcoming'\)">Upcoming<\/button>\n\s*<button class="tab" data-tab="agents"/);
  const upcoming = dashboard.slice(dashboard.indexOf('id="tab-upcoming"'), dashboard.indexOf("<!-- Settings Tab Content -->"));
  assert.match(upcoming, /<p class="goals-intro">Your bookings, flights and reminders from everything you've connected, soonest first\.<\/p>/);
  assert.match(upcoming, /<div id="upcoming-list"><\/div>[\s\S]*<div id="past-section" hidden>/);
  const agents = dashboard.slice(dashboard.indexOf('id="tab-agents"'), dashboard.indexOf('id="tab-upcoming"'));
  assert.doesNotMatch(agents, /upcoming-list|past-section/, "not on Agents");
  assert.match(dashboard, /if \(tabName === 'upcoming'\) loadUpcoming\(\);/);
  assert.match(dashboard, /\{ tab: 'upcoming', text: 'Upcoming is what is coming up:/, "the tour shows it");
  assert.match(dashboard, /\.flights-away \{ color: var\(--muted\);/, "how far away a day is, in a neutral colour: the accent is Closedhand's");
  assert.doesNotMatch(dashboard.slice(dashboard.indexOf("var UPCOMING_ICON"), dashboard.indexOf("function updateUpcomingEmpty")), /&#\d{4,6};&#65039;|\\u\{1F|'\\u23F0'/, "line icons, no emoji");
  assert.match(read("lib/flights-scheduler.js"), /dashboardUrl\(link\.platform, "upcoming"\)/);
  assert.match(read("lib/flights.js"), /dashboardUrl\(link\.platform, "upcoming"\)/);
  assert.equal((read("lib/tools/handlers.js").match(/dashboardUrl\(toolInput\._platform \|\| ctx\.activePlatform, "upcoming"\)/g) || []).length, 2);
  assert.match(read("webapp/views/index.html"), /hash === '#upcoming' \? 'Upcoming'/);
});

test("a reminder about an appointment shows the appointment's time, and when it will remind beside it", async () => {
  const FlightTime = require("../webapp/public/flight-time.js");
  const timeline = dashboard.slice(dashboard.indexOf("    var _upcoming = {"), dashboard.indexOf("    function updateUpcomingEmpty() {"));
  const reminders = dashboard.slice(dashboard.indexOf("    function reminderTitle(name) {"), dashboard.indexOf("    async function loadFlights() {"));
  const els = { "upcoming-list": { innerHTML: "" }, "reminders-past": { innerHTML: "" } };
  const rows = [
    { name: "Plumber visit", next_at: "2027-03-12T07:30:00Z", event_at: "2027-03-12T09:00:00Z", timezone: "Europe/Lisbon", repeats: null },
    { name: "Water the plants", next_at: "2027-03-13T18:00:00Z", timezone: "Europe/Lisbon", repeats: "every Sat" },
  ];
  const ctx = { FlightTime, console, esc: (t) => String(t), updateUpcomingEmpty() {}, UPCOMING_ICON: { reminder: "", done: "" },
    document: { getElementById: (id) => els[id] || null },
    fetch: async () => ({ ok: true, json: async () => rows }) };
  vm.runInNewContext(timeline + reminders + "\nthis.loadReminders = loadReminders;", ctx);
  await ctx.loadReminders();
  const html = els["upcoming-list"].innerHTML;
  assert.match(html, /Plumber visit<\/span><span class="upcoming-kind">Reminder at 07:30<\/span><\/span><span class="upcoming-when">09:00<\/span>/, "the event's time, the reminder's beside it");
  assert.match(html, /Water the plants<\/span><span class="upcoming-kind">Reminder, every Sat<\/span><\/span><span class="upcoming-when">18:00<\/span>/, "a plain reminder still shows when it fires");
  assert.match(read("migrations/056_reminder_event_time.sql"), /ALTER TABLE schedules ADD COLUMN IF NOT EXISTS event_at timestamptz;/);
  assert.match(read("lib/tools/definitions.js"), /event_at: \{\n\s*type: "string",\n\s*description: "When the reminder is about something at a set time/);
  assert.match(read("user-store.js"), /run_once: runOnce, timezone, platform, event_at: eventAt \}/);
});

test("New agent: a task now, or a routine; a small team; each answers in the chat chosen", async () => {
  const form = dashboard.slice(dashboard.indexOf('id="auto-create-modal"'), dashboard.indexOf('<!-- Note Modal -->'));
  assert.match(form, /<h3 id="auto-modal-title">New agent<\/h3>/);
  assert.match(form, /data-trigger="now" onclick="selectTrigger\('now'\)">Now<\/button>\n\s*<button type="button" class="auto-trigger-btn active" data-trigger="manual"/, "Now first, beside the routine choices");
  assert.match(form, /<label for="auto-scope-input">Scope <span class="project-optional">Optional<\/span><\/label>/);
  for (const part of ['class="routine-only" style="flex:1;min-width:13.75rem;">\n      <label for="auto-template-select">', 'id="auto-skills-section" class="routine-only"', 'id="auto-advanced" class="routine-only"', 'class="auto-project-hint routine-only"'])
    assert.ok(form.includes(part), "a routine's own: " + part.slice(0, 40));
  for (const part of ['id="auto-team" class="task-only"', 'id="auto-answer-row" class="task-only"', 'class="task-only team-add"'])
    assert.ok(form.includes(part), "a task's own: " + part.slice(0, 40));
  assert.match(dashboard, /#auto-create-modal\.task-mode \.routine-only, #auto-create-modal:not\(\.task-mode\) \.task-only \{ display: none !important; \}/);
  assert.match(dashboard, /document\.getElementById\('auto-create-modal'\)\.classList\.toggle\('task-mode', type === 'now'\);/);
  assert.match(dashboard, /if \(box\.children\.length >= 4\) return;/, "five agents at most");
  assert.match(dashboard, /name: name,\n\s*description: prompt\.substring\(0, 200\),/, "a routine keeps the name as typed");

  // The start step, run: each agent in the form is its own task.
  const a = dashboard.indexOf("    async function startTasks()");
  const code = dashboard.slice(a, dashboard.indexOf("\n    }\n", a) + 6);
  const el = (value) => ({ value, style: {}, textContent: "", disabled: false });
  const ids = { "auto-prompt-input": el("Find flights from Osaka to Seoul on 8 Nov"), "auto-scope-input": el("Direct only"), "auto-name-input": el("Seoul flights"),
    "auto-create-error": el(""), "auto-save-btn": el(""), "auto-answer-select": { value: "whatsapp_linked", selectedIndex: 0, options: [{ text: "WhatsApp" }] } };
  const team = (goal, scope) => ({ querySelector: (sel) => (sel === ".team-goal" ? { value: goal } : { value: scope }) });
  const posts = [], toasts = [];
  const ctx = { document: { getElementById: (id) => ids[id], querySelectorAll: () => [team("Hotels near the clinic, under ¥20,000", "Walking distance"), team("", "")] },
    fetch: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({}) }; },
    closeCreateAutomationModal() {}, showToast: (m) => toasts.push(m), loadAgents() {} };
  vm.runInNewContext(code + "\nthis.startTasks = startTasks;", ctx);
  await ctx.startTasks();
  assert.equal(posts.length, 2, "an empty extra agent is left out");
  assert.ok(posts.every((p) => p.url === "/api/agents" && p.body.answer_in === "whatsapp_linked"));
  assert.equal(JSON.stringify(posts[0].body), JSON.stringify({ answer_in: "whatsapp_linked", goal: "Find flights from Osaka to Seoul on 8 Nov", scope: "Direct only", title: "Seoul flights" }));
  assert.equal(JSON.stringify(posts[1].body), JSON.stringify({ answer_in: "whatsapp_linked", goal: "Hotels near the clinic, under ¥20,000", scope: "Walking distance" }));
  assert.deepEqual(toasts, ["2 started. They answer in WhatsApp."]);
  ids["auto-prompt-input"].value = "";
  posts.length = 0;
  await ctx.startTasks();
  assert.equal(posts.length, 0);
  assert.equal(ids["auto-create-error"].textContent, "Say what each agent should do.");
});

test("a routine's scope travels in its instructions and reads back apart; a working task can be told something", () => {
  const a = dashboard.indexOf("    var SCOPE_HEAD");
  const ctx = {};
  vm.runInNewContext(dashboard.slice(a, dashboard.indexOf("    function splitRules(full) {")) + "\nthis.splitScope = splitScope; this.HEAD = SCOPE_HEAD;", ctx);
  const back = ctx.splitScope("Check my inbox for invoices" + ctx.HEAD + "Only from the studio account");
  assert.equal(back.prompt, "Check my inbox for invoices");
  assert.equal(back.scope, "Only from the studio account");
  assert.equal(ctx.splitScope("No scope here").scope, "");
  assert.match(dashboard, /task_prompt: withRules\(prompt \+ \(scope \? SCOPE_HEAD \+ scope : ''\), /);
  assert.match(dashboard, /onclick="event\.stopPropagation\(\);openTell\(this, \\'' \+ a\.id \+ '\\'\)">Tell it something<\/button>'/);
  assert.match(dashboard, /fetch\('\/api\/agents\/' \+ id \+ '\/note', \{ method: 'POST'/);
  assert.match(dashboard, /else if \(res && res\.status === 409\) \{ box\.remove\(\); showToast\('It finished before that reached it\. Its answer is under Done lately\.', true\); loadAgents\(\); \}/, "a note too late says the task finished and shows it");
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
test("on a phone an Upcoming card keeps its status and x at the top right", () => {
  assert.match(dashboard, /@media \(max-width: 600px\) \{\n\s+\.upcoming-card-main \{ order: 1; flex-basis: 100%; \}\n\s+\.upcoming-card-row \.flight-status-badge \{ margin-left: auto; \}/);
  assert.equal((dashboard.match(/class="upcoming-card-row"/g) || []).length, 2, "bookings and flights both");
  assert.equal((dashboard.match(/class="upcoming-card-main"/g) || []).length, 2);
  // Its own names: .upcoming-row is a reminder's row, and lent the card's
  // inner row a reminder's border and margin.
  assert.equal((dashboard.match(/class="upcoming-row"/g) || []).length, 0);
});
