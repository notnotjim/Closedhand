// Where an account stands with Closedhand Managed Models, as its computer and
// its account page are told (lib/addresses.js): its first month, a subscription,
// ended (it had one or the other and neither runs now), or none (it never
// had Managed Models; its own LLM provider is all it uses). Whether
// Closedhand's own email is offered here rides along, so the computer can say
// what the subscription includes. For a subscription, base is the key's use when this
// paid month began, so the computer counts this month's use from it (never
// shown; included-ai.js).
const LIVE = ['active', 'trialing', 'past_due'];

async function planFor(db, env, ownerId, now = new Date(), includedAi = null) {
  const email = env.ASSISTANT_EMAIL_ENABLED === '1' && env.ASSISTANT_EMAIL_RELEASED === '1';
  if (!ownerId) return { name: 'none', email };
  const sub = (await db.query(
    'SELECT status, current_period_start, current_period_end, cancel_at_period_end, extended_for, started_at FROM plus_subscriptions WHERE owner_id = $1', [ownerId])).rows[0];
  const key = (await db.query('SELECT ends_at, stopped_at, base_usd FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0];
  if (sub && LIVE.includes(sub.status)) {
    const until = sub.current_period_end ? new Date(sub.current_period_end).toISOString() : null;
    const month = sub.current_period_start ? new Date(sub.current_period_start).getTime() : null;
    return {
      name: 'plus',
      // Its free first month (Polar's trial), which ends on ends_at or renews_at.
      ...(sub.status === 'trialing' ? { trial: true } : {}),
      ...(until ? (sub.cancel_at_period_end ? { ends_at: until } : { renews_at: until }) : {}),
      extended: !!month && !!sub.extended_for && new Date(sub.extended_for).getTime() === month,
      base: Number(key?.base_usd) || 0,
      email,
    };
  }
  if (key && key.ends_at && !key.stopped_at && new Date(key.ends_at) > now) {
    return { name: 'first-month', ends_at: new Date(key.ends_at).toISOString(), email };
  }
  // What ended and when, so My Account can say "Your subscription ended on 27 November".
  const day = (d) => (d ? { ended_at: new Date(d).toISOString() } : {});
  if (sub?.started_at) return { name: 'ended', was: 'plus', ...day(sub.current_period_end), email };
  if (key) return { name: 'ended', was: 'first-month', ...day(key.ends_at), email };
  // Never had Managed Models: subscribing starts with the one free month,
  // unless this sign-in had it on an account before.
  const freeMonth = !sub && !(includedAi && await includedAi.hadFreeMonth(ownerId));
  return { name: 'none', email, ...(freeMonth ? { plus_trial: true } : {}) };
}

module.exports = { planFor, LIVE };
