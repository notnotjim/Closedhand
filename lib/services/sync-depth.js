// lib/services/sync-depth.js: how far back each kind of connection is read.
//
// One method for every connection, its own answer for each. Three questions:
// how likely someone is to look for something far back in it; whether
// Closedhand can search it live at its source when asked about something
// older (the recall before every message sees only what is synced); and how
// much a year of it is to read and embed on the person's computer. The depth
// is as far back as the first warrants, shallower only where live search
// covers the rest and the volume is large. A connection added later answers
// the same three questions here.

const DAY = 86400000;

// Mail is looked for far back (receipts, bookings, contracts, people) and can
// be searched live in the mailbox beyond what is kept. Bulk mail is most of it
// and rarely wanted after a year; a person's own mail is kept five.
const MAIL_DAYS = 365;
const PERSONAL_MAIL_DAYS = 5 * 365;
// Calendars are looked back on for years ("when did I last...") and are small:
// every calendar keeps five years back and one ahead. The year either side of
// today is read on every sync; the years before, once a day, since past events
// rarely change.
const CALENDAR_PAST_DAYS = 5 * 365;
const CALENDAR_NEAR_DAYS = 365;
const CALENDAR_FUTURE_DAYS = 365;
const FAR_PAST_EVERY_MS = DAY;

// Which stretches of a calendar to read on this sync: the near one always,
// the far past when it has not been read for a day. [{ from, to, far }] in
// ms, the near one first. A sync calls farRead(key) once the far one is read,
// so one that failed is read again at the next sync.
const _farRead = new Map();
function calendarWindows(key, now = Date.now()) {
  const near = { from: now - CALENDAR_NEAR_DAYS * DAY, to: now + CALENDAR_FUTURE_DAYS * DAY, far: false };
  if (now - (_farRead.get(key) || 0) < FAR_PAST_EVERY_MS) return [near];
  return [near, { from: now - CALENDAR_PAST_DAYS * DAY, to: near.from, far: true }];
}
function farRead(key, now = Date.now()) { _farRead.set(key, now); }

module.exports = { MAIL_DAYS, PERSONAL_MAIL_DAYS, CALENDAR_PAST_DAYS, CALENDAR_NEAR_DAYS, CALENDAR_FUTURE_DAYS, FAR_PAST_EVERY_MS, calendarWindows, farRead };
