// The maintainer's notices (lib/capacity.js, lib/operator-notices.js), where an
// account stands with Closedhand Managed Models (lib/plan.js), and the subscription's
// email allowances (migration 014), against a real Postgres, in a database of
// its own so it can run beside e2e.js, which empties its own as it starts.
// Invented people only.
// Run: DATABASE_URL=postgres://... node --test closedhand-com/test/capacity.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../lib/db');
const capacity = require('../lib/capacity');
const notices = require('../lib/operator-notices');
const { planFor } = require('../lib/plan');
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || require('node:crypto').randomBytes(32).toString('base64');

const NAME = 'closedhand_capacity_test';
let admin, db;
before(async () => {
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin.query(`CREATE DATABASE ${NAME}`);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + NAME;
  db = new Pool({ connectionString: url.toString() });
  await migrate(db);
});
after(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin?.end();
});

let people = 0;
async function person(email = `person${++people}@example.com`, verified = true) {
  return (await db.query("INSERT INTO owners (provider, subject, email, email_verified) VALUES ($3, $1, $2, $4) RETURNING id",
    ['cap-' + (++people), email, verified ? 'google' : 'microsoft', verified])).rows[0].id;
}
const started = (n, at = new Date()) => Promise.all(Array.from({ length: n }, () =>
  db.query('INSERT INTO starter_grants (person_hash, granted_usd, granted_at) VALUES ($1, 20, $2)', [crypto.randomBytes(16).toString('hex'), at])));
const fresh = async () => { await db.query('TRUNCATE starter_grants, operator_alerts, operator_notices'); };

test('free days past the expected number are told at 75%, 90%, 100%, then every 25%, and never stop anyone', async () => {
  await fresh();
  const queued = notices.create({ db, env: {} });
  const watch = capacity.create({ db, env: { INCLUDED_AI_MONTHLY_PEOPLE: '8', INCLUDED_AI_DAILY_PEOPLE: '1000' }, notices: queued });
  await started(5);
  assert.deepEqual(await watch.check(), [], 'under 75%');
  await started(1);
  assert.deepEqual(await watch.check(), ["Closedhand: 6 people have started their free days of Managed Models this month, against the 8 expected. Raise INCLUDED_AI_MONTHLY_PEOPLE on Railway if more people are coming."]);
  assert.deepEqual(await watch.check(), [], 'told once');
  await started(4);
  assert.deepEqual(await watch.check(), ["Closedhand: 10 people have started their free days of Managed Models this month, against the 8 expected. Raise INCLUDED_AI_MONTHLY_PEOPLE on Railway if more people are coming."], 'one notice for 90%, 100% and 125% passed at once');
  assert.equal((await db.query("SELECT count(*) AS n FROM operator_alerts WHERE kind = 'first-months'")).rows[0].n, '4');
  await started(1, new Date(Date.UTC(2020, 0, 15)));
  assert.deepEqual(await watch.check(), [], 'another month counts apart');
  assert.equal((await db.query('SELECT count(*) AS n FROM operator_notices')).rows[0].n, '2');
});

test('a burst of free days in a day is told once that day', async () => {
  await fresh();
  const watch = capacity.create({ db, env: { INCLUDED_AI_MONTHLY_PEOPLE: '1000', INCLUDED_AI_DAILY_PEOPLE: '3' }, notices: notices.create({ db, env: {} }) });
  await started(2);
  assert.deepEqual(await watch.check(), []);
  await started(1);
  assert.deepEqual(await watch.check(), ['Closedhand: 3 people started their free days of Managed Models in the last 24 hours, more than usual. Worth a look for account farming.']);
  await started(5);
  assert.deepEqual(await watch.check(), [], 'once a day');
});

