const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sameBooking, sameFromEmail, findMatch, mergePlan, mergeInto, isTrackedFlight, noEndOver } = require('../lib/booking-identity');

// Four rows that one Porto stay grew across three scanner passes and two emails.
const A = 'mailA', B = 'mailB';
const stay1 = { id: '1', kind: 'hotel', provider: 'Airbnb', reference: null, starts_at: '2026-09-15T17:00:00Z', ends_at: '2026-10-07T04:00:00Z', location: 'São João, Porto, Portugal', source_email_id: A, updated_at: '2026-09-15T10:27:58Z', details: { room: 'Entire home/flat, hosted by Sam' } };
const stay2 = { id: '2', kind: 'hotel', provider: 'Airbnb', reference: null, starts_at: '2026-09-15T17:00:00Z', ends_at: '2026-10-07T04:00:00Z', location: 'São João, Portugal', source_email_id: A, updated_at: '2026-09-17T04:47:34Z', details: {} };
const stay3 = { id: '3', kind: 'hotel', provider: 'Airbnb', reference: '4000000001', starts_at: '2026-09-16T07:00:00Z', ends_at: '2026-10-07T04:00:00Z', location: 'São João, Porto, Portugal', source_email_id: B, updated_at: '2026-09-16T15:42:29Z', details: { guests: 2 } };
const stay4 = { id: '4', kind: 'hotel', provider: 'Airbnb', reference: null, starts_at: '2026-09-16T08:00:00Z', ends_at: '2026-10-07T04:00:00Z', location: 'São João, Porto, Portugal', source_email_id: A, updated_at: '2026-09-16T15:47:36Z', details: { guests: 2, check_in_url: 'https://airbnb.com/x' } };

test('the same stay is the same stay however the model words it', () => {
  assert.ok(sameFromEmail(stay1, stay2));
  assert.ok(sameFromEmail(stay1, stay4));
  assert.ok(sameBooking(stay1, stay3), 'a second email about the same nights');
  assert.ok(sameBooking(stay2, stay3), 'even with the city dropped from the place');
  assert.ok(sameBooking({ ...stay1, provider: 'Airbnb (host Rita)', source_email_id: 'mailD' }, stay3), 'or the host added to the provider');
  assert.equal(sameBooking({ ...stay1, provider: 'Booking.com', source_email_id: 'mailD' }, stay3), false, 'another platform is another booking');
});

test('different bookings stay different', () => {
  const rideA = { kind: 'car', provider: 'Bolt', reference: 'A-TESTRIDE0000001', starts_at: '2026-09-16T11:05:00Z', ends_at: '2026-09-16T11:30:00Z' };
  const rideB = { kind: 'other', provider: 'Bolt', reference: 'A-TESTRIDE0000002', starts_at: '2026-09-16T17:08:00Z', ends_at: '2026-09-16T17:11:00Z' };
  assert.equal(sameBooking(rideA, rideB), false, 'two references are two bookings');
  const out = { kind: 'train', provider: 'Avanti', starts_at: '2026-10-01T07:00:00Z', source_email_id: 'rt' };
  const back = { kind: 'train', provider: 'Avanti', starts_at: '2026-10-01T18:00:00Z', source_email_id: 'rt' };
  assert.equal(sameFromEmail(out, back), false, 'a return train is two bookings from one email');
  assert.equal(sameBooking(out, back), false);
  const nextStay = { kind: 'hotel', provider: 'Airbnb', starts_at: '2026-10-07T08:00:00Z', ends_at: '2026-10-14T04:00:00Z', location: 'Braga, Portugal' };
  assert.equal(sameBooking(stay1, nextStay), false, 'the following week somewhere else');
  const dinner1 = { kind: 'restaurant', provider: 'Example Bistro', starts_at: '2026-06-18T17:30:00Z', location: '12 Sample St, London W1F 0AA' };
  const dinner2 = { kind: 'restaurant', provider: 'Example Bistro', starts_at: '2026-06-18T17:30:00Z', location: '12 Sample Street, London W1F 0AA' };
  const dinner3 = { kind: 'restaurant', provider: 'Example Bistro', starts_at: '2026-06-19T17:30:00Z' };
  assert.ok(sameBooking(dinner1, dinner2));
  assert.equal(sameBooking(dinner1, dinner3), false, 'the next night is another table');
});

test('a fresh extraction updates the row it already has', () => {
  const existing = [stay1, stay3];
  const again = { kind: 'hotel', provider: 'Airbnb', reference: null, starts_at: '2026-09-16T08:00:00Z', ends_at: '2026-10-07T04:00:00Z', location: 'São João, Portugal', source_email_id: A, details: { guests: 2 } };
  const hit = findMatch(again, existing);
  assert.equal(hit.id, '1', 'the row from the same email wins');
  const viaB = { kind: 'hotel', provider: 'Airbnb', reference: null, starts_at: '2026-09-16T08:00:00Z', ends_at: '2026-10-07T04:00:00Z', source_email_id: 'mailC' };
  assert.ok(findMatch(viaB, existing), 'a third email about the stay still lands on it');
  const merged = mergeInto(again, stay1);
  assert.equal(merged.details.room, 'Entire home/flat, hosted by Sam', 'details learned earlier are kept');
  assert.equal(merged.details.guests, 2);
  const withRef = mergeInto({ ...again, reference: null }, stay3);
  assert.equal(withRef.reference, '4000000001', 'a reference is never lost');
});

