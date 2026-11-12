const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
function registration(values, request) {
  const context = { module: { exports: {} }, URL, URLSearchParams, Buffer, AbortSignal, process: { env: {PORT:'3000'} }, fetch: request, require: name => ({
    'node:crypto': crypto,
    './config': { getConf: async k => values[k], setConf: async patch => Object.assign(values, patch) },
    './crypto-tokens': { encryptString: x => 'enc:v1:' + x, decryptString: x => x?.replace(/^enc:v1:/, '') },
  })[name] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../webapp/phone-registration.js'), 'utf8'), context);
  return context.module.exports;
}
// What closedhand.com answers for a personal URL now: a pass for this
// computer's key, and the relay to show it to.
const KEY = 'A'.repeat(43);
const PASS = Buffer.from(JSON.stringify({ h: 'alex.closedhand.ai', k: KEY, e: Date.now() + 86400000 })).toString('base64url') + '.' + 'c2lnbmF0dXJl';
const RELAY = { address: 'relay.closedhand.ai:443', controlHost: 'relay.closedhand.ai', pin: 'p'.repeat(43) };
const answer = (state, url = 'https://alex.closedhand.ai', extra = {}) => ({ state, url, pass: PASS, relay: RELAY, ...extra });
test('installation identity survives restart, and the last pass is kept sealed for when closedhand.com is down', async () => {
  const values = {}, calls = [];
  const url = 'https://alex.closedhand.ai';
  const request = async (path, options) => { calls.push({ path, auth: options.headers.Authorization, body: options.body }); return { ok: true, json: async () => path.endsWith('/register') ? { ticket: 'signed-fixture' } : answer('active') }; };
  const first = registration(values, request);
  await Promise.all([first.begin('fixture'), first.begin('fixture')]);
  assert.equal(calls[0].auth, calls[1].auth);
  assert.match(values.PHONE_INSTALL_SECRET, /^enc:v1:/);
  const got = await first.connection({ key: KEY });
  assert.ok(calls.at(-1).path.endsWith('/api/phone-enrollment/connection'));
  assert.deepEqual(JSON.parse(calls.at(-1).body), { key: KEY }, 'only the public half of this computer\'s key is sent');
  assert.deepEqual([got.url, got.pass, got.relay.address], [url, PASS, RELAY.address]);
  assert.match(values.PHONE_RELAY, /^enc:v1:/);
  const restarted = registration(values, async () => { throw new Error('Provider unavailable'); });
  const kept = await restarted.connection({ key: KEY });
  assert.deepEqual([kept.url, kept.pass, kept.verify], [url, PASS, false], 'a computer restarts while closedhand.com is down, on its last pass');
  await assert.rejects(registration(values, async () => { throw new Error('Provider unavailable'); }).connection({ key: 'B'.repeat(43) }), /unavailable/, 'only for the key it was made for');
  for (const invalid of ['https://evil.example', 'https://alex.closedhand.ai.evil.example', 'https://www.closedhand.ai', 'https://alex.closedhand.com', url + '?secret=leak', url + '/other', 'http://localhost:3000']) assert.equal(first.validAddress(invalid), false);
});
test('unexpected registration responses never persist a pass, a relay or an attacker address', async () => {
  for (const odd of [answer('active', 'https://other.example'), answer('active', undefined, { relay: { ...RELAY, pin: 'short' } }), answer('active', undefined, { relay: { ...RELAY, address: 'evil.example' } }), answer('active', undefined, { pass: 'not a pass' })]) {
    const values = {};
    const client = registration(values, async () => ({ ok: true, json: async () => odd }));
    await assert.rejects(client.connection({ key: KEY }), /verified/);
    assert.equal(values.PHONE_RELAY, undefined);
    assert.equal(values.PHONE_PERMANENT_URL, undefined);
  }
});
test('new address stays unpublished until the exact installation confirms it', async () => {
  const values={}, calls=[];
  const client=registration(values,async(url,options)=>{
    calls.push({url,options});
    return {ok:true,json:async()=>url.endsWith('/register') ? {ticket:'fixture'} : url.endsWith('/connected') ? {state:'active'} : answer('connecting','https://fixture.closedhand.ai')};
  });
  await client.begin();
  assert.ok(calls[0].url.includes('/phone-enrollment/register'));
  assert.deepEqual(JSON.parse(calls[0].options.body),{port:3000,confirm:'code'},'no name: closedhand.com picks it');
  const connecting=await client.connection({ key: KEY });assert.equal(connecting.verify,true);
  assert.equal(values.PHONE_PERMANENT_URL,undefined);
  const nonce='b'.repeat(64),secret=values.PHONE_INSTALL_SECRET.replace('enc:v1:','');
  assert.equal(await client.challenge(nonce),crypto.createHmac('sha256',secret).update('closedhand-address:'+nonce).digest('hex'));
  await assert.rejects(client.challenge('invalid'));
  await client.confirm(connecting);
  assert.equal(values.PHONE_PERMANENT_URL,'https://fixture.closedhand.ai');
});

test('ownership confirmation is distinct from provisioning and a verified URL', async () => {
  const values = { PHONE_ENROLLMENT: '2' };
  let state = 'unconfirmed';
  const client = registration(values, async () => ({ ok: true, json: async () => ({ state }) }));
  await client.connection(); assert.equal(client.status().ownershipConfirmed, false);
  for (state of ['pending', 'provisioning', 'error']) {
    assert.equal(await client.connection(), null);
    assert.equal(client.status().ownershipConfirmed, true);
    assert.equal(client.status().registrationState, state);
    assert.equal(values.PHONE_PERMANENT_URL, undefined);
  }
});

test('a personal URL is asked for without a name, through the one enrollment route', async () => {
  const calls = [], values = {};
  const client = registration(values, async (url, options) => { calls.push([url, options.body]); return { ok: true, json: async () => ({ ticket: 'fixture' }) }; });
  assert.match(await client.begin(), /^https:\/\/closedhand\.com\/phone-access\/pair#t=fixture&state=[a-f0-9]{32}$/);
  assert.deepEqual(JSON.parse(calls[0][1]), { port: 3000, confirm: 'code' });
  assert.equal(values.PHONE_ADDRESS_NAME, undefined, 'the name is not known until it is confirmed');
  await client.connection().catch(() => {});
  assert.ok(calls.every(([u]) => u.startsWith('https://closedhand.com/api/phone-enrollment/')), 'no calls to the retired route');
});

test('renaming tidies the name as closedhand.com does, then drops the old connection to reconnect', async () => {
  const website = require('../closedhand-com/lib/names');
  const values = { PHONE_PERMANENT_URL: 'https://amber-fox-42.closedhand.ai', PHONE_RELAY: 'enc:v1:{}', PHONE_ADDRESS_NAME: 'amber-fox-42' }, calls = [];
  const client = registration(values, async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ state: 'pending', url: 'https://lucy-smith.closedhand.ai', redirectUntil: '2026-10-29T00:00:00.000Z' }) }; });
  for (const typed of ['Lucy Smith', '  José! ', 'my.home_server', '--a--b', 'x'.repeat(40), '42-lucy', '日本', 'Zoë-Ångström']) {
    assert.equal(client.cleanName(typed), website.cleanName(typed), JSON.stringify(typed));
  }
  for (const bad of ['ab', 'admin', '日本', '']) await assert.rejects(client.rename(bad), /3 to 32 letters/);
  assert.equal(calls.length, 0, 'nothing sent for a name that cannot be used');
  const done = await client.rename('  Lucy Smith! ');
  assert.ok(calls[0].url.endsWith('/api/phone-enrollment/rename'));
  assert.deepEqual(calls[0].body, { name: 'lucy-smith' });
  assert.equal(done.url, 'https://lucy-smith.closedhand.ai');
  assert.equal(values.PHONE_PERMANENT_URL, null, 'the old address is no longer used');
  assert.equal(values.PHONE_RELAY, null, 'nor its pass');
  assert.equal(values.PHONE_ADDRESS_NAME, 'lucy-smith');
  assert.equal(client.status().ownershipConfirmed, true);
  const refused = registration({}, async () => ({ ok: false, json: async () => ({ error: 'That name is taken. Try another.' }) }));
  await assert.rejects(refused.rename('lucy'), /taken/);
  const odd = registration({}, async () => ({ ok: true, json: async () => ({ state: 'pending', url: 'https://evil.example' }) }));
  await assert.rejects(odd.rename('lucy'), /could not be verified/);
});

