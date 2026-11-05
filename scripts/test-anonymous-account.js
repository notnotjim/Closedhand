// Closedhand used anonymously (webapp/phone-registration.js claimAnonymous):
// paid for first in crypto, then the account number comes back once and is
// kept sealed, and from then on no Google or Microsoft sign-in leaves this
// computer for closedhand.com, whichever way it would have gone.
// closedhand.com is a stand-in; invented data only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

function registration(values, request) {
  const context = { module: { exports: {} }, URL, URLSearchParams, Buffer, AbortSignal, console, process: { env: { PORT: '3000' } }, fetch: request, require: name => ({
    'node:crypto': crypto,
    './config': { getConf: async k => values[k], setConf: async patch => { for (const [k, v] of Object.entries(patch)) { if (v === null) delete values[k]; else values[k] = v; } } },
    './crypto-tokens': { encryptString: x => 'enc:v1:' + x, decryptString: x => x?.replace(/^enc:v1:/, '') },
    './included-ai-setup': { receive: async (key) => { values.received = key; } },
  })[name] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../webapp/phone-registration.js'), 'utf8'), context);
  return context.module.exports;
}
const URL_GIVEN = 'https://quiet-heron-27.closedhand.ai';
const NUMBER = 'H7KD 3QPA ZW9M RT4E BN2X';
const TOKEN = 'eyJ.sign-in-fixture-' + crypto.randomBytes(8).toString('hex');
const known = () => ({ PHONE_INSTALL_ID: crypto.randomUUID(), PHONE_INSTALL_SECRET: 'enc:v1:' + 'c'.repeat(64), TERMS_ACCEPTED_AT: '2026-11-06T09:00:00.000Z' });
// closedhand.com as this computer reaches it, keeping every request.
function service(answers = {}) {
  const sent = [];
  const request = async (url, options = {}) => {
    sent.push({ url, method: options.method || 'GET', body: options.body || '' });
    const name = url.replace('https://closedhand.com/api/phone-enrollment/', '');
    const answer = (options.method || 'GET') + ' ' + name in answers ? answers[(options.method || 'GET') + ' ' + name] : answers[name];
    if (answer instanceof Error) throw answer;
    return { ok: true, json: async () => answer || {} };
  };
  return { sent, request, carried: () => sent.filter(s => s.body.includes(TOKEN) || /claim-(google|microsoft)|sign-in-/.test(s.url)) };
}

const PAGE = 'https://closedhand.com/pay/InvFixture0001';
const paidFor = { 'POST claim-anonymous': { state: 'waiting', url: PAGE }, 'GET claim-anonymous': { state: 'pending', url: URL_GIVEN, anonymous: true, accountNumber: NUMBER, included_ai: { key: 'sk-fixture-key', models: {} } } };

test('used anonymously, paid for first: the months and the Terms go, then the account number is collected once, sealed, with Managed Models', async () => {
  const values = known();
  const { sent, request } = service({ 'POST claim-anonymous': { state: 'waiting', url: PAGE }, 'GET claim-anonymous': { state: 'waiting' } });
  const client = registration(values, request);
  assert.deepEqual({ ...(await client.claimAnonymous(6)) }, { state: 'waiting', url: PAGE, months: 6 });
  assert.equal(sent[0].url, 'https://closedhand.com/api/phone-enrollment/claim-anonymous');
  assert.deepEqual(JSON.parse(sent[0].body), { port: 3000, acceptedTerms: true, months: 6 }, 'nothing about the person');
  assert.deepEqual({ ...(await client.anonymousWaiting()) }, { url: PAGE, months: 6 }, 'kept, so setup opened again waits again');
  assert.deepEqual({ ...(await client.anonymousClaim()) }, { state: 'waiting', url: PAGE, months: 6 });
  assert.equal(values.PHONE_ACCOUNT_NUMBER, undefined, 'nothing yet');

  const paid = registration(values, service(paidFor).request);
  assert.deepEqual({ ...(await paid.anonymousClaim()) }, { state: 'ready', url: URL_GIVEN, accountNumber: NUMBER });
  assert.equal(values.PHONE_ACCOUNT_NUMBER, 'enc:v1:' + NUMBER.replace(/ /g, ''), 'sealed, never in plain text');
  assert.equal(values.received.key, 'sk-fixture-key', 'Managed Models set up as for a subscriber');
  assert.equal(values.PHONE_ANONYMOUS, '1');
  assert.equal(values.PHONE_ADDRESS_NAME, 'quiet-heron-27');
  assert.equal(await paid.anonymousWaiting(), null, 'no longer waiting');
  assert.equal(await paid.accountNumber(), NUMBER);
  assert.equal(await paid.accountNumberToSave(), true);
  await paid.accountNumberSaved();
  assert.equal(await paid.accountNumberToSave(), false, 'asked once');
  assert.equal(await paid.accountNumber(), NUMBER, 'still there to show in My Account');
});

test('without the Terms, months or a real payment page nothing is asked or kept, and a lapsed payment page starts over', async () => {
  const values = known();
  delete values.TERMS_ACCEPTED_AT;
  const quiet = service();
  await assert.rejects(registration(values, quiet.request).claimAnonymous(3), /Terms/);
  await assert.rejects(registration(known(), quiet.request).claimAnonymous(4), /3, 6 or 9/);
  assert.equal(quiet.sent.length, 0);
  const odd = service({ 'POST claim-anonymous': { state: 'waiting', url: 'https://pay.example.com/i/x' } });
  const values2 = known();
  await assert.rejects(registration(values2, odd.request).claimAnonymous(3), /payment page/);
  assert.equal(values2.PHONE_ANONYMOUS_PENDING, undefined);
  const lapsed = known();
  lapsed.PHONE_ANONYMOUS_PENDING = JSON.stringify({ url: PAGE, months: 3 });
  assert.deepEqual({ ...(await registration(lapsed, service({ 'GET claim-anonymous': { state: 'none' } }).request).anonymousClaim()) }, { state: 'expired' });
  assert.equal(lapsed.PHONE_ANONYMOUS_PENDING, undefined);
  assert.equal(lapsed.PHONE_ACCOUNT_NUMBER, undefined);
});

test('no sign-in token leaves this computer for an account made with an account number', async () => {
  // Used anonymously here, paid for and collected.
  const values = known();
  const here = service(paidFor);
  const client = registration(values, here.request);
  await client.claimAnonymous(3);
  await client.anonymousClaim();
  for (const provider of ['google', 'microsoft']) {
    assert.deepEqual({ ...(await client.addSignIn(provider, TOKEN)) }, { signIn: 'kept here' });
    assert.equal(await client.claimWithSignIn(provider, TOKEN), null);
  }
  assert.deepEqual(here.carried(), [], 'nothing sent with a sign-in in it');

  // Claimed on closedhand.com's claim page, signed in with the number there:
  // the claim says so.
  const paired = known();
  paired.PHONE_CLAIM_STATES = '[]';
  const page = service({ claim: { state: 'pending', url: URL_GIVEN, anonymous: true } });
  const pairedClient = registration(paired, page.request);
  await pairedClient.claim('ABC234');
  await pairedClient.addSignIn('google', TOKEN);
  assert.deepEqual(page.carried(), []);

  // Not known here yet: closedhand.com is asked whose account it is, with
  // no sign-in in the asking, and nothing is sent.
  const asked = service({ account: { account: { provider: 'anonymous', email: null, url: URL_GIVEN, signIns: [] } } });
  const fresh = known();
  await registration(fresh, asked.request).addSignIn('microsoft', TOKEN);
  assert.deepEqual(asked.sent.map(s => s.url), ['https://closedhand.com/api/phone-enrollment/account']);
  assert.deepEqual(asked.carried(), []);
  assert.equal(fresh.PHONE_ANONYMOUS, '1', 'and remembered');

  // closedhand.com can't say: nothing is sent on a guess.
  const down = service({ account: new Error('fetch failed') });
  await registration(known(), down.request).addSignIn('google', TOKEN);
  assert.deepEqual(down.carried(), []);

  // An account that signs in with Google still has another account added, as before.
  const google = service({ account: { account: { provider: 'google', email: 'wren@example.com', url: URL_GIVEN, signIns: [] } }, 'sign-in-google': { signIn: 'added' } });
  await registration(known(), google.request).addSignIn('google', TOKEN);
  assert.equal(google.carried().length, 1, 'the one sign-in, to the Google account it belongs with');
});

test('every way a sign-in could reach closedhand.com goes through the two guarded calls', () => {
  const root = path.join(__dirname, '..');
  const files = ['webapp', 'lib'].flatMap(dir => fs.readdirSync(path.join(root, dir), { recursive: true }).map(f => path.join(dir, f)))
    .filter(f => f.endsWith('.js') && !f.includes('node_modules') && fs.statSync(path.join(root, f)).isFile());
  for (const file of files) {
    if (file === path.join('webapp', 'phone-registration.js')) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /phone-enrollment\/(claim|sign-in)-/, file + ' passes a sign-in on by itself');
  }
  const server = fs.readFileSync(path.join(root, 'webapp/server.js'), 'utf8');
  const start = server.indexOf('async function claimPersonalUrlWith');
  const body = server.slice(start, server.indexOf('\n}\n', start));
  assert.ok(body.indexOf('PHONE_ANONYMOUS') > -1 && body.indexOf('PHONE_ANONYMOUS') < body.indexOf('addSignIn'), 'checked before anything is passed on');
});

test('My Account learns the account is made with an account number, and deleting it forgets the number here', async () => {
  const values = known();
  values.PHONE_ACCOUNT_NUMBER = 'enc:v1:' + NUMBER.replace(/ /g, '');
  values.PHONE_ANONYMOUS = '1';
  const { request } = service({ account: { account: { provider: 'anonymous', email: null, url: URL_GIVEN, signIns: [], plus: { available: true, active: false, crypto: [{ months: 3, price: '$90', monthly: '$30' }] }, plan: { name: 'none' } } },
    'account/delete': { deleted: true } });
  const client = registration(values, request);
  const account = await client.account();
  assert.deepEqual([account.provider, account.email, account.anonymous, account.numberHere], ['anonymous', null, true, true]);
  assert.equal(account.plus.longer.length, 0, 'no ways to pay by card');
  assert.equal((await client.deleteAccount()).deleted, true);
  for (const k of ['PHONE_ACCOUNT_NUMBER', 'PHONE_ANONYMOUS', 'PHONE_ACCOUNT_NUMBER_SAVED']) assert.equal(values[k], undefined, k);
});
