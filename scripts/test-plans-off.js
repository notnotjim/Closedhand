// Plans that are no longer going ahead, taken off only on proof
// (lib/plans-off.js). Someone's plans changed and Upcoming went on listing
// the old ones. A plan comes off when a message about it says it is
// cancelled, refunded or not going, in words the person's LLM copied from that
// message; anything less is left to the question Closedhand asks. Invented
// people, places and bookings only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

const NOW = Date.parse("2026-12-01T09:00:00Z");
const DAY = 86400000;
const dinner = { id: "b-dinner", kind: "restaurant", title: "Dinner at Tasca Verde", provider: "Tasca Verde", reference: "TV-88213", starts_at: "2026-12-05T20:00:00+00:00", timezone: "Europe/Lisbon", status: "confirmed", source_email_id: "m-confirm", details: {} };
const visit = { id: "b-visit", kind: "appointment", title: "Follow-up at Clinica Sorriso", provider: "Clinica Sorriso", starts_at: "2026-12-03T10:00:00+00:00", timezone: "Europe/Lisbon", status: "confirmed", source_email_id: "whatsapp:4470000000@lid:2026-11-20", details: { from_chat: { app: "WhatsApp", name: "Clinica Sorriso" } } };
const flightFact = (extra = {}) => ({ value: JSON.stringify({ flightNumber: "XQ512", confirmationCode: "QZP4LM", departure: { airport: "LIS", tz: "Europe/Lisbon", dateTime: "2026-12-06T08:00:00+00:00" }, arrival: { airport: "OPO", tz: "Europe/Lisbon", dateTime: "2026-12-06T09:00:00+00:00" }, ...extra }) });

// lib/plans-off.js with the store and its neighbours stood in.
function harness(facts) {
  const ctx = require("../lib/context");
  ctx.store = { facts };
  const bPath = require.resolve("../lib/bookings"), sPath = require.resolve("../lib/storage");
  const cancelled = [];
  require.cache[bPath] = { id: bPath, filename: bPath, loaded: true, exports: { cancelBooking: async (u, id, how) => { cancelled.push([id, how]); return true; }, endRemindersFor: async () => ["r-1"], listUpcoming: async () => [] } };
  require.cache[sPath] = { id: sPath, filename: sPath, loaded: true, exports: { saveStore() {} } };
  const mPath = require.resolve("../lib/plans-off");
  delete require.cache[mPath];
  return { mod: require("../lib/plans-off"), cancelled, restore() { for (const p of [bPath, sPath, mPath]) delete require.cache[p]; ctx.store = null; } };
}

test("only words copied from the message that say it is off take a plan off", () => {
  const { check } = require("../lib/plans-off");
  const plan = { tz: "Europe/Lisbon", evidence: [{ n: 1, at: NOW, from: "Email from Tasca Verde", text: "Hello, we are sorry to tell you your reservation TV-88213 has been cancelled as the kitchen is closed that night." }] };
  const why = "Tasca Verde emailed on Tue 1 Dec that the table is cancelled.";
  assert.deepEqual(check({ n: 1, quote: "your reservation TV-88213 has been cancelled", why }, plan), { why, quote: "your reservation TV-88213 has been cancelled" });
  assert.equal(check({ n: 1, quote: "your reservation was cancelled by the guest", why }, plan), null, "words that are not in the message");
  assert.equal(check({ n: 2, quote: "your reservation TV-88213 has been cancelled", why }, plan), null, "a message that is not there");
  assert.equal(check({ n: 1, quote: "the kitchen is closed that night", why }, plan), null, "words that do not say cancelled, refunded or not going");
  assert.equal(check({ n: 1, quote: "cancelled", why }, plan), null, "too few words to be sure of");
  const terms = { tz: "Europe/Lisbon", evidence: [{ n: 1, at: NOW, from: "Email from Example Stays", text: "Your stay is coming up. Free cancellation until 4 Dec. If cancelled after that, you will be charged the first night." }] };
  assert.equal(check({ n: 1, quote: "Free cancellation until 4 Dec", why: "x" }, terms), null, "a booking's terms are not a cancellation");
  assert.equal(check({ n: 1, quote: "If cancelled after that, you will be charged the first night", why: "x" }, terms), null, "nor is what would happen if it were");
  const hint = { tz: "Europe/Lisbon", evidence: [{ n: 1, at: NOW, from: "WhatsApp chat with Clinica Sorriso, you wrote", text: "I have to fly back to Toronto earlier than planned" }] };
  assert.equal(check({ n: 1, quote: "I have to fly back to Toronto earlier than planned", why: "x" }, hint), null, "plans that make it unlikely are not proof: that is a question");
  const told = { tz: "Europe/Lisbon", evidence: [{ n: 1, at: NOW, from: "WhatsApp chat with Clinica Sorriso, you wrote", text: "Sorry, I won't be able to come on Thursday, please cancel my follow-up" }] };
  assert.ok(check({ n: 1, quote: "please cancel my follow-up", why: "You told Clinica Sorriso it's off, in WhatsApp on Mon 30 Nov." }, told));
});

