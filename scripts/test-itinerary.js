// Plans that cannot all be true: found by rule (lib/itinerary.js), judged by
// the person's LLM, put to them once in chat, shown on each card involved
// until they say what stands (lib/itinerary-check.js). Someone booked a flight
// home in the middle of a trip, and Upcoming listed the rest of the trip after
// it as if nothing were wrong. Invented trips, places and flights only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const itinerary = require("../lib/itinerary");

const flight = (number, from, fromTz, dep, to, toTz, arr, extra = {}) => ({
  value: JSON.stringify({ flightNumber: number, departure: { airport: from, tz: fromTz, dateTime: dep }, arrival: { airport: to, tz: toTz, dateTime: arr }, ...extra }),
});
const LIS = "Europe/Lisbon", YYZ = "America/Toronto", MAD = "Europe/Madrid", FRA = "Europe/Berlin";
const NOW = Date.parse("2026-12-01T09:00:00Z");
// A trip to Lisbon: out on the 10th, a stay, a dental visit on the 13th, home on the 14th.
const trip = {
  "flight-XQ300-2026-12-10": flight("XQ300", "YYZ", YYZ, "2026-12-09T22:00:00-05:00", "LIS", LIS, "2026-12-10T10:05:00+00:00"),
  "flight-XQ301-2026-12-14": flight("XQ301", "LIS", LIS, "2026-12-14T12:30:00+00:00", "YYZ", YYZ, "2026-12-14T15:40:00-05:00"),
};
const stay = { id: "b-stay", kind: "hotel", title: "Casa do Rio, 4 nights", starts_at: "2026-12-10T15:00:00+00:00", ends_at: "2026-12-14T11:00:00+00:00", timezone: LIS, status: "confirmed" };
const dentist = { id: "b-dent", kind: "appointment", title: "Check-up at Clinica Alfama", starts_at: "2026-12-13T10:30:00+00:00", timezone: LIS, status: "confirmed" };
const dinner = { id: "b-dinner", kind: "restaurant", title: "Dinner at Tasca Verde", starts_at: "2026-12-16T20:00:00-05:00", timezone: YYZ, status: "confirmed" };
// The new one: home early, on the 11th.
const early = flight("XQ309", "LIS", LIS, "2026-12-11T13:00:00+00:00", "YYZ", YYZ, "2026-12-11T16:10:00-05:00");

test("a flight home in the middle of a trip clashes with what is still booked there, and the later flight back", () => {
  const facts = { ...trip, "flight-XQ309-2026-12-11": early };
  const found = itinerary.clashes({ flights: itinerary.flightsFrom(facts), bookings: [stay, dentist, dinner], now: NOW });
  assert.equal(found.length, 1);
  const c = found[0];
  assert.equal(c.id, "f:flight-XQ309-2026-12-11");
  assert.deepEqual({ number: c.flight.number, from: c.flight.from, to: c.flight.to }, { number: "XQ309", from: "LIS", to: "YYZ" });
  assert.deepEqual(c.items.map((it) => it.title), ["Casa do Rio, 4 nights", "Check-up at Clinica Alfama", "XQ301"], "the stay, the visit, and the flight back from where they no longer are");
  assert.deepEqual(c.items.map((it) => it.what), ["booking", "booking", "flight"]);
});

