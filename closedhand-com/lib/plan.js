// Where an account stands with Closedhand Managed Models, as its computer and
// its account page are told (lib/addresses.js): its free 14 days, a
// subscription (renewing every month, or every 6 or 12), paid ahead in crypto
// (a plan until a day), ended (it had one of them and none runs now), none (it
// never had Managed Models; its own LLM provider is all it uses), or the
// maintainer's own (no charge, a month of fair use renewing on the 1st). Each
// running plan but the free days says when this month's fair use renews, when
// another month of it is to come (fair_use_renews_at), and whether this month
// was carried on past it. Whether Closedhand's own email is offered here rides
// along, so the computer can say what the subscription includes.
const LIVE = ['active', 'trialing', 'past_due'];
const { monthIn, fairUseMonth } = require('./months');

async function planFor(db, env, ownerId, now = new Date(), includedAi = null) {
  const email = env.ASSISTANT_EMAIL_ENABLED === '1' && env.ASSISTANT_EMAIL_RELEASED === '1';
  if (!ownerId) return { name: 'none', email };
  // The maintainer's own account has Managed Models with no charge, whatever
  // Polar says (lib/maintainer.js): a month of fair use, renewing on the 1st.
  if (await require('./maintainer').isMaintainer(db, env, ownerId)) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    return { name: 'maintainer', renews_at: first, fair_use_renews_at: first, email };
  }
  const sub = (await db.query(
    'SELECT status, current_period_start, current_period_end, cancel_at_period_end, extended_for, started_at, every_months FROM plus_subscriptions WHERE owner_id = $1', [ownerId])).rows[0];
  const key = (await db.query('SELECT ends_at, stopped_at FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
  if (sub && LIVE.includes(sub.status)) {
    const until = sub.current_period_end ? new Date(sub.current_period_end).toISOString() : null;
    const month = fairUseMonth(sub, now);
    // The next month of fair use: within the period paid, or the renewal
    // that begins the next period, unless cancelled.
    const end = sub.current_period_end ? new Date(sub.current_period_end) : null;
    const next = month?.next && end && month.next < end ? month.next : !sub.cancel_at_period_end ? end : null;
    return {
      name: 'plus',
      ...(Number(sub.every_months) > 1 ? { every: Number(sub.every_months) } : {}),
      // Its free first month (Polar's trial), which ends on ends_at or renews_at.
      ...(sub.status === 'trialing' ? { trial: true } : {}),
      ...(until ? (sub.cancel_at_period_end ? { ends_at: until } : { renews_at: until }) : {}),
      ...(next ? { fair_use_renews_at: next.toISOString() } : {}),
      extended: !!month && !!sub.extended_for && new Date(sub.extended_for).getTime() === month.from.getTime(),
      email,
    };
  }
  const ahead = (await db.query('SELECT starts_at, ends_at, ended_at, extended_for FROM ahead_plans WHERE owner_id = $1', [ownerId])).rows[0];
  if (ahead && !ahead.ended_at && new Date(ahead.starts_at) <= now && new Date(ahead.ends_at) > now) {
    const month = monthIn(ahead.starts_at, now);
    return {
      name: 'ahead',
      ends_at: new Date(ahead.ends_at).toISOString(),
      ...(month.next < new Date(ahead.ends_at) ? { fair_use_renews_at: month.next.toISOString() } : {}),
      extended: !!ahead.extended_for && new Date(ahead.extended_for).getTime() === month.from.getTime(),
      email,
    };
  }
  if (key && key.ends_at && !key.stopped_at && new Date(key.ends_at) > now) {
    return { name: 'first-month', ends_at: new Date(key.ends_at).toISOString(), email };
  }
  // What ended and when, so My Account can say "Your subscription ended on 27 November".
  const day = (d) => (d ? { ended_at: new Date(d).toISOString() } : {});
  // The latest to end says what ended: a plan paid ahead, or a subscription.
  const aheadEnd = ahead ? new Date(ahead.ends_at).getTime() : 0, subEnd = sub?.started_at ? new Date(sub.current_period_end || 0).getTime() : -1;
  if (ahead && aheadEnd >= subEnd) return { name: 'ended', was: 'ahead', ...day(ahead.ends_at), email };
  if (sub?.started_at) return { name: 'ended', was: 'plus', ...day(sub.current_period_end), email };
  if (key) return { name: 'ended', was: 'first-month', ...day(key.ends_at), email };
  // Never had Managed Models: subscribing starts with the one free month,
  // unless this sign-in had it on an account before.
  const freeMonth = !sub && !(includedAi && await includedAi.hadFreeMonth(ownerId));
  return { name: 'none', email, ...(freeMonth ? { plus_trial: true } : {}) };
}

module.exports = { planFor, LIVE };