test('notices go to the maintainer\'s own Closedhand once, and by email when it has not collected them in a day', async () => {
  await fresh();
  const operator = await person('Maintainer@Example.com'), someone = await person();
  const sent = [];
  const request = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return new Response('{}'); };
  const env = { OPERATOR_EMAILS: 'someone-else@example.com, maintainer@example.com', ASSISTANT_EMAIL_OPERATOR: 'alerts@example.com',
    MAIL_SES_REGION: 'eu-west-2', MAIL_FROM: 'Closedhand <hello@example.com>', MAIL_AWS_ACCESS_KEY_ID: 'AKIAFIXTURE', MAIL_AWS_SECRET_ACCESS_KEY: 'fixture' };
  const box = notices.create({ db, env, request });
  await box.queue('First notice');
  await box.queue('Second notice');
  assert.deepEqual(await box.collect(someone), [], 'nobody else gets them');
  const lookalike = await person('maintainer@example.com', false);
  assert.deepEqual(await box.collect(lookalike), [], 'nor a sign-in carrying the address unverified');
  const got = await box.collect(operator);
  assert.deepEqual(got.map(n => n.text), ['First notice', 'Second notice']);
  assert.deepEqual(await box.collect(operator), [], 'each once');
  assert.deepEqual(await notices.create({ db, env: {} }).collect(operator), [], 'no OPERATOR_EMAILS, no notices');

  await box.queue('Waiting a day');
  await db.query("UPDATE operator_notices SET created_at = now() - interval '25 hours' WHERE text = 'Waiting a day'");
  assert.equal(await box.emailStale(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://email.eu-west-2.amazonaws.com/v2/email/outbound-emails');
  assert.deepEqual(sent[0].body.Destination, { ToAddresses: ['alerts@example.com'] });
  assert.equal(sent[0].body.Content.Simple.Body.Text.Data, 'Waiting a day');
  assert.equal(await box.emailStale(), 0, 'emailed once');
  assert.deepEqual(await box.collect(operator), [], 'not said again in chat once emailed');
  assert.equal(await notices.create({ db, env: { ...env, MAIL_FROM: '' }, request }).emailStale(), 0, 'no sender, no email');
});

test('the plan says where an account stands: free days, subscribed, ended or none, and when this month\'s fair use renews', async () => {
  const env = { ASSISTANT_EMAIL_ENABLED: '1', ASSISTANT_EMAIL_RELEASED: '1' };
  const now = new Date('2026-11-10T12:00:00Z');
  const none = await person(), first = await person(), over = await person(), plus = await person(), leaving = await person();
  assert.deepEqual(await planFor(db, {}, none, now), { name: 'none', email: false, plus_trial: true }, 'never had Managed Models: a subscription would start with the free days');
  await db.query("INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, ends_at) VALUES ($1, $2, 20, '2026-11-20T00:00:00Z')", [first, crypto.randomBytes(32).toString('hex')]);
  assert.deepEqual(await planFor(db, env, first, now), { name: 'first-month', ends_at: '2026-11-20T00:00:00.000Z', email: true }, 'in the free days: none to come');
  await db.query("INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, ends_at) VALUES ($1, $2, 20, '2026-11-01T00:00:00Z')", [over, crypto.randomBytes(32).toString('hex')]);
  assert.equal((await planFor(db, env, over, now)).name, 'ended');
  await db.query("INSERT INTO plus_subscriptions (owner_id, polar_subscription_id, status, current_period_start, current_period_end, extended_for, started_at) VALUES ($1, 'sub_a', 'active', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', '2026-11-01T00:00:00Z', now())", [plus]);
  await db.query("INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, base_usd) VALUES ($1, $2, 0, 12.5)", [plus, crypto.randomBytes(32).toString('hex')]);
  assert.deepEqual(await planFor(db, env, plus, now), { name: 'plus', renews_at: '2026-12-01T00:00:00.000Z', fair_use_renews_at: '2026-12-01T00:00:00.000Z', extended: true, email: true }, 'carried on in this paid month');
  await db.query("INSERT INTO plus_subscriptions (owner_id, polar_subscription_id, status, current_period_end, cancel_at_period_end, started_at) VALUES ($1, 'sub_b', 'active', '2026-12-01T00:00:00Z', true, now())", [leaving]);
  assert.deepEqual(await planFor(db, env, leaving, now), { name: 'plus', ends_at: '2026-12-01T00:00:00.000Z', extended: false, email: true }, 'cancelled: no more fair use to come');
  // Every 6 months: the fair use renews each month of the period, and the
  // last month of a cancelled one has none to come.
  const six = await person(), sixEnding = await person();
  await db.query("INSERT INTO plus_subscriptions (owner_id, polar_subscription_id, status, current_period_start, current_period_end, every_months, extended_for, started_at) VALUES ($1, 'sub_six', 'active', '2026-09-15T00:00:00Z', '2027-03-15T00:00:00Z', 6, '2026-09-15T00:00:00Z', now())", [six]);
  assert.deepEqual(await planFor(db, env, six, now), { name: 'plus', every: 6, renews_at: '2027-03-15T00:00:00.000Z', fair_use_renews_at: '2026-11-15T00:00:00.000Z', extended: false, email: true },
    'in its second month, renewing on the 15th; carried on in its first month, not this one');
  await db.query("INSERT INTO plus_subscriptions (owner_id, polar_subscription_id, status, current_period_start, current_period_end, every_months, cancel_at_period_end, started_at) VALUES ($1, 'sub_six_b', 'active', '2026-05-20T00:00:00Z', '2026-11-20T00:00:00Z', 6, true, now())", [sixEnding]);
  assert.deepEqual(await planFor(db, env, sixEnding, now), { name: 'plus', every: 6, ends_at: '2026-11-20T00:00:00.000Z', extended: false, email: true });
  await db.query('UPDATE plus_subscriptions SET cancel_at_period_end = false WHERE owner_id = $1', [sixEnding]);
  assert.equal((await planFor(db, env, sixEnding, now)).fair_use_renews_at, '2026-11-20T00:00:00.000Z', 'renewing: the next period begins the next month');
  await db.query("UPDATE plus_subscriptions SET status = 'canceled' WHERE owner_id = $1", [leaving]);
  assert.equal((await planFor(db, env, leaving, now)).name, 'ended', 'an ended subscription without a key');
  const boss = await person('Boss@Example.com');
  const maintained = { ...env, OPERATOR_EMAILS: 'boss@example.com' };
  assert.deepEqual(await planFor(db, maintained, boss, now), { name: 'maintainer', renews_at: '2026-12-01T00:00:00.000Z', fair_use_renews_at: '2026-12-01T00:00:00.000Z', email: true },
    'the maintainer\'s own account: no charge, a month of fair use renewing on the first');
  await db.query("INSERT INTO plus_subscriptions (owner_id, polar_subscription_id, status, current_period_end, cancel_at_period_end, started_at) VALUES ($1, 'sub_boss', 'active', '2026-11-27T00:00:00Z', true, now())", [boss]);
  assert.equal((await planFor(db, maintained, boss, now)).name, 'maintainer', 'whatever Polar says');
  assert.equal((await planFor(db, maintained, none, now)).name, 'none', 'nobody else');
});

test('Closedhand\'s email address works only while Managed Models are the account\'s, with no monthly allowance; a daily guard stays', async () => {
  const reserve = async (account, direction) => (await db.query(
    "SELECT * FROM reserve_mail_relay_usage($1, $2, $3, 1, 1000)", [crypto.randomUUID(), account, direction])).rows[0];
  const mailbox = async (ownerId, email) => {
    const id = crypto.randomUUID();
    await db.query("INSERT INTO mail_relay_accounts (id, owner_id, secret_hash, public_key, address, owner_email) VALUES ($1, $2, 'h', 'k', $3, $4)",
      [id, ownerId, `fixture-${id.slice(0, 8)}@closedhand.ai`, email]);
    return id;
  };
  // What an address has sent this month and today, as the function counts it.
  const owner = email => crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  const month = new Date().toISOString().slice(0, 7) + '-01', today = new Date().toISOString().slice(0, 10);
  const sentThisMonth = (email, sent) => db.query(
    'INSERT INTO mail_relay_usage (owner_key, period, sent) VALUES ($1, $2, $3) ON CONFLICT (owner_key, period) DO UPDATE SET sent = EXCLUDED.sent', [owner(email), month, sent]);
  const sentToday = (email, sent) => db.query(
    'INSERT INTO mail_relay_usage (owner_key, period, sent) VALUES ($1, $2, $3) ON CONFLICT (owner_key, period) DO UPDATE SET sent = EXCLUDED.sent', [owner(email) + ':daily', today, sent]);

  const off = "Closedhand's email address sends and receives mail only with Closedhand Managed Models, which this account doesn't have right now.";
  const noneEmail = `none${people}@example.com`, freeEmail = `free${people}@example.com`, overEmail = `over${people}@example.com`, plusEmail = `plus${people}@example.com`;
  const none = await mailbox(await person(noneEmail), noneEmail);
  const freeOwner = await person(freeEmail), free = await mailbox(freeOwner, freeEmail);
  await db.query("INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, ends_at) VALUES ($1, $2, 12, now() + interval '5 days')", [freeOwner, hex()]);
  const overOwner = await person(overEmail), over = await mailbox(overOwner, overEmail);
  await db.query("INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, ends_at, stopped_at) VALUES ($1, $2, 12, now() - interval '1 day', now())", [overOwner, hex()]);
  const subscriberOwner = await person(plusEmail);
  const subscriber = await mailbox(subscriberOwner, plusEmail);
  await db.query("INSERT INTO plus_subscriptions (owner_id, polar_subscription_id, status, started_at) VALUES ($1, 'sub_mail', 'active', now())", [subscriberOwner]);
  assert.deepEqual(await reserve(none, 'out'), { allowed: false, reason: off }, 'never had Managed Models: nothing is sent');
  assert.deepEqual(await reserve(none, 'in'), { allowed: false, reason: off }, 'nor received, with one plain line');
  assert.deepEqual(await reserve(over, 'in'), { allowed: false, reason: off }, 'free days over');
  await sentThisMonth(freeEmail, 5000);
  assert.deepEqual(await reserve(free, 'out'), { allowed: true, reason: null }, 'in the free days, no monthly allowance');
  await sentThisMonth(plusEmail, 5000);
  assert.deepEqual(await reserve(subscriber, 'out'), { allowed: true, reason: null }, 'with a subscription, none either');
  await sentToday(plusEmail, 1000);
  assert.deepEqual(await reserve(subscriber, 'out'), { allowed: false, reason: 'Your daily email allowance has been reached. It resets at midnight UTC.' }, 'the daily guard stays');
  // The maintainer's own Managed Models count like any other: no end, never free days.
  const bossEmail = `boss${people}@example.com`, bossOwner = await person(bossEmail), boss = await mailbox(bossOwner, bossEmail);
  await db.query("INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, base_usd, base_for, maintainer) VALUES ($1, $2, 0, 0, date_trunc('month', now()), true)", [bossOwner, hex()]);
  assert.deepEqual(await reserve(boss, 'out'), { allowed: true, reason: null }, 'mail through the maintainer\'s Managed Models');
});

// Personal URLs taken, as the limit counts them (working, or reserved today).
async function urls(n, owner) {
  for (let i = 0; i < n; i++) {
    await db.query("INSERT INTO addresses (id, owner_id, secret_hash, hostname, state, activated_at) VALUES ($1, $2, $3, $4, 'active', now())",
      [crypto.randomUUID(), owner || await person(), crypto.randomBytes(32).toString('hex'), `cap-${crypto.randomBytes(4).toString('hex')}.closedhand.ai`]);
  }
}

test('personal URLs nearing the limit are told at 75%, 90% and 100%, and again once the limit is raised', async () => {
  await fresh();
  await db.query('DELETE FROM addresses');
  const queued = notices.create({ db, env: {} });
  const watch = limit => capacity.create({ db, env: { ADDRESS_LIMIT: String(limit), INCLUDED_AI_DAILY_PEOPLE: '1000' }, notices: queued });
  await urls(2);
  assert.deepEqual(await watch(4).check(), [], 'half taken: nothing to say');
  await urls(1);
  assert.deepEqual(await watch(4).check(), ['Closedhand: 3 of 4 personal URLs are taken. Past 4 nobody new can claim one; raise ADDRESS_LIMIT on Railway if more people are coming.']);
  assert.deepEqual(await watch(4).check(), [], 'told once');
  await urls(1);
  assert.equal((await watch(4).check()).length, 1, 'full');
  assert.equal((await watch(5).check()).length, 1, 'raised: the new limit is told in its own right, 80% of it');
  assert.deepEqual(await watch(5).check(), []);
  await urls(1);
  assert.equal((await watch(5).check()).length, 1, 'full again');
  await db.query('DELETE FROM addresses');
});

// Possible misuse (lib/misuse.js), with NEAR AI's keys, its spend and its LLM stood in.
function misuseWorld(keys, answer = 'A household on one connection, probably harmless.', env = {}, spent = 0) {
  const asked = [];
  const includedAi = { enabled: () => true, allKeys: async () => keys, spentThisMonth: async () => spent,
    forOperator: async () => ({ key: 'sk-operator', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated', base: 'https://cloud-api.near.ai/v1' }) };
  const request = async (url, opts) => {
    assert.equal(url, 'https://cloud-api.near.ai/v1/chat/completions');
    asked.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status: 200 });
  };
  return { asked, misuse: require('../lib/misuse').create({ db, env: { INCLUDED_AI_PER_CONNECTION: '3', ...env }, includedAi, request }) };
}
const hex = () => crypto.randomBytes(32).toString('hex');

test('possible misuse: nothing to report shows nothing and asks no LLM', async () => {
  await fresh();
  await db.query('DELETE FROM included_ai_keys; DELETE FROM retired_ai_keys; DELETE FROM addresses');
  const { asked, misuse } = misuseWorld([]);
  assert.deepEqual(await misuse.report(), { signs: [], mine: [], summary: null });
  assert.equal(asked.length, 0);
});

// Spend so far over how much of the month has gone: one test with fixed days,
// since any fixed spend is on pace past a budget early enough in a month.
test('possible misuse: spend on pace past the monthly budget is named, by how far into the month it is', async () => {
  await fresh();
  await db.query('DELETE FROM included_ai_keys; DELETE FROM retired_ai_keys; DELETE FROM addresses; DELETE FROM starter_grants');
  const { misuse } = misuseWorld([{ id: hex(), name: 'Closedhand insights', limit: 100, usage: 40 }], undefined, { INCLUDED_AI_MONTHLY_BUDGET_USD: '100' }, 40);
  assert.deepEqual((await misuse.report(new Date(Date.UTC(2026, 10, 10)))).signs, ['NEAR AI spend is $40.00 so far this month, on pace for $133.33 against the $100.00 budget.']);
  assert.deepEqual((await misuse.report(new Date(Date.UTC(2026, 10, 20)))).signs, [], 'not past it later in the month');
});

test('possible misuse: fast use, unused first months, full connections and loose keys are named, and an LLM sums them up without emails', async () => {
  await fresh();
  await db.query('DELETE FROM included_ai_keys; DELETE FROM retired_ai_keys; DELETE FROM addresses');
  const now = new Date();
  // fast: $15 of $20 two days into its first month, from a personal URL that is online.
  const fast = await person('fast@example.com'), fastKey = hex();
  await urls(1, fast);
  await db.query("UPDATE addresses SET hostname = 'amber-lake-12.closedhand.ai', last_seen_at = now() WHERE owner_id = $1", [fast]);
  await db.query("INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, granted_at, ends_at) VALUES ($1, $2, 20, now() - interval '2 days', now() + interval '28 days')", [fast, fastKey]);
  // slow: $3 of $20 in ten days; never flagged.
  const slow = await person(), slowKey = hex();
  await urls(1, slow);
  await db.query('UPDATE addresses SET last_seen_at = now() WHERE owner_id = $1', [slow]);
  await db.query("INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, granted_at) VALUES ($1, $2, 20, now() - interval '10 days')", [slow, slowKey]);
  // idle: a first month a day old whose personal URL never came online.
  const idle = await person(), idleKey = hex();
  await db.query("INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, granted_at) VALUES ($1, $2, 20, now() - interval '1 day')", [idle, idleKey]);
  // Three first months from one connection.
  for (let i = 0; i < 3; i++) await db.query("INSERT INTO starter_grants (person_hash, network_hash, granted_usd, granted_at) VALUES ($1, 'net-1', 20, now() - interval '1 day')", [hex()]);
  // A replaced key waiting to be deleted is not loose; one nobody holds is.
  const waiting = hex(), loose = hex();
  await db.query('INSERT INTO retired_ai_keys (key_id, tries) VALUES ($1, 4)', [waiting]);
  // A subscriber two days into a paid month whose key had used $10 before it:
  // $16 of this month's $20 is fast too.
  const paid = await person(), paidKey = hex();
  await urls(1, paid);
  await db.query("UPDATE addresses SET hostname = 'quiet-fern-40.closedhand.ai', last_seen_at = now() WHERE owner_id = $1", [paid]);
  await db.query("INSERT INTO plus_subscriptions (owner_id, polar_subscription_id, status, started_at) VALUES ($1, 'sub_fast', 'active', now())", [paid]);
  await db.query("INSERT INTO included_ai_keys (owner_id, key_id, granted_usd, base_usd, base_for) VALUES ($1, $2, 0, 10, now() - interval '2 days')", [paid, paidKey]);
  const keys = [
    { id: fastKey, name: 'Closedhand ' + fast, limit: 20, usage: 15 },
    { id: slowKey, name: 'Closedhand ' + slow, limit: 20, usage: 3 },
    { id: idleKey, name: 'Closedhand ' + idle, limit: 20, usage: 0 },
    { id: paidKey, name: 'Closedhand ' + paid, limit: 30, usage: 26 },
    { id: waiting, name: 'Closedhand ' + crypto.randomUUID(), limit: 5, usage: 1 },
    { id: loose, name: 'Closedhand ' + crypto.randomUUID(), limit: 20, usage: 4.5 },
    { id: hex(), name: 'Closedhand insights', limit: 1, usage: 0.01 },
  ];
  // amber-lake-12 is the maintainer's own account here (OPERATOR_EMAILS): marked, and the LLM is told.
  const { asked, misuse } = misuseWorld(keys, 'One connection has had three first months \u2014 maybe a household.', { OPERATOR_EMAILS: 'Fast@example.com' });
  const got = await misuse.report(now);
  assert.deepEqual(got.signs, [
    '1 NEAR AI key is live that no account holds, with $4.50 used.',
    'amber-lake-12 has used 75% of its free days ($15.00) in 2 days.',
    "quiet-fern-40 has used 80% of this month's subscription fair use ($16.00) in 2 days.",
    `account ${idle.slice(0, 8)} got free days, but its personal URL has never come online.`,
    '1 internet connection has reached the most free days one connection may have (3 in 30 days).',
    '1 replaced or deleted key has not been deleted at NEAR AI after 3 tries.',
  ]);
  assert.deepEqual(got.mine, [false, true, false, false, false, false], 'only the maintainer\'s own account is marked');
  assert.match(asked[0].messages[1].content, /amber-lake-12 has used 75% of its free days \(\$15\.00\) in 2 days\. \(This is your own account\.\)/);
  assert.equal(got.summary, 'One connection has had three first months, maybe a household.', 'no dashes');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].model, 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated');
  assert.deepEqual(asked[0].chat_template_kwargs, { enable_thinking: false }, 'a short answer, without thinking');
  assert.doesNotMatch(JSON.stringify(asked[0]), /@example\.com/, 'never an email');
  await misuse.report(now);
  assert.equal(asked.length, 1, 'the same signs are summed up once');
  await db.query('DELETE FROM included_ai_keys; DELETE FROM retired_ai_keys; DELETE FROM addresses; DELETE FROM starter_grants; DELETE FROM plus_subscriptions');
});

// The credit Managed Models draw on, with the provider stood in: told at 14
// and 7 days left, and when less than one free period's ceiling is left; each
// once, and again only after a top-up.
test('the provider\'s credit running low is told at 14 and 7 days, and under one free period, once until topped up', async () => {
  await fresh();
  const queued = notices.create({ db, env: {} });
  const credit = { left: 300, days: 40 };
  const includedAi = { enabled: () => true, credit: async () => ({ ...credit }), label: 'NEAR AI', trialUsd: 12,
    topUp: 'Add credit, or raise the organisation\'s spend limit, at cloud.near.ai' };
  const watch = capacity.create({ db, env: { INCLUDED_AI_DAILY_PEOPLE: '1000' }, notices: queued, includedAi });
  assert.deepEqual(await watch.check(), [], 'forty days: nothing to say');
  Object.assign(credit, { left: 120, days: 12 });
  assert.deepEqual(await watch.check(), ["Closedhand: the NEAR AI credit Managed Models draw on lasts about 12 more days at the last 30 days' pace ($120.00 left). When it runs out, every free period and every subscription stops at once. Add credit, or raise the organisation's spend limit, at cloud.near.ai."]);
  assert.deepEqual(await watch.check(), [], 'told once');
  Object.assign(credit, { left: 60, days: 6 });
  assert.match((await watch.check())[0], /lasts about 6 more days/, 'and again at a week');
  assert.deepEqual(await watch.check(), []);
  Object.assign(credit, { left: 9.5, days: 1 });
  assert.deepEqual(await watch.check(), ["Closedhand: the NEAR AI credit Managed Models draw on is down to $9.50, less than one person's free days can use. When it runs out, every free period and every subscription stops at once. Add credit, or raise the organisation's spend limit, at cloud.near.ai."]);
  // Topped up: each is told again when it comes back.
  Object.assign(credit, { left: 500, days: 60 });
  assert.deepEqual(await watch.check(), []);
  Object.assign(credit, { left: 100, days: 10 });
  assert.equal((await watch.check()).length, 1, 'told again after the top-up');
  // Unread, or nothing used lately: nothing about days.
  Object.assign(credit, { left: 400, days: null });
  assert.deepEqual(await watch.check(), []);
  const broken = capacity.create({ db, env: { INCLUDED_AI_DAILY_PEOPLE: '1000' }, notices: queued, includedAi: { ...includedAi, credit: async () => { throw new Error('NEAR AI answered 503'); } } });
  const err = console.error; console.error = () => {};
  try { assert.deepEqual(await broken.check(), [], 'a credit that can\'t be read is not a notice'); } finally { console.error = err; }
});

test('NEAR\'s spend limit counts as running out too: what is left is whichever ends first', async () => {
  const { nearAi, SIGN_IN, BROWSER } = require('./near-ai');
  // Each stand-in NEAR starts from the sign-in handed over.
  await db.query('DELETE FROM near_session');
  const near = nearAi({ balance: { remaining: 6.63e9, spend_limit: 10e9, total_spent: 9.5e9, credit_limits: [] } });
  const ai = require('../lib/included-ai').create({ db, env: { NEAR_REFRESH_TOKEN: SIGN_IN, NEAR_USER_AGENT: BROWSER, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44) }, request: near.request });
  assert.equal((await ai.credit(new Date('2027-03-11T09:00:00Z'))).left, 0.5, 'the spend limit ends first');
  await db.query('DELETE FROM near_session');
  const roomy = nearAi({ balance: { remaining: 6.63e9, spend_limit: 100e9, total_spent: 3.37e9, credit_limits: [] } });
  const more = require('../lib/included-ai').create({ db, env: { NEAR_REFRESH_TOKEN: SIGN_IN, NEAR_USER_AGENT: BROWSER, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44) }, request: roomy.request });
  assert.equal((await more.credit(new Date('2027-03-11T09:00:00Z'))).left, 6.63, 'the credit ends first');
});