test("an ordinary trip, a return flight, a same-day connection and a stay ending the day you fly clash with nothing", () => {
  assert.deepEqual(itinerary.clashes({ flights: itinerary.flightsFrom(trip), bookings: [stay, dentist, dinner], now: NOW }), [], "out, stay, home, dinner at home");
  const connection = {
    "flight-XQ500": flight("XQ500", "LIS", LIS, "2026-12-20T07:00:00+00:00", "FRA", FRA, "2026-12-20T11:00:00+01:00"),
    "flight-XQ501": flight("XQ501", "FRA", FRA, "2026-12-20T13:00:00+01:00", "YYZ", YYZ, "2026-12-20T16:00:00-05:00"),
  };
  const lisbonUntilMorning = { id: "b-early", kind: "hotel", title: "Hotel Ribeira", starts_at: "2026-12-18T15:00:00+00:00", ends_at: "2026-12-20T05:00:00+00:00", timezone: LIS, status: "confirmed" };
  const torontoAfter = { id: "b-yyz", kind: "event", title: "Concert at Massey Hall", starts_at: "2026-12-21T19:30:00-05:00", timezone: YYZ, status: "confirmed" };
  assert.deepEqual(itinerary.clashes({ flights: itinerary.flightsFrom(connection), bookings: [lisbonUntilMorning, torontoAfter], now: NOW }), []);
  // A train between near places is normal: Madrid and Lisbon are an hour apart.
  const madrid = { "flight-XQ700": flight("XQ700", "LIS", LIS, "2026-12-10T09:00:00+00:00", "MAD", MAD, "2026-12-10T11:20:00+01:00") };
  assert.deepEqual(itinerary.clashes({ flights: itinerary.flightsFrom(madrid), bookings: [{ ...dentist, starts_at: "2026-12-11T10:30:00+00:00" }], now: NOW }), []);
});

test("what places nobody counts for nothing: cancelled bookings, flights not confirmed or set aside, places with no zone, what is past", () => {
  const facts = { ...trip, "flight-XQ309-2026-12-11": early };
  const cancelled = [{ ...stay, status: "cancelled" }, { ...dentist, status: "cancelled" }];
  assert.deepEqual(itinerary.clashes({ flights: itinerary.flightsFrom(trip), bookings: cancelled, now: NOW }), []);
  for (const extra of [{ pending: true }, { supersededBy: "removed" }, { lastStatus: "Cancelled" }]) {
    const f = flight("XQ309", "LIS", LIS, "2026-12-11T13:00:00+00:00", "YYZ", YYZ, "2026-12-11T16:10:00-05:00", extra);
    assert.deepEqual(itinerary.clashes({ flights: itinerary.flightsFrom({ ...trip, "flight-XQ309": f }), bookings: [stay, dentist], now: NOW }), [], JSON.stringify(extra));
  }
  assert.equal(itinerary.clashes({ flights: itinerary.flightsFrom(facts), bookings: [{ ...dentist, timezone: null }], now: NOW })[0].items.some((it) => it.id === "b-dent"), false, "no zone, no place");
  assert.deepEqual(itinerary.clashes({ flights: itinerary.flightsFrom(facts), bookings: [stay, dentist], now: Date.parse("2027-01-10T00:00:00Z") }), [], "all past");
});

test("two stays far apart on the same nights clash", () => {
  const toronto = { id: "b-yyz-stay", kind: "hotel", title: "Harbourfront Suites", starts_at: "2026-12-11T15:00:00-05:00", ends_at: "2026-12-13T11:00:00-05:00", timezone: YYZ, status: "confirmed" };
  const found = itinerary.clashes({ flights: [], bookings: [stay, toronto], now: NOW });
  assert.deepEqual(found.map((c) => [c.kind, c.items.map((it) => it.id)]), [["stays", ["b-stay", "b-yyz-stay"]]]);
  assert.deepEqual(itinerary.lines(found, {}), {}, "nothing before it is judged");
  const lines = itinerary.lines(found, { clashes: { [found[0].id]: { items: { "b-stay": { state: "asked" }, "b-yyz-stay": { state: "asked" } } } } });
  assert.equal(lines["b-stay"], "Clashes with Harbourfront Suites: both are booked for the same nights.");
  assert.equal(lines["b-yyz-stay"], "Clashes with Casa do Rio, 4 nights: both are booked for the same nights.");
});