test("a plan is found by its reference, flight number and a word of its provider's name, whole words only", () => {
  const { nameWord, plansFrom } = require("../lib/plans-off");
  assert.equal(nameWord("Hotel Aurora Seoul"), "Aurora", "a common word is passed over");
  assert.equal(nameWord("The Grange"), "Grange");
  assert.equal(nameWord("ZEN Spa"), null, "too short to find anything by");
  assert.equal(nameWord("Moda Hair Studio"), "Moda", "the first word of the name that is not common");
  const plans = plansFrom({ bookings: [dinner, visit, { ...dinner, id: "b-gone", status: "cancelled" }, { ...dinner, id: "b-past", starts_at: "2026-11-20T20:00:00Z" }], facts: { "flight-XQ512-2026-12-06": flightFact(), "flight-XQ100-2026-12-07": flightFact({ flightNumber: "XQ100", supersededBy: "removed" }) }, now: NOW });
  assert.deepEqual(plans.map((p) => p.id), ["b-visit", "b-dinner", "flight-XQ512-2026-12-06"], "what is still to come and not already off, soonest first");
  assert.deepEqual(plans.find((p) => p.id === "b-dinner").terms, ["TV-88213".split("-")[1], "Tasca"].map(String), "a reference by its longest part");
  assert.deepEqual(plans.find((p) => p.id === "b-visit").chat, { source: "whatsapp", jid: "4470000000@lid", day: "2026-11-20" }, "and the chat it was booked in");
  assert.deepEqual(plans.find((p) => p.id.startsWith("flight-")).terms, ["XQ512", "QZP4LM"]);
});

