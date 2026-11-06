// lib/itinerary.js: plans that cannot all be true. A new flight that takes
// the person far away while things are still booked where they were, a later
// flight leaving from the place they flew away from, two stays far apart on
// the same nights. One booked a flight home in the middle of a trip, and
// Upcoming listed the rest of the trip after it as if nothing were wrong,
// while Closedhand, placing them by their flights, took them to be home.
//
// A place is the timezone a flight's airport or a booking keeps: zones three
// hours or more apart are too far apart to travel between without a flight,
// so only those count. Nearer places are left alone (a train between two
// cities is normal), and anything without a zone is left out: this only
// finds what cannot be true, and the person's LLM judges each one before
// anything is said (lib/itinerary-check.js). Pure; the webapp keeps a
// byte-identical copy (webapp/itinerary.js).

const FAR_MINUTES = 180;
// A flight places the person where it lands until their next flight, and for
// four days at most: after that they may have gone on in a way nothing shows.
const HOLD_MS = 4 * 86400000;
// A stay that overlaps less than this is a check-out on the morning of a flight.
const STAY_SLACK_MS = 12 * 3600000;

function validZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
}
// Minutes ahead of UTC in `tz` at `ms`.
function offsetMinutes(tz, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((local - Math.floor(ms / 60000) * 60000) / 60000);
}
function far(a, b, ms) {
  if (!validZone(a) || !validZone(b) || a === b) return false;
  return Math.abs(offsetMinutes(a, ms) - offsetMinutes(b, ms)) >= FAR_MINUTES;
}

// A tracked flight as facts keep it (plain, JSON or wrapped {value}), or null
// when it places nobody: not confirmed, cancelled, diverted or set aside.
function readFlight(raw) {
  try {
    let f = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (f && f.value !== undefined) f = typeof f.value === "string" ? JSON.parse(f.value) : f.value;
    if (!f || !f.flightNumber || f.supersededBy || f.pending || /cancel|divert/i.test(f.lastStatus || "")) return null;
    const dep = Date.parse(f.liveStatus?.departureTime || f.departure?.dateTime);
    const arr = Date.parse(f.liveStatus?.arrivalTime || f.arrival?.dateTime);
    if (!Number.isFinite(dep) || !Number.isFinite(arr) || !validZone(f.departure?.tz) || !validZone(f.arrival?.tz)) return null;
    return { number: String(f.flightNumber), dep: { at: dep, tz: f.departure.tz, airport: f.departure.airport || null }, arr: { at: arr, tz: f.arrival.tz, airport: f.arrival.airport || null } };
  } catch { return null; }
}
// Every tracked flight in a set of facts ({ key: value }).
function flightsFrom(facts) {
  const out = [];
  for (const [key, raw] of Object.entries(facts || {})) {
    if (!key.startsWith("flight-")) continue;
    const f = readFlight(raw);
    if (f) out.push({ id: key, ...f });
  }
  return out.sort((a, b) => a.dep.at - b.dep.at);
}
// A booking row as one point or stretch in its own place, or null.
function readBooking(b) {
  if (!b || !b.id || b.status === "cancelled" || b.kind === "flight" || !validZone(b.timezone)) return null;
  const start = Date.parse(b.starts_at), end = b.ends_at ? Date.parse(b.ends_at) : NaN;
  if (!Number.isFinite(start)) return null;
  return { id: String(b.id), title: String(b.title || "A booking"), kind: b.kind || "other", tz: b.timezone, start, end: Number.isFinite(end) && end > start ? end : null };
}