test("each card involved says what it clashes with, in the places Closedhand's look named, until it is settled or found nothing to ask", () => {
  const found = itinerary.clashes({ flights: itinerary.flightsFrom({ ...trip, "flight-XQ309-2026-12-11": early }), bookings: [stay, dentist], now: NOW });
  assert.deepEqual(itinerary.lines(found, {}), {}, "nothing shows before their LLM has judged it: far apart alone is not a clash");
  const judgedReal = { clashes: { "f:flight-XQ309-2026-12-11": { items: Object.fromEntries(found[0].items.map((it) => [it.id, { state: "real" }])) } } };
  assert.deepEqual(itinerary.lines(found, judgedReal), {
    "b-stay": "XQ309 flies you to YYZ before this.",
    "b-dent": "XQ309 flies you to YYZ before this.",
    "flight-XQ301-2026-12-14": "XQ309 flies you to YYZ before this.",
    "flight-XQ309-2026-12-11": "Clashes with what's booked after it.",
  }, "judged real, before the places are named");
  const named = { clashes: { "f:flight-XQ309-2026-12-11": { place: "Toronto", from: "Lisbon", items: { "b-stay": { state: "asked" }, "b-dent": { state: "asked" }, "flight-XQ301-2026-12-14": { state: "asked" } } } } };
  assert.equal(itinerary.lines(found, named)["b-dent"], "You'd be in Toronto by then, on XQ309.");
  assert.equal(itinerary.lines(found, named)["flight-XQ309-2026-12-11"], "Clashes with your plans in Lisbon after it.");
  for (const state of ["settled", "quiet", "open", "gone"]) {
    const done = { clashes: { "f:flight-XQ309-2026-12-11": { items: Object.fromEntries(found[0].items.map((it) => [it.id, { state }])) } } };
    assert.deepEqual(itinerary.lines(found, done), {}, state);
  }
  // Server and cards: the line rides with each booking and flight Upcoming loads.
  const server = read("webapp/server.js"), dash = read("webapp/views/dashboard.html");
  assert.match(server, /\.\.\.b, over: bookingOver\(b, now\), clash: clash\.lines\[b\.id\] \|\| null, clash_asks: clash\.asks\[b\.id\] \|\| null,/);
  assert.match(server, /f\.clash = clash\.lines\[f\._key\] \|\| null;\n\s*f\.clash_asks = clash\.asks\[f\._key\] \|\| null;/);
  assert.match(server, /return \{ lines: itinerary\.lines\(found, record\), asks: itinerary\.asks\(found, record\) \};/);
  assert.match(server, /supabase\.from\("facts"\)\.select\("value"\)\.eq\("user_id", userId\)\.eq\("key", "_itinerary-clashes"\)/);
  assert.match(dash, /clash: clashHtml\(b\.clash, b\.clash_asks\), docs: sourceDocsHtml\(b\.source_mail\)/);
  assert.match(dash, /clash: clashHtml\(f\.clash, f\.clash_asks\), docs: sourceDocsHtml\(f\.source_mail\)/);
  assert.match(dash, /\.up-clash \{[^}]*color: var\(--fg-quiet\); \}/, "in the neutral: yellow is the account's, red is for what went wrong");
  // When Closedhand asked, and where, under the line, from the record.
  const asked = { clashes: { "f:flight-XQ309-2026-12-11": { place: "Toronto", from: "Lisbon", asks: [{ at: "2026-12-01T09:00:00Z", in: ["WhatsApp"] }, { at: "2026-12-02T10:00:00Z", in: ["WhatsApp"] }], items: { "b-stay": { state: "asked" }, "b-dent": { state: "quiet" } } } } };
  const asks = itinerary.asks(found, asked);
  assert.deepEqual(Object.keys(asks).sort(), ["b-stay", "flight-XQ309-2026-12-11"], "only for the lines shown");
  assert.equal(asks["b-stay"].length, 2);
  const old = { clashes: { "f:flight-XQ309-2026-12-11": { asked: "2026-12-01T09:00:00Z", items: { "b-stay": { state: "asked" } } } } };
  assert.deepEqual(itinerary.asks(found, old)["b-stay"], [{ at: "2026-12-01T09:00:00Z", in: [] }], "a question asked before asks were kept still says when");
  const fns = new Function("shortDay", dash.slice(dash.indexOf("    function askedLine("), dash.indexOf("    // A booking found in a chat says which chat")) + "; return { askedLine, whenAsked };")((iso) => new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", ""));
  assert.equal(fns.askedLine([{ at: "2026-11-07T09:00:00Z", in: ["WhatsApp"] }]), "Closedhand asked you in WhatsApp on Sat 7 Nov.");
  const now = new Date(), morning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0).toISOString();
  assert.equal(fns.askedLine([{ at: "2026-11-07T09:00:00Z", in: ["WhatsApp"] }, { at: morning, in: ["WhatsApp"] }]), "Closedhand asked you in WhatsApp on Sat 7 Nov, and again this morning.");
});