test("what was said is read from mail and chats since it was booked, the confirmation itself left out", async () => {
  const dPath = require.resolve("../lib/db");
  const queries = [];
  const rows = {
    terms: [
      { source: "gmail", type: "email", external_id: "m-confirm", received_at: "2026-11-20T10:00:00Z", data: { from: "Tasca Verde", subject: "Your table TV-88213", body: "Confirmed for 5 Dec" } },
      { source: "gmail", type: "email", external_id: "m-cancel", received_at: "2026-11-29T10:00:00Z", data: { from: "Tasca Verde", subject: "TV-88213 cancelled", body: "Your reservation TV-88213 has been cancelled." } },
      { source: "gmail", type: "email", external_id: "m-other", received_at: "2026-11-28T10:00:00Z", data: { from: "Shop", subject: "Tascaria sale", body: "Everything at Tascaria half price" } },
    ],
    chat: [{ source: "whatsapp", type: "message", external_id: "w1", received_at: "2026-11-30T10:00:00Z", data: { chat_name: "Clinica Sorriso", sender: "me", text: "Please cancel my follow-up" } }],
  };
  const q = () => { const calls = []; const b = new Proxy({}, { get: (t, k) => k === "then" ? (res) => res({ data: calls.some((c) => c[0] === "eq" && c[1] === "data->>chat") ? rows.chat : rows.terms }) : (...a) => { calls.push([k, ...a]); return b; } }); queries.push(calls); return b; };
  require.cache[dPath] = { id: dPath, filename: dPath, loaded: true, exports: { supabase: { from: () => q() } } };
  try {
    const { evidenceFor, plansFrom } = require("../lib/plans-off");
    const [visitPlan, dinnerPlan] = plansFrom({ bookings: [dinner, visit], now: NOW });
    const said = await evidenceFor("u1", dinnerPlan, { now: NOW });
    assert.deepEqual(said.map((e) => e.from), ["Email from Tasca Verde"], "the confirmation is not evidence, and Tascaria is not Tasca");
    assert.match(said[0].text, /has been cancelled/);
    const or = queries[0].find((c) => c[0] === "or")[1];
    assert.match(or, /data->>subject\.ilike\.%88213%/);
    assert.match(or, /data->>text\.ilike\.%Tasca%/);
    assert.match(or, /data->>chat_name\.ilike\.%Tasca%/, "a chat named after the provider counts");
    const chat = await evidenceFor("u1", visitPlan, { now: NOW });
    assert.equal(chat[0].from, "WhatsApp chat with Clinica Sorriso, you wrote");
    assert.ok(queries.at(-1).some((c) => c[0] === "gte" && c[2] === "2026-11-20T00:00:00Z"), "the chat since the day it was booked");
  } finally { delete require.cache[dPath]; }
});

test("a plan the evidence shows is off comes off with how it is known; nothing new, nothing is asked of the LLM", async () => {
  const facts = { "flight-XQ512-2026-12-06": flightFact() };
  const { mod, cancelled, restore } = harness(facts);
  try {
    let judged = 0;
    const said = {
      "b-dinner": [{ n: 1, at: NOW - DAY, from: "Email from Tasca Verde", text: "Your reservation TV-88213 has been cancelled." }],
      "b-visit": [{ n: 1, at: NOW - DAY, from: "WhatsApp chat with Clinica Sorriso, they wrote", text: "See you on Thursday at 10" }],
      "flight-XQ512-2026-12-06": [{ n: 1, at: NOW - DAY, from: "Email from Example Air", text: "Booking QZP4LM: your flight XQ512 has been cancelled and refunded." }],
    };
    const deps = { now: NOW, bookings: [dinner, visit], evidence: async (u, p) => said[p.id] || [],
      judge: async (u, groups) => { judged++; return groups.flatMap((g) => g.plans.map((p) => {
        const said = (words) => g.evidence.find((e) => e.text.includes(words))?.n;
        return p.id === "b-dinner" ? { id: p.id, n: said("TV-88213"), quote: "Your reservation TV-88213 has been cancelled", why: "Tasca Verde emailed on Mon 30 Nov that the table is cancelled." }
          : { id: p.id, n: said("XQ512"), quote: "your flight XQ512 has been cancelled and refunded", why: "Example Air emailed on Mon 30 Nov that it's cancelled and refunded." };
      })); } };
    const r = await mod.review("u1", deps);
    assert.equal(judged, 2, "read twice");
    assert.equal(r.checked, 2, "the visit's messages say nothing is off, so they are not put to the LLM");
    assert.deepEqual(cancelled, [["b-dinner", { by: "closedhand", why: "Tasca Verde emailed on Mon 30 Nov that the table is cancelled.", quote: "Your reservation TV-88213 has been cancelled" }]]);
    const flight = JSON.parse(facts["flight-XQ512-2026-12-06"].value);
    assert.equal(flight.supersededBy, "removed", "a flight is no longer tracked");
    assert.equal(flight.cancelled.by, "closedhand");
    assert.deepEqual(flight.cancelled.reminders, ["r-1"], "its reminder went with it, kept so Put back brings it back");
    assert.match(flight.cancelled.why, /Example Air emailed/);
    // The same messages are not read again.
    await mod.review("u1", { ...deps, bookings: [visit] });
    assert.equal(judged, 2);
  } finally { restore(); }
});