test('a confirmed code remembers the name closedhand.com picked', async () => {
  const values = {};
  const client = registration(values, async () => ({ ok: true, json: async () => ({ state: 'pending', url: 'https://amber-fox-42.closedhand.ai' }) }));
  await client.claim('ABC234');
  assert.equal(values.PHONE_ADDRESS_NAME, 'amber-fox-42');
});

test('the code from closedhand.com is checked, tidied and sent only by this copy', async () => {
  const values = {}, calls = [];
  const client = registration(values, async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ state: 'pending', url: 'https://fixture.closedhand.ai' }) }; });
  await assert.rejects(client.claim('12'), /6 letters and numbers/);
  await assert.rejects(client.claim(''), /6 letters and numbers/);
  assert.equal(calls.length, 0, 'nothing sent for a malformed code');
  assert.equal((await client.claim(' abc-234 ')).state, 'pending');
  assert.ok(calls[0].url.endsWith('/api/phone-enrollment/claim'));
  assert.deepEqual(JSON.parse(calls[0].options.body), { code: 'ABC234', acceptedTerms: false }, 'with whether the Terms were agreed on the setup page');
  assert.match(calls[0].options.headers.Authorization, /^Bearer [a-f0-9-]{36}\.[a-f0-9]{64}$/);
  assert.equal(client.status().ownershipConfirmed, true);
  const refused = registration({}, async () => ({ ok: false, json: async () => ({ error: 'That code does not match. Check the code on closedhand.com and try again.' }) }));
  await assert.rejects(refused.claim('ABC234'), /does not match/);
  assert.equal(refused.status().ownershipConfirmed, false);
});