// What cannot all be true, from tracked flights (flightsFrom) and booking
// rows. Each clash names the flight or stays at its heart and the things that
// contradict it:
//   { id: "f:<flight>", kind: "flight", flight: { id, number, from, to, departs, arrives, toTz },
//     items: [{ id, what: "booking"|"flight", title, at }] }
//   { id: "s:<a>:<b>", kind: "stays", items: [two stays] }
// Only what is still to come counts.
function clashes({ flights = [], bookings = [], now = Date.now() } = {}) {
  const stays = [], rows = [];
  for (const raw of bookings) {
    const b = readBooking(raw);
    if (!b) continue;
    if (b.end && b.end < now) continue;
    if (!b.end && b.start < now) continue;
    (b.kind === "hotel" && b.end ? stays : rows).push(b);
  }
  const out = [];
  flights.forEach((f, i) => {
    if (f.arr.at + HOLD_MS < now) return;
    const next = flights[i + 1];
    const until = Math.min(f.arr.at + HOLD_MS, next ? next.dep.at : Infinity);
    const items = [];
    // A later flight leaving from a place this one took them away from.
    if (next && next.dep.at - f.arr.at <= HOLD_MS && far(next.dep.tz, f.arr.tz, next.dep.at)) {
      items.push({ id: next.id, what: "flight", title: next.number, at: next.dep.at });
    }
    // Something booked far away while this flight has them elsewhere.
    for (const b of rows) {
      if (b.start > f.arr.at && b.start < until && far(b.tz, f.arr.tz, b.start)) items.push({ id: b.id, what: "booking", title: b.title, at: b.start });
    }
    for (const s of stays) {
      const overlap = Math.min(s.end, until) - Math.max(s.start, f.arr.at);
      if (overlap > STAY_SLACK_MS && far(s.tz, f.arr.tz, Math.max(s.start, f.arr.at))) items.push({ id: s.id, what: "booking", title: s.title, at: s.start });
    }
    if (!items.length) return;
    out.push({ id: "f:" + f.id, kind: "flight",
      flight: { id: f.id, number: f.number, from: f.dep.airport, to: f.arr.airport, departs: f.dep.at, arrives: f.arr.at, toTz: f.arr.tz },
      items: items.sort((a, b) => a.at - b.at) });
  });
  // Two stays far apart on the same nights.
  for (let i = 0; i < stays.length; i++) {
    for (let j = i + 1; j < stays.length; j++) {
      const a = stays[i], b = stays[j];
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlap > STAY_SLACK_MS && far(a.tz, b.tz, Math.max(a.start, b.start))) {
        out.push({ id: `s:${a.id}:${b.id}`, kind: "stays", items: [a, b].map((s) => ({ id: s.id, what: "booking", title: s.title, at: s.start })) });
      }
    }
  }
  return out;
}

// The quiet line each card involved shows until the person settles it in
// chat. `record` is what lib/itinerary-check.js keeps: per clash the places
// the person's LLM named and each item's state. Only what their LLM judged a
// real clash shows ("asked", or "real" when the question could not be sent
// yet): the rule check finds things in two far places, and that alone is not
// a clash (an online call, a booking for someone else). Returns
// { [item or flight id]: line }.
const JUDGED_REAL = ["asked", "real"];
function lines(found, record = {}) {
  const out = {};
  const kept = (record && record.clashes) || {};
  for (const c of found) {
    const rec = kept[c.id] || {};
    const shown = c.items.filter((it) => JUDGED_REAL.includes(rec.items?.[it.id]?.state));
    if (!shown.length) continue;
    if (c.kind === "stays") {
      const [a, b] = c.items;
      if (shown.includes(a)) out[a.id] = `Clashes with ${b.title}: both are booked for the same nights.`;
      if (shown.includes(b)) out[b.id] = `Clashes with ${a.title}: both are booked for the same nights.`;
      continue;
    }
    const { number, to } = c.flight;
    for (const it of shown) {
      out[it.id] = rec.place ? `Clashes with ${number}: you'd be in ${rec.place} by then.` : `Clashes with ${number}, which flies you to ${to || "somewhere else"} before this.`;
    }
    out[c.flight.id] = rec.from ? `Clashes with your plans in ${rec.from} after it.` : "Clashes with what's booked after it.";
  }
  return out;
}

module.exports = { clashes, lines, flightsFrom, readFlight, readBooking, far, offsetMinutes, FAR_MINUTES, HOLD_MS };