test("words the LLM gives that are not in the message take nothing off, and a plan put back is not taken off again for what was already said", async () => {
  const facts = {};
  const { mod, cancelled, restore } = harness(facts);
  try {
    let judged = 0;
    const said = [{ n: 1, at: NOW - DAY, from: "Email from Tasca Verde", text: "Your reservation TV-88213 has been cancelled." }];
    const judge = async (u, groups) => { judged++; return [{ id: groups[0].plans[0].id, n: 1, quote: "we have cancelled your booking for good", why: "x" }]; };
    await mod.review("u1", { now: NOW, bookings: [dinner], evidence: async () => said, judge });
    assert.equal(judged, 2);
    assert.deepEqual(cancelled, [], "made-up words take nothing off");
    const kept = { ...dinner, id: "b-kept", details: { kept: new Date(NOW - DAY / 2).toISOString() } };
    await mod.review("u1", { now: NOW, bookings: [kept], evidence: async () => said, judge });
    assert.equal(judged, 2, "said before it was put back: not read again");
    await mod.review("u1", { now: NOW, bookings: [kept], evidence: async () => [{ ...said[0], at: NOW - DAY / 4 }], judge });
    assert.equal(judged, 4, "said after: read");
  } finally { restore(); }
});

test("every look at clashes looks for proof first, and a source that says cancelled says so under Cancelled plans", () => {
  assert.match(read("lib/itinerary-check.js"), /try \{ await \(deps\.plansOff \|\| require\("\.\/plans-off"\)\.review\)\(userId, \{ now \}\); \}/);
  // Read from the source: CI's checks run without the packages lib/bookings.js loads.
  const src = read("lib/bookings.js");
  const cancelledBy = new Function(src.slice(src.indexOf("function cancelledBy("), src.indexOf("// A booking taken off the person's plans")) + "; return cancelledBy;")();
  const b = { provider: "Tasca Verde", timezone: "Europe/Lisbon" };
  assert.equal(cancelledBy(b, { from: '"Tasca Verde" <tables@example.com>', date: "2026-11-30T10:00:00Z" }), "Tasca Verde emailed on Mon 30 Nov that it's cancelled.");
  assert.equal(cancelledBy({ timezone: "Europe/Lisbon" }, { from: '"Example Tours" <x@example.com>', date: "2026-11-30T10:00:00Z" }), "Example Tours emailed on Mon 30 Nov that it's cancelled.");
  assert.equal(cancelledBy(b, { chat: { app: "WhatsApp", name: "Clinica Sorriso" }, date: "2026-11-30T10:00:00Z" }), "Your WhatsApp chat with Clinica Sorriso on Mon 30 Nov says it's cancelled.");
  const bookings = read("lib/bookings.js");
  assert.match(bookings, /\.\.\.\(b\.status === "cancelled" \? \{ cancelled: \{ by: "source", at: new Date\(\)\.toISOString\(\), why: cancelledBy\(b, src\) \} \} : \{\}\)/);
  assert.match(bookings, /const OTHER_WORDS = "[^"]* cancel cancelled refund";/, "a chat that calls something off is read too");
});