test('closedhand.com counts as available only when reached and giving out personal URLs, checked at most every thirty seconds', async () => {
  let calls = 0, reply = { ok: true, json: async () => ({ signedIn: false, available: true }) };
  const client = registration({}, async url => { calls++; assert.equal(url, 'https://closedhand.com/api/account'); if (reply instanceof Error) throw reply; return reply; });
  assert.equal(await client.serviceAvailable(), true);
  assert.equal(await client.serviceAvailable(), true);
  assert.equal(calls, 1, 'cached');
  for (const [answer, why] of [[{ ok: true, json: async () => ({ available: false }) }, 'switched off'], [{ ok: false, json: async () => ({}) }, 'refused'], [new Error('offline'), 'unreachable']]) {
    reply = answer;
    const fresh = registration({}, async () => { if (reply instanceof Error) throw reply; return reply; });
    assert.equal(await fresh.serviceAvailable(), false, why);
  }
});
test('an address closedhand.com no longer knows for this computer is forgotten here too', async () => {
  const saved = { PHONE_PERMANENT_URL: 'https://amber-fox-42.closedhand.ai', PHONE_RELAY: 'enc:v1:{}', PHONE_ADDRESS_NAME: 'amber-fox-42', PHONE_ENROLLMENT: '2',
    PHONE_INSTALL_ID: '11111111-1111-4111-8111-111111111111', PHONE_INSTALL_SECRET: 'enc:v1:' + 'a'.repeat(64) };
  const ask = reply => async () => ({ ok: true, json: async () => reply });
  // Still known there: carries on, with a fresh pass.
  let values = { ...saved };
  const still = await registration(values, ask(answer('active', saved.PHONE_PERMANENT_URL))).connection({ key: KEY });
  assert.deepEqual([still.url, still.pass], [saved.PHONE_PERMANENT_URL, PASS]);
  // Gone there (account deleted, unused, or moved to another computer): forgotten here too.
  values = { ...saved };
  const client = registration(values, ask({ state: 'unconfirmed' }));
  assert.equal(await client.connection({ key: KEY }), null);
  assert.deepEqual([values.PHONE_PERMANENT_URL, values.PHONE_RELAY, values.PHONE_ADDRESS_NAME, values.PHONE_ENROLLMENT], [null, null, null, null]);
  assert.equal(values.PHONE_INSTALL_ID, saved.PHONE_INSTALL_ID, 'the computer keeps its identity');
  assert.equal(client.status().ownershipConfirmed, false);
});
// Objects made inside the sandbox, compared as plain data.
const plain = value => JSON.parse(JSON.stringify(value));
test('the Closedhand account: shown only as closedhand.com states it, and deleted there before anything here is forgotten', async () => {
  const saved = { PHONE_PERMANENT_URL: 'https://amber-fox-42.closedhand.ai', PHONE_RELAY: 'enc:v1:{}', PHONE_ADDRESS_NAME: 'amber-fox-42',
    PHONE_INSTALL_ID: '11111111-1111-4111-8111-111111111111', PHONE_INSTALL_SECRET: 'enc:v1:' + 'a'.repeat(64) };
  const calls = [];
  const reply = answer => async (url, options) => { calls.push([options.method, url]); return { ok: !answer.error, json: async () => answer }; };
  assert.deepEqual(plain(await registration({ ...saved }, reply({ account: { provider: 'google', email: 'a@example.com', url: 'https://amber-fox-42.closedhand.ai' } })).account()),
    { provider: 'google', email: 'a@example.com', url: 'https://amber-fox-42.closedhand.ai', signIns: [], plan: null, used: null, plus: null });
  // My Account's details, each only in the shape it should have.
  assert.deepEqual(plain(await registration({ ...saved }, reply({ account: { provider: 'microsoft', email: 'a@example.com', url: 'https://amber-fox-42.closedhand.ai',
    signIns: [{ provider: 'microsoft', email: 'a@example.com' }, { provider: 'evil', email: 7 }],
    plan: { name: 'plus', email: true, renews_at: '2026-12-01T00:00:00Z', base: 3, extra: 'x' }, used: 0.42,
    plus: { available: true, active: true, nearly: 'yes', renews_at: 'soon', prices: { plus: '$10', extend: { a: 1 } }, card: { brand: '<b>visa</b>', last4: '4242', expires: '08/29', number: '4242424242424242' } } } })).account()),
    { provider: 'microsoft', email: 'a@example.com', url: 'https://amber-fox-42.closedhand.ai',
      signIns: [{ provider: 'microsoft', email: 'a@example.com' }, { provider: 'google', email: null }],
      plan: { name: 'plus', email: true, ends_at: null, renews_at: '2026-12-01T00:00:00.000Z', fair_use_renews_at: null }, used: 0.42,
      plus: { available: true, active: true, extended: false, nearly: false, ends_at: null, renews_at: null, prices: { plus: '$10', extend: null }, longer: [], crypto: [], card: { brand: null, last4: '4242', expires: '08/29' } } });
  // The other ways to pay: each length a whole number of months with its prices, nothing else.
  const open = plain(await registration({ ...saved }, reply({ account: { provider: 'google', url: 'https://amber-fox-42.closedhand.ai', plan: { name: 'none', email: true },
    plus: { available: true, active: false, longer: [{ months: 6, price: '$162', monthly: '$27' }, { months: 'twelve', price: '$288' }], crypto: [{ months: 3, price: '$90', monthly: '$30', script: '<b>' }] } } })).account());
  assert.deepEqual([open.plus.longer, open.plus.crypto], [[{ months: 6, price: '$162', monthly: '$27' }], [{ months: 3, price: '$90', monthly: '$30' }]], 'a length that is not a number of months is left out');
  // Every 6 months: how often, its own price, and when this month's fair use renews.
  const longer = plain(await registration({ ...saved }, reply({ account: { provider: 'google', url: 'https://amber-fox-42.closedhand.ai',
    plan: { name: 'plus', email: true, renews_at: '2027-05-06T00:00:00Z', fair_use_renews_at: '2026-12-06T00:00:00Z', extended: true },
    plus: { available: true, active: true, every: 6, renews_at: '2027-05-06T00:00:00Z', prices: { plus: '$30', extend: '$30', every: '$162' } } } })).account());
  assert.deepEqual([longer.plan.fair_use_renews_at, longer.plan.extended, longer.plus.every, longer.plus.prices.every], ['2026-12-06T00:00:00.000Z', true, 6, '$162']);
  assert.equal(plain(await registration({ ...saved }, reply({ account: { provider: 'google', url: 'https://amber-fox-42.closedhand.ai', plus: { available: true, every: 5 } } })).account()).plus.every, undefined, 'only 6 or 12');
  // Paid ahead in crypto, and carrying on that way.
  const paidAhead = plain(await registration({ ...saved }, reply({ account: { provider: 'google', url: 'https://amber-fox-42.closedhand.ai', plan: { name: 'ahead', email: true, ends_at: '2027-05-06T00:00:00Z', fair_use_renews_at: '2026-12-06T00:00:00Z' },
    plus: { available: true, active: false, ahead_until: '2027-05-06T00:00:00Z', crypto: [{ months: 3, price: '$90', monthly: '$30' }], crypto_extend: '$30' } } })).account());
  assert.deepEqual(paidAhead.plan, { name: 'ahead', email: true, ends_at: '2027-05-06T00:00:00.000Z', renews_at: null, fair_use_renews_at: '2026-12-06T00:00:00.000Z' }, 'a plan paid ahead reaches My Account');
  assert.deepEqual([paidAhead.plus.ahead_until, paidAhead.plus.crypto_extend], ['2027-05-06T00:00:00.000Z', '$30']);
  assert.equal(plain(await registration({ ...saved }, reply({ account: { provider: 'google', url: 'https://amber-fox-42.closedhand.ai', used: 7, plan: { name: 'gold' } } })).account()).used, null, 'a share is between none and all');
  assert.deepEqual(plain(await registration({ ...saved }, reply({ account: { provider: 'google', url: 'https://amber-fox-42.closedhand.ai', used: 0.2, plan: { name: 'maintainer', email: true, renews_at: '2026-12-01T00:00:00Z', fair_use_renews_at: '2026-12-01T00:00:00Z' } } })).account()).plan,
    { name: 'maintainer', email: true, ends_at: null, renews_at: '2026-12-01T00:00:00.000Z', fair_use_renews_at: '2026-12-01T00:00:00.000Z' }, "the maintainer's plan reaches My Account");
  assert.equal(await registration({ ...saved }, reply({ account: { provider: 'google', email: 'a@example.com', url: 'https://evil.example' } })).account(), null, 'never an address it cannot verify');
  assert.equal(await registration({ ...saved }, reply({ account: null })).account(), null);
  // A computer that never asked for a personal URL has no account, and never makes an identity to find out.
  const fresh = {};
  assert.equal(await registration(fresh, reply({})).account(), null);
  assert.deepEqual(plain(await registration(fresh, reply({})).deleteAccount()), { deleted: false });
  assert.equal(fresh.PHONE_INSTALL_ID, undefined);
  // Refused there: nothing forgotten here.
  let values = { ...saved };
  await assert.rejects(registration(values, reply({ error: 'Please wait a minute and try again.' })).deleteAccount(), /wait a minute/);
  assert.equal(values.PHONE_PERMANENT_URL, saved.PHONE_PERMANENT_URL);
  values = { ...saved };
  calls.length = 0;
  assert.deepEqual(plain(await registration(values, reply({ deleted: true })).deleteAccount()), { deleted: true });
  assert.deepEqual(calls, [['POST', 'https://closedhand.com/api/phone-enrollment/account/delete']]);
  assert.equal(values.PHONE_PERMANENT_URL, null); assert.equal(values.PHONE_RELAY, null);
});