// lib/itinerary-check.js with the store and its neighbours stood in.
function check(facts) {
  const ctx = require("../lib/context");
  ctx.store = { facts };
  const bPath = require.resolve("../lib/bookings"), oPath = require.resolve("../lib/plans-off"), sPath = require.resolve("../lib/storage");
  const removed = [];
  require.cache[bPath] = { id: bPath, filename: bPath, loaded: true, exports: { cancelBooking: async (userId, id, said) => { removed.push([id, said]); return true; }, listUpcoming: async () => [] } };
  require.cache[oPath] = { id: oPath, filename: oPath, loaded: true, exports: { review: async () => ({ checked: 0, off: [] }) } };
  require.cache[sPath] = { id: sPath, filename: sPath, loaded: true, exports: { saveStore() {} } };
  const cPath = require.resolve("../lib/itinerary-check");
  delete require.cache[cPath];
  return { mod: require("../lib/itinerary-check"), removed, restore() { for (const p of [bPath, oPath, sPath, cPath]) delete require.cache[p]; ctx.store = null; } };
}

test("a clash is judged by the person's LLM and put to them once; a new item clashing with the same flight is asked about on its own", async () => {
  const facts = { ...trip, "flight-XQ309-2026-12-11": early };
  const { mod, restore } = check(facts);
  try {
    const judged = [], told = [];
    const judge = async (userId, clash, picture, only) => { judged.push([...only]); assert.match(picture, /Flight XQ309: LIS .* -> YYZ/); return { clashing: [...only], ask: true, message: "Your new XQ309 takes you home on 11 Dec, but you're still booked in Lisbon after it. Are you cutting the trip short?", place: "Toronto", from: "Lisbon" }; };
    const tell = async (userId, store, text) => { told.push(text); return ["WhatsApp"]; };
    const r1 = await mod.review("u1", { bookings: [stay], judge, tell, now: NOW });
    assert.deepEqual(r1, { found: 1, asked: 1 });
    assert.deepEqual(judged, [["b-stay", "flight-XQ301-2026-12-14"]]);
    const r2 = await mod.review("u1", { bookings: [stay], judge, tell, now: NOW });
    assert.deepEqual(r2, { found: 1, asked: 0 }, "never asked twice");
    assert.equal(judged.length, 1);
    await mod.review("u1", { bookings: [stay, dentist], judge, tell, now: NOW });
    assert.deepEqual(judged.at(-1), ["b-dent"], "a new booking in the way is its own question");
    assert.equal(told.length, 2);
    const record = mod.readRecord(facts).clashes["f:flight-XQ309-2026-12-11"];
    assert.deepEqual({ place: record.place, from: record.from, number: record.number }, { place: "Toronto", from: "Lisbon", number: "XQ309" });
    assert.deepEqual(Object.values(record.items).map((it) => it.state), ["asked", "asked", "asked"]);
    // Closedhand's own picture: the chat's time block says it, with the ids that settle it.
    const block = require("../lib/time-context").clashContext(facts);
    assert.match(block, /PLANS THAT CLASH/);
    assert.match(block, /\[f:flight-XQ309-2026-12-11\] XQ309 takes them to Toronto, but still booked in Lisbon after it: Casa do Rio, 4 nights \(id b-stay\), flight XQ301 \(id flight-XQ301-2026-12-14\), Check-up at Clinica Alfama \(id b-dent\)\./);
    assert.match(block, /Asked them already; do not ask again unprompted\./);
    assert.match(block, /settle it with plans_settle/);
  } finally { restore(); }
});