test('two bookings from one email claim two rows', () => {
  const out = { id: 'o', kind: 'train', provider: 'Avanti', starts_at: '2026-10-01T07:00:00Z', source_email_id: 'rt' };
  const back = { id: 'b', kind: 'train', provider: 'Avanti', starts_at: '2026-10-01T18:00:00Z', source_email_id: 'rt' };
  const claimed = new Set();
  const h1 = findMatch({ ...out, id: undefined, starts_at: '2026-10-01T07:05:00Z' }, [out, back], claimed);
  assert.equal(h1.id, 'o'); claimed.add(h1.id);
  const h2 = findMatch({ ...back, id: undefined, starts_at: '2026-10-01T18:05:00Z' }, [out, back], claimed);
  assert.equal(h2.id, 'b');
});

test('existing duplicates merge down to the row with the reference', () => {
  const plan = mergePlan([stay1, stay2, stay3, stay4]);
  assert.deepEqual(plan.drop.sort(), ['1', '2', '4']);
  assert.equal(plan.keep.length, 1);
  assert.equal(plan.keep[0].id, '3');
  assert.equal(plan.keep[0].patch.reference, '4000000001');
  assert.equal(plan.keep[0].patch.details.check_in_url, 'https://airbnb.com/x', 'details from the dropped rows survive');
  assert.equal(plan.keep[0].patch.details.room, 'Entire home/flat, hosted by Sam');
  const none = mergePlan([stay3, { id: 'r', kind: 'car', provider: 'Bolt', reference: 'X1', starts_at: '2026-09-16T11:05:00Z', ends_at: '2026-09-16T11:30:00Z' }]);
  assert.deepEqual(none, { keep: [], drop: [] });
});

test('a flight booked through an agency is the tracked flight, not a second one', () => {
  // The agency's email gives its own order number; the airline's code is what the tracker keeps.
  const tracked = [{ ref: 'TST9QX', departs: Date.parse('2026-11-02T22:15:00+01:00') }];
  const agency = { kind: 'flight', provider: 'Example Air', reference: '100 200 300', starts_at: '2026-11-02T21:15:00.000Z' };
  assert.ok(isTrackedFlight(agency, tracked), 'same departure, different reference');
  assert.ok(isTrackedFlight({ kind: 'other', reference: 'tst9qx', starts_at: '2026-12-01T09:00:00Z' }, tracked), 'the airline code, however filed');
  assert.equal(isTrackedFlight({ ...agency, starts_at: '2026-11-03T09:00:00Z' }, tracked), false, 'the return leg is another flight');
  assert.equal(isTrackedFlight({ kind: 'hotel', provider: 'Example Inn', starts_at: '2026-11-02T21:15:00Z' }, tracked), false, 'a stay starting then is not the flight');
  assert.equal(isTrackedFlight(agency, []), false);
});

test('a flight booking with only its day is the tracked flight leaving that day', () => {
  // An agency's trip reminder gave the route and the day, never the time; kept at midnight, it showed as a second flight at 00:00.
  const tracked = [{ ref: 'QX7H2M', departs: Date.parse('2026-12-14T13:40:00+09:00'), day: '2026-12-14' }];
  const untimed = { kind: 'flight', provider: 'Example Trips', reference: '700 800 900', starts_at: '2026-12-14T00:00:00+09:00', timezone: 'Asia/Tokyo', details: { time_unknown: true } };
  assert.ok(isTrackedFlight(untimed, tracked), 'the reader said the time was not given');
  assert.ok(isTrackedFlight({ ...untimed, details: {}, starts_at: '2026-12-13T15:00:00.000Z' }, tracked), 'one stored before that, at midnight where it is');
  assert.equal(isTrackedFlight({ ...untimed, starts_at: '2026-12-15T00:00:00+09:00' }, tracked), false, 'another day is another flight');
  assert.equal(isTrackedFlight({ ...untimed, details: {}, starts_at: '2026-12-14T19:10:00+09:00' }, tracked), false, 'a flight with its own time later that day is another flight');
  assert.equal(isTrackedFlight({ ...untimed, kind: 'hotel' }, tracked), false, 'a stay that day is not the flight');
});