test('claiming with the Google or Microsoft sign-in sends it once, by this copy, and steps aside when closedhand.com wants the confirmation page', async () => {
  for (const provider of ['google', 'microsoft']) {
    const values = {}, calls = [];
    const client = registration(values, async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ state: 'pending', url: 'https://amber-fox-42.closedhand.ai' }) }; });
    const done = await client.claimWithSignIn(provider, 'id.token.here');
    assert.equal(done.url, 'https://amber-fox-42.closedhand.ai');
    assert.ok(calls[0].url.endsWith('/api/phone-enrollment/claim-' + provider));
    assert.deepEqual(JSON.parse(calls[0].options.body), { idToken: 'id.token.here', port: 3000, acceptedTerms: false });
    assert.match(calls[0].options.headers.Authorization, /^Bearer [a-f0-9-]{36}\.[a-f0-9]{64}$/);
    assert.equal(values.PHONE_ADDRESS_NAME, 'amber-fox-42'); assert.equal(values.PHONE_ENROLLMENT, '2');
    assert.equal(client.status().ownershipConfirmed, true);
    const elsewhere = registration({}, async () => ({ ok: true, json: async () => ({ state: 'unconfirmed', claimHere: true }) }));
    assert.equal(await elsewhere.claimWithSignIn(provider, 'id.token.here'), null);
    assert.equal(elsewhere.status().ownershipConfirmed, false);
    const attacker = registration({}, async () => ({ ok: true, json: async () => ({ state: 'pending', url: 'https://evil.example' }) }));
    assert.equal(await attacker.claimWithSignIn(provider, 'id.token.here'), null, 'an address that is not a personal URL is ignored');
  }
  const asked = [];
  await assert.rejects(registration({}, async (url) => { asked.push(url); return { ok: true, json: async () => ({}) }; }).claimWithSignIn('account/delete', 'id.token.here'));
  assert.deepEqual(asked, [], 'only a Google or Microsoft sign-in is sent');
});