// A clinic cancelled a procedure; its shampoo and follow-up, aftercare for
// it, stayed on Upcoming and were asked about.
test("what was part of a plan that is off comes off with it, on that plan's cancelling words, and only within its provider", async () => {
  const facts = {};
  const { mod, cancelled, restore } = harness(facts);
  try {
    const surgery = { ...visit, id: "b-proc", title: "Procedure at Clinica Sorriso", starts_at: "2026-12-02T10:00:00+00:00", status: "cancelled", details: { cancelled: { by: "closedhand", at: new Date(NOW - DAY).toISOString(), why: "Clinica Sorriso cancelled it." } } };
    const rinse = { ...visit, id: "b-rinse", title: "Rinse at Clinica Sorriso", source_email_id: "m-rinse", starts_at: "2026-12-03T10:00:00+00:00" };
    const check = { ...visit, id: "b-check", title: "Check-up at Clinica Sorriso", source_email_id: "m-check", starts_at: "2026-12-04T10:00:00+00:00" };
    const said = [{ id: "w9", n: 1, at: NOW - 2 * DAY, from: "WhatsApp chat with Clinica Sorriso, they wrote", text: "As we have not heard back, we will cancel your procedure on Wednesday 2 December." }];
    let seen = null;
    const judge = async (u, groups) => { seen = groups; return []; };
    const asked = [];
    const partOf = async (u, parent, after) => {
      asked.push([parent.title, after.map((p) => p.id)]);
      if (parent.title === "Procedure at Clinica Sorriso") return [{ id: "b-rinse", why: "It was aftercare for your procedure on Wed 2 Dec, which Clinica Sorriso cancelled." }, { id: "b-dinner", why: "Not this provider's." }];
      if (parent.title === "Rinse at Clinica Sorriso") return [{ id: "b-check", why: "Part of the same aftercare." }];
      return [];
    };
    const early = { ...visit, id: "b-early", title: "Consultation at Clinica Sorriso", source_email_id: "m-early", starts_at: "2026-12-02T08:00:00+00:00" };
    await mod.review("u1", { now: NOW, bookings: [surgery, rinse, check, dinner, early], evidence: async (u, p) => p.group === "name:clinica" ? said : [], judge, partOf });
    assert.equal(seen.length, 1, "the clinic's plans together, with what it already had taken off");
    assert.deepEqual(seen[0].plans.map((p) => p.id), ["b-early", "b-rinse", "b-check"]);
    assert.deepEqual(seen[0].gone.map((x) => x.title), ["Procedure at Clinica Sorriso"]);
    assert.deepEqual(asked, [["Procedure at Clinica Sorriso", ["b-rinse", "b-check"]], ["Procedure at Clinica Sorriso", ["b-rinse", "b-check"]], ["Rinse at Clinica Sorriso", ["b-check"]], ["Rinse at Clinica Sorriso", ["b-check"]]], "asked twice, only about the provider's plans after it, then about what hung on those");
    assert.deepEqual(cancelled.map(([id]) => id), ["b-rinse", "b-check"], "aftercare goes with it, and what was part of that too, never one before it");
    assert.match(cancelled[0][1].why, /aftercare for your procedure/);
    assert.equal(cancelled[0][1].part_of, "Procedure at Clinica Sorriso");
    assert.ok(!cancelled.some(([id]) => id === "b-dinner"), "another provider's plan is not part of it");
  } finally { restore(); }
});

test("a refund the person asked for, or what they told Closedhand, counts; a new rule looks at every plan again", async () => {
  const { check, toldClosedhand, readRecord, RECORD_KEY } = require("../lib/plans-off");
  const refund = { tz: "Europe/Lisbon", evidence: [{ n: 1, at: NOW, from: "Email from Example Trips", text: "Booking QZP4LM: we have received your refund request for flight XQ512." }] };
  assert.ok(check({ n: 1, quote: "we have received your refund request for flight XQ512", why: "You asked Example Trips for a refund on Mon 30 Nov." }, refund));
  const convo = [
    { role: "user", content: "I've cancelled the Tasca dinner, we're eating at home", ts: new Date(NOW - DAY).toISOString() },
    { role: "assistant", content: "Tasca Verde noted.", ts: new Date(NOW - DAY).toISOString() },
    { role: "user", content: "Tasca was great last year", ts: new Date(NOW - 90 * DAY).toISOString() },
  ];
  assert.deepEqual(toldClosedhand(convo, ["Tasca"], NOW).map((e) => [e.from, e.text]), [["You wrote to Closedhand", "I've cancelled the Tasca dinner, we're eating at home"]], "their own words, recent, naming it");
  assert.deepEqual(readRecord({ [RECORD_KEY]: JSON.stringify({ checked: { "b-dinner": "2026-11-30T00:00:00Z" } }) }).checked, {}, "a record from before the rule changed is set aside");
  assert.match(read("lib/plans-off.js"), /const RECORD_VERSION = 2;/);
});

