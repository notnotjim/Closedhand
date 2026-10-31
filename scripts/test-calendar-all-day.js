// An all-day event (a birthday, a day off) is a date alone, on every calendar
// Closedhand writes to, and the confirmation says so in words: a birthday
// moved by its date showed "Time: 00:00 to 00:00 (timezone not specified)",
// and a new yearly one sent as an API request showed only "POST" and an
// address.
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
Object.assign(console, quiet);

test("a date alone is an all-day event, ending the day after its last day", () => {
  assert.deepEqual(zone.googleEventTime("2027-02-21", "Europe/Lisbon"), { date: "2027-02-21" });
  assert.deepEqual(zone.googleEventTime("2027-02-21T10:00:00+09:00", "Europe/Lisbon"), { dateTime: "2027-02-21T10:00:00+09:00" });
  assert.equal(zone.allDayEnd("2027-02-21"), "2027-02-22", "one day when no end is given");
  assert.equal(zone.allDayEnd("2027-02-21", "2027-02-21"), "2027-02-22", "nor an end on the same day");
  assert.equal(zone.allDayEnd("2027-02-21", "2027-02-24"), "2027-02-24");
  assert.equal(zone.allDayEnd("2027-02-21T10:00:00+09:00", "2027-02-21T11:00:00+09:00"), "2027-02-21T11:00:00+09:00", "a timed event keeps its end");
  assert.equal(caldav._test.icsWhen("DTSTART", "2027-02-21"), "DTSTART;VALUE=DATE:20270221");
  assert.equal(caldav._test.icsWhen("DTSTART", "2027-02-21T10:00:00Z"), "DTSTART:20270221T100000Z");
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
  assert.equal(engine.formatConfirmDateTime("2027-02-21"), "Sunday, 21 February 2027, all day");
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
  assert.deepEqual(dates.outlookRecurrence("yearly", "2027-02-21"), { pattern: { type: "absoluteYearly", interval: 1, month: 2, dayOfMonth: 21 }, range: { type: "noEnd", startDate: "2027-02-21" } });
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
