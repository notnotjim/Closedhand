// All-day events are handed to the model by their last day: calendars write
// the end as the day after, so a stay to 7 October read as "until 8 October".
// Events still going on count as part of the dates asked about, and place
// names come back in English.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dates = require("../lib/calendar-dates");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("a Google all-day event ends on its last day, not the day after", () => {
  const stay = { start: { date: "2026-09-16" }, end: { date: "2026-10-08" } };
  assert.deepEqual(dates.googleEventTimes(stay), { start: "2026-09-16", end: "2026-10-07", all_day: true });
  assert.deepEqual(dates.googleEventTimes({ start: { date: "2026-10-03" }, end: { date: "2026-10-04" } }), { start: "2026-10-03", end: "2026-10-03", all_day: true });
  assert.deepEqual(dates.googleEventTimes({ start: { date: "2026-10-03" } }), { start: "2026-10-03", end: "2026-10-03", all_day: true });
  const timed = { start: { dateTime: "2026-10-09T19:00:00+08:00" }, end: { dateTime: "2026-10-09T21:00:00+08:00" } };
  assert.deepEqual(dates.googleEventTimes(timed), { start: "2026-10-09T19:00:00+08:00", end: "2026-10-09T21:00:00+08:00" });
  assert.equal(dates.dayBefore("2026-03-01"), "2026-02-28");
});

test("an Outlook all-day event ends on its last day too", () => {
  const stay = { isAllDay: true, start: { dateTime: "2026-09-16T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-08T00:00:00.0000000", timeZone: "UTC" } };
  assert.deepEqual(dates.outlookEventTimes(stay), { start: "2026-09-16", end: "2026-10-07", all_day: true });
  const timed = { start: { dateTime: "2026-10-09T11:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-09T12:00:00.0000000", timeZone: "UTC" } };
  assert.deepEqual(dates.outlookEventTimes(timed), { start: "2026-10-09T11:00:00.0000000Z", end: "2026-10-09T12:00:00.0000000Z" });
});

test("the calendar copy shows last days and keeps what it does not recognise", () => {
  assert.deepEqual(dates.shownTimes({ summary: "Stay", start: "2026-09-16", end: "2026-10-08" }), { summary: "Stay", start: "2026-09-16", end: "2026-10-07", all_day: true });
  const timed = { start: "2026-10-09T19:00:00+08:00", end: "2026-10-09T21:00:00+08:00" };
  assert.equal(dates.shownTimes(timed), timed);
});

test("every place events reach the model reads them through the helper", () => {
  assert.match(read("lib/services/data-access.js"), /\.\.\.require\("\.\.\/calendar-dates"\)\.googleEventTimes\(e\)/);
  assert.match(read("lib/services/data-access.js"), /\.\.\.require\("\.\.\/calendar-dates"\)\.outlookEventTimes\(e\)/);
  assert.match(read("lib/services/data-access.js"), /\$select=id,subject,start,end,isAllDay,/);
  assert.equal((read("lib/tools/handlers.js").match(/\.\.\.require\("\.\.\/calendar-dates"\)\.googleEventTimes\(result\)/g) || []).length, 2, "create and update results");
  assert.match(read("lib/onboarding.js"), /\.\.\.require\("\.\/calendar-dates"\)\.googleEventTimes\(e\)/);
  const sync = read("lib/services/data-sync.js");
  assert.match(sync, /\.map\(evt => evt\._cache_source === "mac_calendar" \? evt : shownTimes\(evt\)\)/);
  // Overlapping counts: a stay that began last month is part of this week.
  assert.match(sync, /if \(evtStart > endMs \|\| \(isNaN\(evtEnd\) \? evtStart : evtEnd\) < startMs\) return false;/);
});

test("place lookups ask OpenStreetMap for English names", () => {
  for (const f of ["lib/onboarding.js", "webapp/server.js", "webapp/views/dashboard.html", "lib/maps-fallback.js"]) {
    const src = read(f);
    if (f === "lib/maps-fallback.js") continue;
    for (const line of src.split("\n").filter((l) => /nominatim\.openstreetmap\.org\/(search|reverse)/.test(l))) {
      assert.match(line, /accept-language=en/, `${f}: ${line.trim().slice(0, 80)}`);
    }
  }
  assert.match(read("lib/maps-fallback.js"), /"Accept-Language": "en"/);
});