test('a code handed straight back counts only with the state from this copy\'s own recent link, and only once', async () => {
  const values = {}, sent = [];
  const client = registration(values, async (url, options) => { sent.push(url); return { ok: true, json: async () => url.endsWith('/register') ? { ticket: 'fixture' } : { state: 'connecting', url: 'https://amber-fox-42.closedhand.ai' } }; });
  const link = new URL(await client.begin());
  assert.equal(link.origin + link.pathname, 'https://closedhand.com/phone-access/pair');
  const params = new URLSearchParams(link.hash.slice(1));
  assert.equal(params.get('t'), 'fixture');
  assert.match(params.get('state'), /^[a-f0-9]{32}$/);
  for (const stranger of ['f'.repeat(32), 'short', '', null]) await assert.rejects(client.claim('ABC123', stranger), /didn’t come from this Closedhand/);
  assert.equal(sent.filter(u => u.endsWith('/claim')).length, 0, 'a code with a strange state is never sent on');
  await client.claim('abc 123', params.get('state'));
  assert.equal(sent.filter(u => u.endsWith('/claim')).length, 1);
  await assert.rejects(client.claim('ABC123', params.get('state')), /didn’t come/, 'one use');
  await client.claim('ABC123');
  assert.equal(sent.filter(u => u.endsWith('/claim')).length, 2, 'a typed code needs no state');
  // A link older than its ticket's thirty minutes no longer counts.
  const later = new URLSearchParams(new URL(await client.begin()).hash.slice(1)).get('state');
  values.PHONE_CLAIM_STATES = JSON.stringify(JSON.parse(values.PHONE_CLAIM_STATES).map(s => ({ ...s, at: s.at - 31 * 60000 })));
  await assert.rejects(client.claim('ABC123', later), /didn’t come/);
});

