// An all-day event (a birthday, a day off) is a date alone, on every calendar
// Closedhand writes to, and the confirmation says so in words: a birthday
// moved by its date showed "Time: 00:00 to 00:00 (timezone not specified)",
// and a new yearly one sent as an API request showed only "POST" and an
// address. A change names the event as its calendar has it and shows what
// changes from what to what: the name on the card was the model's.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

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
const resolve = Module._resolveFilename;
const load = Module._load;
Module._resolveFilename = function (request, parent, ...rest) {
  try { return resolve.call(this, request, parent, ...rest); }
  catch (e) { if (!request.startsWith(".") && !request.startsWith("/")) return "STUB:" + request; throw e; }
};
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (String(resolved).startsWith("STUB:")) return stub(request);
  return load.apply(this, arguments);
};
const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = console.warn = console.error = () => {};
const engine = require("../lib/engine");
const zone = require("../lib/timezone");
const caldav = require("../lib/services/caldav");
const ctx = require("../lib/context");
Object.assign(console, quiet);

test("a date alone is an all-day event, ending the day after its last day", () => {
  assert.deepEqual(zone.googleEventTime("2027-03-14", "Europe/Lisbon"), { date: "2027-03-14" });
  assert.deepEqual(zone.googleEventTime("2027-03-14T10:00:00+09:00", "Europe/Lisbon"), { dateTime: "2027-03-14T10:00:00+09:00" });
  assert.equal(zone.allDayEnd("2027-03-14"), "2027-03-15", "one day when no end is given");
  assert.equal(zone.allDayEnd("2027-03-14", "2027-03-14"), "2027-03-15", "nor an end on the same day");
  assert.equal(zone.allDayEnd("2027-03-14", "2027-03-17"), "2027-03-17");
  assert.equal(zone.allDayEnd("2027-03-14T10:00:00+09:00", "2027-03-14T11:00:00+09:00"), "2027-03-14T11:00:00+09:00", "a timed event keeps its end");
  assert.equal(caldav._test.icsWhen("DTSTART", "2027-03-14"), "DTSTART;VALUE=DATE:20270314");
  assert.equal(caldav._test.icsWhen("DTSTART", "2027-03-14T10:00:00Z"), "DTSTART:20270314T100000Z");
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /end: zone\.googleEventTime\(zone\.allDayEnd\(toolInput\.start, toolInput\.end\), tz\),/, "Google, made");
  assert.match(handlers, /const end = zone\.allDayEnd\(toolInput\.start, toolInput\.end\);\n\s*if \(end\) patch\.end = zone\.googleEventTime\(end, tz\);/, "Google, moved");
  assert.match(handlers, /Object\.assign\(out, \{ isAllDay: true, start: day\(input\.start\), end: day\(tz\.allDayEnd\(input\.start, input\.end\)\) \}\);/, "Outlook");
  const defs = require("../lib/tools/definitions").INTERNAL_TOOLS;
  for (const name of ["gcal_create_event", "outlook_cal_create_event", "caldav_create_event", "gcal_update_event", "outlook_cal_update_event", "caldav_update_event"]) {
    assert.match(defs.find((t) => t.name === name).input_schema.properties.start.description, /the date alone/, name);
  }
});

test("the confirmation says all day, and names a new event from what is sent", () => {
  assert.equal(engine.formatConfirmDateTime("2027-03-14"), "Sunday, 14 March 2027, all day");
  assert.equal(engine.sentEventLine({ summary: "Rosa's bday", start: { date: "2026-09-11" }, end: { date: "2026-09-12" }, recurrence: ["RRULE:FREQ=YEARLY"] }),
    "\"Rosa's bday\", all day on Friday, 11 September 2026, every year");
  assert.match(engine.sentEventLine(JSON.stringify({ summary: "Dentist", start: { dateTime: "2026-11-13T10:00:00+09:00" } })), /^"Dentist", Friday, 13 November 2026 at 10:00/);
  assert.equal(engine.sentEventLine({ raw: "a draft" }), "", "only an event");
  const src = read("lib/engine.js");
  assert.match(src, /if \(!named && method !== "DELETE"\) named = sentEventLine\(block\.input\.body\);/);
  assert.match(src, /if \(!\(plain && named\)\) confirmSummary \+= `\\n\$\{method\} \$\{host\}\$\{path\}\\n`;/, "with a name, no address");
});