test('with no end time, a booking is over an hour in, an all-day one at the end of its day, a stay a day later', () => {
  const start = '2026-11-02T10:00:00+00:00', ms = Date.parse(start), hour = 3600000;
  assert.equal(noEndOver({ kind: 'restaurant', starts_at: start }), ms + hour);
  assert.equal(noEndOver({ kind: 'hotel', starts_at: start }), ms + 24 * hour);
  assert.equal(noEndOver({ kind: 'event', starts_at: start, timezone: 'Europe/London', details: { all_day: true } }), Date.parse('2026-11-03T00:00:00+00:00'), 'midnight where it is');
  assert.equal(noEndOver({ kind: 'event', starts_at: new Date(ms), details: {} }), ms + hour, 'a stored date works too');
  assert.equal(noEndOver({ kind: 'train', starts_at: '2026-11-02T00:00:00+00:00', timezone: 'Europe/London', details: { time_unknown: true } }), Date.parse('2026-11-03T00:00:00+00:00'), 'a day without its time lasts the day');
});

// A clinic's booking-page link was saved as a "Check in" link on every visit,
// and the token inside it as one visit's "Ref".
test('a reference is one the text gives, never the code inside a link, and a check-in link is only for checking in', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'bookings.js'), 'utf8');
  assert.match(src, /const srcWords = `\$\{src \? src\.subject : ""\} \$\{src \? src\.body : ""\}`\.replace\(\/https\?:\\\/\\\/\\S\+\/gi, " "\)/);
  assert.match(src, /if \(reference && !srcWords\.includes\(/);
  assert.match(src, /"check_in_url": "the link to check in online \(a flight's or hotel's online check-in\), or null; never a link that only shows or changes the booking"/);
});

test('a booking whose email gave only its day is the timed one at that place that day, and never takes its time', () => {
  // One clinic emailed the day of an appointment; another email gave its time. Kept apart, the day-only one showed as a second card.
  const dayOnly = { id: 'd1', kind: 'appointment', provider: 'Larkspur Dental Studio', reference: 'LD-4410', starts_at: '2026-12-02T00:00:00+09:00', timezone: 'Asia/Tokyo', source_email_id: 'mailC', updated_at: '2026-11-20T09:00:00Z', details: { time_unknown: true, notes: 'Bring your X-rays' } };
  const timed = { id: 't1', kind: 'appointment', provider: 'Larkspur Dental', reference: null, starts_at: '2026-12-02T11:00:00+09:00', timezone: 'Asia/Tokyo', source_email_id: 'mailD', updated_at: '2026-11-19T09:00:00Z', details: { room: '3' } };
  assert.ok(sameBooking(dayOnly, timed));
  assert.equal(sameBooking(dayOnly, { ...timed, starts_at: '2026-12-03T11:00:00+09:00' }), false, 'another day is another booking');
  assert.equal(sameBooking(dayOnly, { ...timed, provider: 'Harbourside Physio' }), false, 'another place is another booking');
  assert.equal(sameBooking({ ...dayOnly, details: {} }, { ...timed, starts_at: '2026-12-02T16:00:00+09:00' }), true, 'one stored before the reader said so, at midnight there');
  const plan = mergePlan([dayOnly, timed]);
  assert.deepEqual(plan.drop, ['d1'], 'the one with its time stays, though the other has the reference');
  assert.equal(plan.keep[0].id, 't1');
  assert.equal(plan.keep[0].patch.reference, 'LD-4410', 'and gains the reference');
  assert.equal(plan.keep[0].patch.details.time_unknown, undefined, 'and still shows its time');
  assert.equal(plan.keep[0].patch.details.notes, 'Bring your X-rays');
  // A later email giving only the day updates the timed row and keeps its time.
  const merged = mergeInto({ ...dayOnly, id: undefined }, timed);
  assert.equal(merged.starts_at, '2026-12-02T11:00:00+09:00');
  assert.equal(merged.details.time_unknown, undefined);
  assert.equal(mergeInto(timed, dayOnly).starts_at, '2026-12-02T11:00:00+09:00', 'and a time that arrives replaces the day alone');
  assert.equal(mergeInto(timed, dayOnly).details.time_unknown, undefined);
});

test('a reading that calls a timed booking all day never hides its time', () => {
  // A clinic's chat gave only the day and the reader called the visit all day; merged into the 11:00 booking, the card showed no time.
  const timed = { id: 't2', kind: 'appointment', provider: 'Larkspur Dental', starts_at: '2026-12-02T11:00:00+09:00', timezone: 'Asia/Tokyo', details: { room: '3' } };
  const dayOnly = { kind: 'appointment', provider: 'Larkspur Dental Studio', starts_at: '2026-12-02T00:00:00+09:00', timezone: 'Asia/Tokyo', details: { all_day: true, guests: 1 } };
  const merged = mergeInto(dayOnly, timed);
  assert.equal(merged.starts_at, '2026-12-02T11:00:00+09:00');
  assert.equal(merged.details.all_day, undefined, 'not all day: its time stands');
  assert.equal(merged.details.guests, 1, 'what the reading knew is kept');
  assert.equal(mergeInto(dayOnly, { ...timed, details: { all_day: true } }).details.all_day, true, 'one that was all day stays so');
  const card = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'webapp/views/dashboard.html'), 'utf8');
  assert.match(card, /var when = det\.time_unknown \|\| \(det\.all_day && at === '00:00'\) \? '' : at;/, 'and a card shows any time that is not midnight');
});