test('a second Google or Microsoft account connected once there is a personal URL is passed on, so it signs in to the same account', async () => {
  for (const provider of ['google', 'microsoft']) {
    const calls = [];
    const client = registration({}, async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ signIn: 'added' }) }; });
    assert.deepEqual(plain(await client.addSignIn(provider, 'id.token.second')), { signIn: 'added' });
    // Whose account it is comes first: one made with an account number gets no sign-in (test-anonymous-account.js).
    assert.ok(calls[0].url.endsWith('/api/phone-enrollment/account') && !calls[0].options.body);
    assert.ok(calls[1].url.endsWith('/api/phone-enrollment/sign-in-' + provider));
    assert.deepEqual(JSON.parse(calls[1].options.body), { idToken: 'id.token.second' });
    assert.match(calls[1].options.headers.Authorization, /^Bearer [a-f0-9-]{36}\.[a-f0-9]{64}$/, "as this computer");
  }
  await assert.rejects(registration({}, async () => ({ ok: true, json: async () => ({}) })).addSignIn('account/delete', 'x'));
  const server = fs.readFileSync(path.join(__dirname, '..', 'webapp/server.js'), 'utf8');
  assert.match(server, /if \(await getRuntimeConf\("PHONE_PERMANENT_URL"\) \|\| registration\.status\(\)\.ownershipConfirmed\) \{\n\s*await registration\.addSignIn\(provider, idToken\)\.catch\(/, 'once the computer has its URL, a connected account is added as a sign-in');
});