test("a birthday repeats every year on every calendar, and the confirmation says so", () => {
  const dates = require("../lib/calendar-dates");
  assert.equal(dates.repeatRule("yearly"), "RRULE:FREQ=YEARLY");
  assert.equal(dates.repeatRule("fortnightly"), null, "only what each calendar can say");
  assert.deepEqual(dates.outlookRecurrence("yearly", "2027-03-14"), { pattern: { type: "absoluteYearly", interval: 1, month: 3, dayOfMonth: 14 }, range: { type: "noEnd", startDate: "2027-03-14" } });
  assert.deepEqual(dates.outlookRecurrence("weekly", "2026-11-13T10:00:00+09:00").pattern.daysOfWeek, ["friday"], "the day where it starts");
  const defs = require("../lib/tools/definitions").INTERNAL_TOOLS;
  for (const name of ["gcal_create_event", "outlook_cal_create_event", "caldav_create_event"]) {
    assert.deepEqual(defs.find((t) => t.name === name).input_schema.properties.repeats.enum, ["yearly", "monthly", "weekly", "daily"], name);
  }
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /const rule = require\("\.\.\/calendar-dates"\)\.repeatRule\(toolInput\.repeats\);\n\s*if \(rule\) event\.recurrence = \[rule\];/, "Google");
  assert.match(handlers, /const recurrence = require\("\.\.\/calendar-dates"\)\.outlookRecurrence\(toolInput\.repeats, toolInput\.start\);\n\s*if \(recurrence\) fields\.recurrence = recurrence;/, "Outlook");
  assert.match(read("lib/services/caldav.js"), /require\("\.\.\/calendar-dates"\)\.repeatRule\(repeats\) \|\| "",/, "CalDAV");
  assert.match(read("lib/engine.js"), /if \(block\.input\.repeats\) confirmSummary \+= `Repeats: every \$\{\{ yearly: "year"/);
});

const CALENDAR_TOOLS = ["gcal_update_event", "outlook_cal_update_event", "caldav_update_event", "gcal_delete_event", "outlook_cal_delete_event", "caldav_delete_event"];
test("a change or delete names the event as its calendar has it, and what changes from what to what", () => {
  ctx.store = ctx.activeUserStore = { location: { timezone: "Asia/Tokyo" } };
  const bday = { title: "Mina's dad's bday", start: "2019-06-08", end: "2019-06-08", all_day: true, location: "", repeats: "yearly" };
  assert.equal(engine.eventChangeLines({ event_id: "e1", summary: "Dad's bday", start: "2027-03-14" }, bday),
    "Title: Mina's dad's bday → Dad's bday\nWhen: Saturday, 8 June 2019, all day, every year → Sunday, 14 March 2027, all day, every year\n");
  assert.equal(engine.eventChangeLines({ event_id: "e1", summary: "Mina's dad's birthday" }, bday), "Title: Mina's dad's bday → Mina's dad's birthday\nWhen: Saturday, 8 June 2019, all day, every year\n", "what stays still says which event");
  assert.equal(engine.eventChangeLines({ event_id: "e1" }, bday), "When: Saturday, 8 June 2019, all day, every year\n", "a delete");
  assert.match(engine.eventChangeLines({ event_id: "e1", start: "2027-03-14" }, null), /^When: Sunday, 14 March 2027, all day\nI couldn't read this event from your calendar, so I can't show it as it is now\.\n$/);
  assert.equal(engine.eventChangeLines({ event_id: "e2", start: "2026-11-13T11:00:00", end: "2026-11-13T12:00:00", location: "Clinic, 2 Elm Row" }, { title: "Dentist", start: "2026-11-13T01:00:00Z", end: "2026-11-13T02:00:00Z", location: "" }),
    "When: Friday, 13 November 2026, 10:00 to 11:00 (Tokyo time) → Friday, 13 November 2026, 11:00 to 12:00 (Tokyo time)\nLocation: Clinic, 2 Elm Row\n", "times where they are, as the tools write them");
  assert.equal(engine.whenText("2026-09-16", "2026-10-07"), "Wednesday, 16 September 2026 to Wednesday, 7 October 2026, all day");
  assert.equal(caldav._test.icsWhen("DTSTART", "2027-07-21T10:00:00"), "DTSTART:20270721T010000Z", "CalDAV writes a time with no offset where they are, as Google and Outlook do");
  const src = read("lib/engine.js");
  assert.match(src, /\? await require\("\.\/tools\/handlers"\)\.eventNow\(block\.name, block\.input\)\.catch\(\(\) => null\) : null;/);
  assert.match(src, /const shownName = eventNow \? eventNow\.title \|\| "\(no title\)" : CALENDAR_CHANGES\.has\(block\.name\) \? block\.input\.event_name \|\| eventName : eventName;/, "never the new title in the old one's place");
  const handlers = read("lib/tools/handlers.js");
  for (const call of [/calendars\/primary\/events\/\$\{encodeURIComponent\(input\.event_id\)\}\?fields=summary,start,end,location,recurrence/, /me\/events\/\$\{encodeURIComponent\(input\.event_id\)\}\?\$select=subject,start,end,isAllDay,location,recurrence/, /require\("\.\.\/services\/caldav"\)\.getEvent\(input\.event_url\)/]) assert.match(handlers, call);
  const asks = read("lib/confirmation.js");
  for (const name of CALENDAR_TOOLS) assert.match(asks, new RegExp(`"${name}"`), `${name} asks first, on every calendar`);
  assert.deepEqual(["RRULE:FREQ=YEARLY", "absoluteYearly", "relativeMonthly", ""].map(require("../lib/calendar-dates").repeatsOf), ["yearly", "yearly", "monthly", ""]);
});
