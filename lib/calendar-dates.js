// Calendars write an all-day event's end as the day after its last day: a
// stay from 16 September to 7 October ends on 8 October. Read as it comes,
// every all-day event runs a day too long ("until 8 October"), so events
// handed to the model carry their last day, and say they are all-day.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayBefore(ymd) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// A last day never before the first: a one-day event ends the day it starts.
function lastDay(first, endExclusive) {
  if (!endExclusive) return first;
  const last = dayBefore(endExclusive);
  return last < first ? first : last;
}

// A Google Calendar event: { start, end } for timed events, as Google gives
// them; for all-day events the first and last days and all_day: true.
function googleEventTimes(e) {
  if (e?.start?.date && !e.start.dateTime) {
    return { start: e.start.date, end: lastDay(e.start.date, e.end?.date || null), all_day: true };
  }
  return { start: e?.start?.dateTime || null, end: e?.end?.dateTime || null };
}

// A Microsoft Graph event, which marks all-day events with isAllDay and gives
// them midnight-to-midnight times.
function outlookEventTimes(e) {
  const at = (t) => (t?.dateTime ? t.dateTime + (t.timeZone === "UTC" ? "Z" : "") : "");
  if (e?.isAllDay && e.start?.dateTime) {
    const first = e.start.dateTime.slice(0, 10);
    return { start: first, end: lastDay(first, e.end?.dateTime ? e.end.dateTime.slice(0, 10) : null), all_day: true };
  }
  return { start: at(e?.start), end: at(e?.end) };
}

// An event already flattened to { start, end } strings from Google's form
// (the calendar copy): date-only start and end mean all-day.
function shownTimes(evt) {
  if (evt && DAY.test(evt.start || "") && DAY.test(evt.end || "")) {
    return { ...evt, end: lastDay(evt.start, evt.end), all_day: true };
  }
  return evt;
}

// How often a new event repeats, with no end (a birthday is yearly), in each
// calendar's own form: an iCalendar rule for Google and CalDAV, a pattern
// from its first day for Outlook.
const REPEATS = { yearly: "YEARLY", monthly: "MONTHLY", weekly: "WEEKLY", daily: "DAILY" };
function repeatRule(repeats) {
  return REPEATS[repeats] ? `RRULE:FREQ=${REPEATS[repeats]}` : null;
}
function outlookRecurrence(repeats, start) {
  if (!REPEATS[repeats]) return null;
  const day = new Date(String(start).slice(0, 10) + "T00:00:00Z");
  const startDate = day.toISOString().slice(0, 10);
  const pattern = {
    yearly: { type: "absoluteYearly", interval: 1, month: day.getUTCMonth() + 1, dayOfMonth: day.getUTCDate() },
    monthly: { type: "absoluteMonthly", interval: 1, dayOfMonth: day.getUTCDate() },
    weekly: { type: "weekly", interval: 1, daysOfWeek: [["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][day.getUTCDay()]] },
    daily: { type: "daily", interval: 1 },
  }[repeats];
  return { pattern, range: { type: "noEnd", startDate } };
}

// How often an event already repeats, from Google's or CalDAV's rule
// ("RRULE:FREQ=YEARLY") or Outlook's pattern ("absoluteYearly"): "yearly",
// or "" when it does not.
function repeatsOf(rule) {
  const m = String(rule || "").match(/FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY)|(yearly|monthly|weekly|daily)$/i);
  return m ? (m[1] || m[2]).toLowerCase() : "";
}

module.exports = { dayBefore, googleEventTimes, outlookEventTimes, shownTimes, repeatRule, outlookRecurrence, repeatsOf };