test("an event time without an offset is where the user is, never the calendar's zone or the server's clock", () => {
  const tz = require("../lib/timezone");
  assert.deepEqual(tz.googleEventTime("2026-10-09T19:00:00", "Asia/Ho_Chi_Minh"), { dateTime: "2026-10-09T19:00:00", timeZone: "Asia/Ho_Chi_Minh" });
  assert.deepEqual(tz.googleEventTime("2026-10-09T19:00:00+08:00", "Asia/Ho_Chi_Minh"), { dateTime: "2026-10-09T19:00:00+08:00" }, "an offset given is kept");
  assert.deepEqual(tz.googleEventTime("2026-10-09T11:00:00Z", "Asia/Ho_Chi_Minh"), { dateTime: "2026-10-09T11:00:00Z" });
  assert.equal(tz.eventInstant("2026-10-09T19:00", "Asia/Ho_Chi_Minh").toISOString(), "2026-10-09T12:00:00.000Z");
  assert.equal(tz.eventInstant("2026-07-01T09:00:00", "Europe/London").toISOString(), "2026-07-01T08:00:00.000Z", "summer time");
  assert.equal(tz.eventInstant("2026-01-15T09:00:00", "Europe/London").toISOString(), "2026-01-15T09:00:00.000Z");
  const handlers = read("lib/tools/handlers.js");
  assert.equal((handlers.match(/googleEventTime\((toolInput\.start|zone\.allDayEnd\(toolInput\.start, toolInput\.end\)|end), tz\)/g) || []).length, 4, "Google create and update, an all-day end worked out from the start");
  // Outlook's create and update share one conversion (outlookEventFields).
  assert.match(handlers, /function outlookEventFields\(input\) \{[\s\S]*?const zone = tz\.getUserTimezone\(ctx\.store\);\n\s*const at = \(t\) => \(\{ dateTime: tz\.eventInstant\(t, zone\)/, "Outlook create and update");
  assert.equal((handlers.match(/outlookEventFields\(toolInput\)/g) || []).length, 2);
  assert.doesNotMatch(handlers, /new Date\(toolInput\.(start|end)\)\.toISOString\(\)/, "no event time read by the server's clock");
});

test("the calendar search finds the dates asked about however many events are saved, an event with no start kept included", async () => {
  const vm = require("node:vm");
  const src = read("lib/services/data-sync.js");
  const at = src.indexOf("async function queryCacheCalendar");
  const fnSrc = src.slice(at, src.indexOf("\n}\n", at) + 2);
  // 1,200 saved events, one a day from January 2023, and an Outlook all-day
  // one with no start kept (received_at null) inside the dates asked about.
  const day = (n) => new Date(Date.parse("2023-01-01T09:00:00Z") + n * 86400000).toISOString();
  const rows = Array.from({ length: 1200 }, (_, n) => ({ source: "gcal", synced_at: new Date().toISOString(), received_at: day(n), data: { summary: "Event " + n, start: day(n), end: day(n) } }));
  rows.push({ source: "outlook_cal", synced_at: new Date().toISOString(), received_at: null, data: { summary: "Team day", start: "2026-04-14", end: "2026-04-15", date: "" } });
  // Stands in for the database, applying the query as Postgres would.
  const supabase = { from: () => { let list = rows; const q = {
    select: () => q, eq: () => q,
    or: (dsl) => { const lte = dsl.match(/received_at\.lte\.([^,]+)/)[1]; list = list.filter((r) => r.received_at === null ? /received_at\.is\.null/.test(dsl) : r.received_at <= lte); return q; },
    order: (col, { ascending, nullsFirst }) => { list = [...list].sort((a, b) => (nullsFirst ? -1 : 1) * ((a[col] === null) - (b[col] === null)) || (ascending ? 1 : -1) * String(a[col]).localeCompare(String(b[col]))); return q; },
    limit: async (n) => ({ data: list.slice(0, n), error: null }),
  }; return q; } };
  const box = { supabase, console: { log() {}, error() {} }, Date, isNaN, String, require: (n) => n === "../calendar-dates" ? dates : (() => { throw Error(n); })(), CALENDAR_COPY_FRESH_MS: 60000 };
  vm.runInNewContext(fnSrc + "\nthis.f = queryCacheCalendar;", box);
  // Event 1199 starts 2026-04-14; read oldest first with a cap of 1,000 it was never seen.
  const got = await box.f("u", "2026-04-13T00:00:00Z", "2026-04-16T00:00:00Z");
  assert.ok(got.events.some((e) => e.summary === "Event 1199"), "the newest event, past the first 1,000");
  assert.ok(got.events.some((e) => e.summary === "Team day"), "an event with no start kept is still read");
  const starts = got.events.filter((e) => e.summary.startsWith("Event")).map((e) => e.start);
  assert.deepEqual(starts, [...starts].sort(), "oldest first, as before");
});