test("a clash its look found nothing to ask about stays quiet, and one it could not judge is judged again later", async () => {
  const facts = { ...trip, "flight-XQ309-2026-12-11": early };
  const { mod, restore } = check(facts);
  try {
    let verdict = null, told = 0;
    const deps = { bookings: [stay], judge: async () => verdict, tell: async () => { told++; return ["WhatsApp"]; }, now: NOW };
    await mod.review("u1", deps);
    const items = () => Object.values(mod.readRecord(facts).clashes["f:flight-XQ309-2026-12-11"].items).map((it) => it.state);
    assert.deepEqual(items(), ["open", "open"], "not judged: still open");
    const found = itinerary.clashes({ flights: itinerary.flightsFrom(facts), bookings: [stay], now: NOW });
    assert.deepEqual(itinerary.lines(found, mod.readRecord(facts)), {}, "and nothing shows on the cards meanwhile");
    verdict = { clashing: [], ask: false, message: "", place: "", from: "" };
    await mod.review("u1", deps);
    assert.deepEqual(items(), ["quiet", "quiet"]);
    assert.equal(told, 0);
    assert.equal(require("../lib/time-context").clashContext(facts), "", "nothing open, nothing said");
  } finally { restore(); }
});

test("the person's answer settles it: what no longer stands comes off their plans, and nothing more is asked or shown", async () => {
  const facts = { ...trip, "flight-XQ309-2026-12-11": early };
  const { mod, removed, restore } = check(facts);
  try {
    await mod.review("u1", { bookings: [stay, dentist], judge: async (u, c, p, only) => ({ clashing: [...only], ask: true, message: "Cutting it short?", place: "Toronto", from: "Lisbon" }), tell: async () => ["WhatsApp"], now: NOW });
    assert.deepEqual((await mod.settle("u1", { clash: "f:nope" })).error, "No clash with that id. The time block lists the open ones.");
    const r = await mod.settle("u1", { clash: "f:flight-XQ309-2026-12-11", drop: ["b-stay", "b-dent", "flight-XQ301-2026-12-14"] });
    assert.deepEqual(r, { success: true, dropped: ["Casa do Rio, 4 nights", "Check-up at Clinica Alfama", "XQ301"], kept: [] });
    assert.deepEqual(removed, [["b-stay", { by: "you" }], ["b-dent", { by: "you" }]], "bookings go to Cancelled plans as the dashboard's x sends them, saying the person said so");
    const xq301 = JSON.parse(facts["flight-XQ301-2026-12-14"].value);
    assert.equal(xq301.supersededBy, "removed", "and a flight is no longer tracked");
    assert.equal(xq301.cancelled.by, "you", "and is listed under Cancelled plans, saying so");
    assert.equal(itinerary.flightsFrom(facts).some((f) => f.number === "XQ301"), false);
    assert.deepEqual(mod.openClashes(facts), []);
    assert.equal(require("../lib/time-context").clashContext(facts), "");
    const found = itinerary.clashes({ flights: itinerary.flightsFrom(facts), bookings: [], now: NOW });
    assert.deepEqual(found, [], "and the plans agree now");
  } finally { restore(); }
});