test("the subscription in My Account: Polar's forms only from Polar, and each answer only in its shape", async () => {
  const saved = { PHONE_INSTALL_ID: '11111111-1111-4111-8111-111111111111', PHONE_INSTALL_SECRET: 'enc:v1:' + 'a'.repeat(64) };
  const calls = [];
  const reply = answer => async (url, options) => { calls.push([options.method, url, options.body]); return { ok: !answer.error, json: async () => answer }; };
  const plus = (answer, ...args) => registration({ ...saved }, reply(answer)).plus(...args);
  assert.deepEqual(plain(await plus({ url: 'https://polar.sh/checkout/polar_c_x' }, 'checkout', { kind: 'extend' })), { url: 'https://polar.sh/checkout/polar_c_x' });
  assert.deepEqual(calls.at(-1), ['POST', 'https://closedhand.com/api/phone-enrollment/plus/checkout', '{"kind":"extend","agreed":false}']);
  // Subscribing every 6 months, with the box ticked; carrying on in crypto; paying ahead in crypto.
  await plus({ url: 'https://polar.sh/checkout/polar_c_y' }, 'checkout', { kind: 'plus', months: '6', agreed: true });
  assert.equal(calls.at(-1)[2], '{"kind":"plus","months":6,"agreed":true}');
  assert.deepEqual(plain(await plus({ url: 'https://closedhand.com/pay/InvFixture0001' }, 'checkout', { kind: 'extend', agreed: true })), { url: 'https://closedhand.com/pay/InvFixture0001' }, 'carrying on in crypto opens the crypto payment page');
  assert.deepEqual(plain(await plus({ url: 'https://closedhand.com/pay/InvFixture0002' }, 'checkout', { kind: 'ahead', months: 3, agreed: 'yes' })), { url: 'https://closedhand.com/pay/InvFixture0002' });
  assert.equal(calls.at(-1)[2], '{"kind":"ahead","months":3,"agreed":false}', 'only a true agrees');
  await assert.rejects(plus({ url: 'https://polar.sh/checkout/polar_c_z' }, 'checkout', { kind: 'ahead', months: 3, agreed: true }), /payment service/, 'crypto only on its own page');
  await assert.rejects(plus({ url: 'https://closedhand.com/pay/InvFixture0003' }, 'checkout', { kind: 'plus', agreed: true }), /payment service/, 'the subscription only on Polar');
  await assert.rejects(plus({ url: 'https://evil.example.com/polar.sh/' }, 'checkout', { kind: 'plus' }), /payment service/, 'a form from anywhere but Polar is never framed');
  await assert.rejects(plus({ url: 'https://polar.sh.evil.example.com/x' }, 'checkout', {}), /payment service/);
  assert.deepEqual(plain(await plus({ token: 'polar_cst_x', web: 'https://sandbox.polar.sh' }, 'card')), { token: 'polar_cst_x', web: 'https://sandbox.polar.sh' });
  await assert.rejects(plus({ token: 'polar_cst_x', web: 'https://evil.example.com' }, 'card'), /payment service/);
  assert.deepEqual(plain(await plus({ plus: {} }, 'cancel', { cancel: 'yes' })), { done: true });
  assert.equal(calls.at(-1)[2], '{"cancel":false}', 'only a true cancels');
  assert.deepEqual(plain(await plus({ payments: [{ id: '11111111-2222-4333-8444-555555555555', at: '2026-11-01T00:00:05Z', what: 'plus', amount: '$10', refunded: false, card: '4242' }, { id: '../x' }] }, 'payments')),
    [{ id: '11111111-2222-4333-8444-555555555555', at: '2026-11-01T00:00:05.000Z', what: 'plus', amount: '$10', refunded: false }]);
  await assert.rejects(plus({ url: 'https://files.example.com/a.pdf' }, 'invoice', { id: '../account/delete' }), /not there/, 'never another path');
  assert.deepEqual(plain(await plus({ url: 'https://files.example.com/a.pdf' }, 'invoice', { id: '11111111-2222-4333-8444-555555555555' })), { url: 'https://files.example.com/a.pdf' });
  assert.equal(calls.at(-1)[1], 'https://closedhand.com/api/phone-enrollment/plus/invoice?id=11111111-2222-4333-8444-555555555555');
  await assert.rejects(registration({}, reply({})).plus('payments'), /Claim your personal URL first/);
});
