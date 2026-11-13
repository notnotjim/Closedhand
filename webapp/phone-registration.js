// Personal URL registration with closedhand.com. Only routing credentials leave the install.
// A claim can bring back the AI that comes with Closedhand (included-ai-setup.js).
// Claimed without an email, the Closedhand account is known only by an
// account number, and no Google or Microsoft sign-in ever goes to
// closedhand.com from this computer (anonymous).
const crypto = require('node:crypto');
const { getConf, setConf } = require('./config');
const { encryptString, decryptString } = require('./crypto-tokens');
const PROVIDER = 'https://closedhand.com';
function encrypted(value) {
  const result = encryptString(value);
  if (!result?.startsWith('enc:v1:')) throw new Error('Your personal URL needs encrypted storage. Check Closedhand’s settings.');
  return result;
}
let identityPromise;
let registrationState = null;
async function credentials() {
  if (identityPromise) return identityPromise;
  identityPromise = (async () => {
    let id = await getConf('PHONE_INSTALL_ID');
    let secret = decryptString(await getConf('PHONE_INSTALL_SECRET'));
    if (!id && !secret) {
      id = crypto.randomUUID(); secret = crypto.randomBytes(32).toString('hex');
      await setConf({ PHONE_INSTALL_ID: id, PHONE_INSTALL_SECRET: encrypted(secret) });
    }
    if (!/^[a-f0-9-]{36}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('Could not open the personal URL settings.');
    return id + '.' + secret;
  })().catch(error => { identityPromise = null; throw error; });
  return identityPromise;
}
async function call(path, method = 'GET', body) {
  const response = await fetch(PROVIDER + '/api/phone-enrollment/' + path, {
    method, headers: { Authorization: 'Bearer ' + await credentials(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not set up your personal URL. Please try again.');
  return result;
}
// Ask for a personal URL. closedhand.com picks the name (two ordinary words
// and a number); the owner can rename it later. closedhand.com gives its
// owner a code after they confirm, and handing it in here (claim) is what
// finishes, so only this copy can. The link carries a one-time state: when
// closedhand.com hands the code straight back to setup on this computer, the
// state comes with it, so a code arriving any other way is never sent on.
async function begin() {
  const data = await call('register', 'POST', { port: Number(process.env.PORT || 3000), confirm: 'code' });
  if (typeof data.ticket !== 'string') throw new Error('Could not start claiming your personal URL.');
  const state = crypto.randomBytes(16).toString('hex');
  // A ticket lasts thirty minutes; a few recent links stay good together.
  const recent = (await claimStates()).filter(s => Date.now() - s.at < 30 * 60000).slice(-4);
  await setConf({ PHONE_ENROLLMENT: '2', PHONE_CLAIM_STATES: JSON.stringify([...recent, { state, at: Date.now() }]) });
  return PROVIDER + '/phone-access/pair#' + new URLSearchParams({ t: data.ticket, state });
}
async function claimStates() {
  try { const list = JSON.parse(await getConf('PHONE_CLAIM_STATES') || '[]'); return Array.isArray(list) ? list.filter(s => s && typeof s.state === 'string' && typeof s.at === 'number') : []; }
  catch (_) { return []; }
}
// A typed name tidied the way closedhand.com tidies it (closedhand-com/lib/
// names.js): lower case, no accents, spaces and dots as hyphens, nothing else.
function cleanName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[\s._]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
    .replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '');
}
// Rename the personal URL. The old name stops opening anything and stays
// reserved to its owner for six months. This copy then reconnects at the new
// name and proves it answers there, as it did the first time.
async function rename(name) {
  const clean = cleanName(name);
  if (!validAddress('https://' + clean + '.closedhand.ai')) {
    throw new Error('Use 3 to 32 letters, numbers or hyphens, starting with a letter. A few names, like admin and mail, are kept back.');
  }
  const data = await call('rename', 'POST', { name: clean });
  if (!validAddress(data.url)) throw new Error('The new personal URL could not be verified.');
  await setConf({ PHONE_PERMANENT_URL: null, PHONE_RELAY: null, PHONE_ADDRESS_NAME: new URL(data.url).hostname.split('.')[0] });
  registrationState = ['pending', 'provisioning', 'connecting', 'active', 'error'].includes(data.state) ? data.state : 'pending';
  return data;
}
// Can closedhand.com give out personal URLs right now? Reached, and not
// switched off. Checked at most every thirty seconds.
let serviceCheck = { at: 0, available: null };
async function serviceAvailable() {
  if (Date.now() - serviceCheck.at < 30000 && serviceCheck.available !== null) return serviceCheck.available;
  let available = false, includedAi = false, includedAiModel = null;
  try {
    const response = await fetch(PROVIDER + '/api/account', { redirect: 'error', signal: AbortSignal.timeout(6000) });
    const answer = response.ok ? await response.json() : {};
    available = answer.available === true;
    includedAi = available && answer.includedAi === true;
    if (includedAi && typeof answer.includedAiModel === 'string') includedAiModel = answer.includedAiModel;
  } catch (_) { available = false; }
  serviceCheck = { at: Date.now(), available, includedAi, includedAiModel };
  return available;
}
// Whether claiming the personal URL now would bring the AI that comes with
// Closedhand, so setup can say so before it is claimed.
async function includedAiOffered() {
  await serviceAvailable();
  return serviceCheck.includedAi === true;
}
// The LLM a claim now would bring, by its model ID, or null.
async function includedAiModel() {
  return (await includedAiOffered()) ? serviceCheck.includedAiModel || null : null;
}
// What closedhand.com says about Closedhand Managed Models for this computer
// (included-ai-setup.js refresh): the models in use, its account's plan, a
// key waiting for it, and notices for its account. Null on a computer that
// never asked for a personal URL.
async function includedAiState() {
  if (!(await getConf('PHONE_INSTALL_ID'))) return null;
  return (await call('included-ai', 'GET')) || null;
}
function validAddress(value) {
  try {
    const u = new URL(value);
    const name = u.hostname.slice(0, -'.closedhand.ai'.length);
    // The same names closedhand.com refuses (closedhand-com/lib/addresses.js).
    const reserved = new Set(['www', 'app', 'api', 'admin', 'account', 'accounts', 'auth', 'login', 'mail', 'smtp', 'support', 'status', 'cloud', 'dashboard', 'closedhand',
      'autodiscover', 'autoconfig', 'mta-sts', 'webmail', 'imap', 'pop', 'mx', 'ns1', 'ns2', 'sso', 'id', 'help', 'security', 'docs', 'relay', 'assist',
      'billing', 'pay', 'secure', 'static', 'cdn', 'blog', 'open', 'keep', 'setup']);
    return u.protocol === 'https:' && /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(u.hostname) &&
      !reserved.has(name) && !/^..--/.test(name) && !u.port && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash;
  } catch (_) { return false; }
}
// The personal URL, and what this computer needs to take it at the relay
// (relay-client.js): a pass from closedhand.com for this computer's own key,
// lasting a day, and which relay to use, named with its certificate so no
// other server can pose as it. An address closedhand.com no longer knows for
// this computer (its account was deleted, it went unused, or it moved to
// another computer) is forgotten here too.
async function connection({ key } = {}) {
  let data;
  try { data = await call('connection', 'POST', { key }); }
  catch (error) {
    // closedhand.com can't be reached: the last pass, while it lasts.
    const kept = await getConf('PHONE_RELAY').then(v => JSON.parse(decryptString(v) || 'null')).catch(() => null);
    if (kept && kept.key === key && passExpiry(kept.pass) > Date.now() + 60000) { registrationState = 'active'; return { ...kept.connection, verify: false }; }
    throw error;
  }
  registrationState = ['unconfirmed', 'pending', 'provisioning', 'connecting', 'active', 'error'].includes(data.state) ? data.state : null;
  if (data.state === 'unconfirmed' && await getConf('PHONE_PERMANENT_URL')) await forget();
  if (data.state === 'replaced') {
    await forget();
    if (validAddress(data.url) && replacedHook) await replacedHook(data.url);
    return null;
  }
  if (!['active', 'connecting'].includes(data.state)) return null;
  const relay = data.relay || {};
  if (!validAddress(data.url) || typeof data.pass !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.pass)
    || typeof relay.address !== 'string' || !/^[a-z0-9.-]+:\d{1,5}$/.test(relay.address)
    || typeof relay.controlHost !== 'string' || !/^[a-z0-9.-]+$/.test(relay.controlHost)
    || typeof relay.pin !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(relay.pin)) throw new Error('Your personal URL could not be verified.');
  const result = { url: data.url, pass: data.pass, relay: { address: relay.address, controlHost: relay.controlHost, pin: relay.pin } };
  if (data.state === 'active') await setConf({ PHONE_PERMANENT_URL: data.url, PHONE_RELAY: encrypted(JSON.stringify({ key, connection: result, pass: data.pass })) });
  return { ...result, verify: data.state === 'connecting' };
}
// Once this computer answers at its personal URL, closedhand.com checks it
// there (the address becomes active) and the address is kept here.
async function confirm(permanent) {
  if (!permanent.verify) return;
  await call('connected', 'POST', {});
  await setConf({ PHONE_PERMANENT_URL: permanent.url });
}
// When a pass runs out, as it says.
function passExpiry(pass) {
  try { return Number(JSON.parse(Buffer.from(String(pass).split('.')[0], 'base64url').toString('utf8')).e) || 0; } catch (_) { return 0; }
}
// state: set when closedhand.com handed the code back by itself (not typed).
// Whether the person agreed to the Terms and Privacy policy on the setup
// page, which a claim tells closedhand.com (it keeps which Terms and when).
async function termsAccepted() { return !!(await getConf('TERMS_ACCEPTED_AT')); }
async function acceptTerms() { await setConf({ TERMS_ACCEPTED_AT: new Date().toISOString() }); }
async function claim(code, state) {
  code = String(code || '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('The code is 6 letters and numbers, as shown on closedhand.com.');
  if (state !== undefined) {
    const states = await claimStates();
    const match = typeof state === 'string' && /^[a-f0-9]{32}$/.test(state) &&
      states.find(s => Date.now() - s.at < 30 * 60000 && s.state.length === 32 && crypto.timingSafeEqual(Buffer.from(s.state), Buffer.from(state)));
    if (!match) throw new Error('That link didn’t come from this Closedhand. Get your personal URL here instead.');
    await setConf({ PHONE_CLAIM_STATES: JSON.stringify(states.filter(s => s !== match)) });
  }
  const data = withIncludedAi(await call('claim', 'POST', { code, acceptedTerms: await termsAccepted() }));
  if (data.anonymous === true) await setConf({ PHONE_ANONYMOUS: '1' });
  if (['pending', 'provisioning', 'connecting', 'active', 'error'].includes(data.state)) registrationState = data.state;
  // The name closedhand.com picked, so setup can say where Closedhand is.
  if (validAddress(data.url)) await setConf({ PHONE_ADDRESS_NAME: new URL(data.url).hostname.split('.')[0] });
  return data;
}
// Claim in one step with the Google or Microsoft sign-in this computer has
// just done through Closedhand's own app for it, checked by closedhand.com
// against that provider's keys. Null when closedhand.com wants it claimed on
// its confirmation page instead (an address already used on another computer).
async function claimWithSignIn(provider, idToken) {
  if (!['google', 'microsoft'].includes(provider)) throw new Error('Unknown sign-in');
  if (await getConf('PHONE_ANONYMOUS') === '1') return null;
  const data = withIncludedAi(await call('claim-' + provider, 'POST', { idToken, port: Number(process.env.PORT || 3000), acceptedTerms: await termsAccepted() }));
  if (data.claimHere || !validAddress(data.url)) return null;
  if (['pending', 'provisioning', 'connecting', 'active', 'error'].includes(data.state)) registrationState = data.state;
  await setConf({ PHONE_ENROLLMENT: '2', PHONE_ADDRESS_NAME: new URL(data.url).hostname.split('.')[0] });
  return data;
}
// Another Google or Microsoft account connected once this computer has its
// personal URL: closedhand.com lets it sign in to the same Closedhand
// account, so any account connected at setup signs in there.
async function addSignIn(provider, idToken) {
  if (!['google', 'microsoft'].includes(provider)) throw new Error('Unknown sign-in');
  if (await anonymous()) return { signIn: 'kept here' };
  return call('sign-in-' + provider, 'POST', { idToken });
}
// Whether this computer's Closedhand account was made with an account
// number. Known here from its claim; otherwise closedhand.com is asked, and
// when it can't say, the answer is yes, so a sign-in never leaves on a guess.
async function anonymous() {
  if (await getConf('PHONE_ANONYMOUS') === '1') return true;
  try {
    const found = (await call('account')).account;
    if (found?.provider !== 'anonymous') return false;
    await setConf({ PHONE_ANONYMOUS: '1' });
    return true;
  } catch (_) { return true; }
}
// Using Closedhand anonymously, paid for first in crypto: closedhand.com
// keeps a claim waiting for the payment and answers with its payment page.
// Once paid, closedhand.com makes the Closedhand account with an account
// number, and this computer collects it once (anonymousClaim): the number,
// kept here sealed for My Account to show on request, the personal URL, and
// Managed Models, set up as for a subscriber. A Google or Microsoft sign-in
// waiting to claim is never sent.
const NUMBER = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{20}$/;
const grouped = (number) => number.match(/.{4}/g).join(' ');
async function claimAnonymous(months) {
  if (!(await termsAccepted())) throw new Error('Agree to the Terms and Privacy policy first.');
  months = Number(months);
  if (![3, 6, 9].includes(months)) throw new Error('Choose 3, 6 or 9 months.');
  const data = await call('claim-anonymous', 'POST', { port: Number(process.env.PORT || 3000), acceptedTerms: true, months });
  if (data.state !== 'waiting' || !CRYPTO_PAGE.test(String(data.url))) throw new Error('Could not open the payment page. Please try again.');
  await setConf({ PHONE_ANONYMOUS_PENDING: JSON.stringify({ url: data.url, months }) });
  return { state: 'waiting', url: data.url, months };
}
// A claim waiting for its payment here: its payment page and months, or null.
async function anonymousWaiting() {
  try {
    const waiting = JSON.parse(await getConf('PHONE_ANONYMOUS_PENDING') || 'null');
    return waiting && CRYPTO_PAGE.test(String(waiting.url)) ? { url: waiting.url, months: [3, 6, 9].includes(waiting.months) ? waiting.months : null } : null;
  } catch (_) { return null; }
}
// Where that claim stands: waiting, ready (collected now, once) or expired
// (the invoice lapsed, so closedhand.com let the claim go).
async function anonymousClaim() {
  const waiting = await anonymousWaiting();
  if (!waiting) return { state: 'none' };
  const data = withIncludedAi(await call('claim-anonymous'));
  if (data.state === 'waiting') return { state: 'waiting', ...waiting };
  const number = String(data.accountNumber || '').replace(/\s/g, '');
  if (!NUMBER.test(number)) {
    await setConf({ PHONE_ANONYMOUS_PENDING: null });
    return { state: 'expired' };
  }
  const url = validAddress(data.url) ? data.url : null;
  await setConf({ PHONE_ANONYMOUS_PENDING: null, PHONE_ENROLLMENT: '2', PHONE_ANONYMOUS: '1', PHONE_ACCOUNT_NUMBER: encrypted(number), PHONE_ACCOUNT_NUMBER_SAVED: null,
    ...(url ? { PHONE_ADDRESS_NAME: new URL(url).hostname.split('.')[0] } : {}) });
  if (['pending', 'provisioning', 'connecting', 'active', 'error'].includes(data.state)) registrationState = data.state;
  return { state: 'ready', url, accountNumber: grouped(number) };
}
// What using Closedhand anonymously costs: each length paid ahead in crypto,
// with its price and its price a month, as closedhand.com shows them to
// anyone. Read at most every ten minutes.
let offer = { at: 0, crypto: [] };
async function anonymousOffer() {
  if (Date.now() - offer.at < 600000 && offer.crypto.length) return { crypto: offer.crypto };
  try {
    const response = await fetch(PROVIDER + '/api/managed-models', { redirect: 'error', signal: AbortSignal.timeout(8000) });
    const coins = response.ok ? lengths((await response.json()).crypto).filter((o) => [3, 6, 9].includes(o.months)) : [];
    offer = { at: Date.now(), crypto: coins };
  } catch (_) { offer = { at: Date.now(), crypto: [] }; }
  return { crypto: offer.crypto };
}
// The account number this computer was given, grouped as it is shown, or
// null (an account claimed with a sign-in, or claimed on another computer).
async function accountNumber() {
  const number = decryptString(await getConf('PHONE_ACCOUNT_NUMBER'));
  return number && NUMBER.test(number) ? grouped(number) : null;
}
// Setup asks for the number to be saved before going on, once.
async function accountNumberToSave() {
  return !!(await getConf('PHONE_ACCOUNT_NUMBER')) && (await getConf('PHONE_ACCOUNT_NUMBER_SAVED')) !== '1';
}
async function accountNumberSaved() { await setConf({ PHONE_ACCOUNT_NUMBER_SAVED: '1' }); }
// A claim's answer without the included AI's key, which is kept here (sealed)
// and set up as the models; nothing returned from here carries it.
function withIncludedAi(data) {
  const { included_ai: included, ...rest } = data || {};
  if (included) require('./included-ai-setup').receive(included).catch(e => console.error('[included ai] not kept:', e.message));
  return rest;
}
async function challenge(nonce) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error('Invalid challenge');
  const secret = (await credentials()).split('.').pop();
  return crypto.createHmac('sha256',secret).update('closedhand-address:'+nonce).digest('hex');
}
// This computer's Closedhand account, for My Account in the dashboard: the
// Google or Microsoft sign-ins that own its personal URL, its plan, this
// month's fair use as a share and the subscription. Null without one. Each field
// is taken only in the shape it should have.
async function account() {
  if (!(await getConf('PHONE_INSTALL_ID'))) return null;
  const found = (await call('account')).account;
  if (!found || !validAddress(found.url)) return null;
  const provider = (p) => ['microsoft', 'anonymous'].includes(p) ? p : 'google';
  if (found.provider === 'anonymous' && (await getConf('PHONE_ANONYMOUS')) !== '1') await setConf({ PHONE_ANONYMOUS: '1' });
  const text = (v) => typeof v === 'string' ? v.slice(0, 200) : null;
  const date = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
  const plan = found.plan && ['first-month', 'plus', 'ended', 'none', 'maintainer', 'ahead'].includes(found.plan.name) ? found.plan : null;
  const plus = found.plus && typeof found.plus === 'object' ? found.plus : null;
  const prices = plus?.prices && typeof plus.prices === 'object' ? plus.prices : {};
  return {
    provider: provider(found.provider), email: text(found.email), url: new URL(found.url).origin,
    ...(found.provider === 'anonymous' ? { anonymous: true, numberHere: !!(await getConf('PHONE_ACCOUNT_NUMBER')) } : {}),
    signIns: (Array.isArray(found.signIns) ? found.signIns : []).slice(0, 10).map((s) => ({ provider: provider(s?.provider), email: text(s?.email) })),
    plan: plan ? { name: plan.name, email: plan.email === true, ends_at: date(plan.ends_at), renews_at: date(plan.renews_at),
      fair_use_renews_at: date(plan.fair_use_renews_at), ...(plan.extended === true ? { extended: true } : {}),
      ...(plan.trial === true ? { trial: true } : {}), ...(plan.plus_trial === true ? { plus_trial: true } : {}),
      ...(plan.name === 'ended' ? { was: ['plus', 'first-month', 'ahead'].includes(plan.was) ? plan.was : null, ended_at: date(plan.ended_at) } : {}) } : null,
    used: typeof found.used === 'number' && found.used >= 0 && found.used <= 1 ? found.used : null,
    plus: plus ? { available: plus.available === true, active: plus.active === true, extended: plus.extended === true, nearly: plus.nearly === true,
      ...(plus.trial === true ? { trial: true } : {}), ...(plus.free_month === true ? { free_month: true } : {}),
      ends_at: date(plus.ends_at), renews_at: date(plus.renews_at), prices: { plus: text(prices.plus), extend: text(prices.extend), ...(text(prices.every) ? { every: text(prices.every) } : {}) },
      ...([6, 12].includes(plus.every) ? { every: plus.every } : {}),
      // Paid ahead in crypto until when; the other ways to pay, each length
      // with its price and its price a month; and carrying on in crypto.
      ...(date(plus.ahead_until) ? { ahead_until: date(plus.ahead_until) } : {}),
      longer: lengths(plus.longer), crypto: lengths(plus.crypto),
      ...(typeof plus.crypto_extend === 'string' ? { crypto_extend: plus.crypto_extend.slice(0, 20) } : {}),
      card: plus.card && /^\d{4}$/.test(String(plus.card.last4)) ? { brand: /^[A-Za-z ]{1,20}$/.test(String(plus.card.brand)) ? plus.card.brand : null, last4: plus.card.last4,
        expires: /^\d{2}\/\d{2}$/.test(String(plus.card.expires)) ? plus.card.expires : null } : null } : null,
  };
}
// A way to pay as closedhand.com offers it (the subscription every 6 or 12
// months, or paying ahead in crypto): each length a whole number of months
// with its price and its price a month.
function lengths(given) {
  return (Array.isArray(given) ? given : []).slice(0, 4)
    .filter((o) => Number.isInteger(o?.months) && o.months > 0 && o.months <= 24 && typeof o.price === 'string')
    .map((o) => ({ months: o.months, price: o.price.slice(0, 20), monthly: typeof o.monthly === 'string' ? o.monthly.slice(0, 20) : null }));
}
// The subscription in My Account, through closedhand.com: Polar's forms to frame
// here (only from Polar's own addresses), cancelling or keeping it, what was
// paid and its invoices. Each answer is taken only in the shape it should have.
const POLAR = /^https:\/\/([a-z]+\.)?polar\.sh\//;
// A crypto payment's page, on closedhand.com's own payment server.
const CRYPTO_PAGE = /^https:\/\/closedhand\.com\/pay\/[A-Za-z0-9]{8,64}$/;
const ORDER = /^[0-9a-f-]{36}$/;
async function plus(action, { kind, cancel, id, months, agreed } = {}) {
  if (!(await getConf('PHONE_INSTALL_ID'))) throw new Error('Claim your personal URL first.');
  const unexpected = () => new Error('Could not reach the payment service just now. Please try again.');
  // Subscribing (every month, 6 or 12), paying ahead in crypto, or carrying
  // on the way the plan is paid: Polar's page, or closedhand.com's own crypto
  // payment page.
  if (action === 'checkout') {
    const what = ['extend', 'ahead'].includes(kind) ? kind : 'plus';
    const { url } = await call('plus/checkout', 'POST', { kind: what, ...(what === 'extend' ? {} : { months: Number(months) || 1 }), agreed: agreed === true });
    const pages = { plus: [POLAR], extend: [POLAR, CRYPTO_PAGE], ahead: [CRYPTO_PAGE] }[what];
    if (!pages.some((page) => page.test(String(url)))) throw unexpected();
    return { url };
  }
  if (action === 'card') {
    const { token, web } = await call('plus/card', 'POST', {});
    if (typeof token !== 'string' || !/^https:\/\/(sandbox\.)?polar\.sh$/.test(String(web))) throw unexpected();
    return { token, web };
  }
  if (action === 'cancel') {
    await call('plus/cancel', 'POST', { cancel: cancel === true });
    return { done: true };
  }
  if (action === 'payments') {
    const { payments } = await call('plus/payments');
    const date = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
    // A crypto payment has no invoice to fetch: its id is BTCPay's, kept apart.
    const crypto = (p) => p?.crypto === true && /^btcpay:[A-Za-z0-9]{8,64}$/.test(String(p?.id));
    return (Array.isArray(payments) ? payments : []).slice(0, 24).filter((p) => ORDER.test(String(p?.id)) || crypto(p))
      .map((p) => ({ id: p.id, at: date(p.at), what: ['extend', 'ahead'].includes(p.what) ? p.what : 'plus',
        ...(p.what !== 'extend' && Number.isInteger(p.months) && p.months > 0 && p.months <= 24 ? { months: p.months } : {}), ...(crypto(p) ? { crypto: true } : {}),
        amount: typeof p.amount === 'string' ? p.amount.slice(0, 20) : null, refunded: p.refunded === true }));
  }
  if (action === 'invoice') {
    if (!ORDER.test(String(id))) throw new Error('That invoice is not there.');
    const { url } = await call('plus/invoice?id=' + encodeURIComponent(id));
    if (!/^https:\/\//.test(String(url))) throw unexpected();
    return { url };
  }
  throw new Error('Unknown action');
}
// Delete this computer's Closedhand account on closedhand.com, then forget
// the personal URL here. Throws when closedhand.com can't do it, so the
// person can be told before anything else is deleted.
async function deleteAccount() {
  if (!(await getConf('PHONE_INSTALL_ID'))) return { deleted: false };
  const data = await call('account/delete', 'POST', {});
  await forget();
  await setConf({ PHONE_ANONYMOUS: null, PHONE_ACCOUNT_NUMBER: null, PHONE_ACCOUNT_NUMBER_SAVED: null, PHONE_ANONYMOUS_PENDING: null });
  return { deleted: data.deleted === true };
}
// What runs when closedhand.com says Closedhand runs on another computer now
// (server.js): one Closedhand runs for an account.
let replacedHook = null;
function onReplaced(fn) { replacedHook = fn; }

async function forget() {
  registrationState = null;
  await setConf({ PHONE_PERMANENT_URL: null, PHONE_RELAY: null, PHONE_ADDRESS_NAME: null, PHONE_ENROLLMENT: null });
}
function status() {
  return { registrationState, ownershipConfirmed: ['pending', 'provisioning', 'connecting', 'active', 'error'].includes(registrationState) };
}
module.exports = { onReplaced, begin, claim, claimWithSignIn, claimAnonymous, anonymousWaiting, anonymousClaim, anonymousOffer, anonymous, accountNumber, accountNumberToSave, accountNumberSaved, termsAccepted, acceptTerms, addSignIn, rename, cleanName, connection, validAddress, confirm, challenge, status, serviceAvailable, includedAiOffered, includedAiModel, includedAiState, account, plus, deleteAccount };
