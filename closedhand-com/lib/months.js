// Calendar months from a given moment, in UTC: what a month of fair use is
// counted in, within a subscription's paid period of 1, 6 or 12 months and a
// plan paid ahead (lib/plus.js, lib/ahead.js, lib/included-ai.js,
// lib/plan.js). A month from 31 January is the last day of February, as
// people count it.
function addMonths(from, n) {
  const at = new Date(from);
  const day = at.getUTCDate();
  at.setUTCDate(1);
  at.setUTCMonth(at.getUTCMonth() + n);
  const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
  at.setUTCDate(Math.min(day, last));
  return at;
}

// The month a plan that began at start is in now: when it began, and when the
// next begins.
function monthIn(start, now = new Date()) {
  let n = Math.max(0, (now.getUTCFullYear() - new Date(start).getUTCFullYear()) * 12 + now.getUTCMonth() - new Date(start).getUTCMonth() - 1);
  while (addMonths(start, n + 1) <= now) n++;
  return { from: addMonths(start, n), next: addMonths(start, n + 1) };
}

// The month of fair use a paid period from start to end is in now. Never one
// past the period: a renewal not yet paid begins no new month.
function monthOfPeriod(start, end, now = new Date()) {
  const last = end ? new Date(new Date(end).getTime() - 1) : now;
  const month = monthIn(start, now < last ? now : last);
  return { from: month.from, next: end && month.next > new Date(end) ? new Date(end) : month.next };
}

// The month of fair use a subscription is in: its paid period when it renews
// every month, else the month of its 6 or 12 that runs now. Null before
// Polar has said when the period began.
function fairUseMonth(sub, now = new Date()) {
  if (!sub?.current_period_start) return null;
  if (!(Number(sub.every_months) > 1)) return { from: new Date(sub.current_period_start), next: sub.current_period_end ? new Date(sub.current_period_end) : null };
  return monthOfPeriod(sub.current_period_start, sub.current_period_end, now);
}

module.exports = { addMonths, monthIn, monthOfPeriod, fairUseMonth };
