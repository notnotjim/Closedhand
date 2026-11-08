// Current clocks are prompt evidence, never inferred from the server's date.
const FlightTime = require('./flight-time');
const validZone = tz => {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
};
function currentTimeContext(store, now = new Date()) {
  const locations = [store?.location, store?.profile?.settings?.location].filter(Boolean);
  const known = locations.find(loc => validZone(loc.timezone));
  let tz = known?.timezone;
  let at = now, suffix;
  // Newer evidence than the saved place wins: a flight that landed since
  // (lib/flights.js moveToLanding saves it at the next check), or the phone's
  // clock moving to another zone since (phone-zone.js). The newer of the two.
  const landing = known ? placeFromFlights(store?.facts, now) : null;
  const landed = landing?.landed && landing.at > (Date.parse(known.updated || "") || 0) ? landing : null;
  const phone = known ? require('./phone-zone').movedZone(known, now) : null;
  const phoneAt = phone ? Date.parse(known.deviceZone.at) : 0;
  const since = known?.name ? ` of ${known.name}` : "";
  const newer = phone && (!landed || phoneAt > landed.at) ? 'phone' : landed ? 'landed' : null;
  if (newer === 'phone') {
    tz = phone;
    suffix = `Current time where the user most likely is (${tz}, from their phone's clock, which changed after their saved location${since})`;
  } else if (newer === 'landed') {
    tz = landed.tz;
    suffix = `Current time where the user most likely is (${tz}, inferred from flight ${landed.flight} ${landed.why}, after their saved location${since})`;
  } else if (known) suffix = `Current time where the user is (${tz})`;
  else {
    const coordinates = locations.find(loc => Number.isFinite(loc.latitude) && Math.abs(loc.latitude) <= 90
      && Number.isFinite(loc.longitude) && Math.abs(loc.longitude) <= 180);
    if (coordinates) {
      const offset = Math.round(coordinates.longitude / 15);
      at = new Date(now.getTime() + offset * 3600000);
      tz = 'UTC';
      suffix = `Estimated local time from longitude (UTC${offset >= 0 ? '+' : ''}${offset}, timezone unconfirmed)`;
    } else {
      // Tracked flights place the person: about to depart an airport, or
      // landed at one, means they are in that airport's zone now. Leaving
      // the arithmetic to the model gave "20:00 is eight hours away" for a
      // flight leaving in eighty minutes.
      const placed = placeFromFlights(store?.facts, now);
      if (placed) {
        tz = placed.tz;
        suffix = `Current time where the user most likely is (${tz}, inferred from flight ${placed.flight} ${placed.why}; no location saved, so confirm if it matters)`;
      } else {
        tz = validZone(store?.profile?.timezone) ? store.profile.timezone : 'UTC';
        suffix = `Reference clock (${tz}); the user's current location is unknown, so this is not confirmed as their local date or time`;
      }
    }
  }
  const date = at.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return { timezone: newer ? tz : known?.timezone || null, text: `${suffix}: ${date}, ${time}. Use confirmed local time for ordinary events. For travel, use each airport or property's local date and time, including today/tomorrow. Do not copy relative dates from earlier messages.` };
}
function parseFlight(raw) {
  let f = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (f?.value !== undefined) f = typeof f.value === 'string' ? JSON.parse(f.value) : f.value;
  return f;
}
// The most recent thing a tracked flight says about where the person is: a
// departure within the next 36 hours puts them at that airport now; a landing
// within the last 30 days puts them where they landed. A booking not yet
// confirmed, or a flight cancelled or diverted, places nobody.
function placeFromFlights(facts, now = new Date()) {
  let best = null;
  for (const [key, raw] of Object.entries(facts || {})) {
    if (!key.startsWith('flight-')) continue;
    try {
      const f = parseFlight(raw);
      if (!f || f.supersededBy || f.pending || /cancel|divert/i.test(f.lastStatus || '')) continue;
      const dep = Date.parse(f?.liveStatus?.departureTime || f?.departure?.dateTime);
      const arr = Date.parse(f?.liveStatus?.arrivalTime || f?.arrival?.dateTime);
      const t = now.getTime();
      if (Number.isFinite(arr) && arr <= t && t - arr <= 30 * 86400000 && validZone(f?.arrival?.tz)) {
        if (!best || arr > best.at) best = { at: arr, tz: f.arrival.tz, flight: f.flightNumber, airport: f.arrival.airport || null, landed: true, why: `that landed at ${f.arrival.airport || 'its destination'}` };
      } else if (Number.isFinite(dep) && dep > t && dep - t <= 36 * 3600000 && validZone(f?.departure?.tz)) {
        if (!best || dep - 36 * 3600000 > best.at) best = { at: dep - 36 * 3600000, tz: f.departure.tz, flight: f.flightNumber, why: `departing ${f.departure.airport || 'its airport'} soon` };
      }
    } catch { /* a malformed fact places nobody */ }
  }
  return best;
}
function untilText(ms, now) {
  const diff = ms - now.getTime();
  if (diff <= 0 || diff > 86400000) return null;
  const h = Math.floor(diff / 3600000), m = Math.round((diff % 3600000) / 60000);
  return `departs in ${h ? h + ' h ' : ''}${m} min from now`;
}
function flightDateContext(facts, now = new Date()) {
  const flights = [];
  for (const [key, raw] of Object.entries(facts || {})) {
    if (!key.startsWith('flight-')) continue;
    try {
      let f = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (f?.value !== undefined) f = typeof f.value === 'string' ? JSON.parse(f.value) : f.value;
      const dep = f?.liveStatus?.departureTime || f?.departure?.dateTime;
      const ms = Date.parse(dep);
      if (f?.supersededBy || f?.landed || !Number.isFinite(ms) || (ms < now.getTime() - 86400000 || ms > now.getTime() + 14 * 86400000)) continue;
      const point = f.departure || {};
      const date = FlightTime.dateKey(dep, point);
      if (!date) continue;
      const soon = untilText(ms, now);
      flights.push({ ms, text: `${f.flightNumber}: ${date}, ${FlightTime.time(dep, point)} at ${point.airport || 'departure airport'}; ${FlightTime.daysAway(dep, point, now) || 'past departure date'} in the departure airport's timezone.${soon ? `; ${soon}` : ''}` });
    } catch { /* Malformed facts do not become date evidence. */ }
  }
  const live = !!process.env.FLIGHTAWARE_API_KEY;
  const noLive = flights.length && !live
    ? '\nThere is no live flight status source here. Asked whether a flight is delayed, answer at once from the booking: give the scheduled time, say live status is not available here, and point to the airline\'s app or the airport board. Do not fetch or browse flight-tracker sites; they block automated reading and take minutes to fail.'
    : '';
  return flights.length ? '\n\nFLIGHT DATES (checked now, airport-local; use these over earlier relative wording):\n'
    + flights.sort((a, b) => a.ms - b.ms).slice(0, 6).map(f => f.text).join('\n') + noLive : '';
}
// The zone the person is most likely in now, by the same evidence as the
// clock above (a flight that landed, the phone's clock), for code that works
// out hours: quiet hours, the time of a nudge. Falls back to the saved place.
function personZone(store, now = new Date()) {
  return currentTimeContext(store, now).timezone || require('./timezone').getUserTimezone(store);
}
// Plans that cannot all be true, put to the person and not yet settled
// (lib/itinerary-check.js). Said with the clock, so nothing assumes where they
// are on those days, and with the ids that settle it once they say.
function clashContext(facts) {
  let open = [];
  try { open = require('./itinerary-check').openClashes(facts); } catch { return ''; }
  if (!open.length) return '';
  const items = c => c.items.map(it => `${it.what === 'flight' ? 'flight ' : ''}${it.title} (id ${it.id})`).join(', ');
  return '\n\nPLANS THAT CLASH (these cannot all be true; until the person says what stands, do not assume where they are on those days, and ask rather than guess when it matters):\n'
    + open.map(c => `- [${c.id}] ${c.number ? `${c.number} takes them ${c.place ? 'to ' + c.place : 'far away'}, but still booked ${c.from ? 'in ' + c.from + ' ' : ''}after it: ` : 'Booked for the same nights far apart: '}${items(c)}.${c.asked ? ' Asked them already; do not ask again unprompted.' : ''}`).join('\n')
    + '\nWhen they say what stands, settle it with plans_settle: drop what they say is off, keep what they say stands; what they have not answered about stays open. A short reply right after you asked about one of these ("no, it\'s cancelled") answers that question.';
}
// The time block the chat gets: the clock, then tracked flights' dates in
// their airports' own time, then plans that clash.
function timeBlock(store, now = new Date()) {
  return currentTimeContext(store, now).text + flightDateContext(store?.facts, now) + clashContext(store?.facts);
}
module.exports = { currentTimeContext, flightDateContext, clashContext, placeFromFlights, personZone, timeBlock };