test("the bookings reader reads the last days of chats first, and a different plan never goes into one taken off", () => {
  const src = read("lib/bookings.js");
  assert.match(src, /const recent = await recentChatHits\(userId\)\.catch\(\(\) => \[\]\);\n\s*const hits = recent\.concat\(/, "recent days before the ranked search");
  const talk = new RegExp(src.match(/const BOOKING_TALK = new RegExp\(`(.*)`, "i"\);/)[1].replace("${OTHER_WORDS.split(\" \").join(\"|\")}", "booked").replace(/\\\\/g, "\\"), "i");
  assert.ok(talk.test("After your in-person consultation tomorrow at 10 a.m. we will confirm"));
  assert.ok(talk.test("Ok see you there at 10am"));
  assert.ok(!talk.test("Lovely weather today"));
  const { sameBooking } = require("../lib/booking-identity");
  const off = { kind: "appointment", provider: "Clinica Sorriso", title: "Procedure at Clinica Sorriso", starts_at: "2026-12-02T10:00:00+00:00", status: "cancelled", details: { cancelled: { by: "closedhand" } } };
  const consult = { kind: "appointment", provider: "Clinica Sorriso", title: "Consultation at Clinica Sorriso", starts_at: "2026-12-02T09:00:00+00:00", status: "confirmed", details: {} };
  assert.equal(sameBooking(off, consult), false, "a consultation booked the morning a procedure was cancelled is its own plan");
  assert.equal(sameBooking(off, { ...consult, title: "Procedure at Clinica Sorriso" }), true, "the same thing again is the same booking");
  assert.equal(sameBooking({ ...off, details: { cancelled: { by: "source" } } }, consult), true, "unchanged where the provider cancelled it");
  assert.equal(sameBooking({ ...off, status: "confirmed", details: {} }, { ...consult, status: "cancelled" }), true, "and a cancellation still finds its booking");
});

// A reminder for the 09:00 appointment kept firing after the appointment was
// called off: the reminder is about that plan alone.
test("a reminder set for a plan's own time goes when the plan comes off, and Put back brings it back", async () => {
  const src = read("lib/bookings.js");
  const rows = [{ id: "r-1", user_id: "u1", enabled: true, event_at: "2026-12-03T10:00:00.000Z" }, { id: "r-2", user_id: "u1", enabled: true, event_at: "2026-12-03T11:00:00.000Z" }];
  const q = (filters = []) => ({ select: () => q(filters), eq: (k, v) => q([...filters, [k, v]]), in: (k, v) => q([...filters, [k, v, "in"]]),
    update: (patch) => ({ eq: (k, v) => ({ in: async (k2, ids) => { rows.filter((r) => r[k] === v && ids.includes(r.id)).forEach((r) => Object.assign(r, patch)); return {}; } }) }),
    then: (res) => res({ data: rows.filter((r) => filters.every(([k, v]) => r[k] === v)).map((r) => ({ id: r.id })) }) });
  const endRemindersFor = new Function("supabase", src.slice(src.indexOf("async function endRemindersFor("), src.indexOf("// Old bookings drop off after a month")) + "; return endRemindersFor;")({ from: () => q() });
  assert.deepEqual(await endRemindersFor("u1", "2026-12-03T10:00:00+00:00"), ["r-1"]);
  assert.deepEqual(rows.map((r) => r.enabled), [false, true], "only the one set for that plan's time");
  assert.match(src, /const reminders = await endRemindersFor\(userId, row\.starts_at\);/, "a booking taken off takes its reminder");
  const server = read("webapp/server.js");
  assert.match(server, /const reminders = await planReminders\(userId, row\.starts_at, false\);/, "so does the x");
  assert.match(server, /else \{ await planReminders\(userId, null, true, details\.cancelled\?\.reminders\); delete details\.cancelled; details\.kept = at; \}/, "and Put back brings it back");
  assert.match(read("lib/itinerary-check.js"), /const reminders = await require\("\.\/bookings"\)\.endRemindersFor\(userId, f\.departure\?\.dateTime\);/, "a flight's too");
});

test("what is put to the LLM is read twice, and either reading counts once it holds", async () => {
  const facts = {};
  const { mod, cancelled, restore } = harness(facts);
  try {
    let calls = 0;
    const said = [{ id: "m1", n: 1, at: NOW - DAY, from: "Email from Tasca Verde", text: "Your reservation TV-88213 has been cancelled." }];
    const judge = async (u, groups) => { calls++; const n = groups[0].evidence[0].n; return calls === 1 ? [] : [{ id: groups[0].plans[0].id, n, quote: "Your reservation TV-88213 has been cancelled", why: "Tasca Verde emailed that it's cancelled." }]; };
    await mod.review("u1", { now: NOW, bookings: [dinner], evidence: async () => said, judge });
    assert.equal(calls, 2);
    assert.deepEqual(cancelled.map(([id]) => id), ["b-dinner"], "the reading that found it counts");
  } finally { restore(); }
});

// The chat took a shampoo off the calendar, said it was gone, and Upcoming
// kept the booking for it: one plan kept twice, changed in one place.
test("a booking follows its calendar event off the calendar: within an hour of it and sharing a word of what it is", async () => {
  const src = read("lib/bookings.js");
  const later = new Date(Date.now() + 5 * DAY);
  const iso = (ms) => new Date(ms).toISOString();
  const rows = [
    { id: "b-wash", title: "Rinse at Clinica Sorriso", provider: "Clinica Sorriso", starts_at: iso(later.getTime() + 30 * 60000), status: "confirmed" },
    { id: "b-lunch", title: "Lunch at Tasca Verde", provider: "Tasca Verde", starts_at: iso(later.getTime() + 20 * 60000), status: "confirmed" },
  ];
  const q = (f = []) => ({ select: () => q(f), eq: () => q(f), neq: () => q(f), gte: (k, v) => q([...f, (r) => r[k] >= v]), lte: (k, v) => q([...f, (r) => r[k] <= v]), then: (res) => res({ data: rows.filter((r) => f.every((t) => t(r))) }) });
  const cancelled = [];
  const gone = new Function("supabase", "cancelBooking", src.slice(src.indexOf("const COMMON = new Set("), src.indexOf("// Old bookings drop off after a month")) + "; return calendarEventsGone;")({ from: () => q() }, async (u, id, how) => { cancelled.push([id, how]); return true; });
  assert.deepEqual(await gone("u1", [{ summary: "Rinse - Clinica Sorriso", at: later.toISOString() }]), ["b-wash"], "the same plan, not lunch at the same hour");
  assert.equal(cancelled[0][1].by, "calendar");
  assert.match(cancelled[0][1].why, /^Taken off your calendar on \w{3} \d{1,2} \w{3}\.$/);
  assert.deepEqual(await gone("u1", [{ summary: "Rinse - Clinica Sorriso", at: new Date(Date.now() - DAY).toISOString() }]), [], "nothing over");
  assert.deepEqual(await gone("u1", [{ summary: "Appointment", at: later.toISOString() }]), [], "a word every plan shares is not enough");
  assert.match(read("lib/services/data-sync.js"), /try \{ await require\("\.\.\/bookings"\)\.calendarEventsGone\(userId, goneRows\.map\(r => \(\{ summary: r\.data\?\.summary \|\| r\.data\?\.title \|\| "", at: r\.received_at \}\)\)\); \}/, "wherever an event is found deleted, on any calendar connection");
});