test("the chat can settle a clash, and every scan that brings in a booking or a flight looks for one", () => {
  const defs = read("lib/tools/definitions.js"), handlers = read("lib/tools/handlers.js");
  assert.match(defs, /name: "plans_settle",\n\s*groups: \["travel"\],/);
  assert.match(handlers, /case "plans_settle": \{\n\s*return await require\("\.\.\/itinerary-check"\)\.settle\(toolInput\._userId \|\| ctx\.activeUserId, toolInput\);/);
  assert.match(read("lib/bookings.js"), /try \{ await require\("\.\/itinerary-check"\)\.review\(userId\); \}/);
  const flights = read("lib/flights.js");
  assert.match(flights, /if \(result\.patches\.length\) \{ saveStore\(\); await reviewPlans\(userId\); \}/);
  assert.match(flights, /if \(newFlights\.length > 0\) \{ saveStore\(\); await reviewPlans\(userId\); \}/);
  assert.match(read("lib/engine.js"), /flightDateContext\(ctx\.store\?\.facts, now\) \+ clashContext\(ctx\.store\?\.facts\)/);
  // The webapp works the lines out with the same rules.
  assert.equal(read("webapp/itinerary.js"), read("lib/itinerary.js"));
});

// Far apart alone is not a clash: the person's LLM says, from what each thing
// is, which really cannot happen, and only those are shown or asked about.
test("only what the person's LLM judges a real clash is shown or asked about", async () => {
  const facts = { ...trip, "flight-XQ309-2026-12-11": early };
  const { mod, restore } = check(facts);
  try {
    const told = [];
    // The stay needs them there; the check-up, say, turned out to be a video call.
    const judge = async () => ({ clashing: ["b-stay"], ask: true, message: "Your new XQ309 leaves Lisbon on 11 Dec, but Casa do Rio is booked to the 15th. Are you cutting the trip short?", place: "Toronto", from: "Lisbon" });
    await mod.review("u1", { bookings: [stay, dentist], judge, tell: async (u, s, t) => { told.push(t); return ["WhatsApp"]; }, now: NOW });
    const record = mod.readRecord(facts);
    const states = Object.fromEntries(Object.entries(record.clashes["f:flight-XQ309-2026-12-11"].items).map(([id, it]) => [id, it.state]));
    assert.equal(states["b-stay"], "asked");
    assert.equal(states["b-dent"], "quiet", "the call needs nobody there");
    assert.ok(Object.entries(states).every(([id, st]) => id === "b-stay" || st === "quiet"), "everything else the check noticed stays quiet");
    const found = itinerary.clashes({ flights: itinerary.flightsFrom(facts), bookings: [stay, dentist], now: NOW });
    const shown = itinerary.lines(found, record);
    assert.deepEqual(Object.keys(shown).sort(), ["b-stay", "flight-XQ309-2026-12-11"]);
    assert.equal(told.length, 1);
    // Judged real but with nowhere to send the question: shown, and asked about after the next scan.
    const facts2 = { ...trip, "flight-XQ309-2026-12-11": early };
    const second = check(facts2);
    try {
      await second.mod.review("u1", { bookings: [stay], judge: async () => ({ clashing: ["b-stay"], ask: true, message: "Cutting it short?", place: "Toronto", from: "Lisbon" }), tell: async () => [], now: NOW });
      assert.equal(second.mod.readRecord(facts2).clashes["f:flight-XQ309-2026-12-11"].items["b-stay"].state, "real");
      assert.equal(second.mod.openClashes(facts2).length, 1, "and in Closedhand's picture");
    } finally { second.restore(); }
  } finally { restore(); }
});

// A flight found before this check existed was never judged: review ran only
// after a scan that found a booking. Every scheduled bookings pass reviews.
test("every scheduled bookings pass judges clashes, not only one that found a booking", () => {
  const src = read("lib/bookings.js");
  const pass = src.slice(src.indexOf("const pass = async () => {"), src.indexOf("setTimeout(pass, FIRST_SCAN_DELAY_MS)"));
  assert.match(pass, /await scanBookings\(u\.userId\);\n[\s\S]*?try \{ await require\("\.\/itinerary-check"\)\.review\(u\.userId\); \}/);
});

// A trip of its own: settling a clash in an earlier test marked the shared
// flights as no longer tracked.
const ownTrip = () => ({
  "flight-XQ300-2026-12-10": flight("XQ300", "YYZ", YYZ, "2026-12-09T22:00:00-05:00", "LIS", LIS, "2026-12-10T10:05:00+00:00"),
  "flight-XQ301-2026-12-14": flight("XQ301", "LIS", LIS, "2026-12-14T12:30:00+00:00", "YYZ", YYZ, "2026-12-14T15:40:00-05:00"),
  "flight-XQ309-2026-12-11": flight("XQ309", "LIS", LIS, "2026-12-11T13:00:00+00:00", "YYZ", YYZ, "2026-12-11T16:10:00-05:00"),
});

// Asked once and left, a question read as if Closedhand had forgotten it: the
// plans stayed on Upcoming with nothing more said. Unanswered, it is asked
// again a day later, then in the day and a half before each plan it is about.
test("a question with no answer is asked again a day later, then before each plan it is about, never within half a day", async () => {
  const facts = ownTrip();
  const { mod, restore } = check(facts);
  try {
    const told = [], nudged = [];
    const H = 3600000;
    const deps = (now) => ({ bookings: [stay], now, judge: async (u, c, p, only) => ({ clashing: [...only], ask: true, message: "Cutting it short?", place: "Toronto", from: "Lisbon" }),
      nudge: async (u, rec, open) => { nudged.push(open.map((it) => it.id)); return "Still booked in Lisbon from Thu 10 Dec. Is that off?"; },
      tell: async (u, s, t) => { told.push(t); return ["WhatsApp"]; } });
    await mod.review("u1", deps(NOW));
    assert.equal(told.length, 1);
    await mod.review("u1", deps(NOW + 6 * H));
    assert.equal(told.length, 1, "not again the same day");
    await mod.review("u1", deps(NOW + 25 * H));
    assert.equal(told.length, 2, "again once a day has passed");
    assert.deepEqual(nudged[0], ["b-stay", "flight-XQ301-2026-12-14"], "about what is still open");
    await mod.review("u1", deps(NOW + 4 * 24 * H));
    assert.equal(told.length, 2, "then quiet until the plan nears");
    const stayAt = Date.parse(stay.starts_at);
    await mod.review("u1", deps(stayAt - 30 * H));
    assert.equal(told.length, 3, "again in the day and a half before the stay");
    await mod.review("u1", deps(stayAt - 12 * H));
    assert.equal(told.length, 3, "once for that plan");
    const flightAt = Date.parse("2026-12-14T12:30:00+00:00");
    await mod.review("u1", deps(flightAt - 20 * H));
    assert.equal(told.length, 4, "and again before the next one");
    assert.deepEqual(nudged.at(-1), ["flight-XQ301-2026-12-14"], "only what is still to come");
    const rec = mod.readRecord(facts).clashes["f:flight-XQ309-2026-12-11"];
    assert.equal(rec.asks.length, 4);
    assert.deepEqual(rec.asks[0].in, ["WhatsApp"], "each time says where it went");
    // Once they answer, nothing more.
    await mod.settle("u1", { clash: "f:flight-XQ309-2026-12-11", drop: [] });
    await mod.review("u1", deps(flightAt - 2 * H));
    assert.equal(told.length, 4);
  } finally { restore(); }
});

test("proof comes first: a plan found to be off leaves the question, and nothing is asked about it again", async () => {
  const facts = ownTrip();
  const { mod, restore } = check(facts);
  try {
    const told = [], order = [];
    const booked = { ...stay };
    const base = { bookings: [booked], judge: async (u, c, p, only) => { order.push("judge"); return { clashing: [...only], ask: true, message: "Cutting it short?", place: "Toronto", from: "Lisbon" }; },
      nudge: async () => "Still on?", tell: async (u, s, t) => { told.push(t); return ["WhatsApp"]; } };
    await mod.review("u1", { ...base, now: NOW, plansOff: async () => { order.push("proof"); } });
    assert.deepEqual(order, ["proof", "judge"], "proof is looked for before anything is judged or asked");
    // The stay's own email says it is cancelled: lib/plans-off.js takes it off.
    await mod.review("u1", { ...base, now: NOW + 25 * 3600000, plansOff: async () => { booked.status = "cancelled"; } });
    const rec = mod.readRecord(facts).clashes["f:flight-XQ309-2026-12-11"];
    assert.equal(rec.items["b-stay"].state, "gone", "off the question");
    assert.equal(rec.items["flight-XQ301-2026-12-14"].state, "asked", "the rest still open");
    assert.deepEqual(mod.openClashes(facts)[0].items.map((it) => it.id), ["flight-XQ301-2026-12-14"]);
    assert.equal(told.length, 2, "asked again only about the flight");
  } finally { restore(); }
});
