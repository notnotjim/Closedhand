// What the maintainer is told, in time to raise a limit before anyone is
// refused (lib/operator-notices.js says where). Nothing here stops anything:
// free days keep being given past the expected number. The credit of
// closedhand.com's organisation at NEAR AI is the stop for spending, shown on
// the insights page with the days it lasts. Each threshold is told once per period
// (operator_alerts).
//
// - Free days started this calendar month, against
//   INCLUDED_AI_MONTHLY_PEOPLE: at 75%, 90% and 100%, then every further 25%.
// - Free days started in the last 24 hours reaching
//   INCLUDED_AI_DAILY_PEOPLE: once a UTC day, as a burst worth a look.
// - Accounts made with an account number in the last 24 hours reaching
//   ANONYMOUS_DAILY_ACCOUNTS: once a UTC day, as a burst worth a look.
// - Personal URLs taken, against ADDRESS_LIMIT: at 75%, 90% and 100%, told
//   again once the limit is raised. Past it nobody new can claim one.
// - The credit the uncensored LLM draws on at their provider (NEAR's spend limit
//   included): when it lasts 14 days and then 7 at the last 30 days' pace,
//   and when it is less than one free period's ceiling (INCLUDED_AI_TRIAL_USD).
//   Each is told again only after the credit has been topped up.
// The thresholds a share has reached: the fixed ones, then every 25% past 100.
function reached(share, fixed, every = 0) {
  const levels = fixed.filter(level => share >= level);
  if (every) for (let level = 100 + every; level <= share; level += every) levels.push(level);
  return levels;
}

function create({ db, env = process.env, notices, includedAi = null }) {
  const monthlyPeople = Number(env.INCLUDED_AI_MONTHLY_PEOPLE || 100);
  const dailyPeople = Number(env.INCLUDED_AI_DAILY_PEOPLE || 25);
  const urlLimit = Number.parseInt(env.ADDRESS_LIMIT || '100', 10);
  const dailyAnonymous = Number(env.ANONYMOUS_DAILY_ACCOUNTS || 10);

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
      told.push(`Closedhand: ${started} people have started their 14 free days of the uncensored LLM this month, against the ${monthlyPeople} expected. If more people are coming, raise the number expected each month.`);
    }
    if (dailyPeople > 0 && lastDay >= dailyPeople && await claim('burst', day, [100])) {
      told.push(`Closedhand: ${lastDay} people started their 14 free days of the uncensored LLM in the last 24 hours, more than usual. Worth a look for account farming.`);
    }
    const anonymous = Number((await db.query("SELECT count(*)::int AS n FROM owners WHERE provider = 'anonymous' AND created_at >= $1::timestamptz - interval '1 day'", [now])).rows[0].n);
    if (dailyAnonymous > 0 && anonymous >= dailyAnonymous && await claim('anonymous-burst', day, [100])) {
      told.push(`Closedhand: ${anonymous} accounts were made with an account number in the last 24 hours, more than usual. Worth a look for account farming.`);
    }
    // The credit every key draws on: when it runs out, every free period and
    // every subscription stops at once.
    const credit = includedAi?.enabled() ? await includedAi.credit(now).catch(e => { console.error('[capacity] credit unavailable:', e.message); return null; }) : null;
    if (credit) {
      const trialUsd = Number(includedAi.trialUsd || env.INCLUDED_AI_TRIAL_USD || 12);
      const days = credit.days == null ? Infinity : credit.days;
      if (days > 14 && credit.left >= trialUsd) await db.query("DELETE FROM operator_alerts WHERE kind = 'provider-credit'");
      const left = '$' + Math.max(0, credit.left).toFixed(2);
      if (credit.left < trialUsd && await claim('provider-credit', 'until-topped-up', [1])) {
        told.push(`Closedhand: the ${includedAi.label} credit the uncensored LLM draws on is down to ${left}, less than one person's free days can use. When it runs out, every free period and every subscription stops at once. ${includedAi.topUp}.`);
      } else if (days <= 14 && await claim('provider-credit', 'until-topped-up', days <= 7 ? [14, 7] : [14])) {
        told.push(`Closedhand: the ${includedAi.label} credit the uncensored LLM draws on lasts about ${days} more ${days === 1 ? 'day' : 'days'} at the last 30 days' pace (${left} left). When it runs out, every free period and every subscription stops at once. ${includedAi.topUp}.`);
      }
    }
    // Counted as the limit counts them (lib/addresses.js): working ones and
    // fresh reservations.
    const taken = Number((await db.query(
      "SELECT count(*)::int AS n FROM addresses WHERE activated_at IS NOT NULL OR created_at > now() - interval '24 hours'")).rows[0].n);
    if (urlLimit > 0 && await claim('personal-urls', 'limit-' + urlLimit, reached(taken / urlLimit * 100, [75, 90, 100]))) {
      told.push(`Closedhand: ${taken} of ${urlLimit} personal URLs are taken. Past ${urlLimit} nobody new can claim one, so raise the limit if more people are coming.`);
    }
    for (const text of told) await notices.queue(text);
    return told;
  }

  return { check };
}

module.exports = { create, reached };
