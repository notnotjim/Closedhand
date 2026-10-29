// What the maintainer is told, in time to raise a limit before anyone is
// refused (lib/operator-notices.js says where). Nothing here stops anything:
// first months keep being given past the expected number. OpenRouter's own
// budget and credit are the stop for spending, and OpenRouter emails its
// low-balance alert itself. Each threshold is told once per period
// (operator_alerts).
//
// - First months started this calendar month, against
//   INCLUDED_AI_MONTHLY_PEOPLE: at 75%, 90% and 100%, then every further 25%.
// - First months started in the last 24 hours reaching
//   INCLUDED_AI_DAILY_PEOPLE: once a UTC day, as a burst worth a look.
// - Personal URLs taken, against ADDRESS_LIMIT: at 75%, 90% and 100%, told
//   again once the limit is raised. Past it nobody new can claim one.
// The thresholds a share has reached: the fixed ones, then every 25% past 100.
function reached(share, fixed, every = 0) {
  const levels = fixed.filter(level => share >= level);
  if (every) for (let level = 100 + every; level <= share; level += every) levels.push(level);
  return levels;
}

function create({ db, env = process.env, notices }) {
  const monthlyPeople = Number(env.INCLUDED_AI_MONTHLY_PEOPLE || 100);
  const dailyPeople = Number(env.INCLUDED_AI_DAILY_PEOPLE || 25);
  const urlLimit = Number.parseInt(env.ADDRESS_LIMIT || '100', 10);

  // Claims the levels not yet told for this period; true when any was new, so
  // one notice says where things stand rather than one per level passed.
  async function claim(kind, period, levels) {
    let fresh = false;
    for (const level of levels) {
      const made = await db.query(
        'INSERT INTO operator_alerts (kind, period, level) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING level', [kind, period, level]);
      if (made.rowCount) fresh = true;
    }
    return fresh;
  }

  // Run hourly. Returns the notices queued, for the log and the tests.
  async function check(now = new Date()) {
    const told = [];
    const month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
    const counts = (await db.query(
      `SELECT count(*) FILTER (WHERE granted_at >= date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS month,
              count(*) FILTER (WHERE granted_at >= $1::timestamptz - interval '1 day') AS day
         FROM starter_grants WHERE granted_at >= LEAST($1::timestamptz - interval '1 day', date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      [now])).rows[0];
    const started = Number(counts.month), lastDay = Number(counts.day);
    if (monthlyPeople > 0 && await claim('first-months', month, reached(started / monthlyPeople * 100, [75, 90, 100], 25))) {
      told.push(`Closedhand: ${started} of this month's ${monthlyPeople} first months of Managed Models are taken. Raise INCLUDED_AI_MONTHLY_PEOPLE on Railway if more people are coming.`);
    }
    if (dailyPeople > 0 && lastDay >= dailyPeople && await claim('burst', day, [100])) {
      told.push(`Closedhand: ${lastDay} first months of Managed Models started in the last 24 hours, more than usual. Worth a look for account farming.`);
    }
    // Counted as the limit counts them (lib/addresses.js): working ones and
    // fresh reservations.
    const taken = Number((await db.query(
      "SELECT count(*)::int AS n FROM addresses WHERE state <> 'revoked' AND (activated_at IS NOT NULL OR created_at > now() - interval '24 hours')")).rows[0].n);
    if (urlLimit > 0 && await claim('personal-urls', 'limit-' + urlLimit, reached(taken / urlLimit * 100, [75, 90, 100]))) {
      told.push(`Closedhand: ${taken} of ${urlLimit} personal URLs are taken. Past ${urlLimit} nobody new can claim one; raise ADDRESS_LIMIT on Railway if more people are coming.`);
    }
    for (const text of told) await notices.queue(text);
    return told;
  }

  return { check };
}

module.exports = { create, reached };
