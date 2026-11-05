// The Managed Models subscription: Closedhand Managed Models carried on after the free month, paid
// every month, every 6 months or every 12 (one product for each, for less a
// month the longer it is), renewing until cancelled. Polar sells it (it is
// the merchant of record: it takes the card, charges tax and handles refunds),
// so nothing about a payment is kept here, only what the subscription allows.
// The person subscribes from their account on closedhand.com; Polar tells
// closedhand.com what happened through signed webhooks; the account's NEAR AI
// key (included-ai.js) is then set to the fair-use ceiling, or stopped when the
// subscription ends. However long the paid period, the fair use is a month's
// and renews each month of it (lib/months.js fairUseMonth). Cancelling stops
// the next renewal and the period paid runs to its end. Managing or cancelling
// happens in Polar's customer portal. Past fair use, a one-time purchase
// carries the person on to the end of the month. Paying ahead in crypto
// instead is lib/ahead.js.
const crypto = require('crypto');
const { equal } = require('./session');
const { fairUseMonth } = require('./months');

const LIVE = ['active', 'trialing', 'past_due'];
// Most of a month's fair use: the account page offers carrying on from here.
const NEARLY_USED = 0.8;
// The currency each country pays in: pounds in the UK and its islands, euros
// in the euro area, dollars everywhere else.
const EURO = new Set(['AT', 'BE', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES', 'AD', 'MC', 'SM', 'VA', 'ME', 'XK']);
function currencyFor(country) {
  const code = String(country || '').toUpperCase();
  if (['GB', 'GG', 'JE', 'IM'].includes(code)) return 'gbp';
  if (EURO.has(code)) return 'eur';
  return 'usd';
}
// Polar's clock and ours may differ a little; anything older is a replay.
const TOLERANCE_S = 5 * 60;

// The keys a webhook may be signed with. A secret made since 8 September 2026
// is a Standard Webhooks secret: "whsec_" then the key in base64. An older one
// signs with the UTF-8 bytes of the whole string. Both are tried, as Polar's
// own libraries do.
function signingKeys(secret) {
  const keys = [Buffer.from(secret, 'utf8')];
  const encoded = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    const key = Buffer.from(encoded, 'base64');
    if (key.length >= 16) keys.unshift(key);
  }
  return keys;
}

// Standard Webhooks: webhook-signature carries one or more "v1,<base64>",
// each an HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<body>".
function verify(headers, raw, secret, now = Date.now()) {
  const id = headers['webhook-id'], at = headers['webhook-timestamp'], signature = headers['webhook-signature'];
  if (!secret || !id || !at || !signature || !Buffer.isBuffer(raw)) return false;
  const seconds = Number(at);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > TOLERANCE_S) return false;
  const signed = Buffer.concat([Buffer.from(`${id}.${at}.`, 'utf8'), raw]);
  const given = String(signature).split(' ').map(part => part.split(',')).filter(([v, sig]) => v === 'v1' && sig).map(([, sig]) => sig);
  return signingKeys(secret).some(key => {
    const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');
    return given.some(sig => equal(sig, expected));
  });
}

// What the person agrees to before a payment that charges at once.
const AGREE = 'Tick the box first: this payment starts straight away.';

function create({ db, env = process.env, request = fetch, includedAi, ahead = null, baseUrl = 'https://closedhand.com' }) {
  const API = env.POLAR_SERVER === 'sandbox' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh';
  // Where Polar's own forms are served, to frame in My Account.
  const WEB = env.POLAR_SERVER === 'sandbox' ? 'https://sandbox.polar.sh' : 'https://polar.sh';
  const token = String(env.POLAR_ACCESS_TOKEN || '');
  const webhookSecret = String(env.POLAR_WEBHOOK_SECRET || '');
  const plusProduct = String(env.POLAR_PLUS_PRODUCT_ID || '');
  const extendProduct = String(env.POLAR_EXTEND_PRODUCT_ID || '');
  // The subscription renewing every 6 or 12 months: a product for each.
  const longProducts = { 6: String(env.POLAR_6_MONTHS_PRODUCT_ID || ''), 12: String(env.POLAR_12_MONTHS_PRODUCT_ID || '') };
  // How many months a subscription product renews every, or 0 for any other product.
  const everyOf = product => !product ? 0 : product === plusProduct ? 1 : Number(Object.keys(longProducts).find(m => longProducts[m] === product)) || 0;
  const enabled = () => !!(token && webhookSecret && plusProduct && includedAi?.enabled());
  const longerOn = () => enabled() && !!longProducts[6] && !!longProducts[12];
  const ours = product => !!product && (everyOf(product) > 0 || product === extendProduct);

  async function api(path, method = 'GET', body) {
    const response = await request(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!response.ok) throw Object.assign(new Error(`Polar answered ${response.status} to ${method} ${path}`), { status: response.status, reason: String(json?.error || '') });
    return json;
  }

  async function row(ownerId) {
    return (await db.query('SELECT * FROM plus_subscriptions WHERE owner_id = $1', [ownerId])).rows[0] || null;
  }

  // Stops a subscription at Polar now. Gone already, or already cancelled, is
  // done; any other refusal (a token without the right to cancel answers 403
  // too) throws, so whatever asked tries again.
  async function revoke(subscriptionId) {
    try { await api('/v1/subscriptions/' + encodeURIComponent(subscriptionId), 'DELETE'); }
    catch (e) { if (e.status !== 404 && !(e.status === 403 && /AlreadyCanceled/i.test(e.reason))) throw e; }
  }
  // Gives a payment back in full, for a purchase that bought nothing. One
  // already given back is done; any other refusal (a token without the right
  // to refund) throws, so Polar sends the event again.
  async function refund(order, reason) {
    const amount = Number(order.refundable_amount ?? order.net_amount ?? 0);
    if (typeof order.id !== 'string' || !(amount > 0)) return;
    try { await api('/v1/refunds/', 'POST', { order_id: order.id, reason, amount }); }
    catch (e) { if (!(e.status === 403 && /refund/i.test(e.reason))) throw e; }
  }
  // A subscription as Polar has it now, or null when Polar has none.
  async function atPolar(subscriptionId) {
    try { return await api('/v1/subscriptions/' + encodeURIComponent(subscriptionId)); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }
  // Whether the account already holds another subscription that Polar still
  // runs: then this one is a second one and buys nothing. One Polar has ended
  // whose last event is still on its way is not.
  async function holdsAnother(ownerId, subscriptionId) {
    const held = await row(ownerId);
    if (!held || held.polar_subscription_id === subscriptionId || !LIVE.includes(held.status)) return false;
    return LIVE.includes(String((await atPolar(held.polar_subscription_id))?.status || ''));
  }

  // What the account page and the person's computer are told: whether it is
  // on, when it renews or ends, and whether most of this month's fair use is
  // used. Never anything about the payment or an amount.
  async function state(ownerId) {
    const sub = ownerId ? await row(ownerId) : null;
    const active = !!sub && LIVE.includes(sub.status);
    const until = sub?.current_period_end ? new Date(sub.current_period_end).toISOString() : null;
    const plan = ahead && ownerId ? await ahead.running(ownerId) : null;
    const used = active || plan ? await includedAi.usage(ownerId).catch(() => null) : null;
    const month = active ? fairUseMonth(sub) : null;
    return {
      available: enabled(),
      active,
      // Renewing every 6 or 12 months rather than every month.
      ...(active && Number(sub.every_months) > 1 ? { every: Number(sub.every_months) } : {}),
      // Paid ahead in crypto, until when.
      ...(plan ? { ahead_until: new Date(plan.ends_at).toISOString() } : {}),
      // In its free first month, or able to start with one.
      ...(active && sub.status === 'trialing' ? { trial: true } : {}),
      ...(ownerId && await freeMonth(ownerId) ? { free_month: true } : {}),
      ...(active && until ? (sub.cancel_at_period_end ? { ends_at: until } : { renews_at: until }) : {}),
      // This month of fair use carried on already, by card or in crypto.
      extended: active ? !!month && !!sub.extended_for && new Date(sub.extended_for).getTime() === month.from.getTime() : !!plan && ahead.extended(plan),
      nearly: !!used && used.used >= used.limit * NEARLY_USED,
    };
  }

  // The prices people see, in their own currency: Polar charges in the
  // currency it picks from where they are, and the page says the same. Read
  // from the products (each has a price per currency, in cents) once an hour.
  let priced = { at: 0, list: null };
  async function priceList() {
    if (priced.list && Date.now() - priced.at < 3600000) return priced.list;
    const list = {};
    for (const [name, id] of [['plus', plusProduct], ['extend', extendProduct], ['6', longProducts[6]], ['12', longProducts[12]]]) {
      if (!id) continue;
      const product = await api('/v1/products/' + encodeURIComponent(id));
      list[name] = {};
      for (const price of product?.prices || []) {
        if (price.amount_type === 'fixed' && !price.is_archived && Number.isInteger(price.price_amount)) list[name][String(price.price_currency).toLowerCase()] = price.price_amount;
      }
    }
    priced = { at: Date.now(), list };
    return list;
  }
  // "£6", "€7" or "$8" for where the person is (Cloudflare's country), or
  // null when Polar's prices can't be read just now.
  async function prices(country) {
    if (!enabled()) return null;
    try {
      const list = await priceList();
      const want = currencyFor(country);
      const label = (amounts) => {
        if (!amounts) return null;
        const currency = amounts[want] !== undefined ? want : amounts.usd !== undefined ? 'usd' : Object.keys(amounts)[0];
        return currency ? money(amounts[currency], currency) : null;
      };
      return { plus: label(list.plus), extend: label(list.extend) };
    } catch (e) {
      console.error('[plus] prices:', e.message);
      return null;
    }
  }

  // The subscription every 6 or 12 months where the person is: each with its
  // price and what that comes to a month. Empty when off or unreadable.
  async function longerPrices(country) {
    if (!longerOn()) return [];
    try {
      const list = await priceList();
      const want = currencyFor(country), out = [];
      for (const months of [6, 12]) {
        const amounts = list[String(months)];
        if (!amounts) continue;
        const currency = amounts[want] !== undefined ? want : amounts.usd !== undefined ? 'usd' : Object.keys(amounts)[0];
        if (currency) out.push({ months, price: money(amounts[currency], currency), monthly: money(Math.round(amounts[currency] / months), currency) });
      }
      return out;
    } catch (e) {
      console.error('[plus] prices:', e.message);
      return [];
    }
  }

  // "£6", "€7" or "$8": an amount in cents, as people in that currency write it.
  function money(cents, currency) {
    if (!Number.isInteger(cents) || typeof currency !== 'string') return null;
    const locale = { gbp: 'en-GB', eur: 'en-IE' }[currency.toLowerCase()] || 'en-US';
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(cents / 100);
  }

  // Polar's checkout for one product, tied to this account by its own ID, so
  // the webhooks that follow can name it. origin: the personal URL that frames
  // it in My Account, which Polar then lets show it.
  // Each person has 14 free days of Managed Models, set up when they claim
  // their personal URL; someone who did not get them then has them as the
  // subscription's first 14 days instead (INCLUDED_AI_TRIAL_DAYS, so both
  // free periods are the same length): Polar takes the card, charges nothing
  // until they end and emails three days before they do (Polar's trials).
  // Once had, never again; any trial set on the product in Polar is turned off
  // for everyone else.
  async function freeMonth(ownerId) {
    return enabled() && !!ownerId && !(await row(ownerId)) && !(await includedAi.hadFreeMonth(ownerId));
  }
  async function checkoutFor(owner, product, back, origin, trial = false, extra = {}) {
    const made = await api('/v1/checkouts/', 'POST', {
      products: [product],
      ...(trial ? { trial_interval: 'day', trial_interval_count: includedAi.trialDays } : { allow_trial: false }),
      external_customer_id: owner.id,
      ...(owner.email ? { customer_email: owner.email } : {}),
      success_url: baseUrl + '/account?plus=' + back,
      ...(origin ? { embed_origin: origin } : {}),
      metadata: { owner_id: owner.id, ...extra },
    });
    if (typeof made?.url !== 'string' || !made.url.startsWith('https://')) throw new Error('Polar did not return a checkout');
    return made.url;
  }
  // Subscribing every month, or every 6 or 12 months. Only the monthly one
  // starts with the free days, for someone who never had them.
  const checkout = async (owner, origin, every = 1) => every === 1
    ? checkoutFor(owner, plusProduct, 'welcome', origin, await freeMonth(owner.id))
    : checkoutFor(owner, longProducts[every], 'welcome', origin);
  const extend = (owner, origin) => checkoutFor(owner, extendProduct, 'extended', origin);
  // Why subscribing this way can't start now, as words for the person, or
  // null when it can: the lengths there are, and agreeing first to a payment
  // that charges at once (any but the monthly one with free days first).
  async function cannotSubscribe(owner, every, agreed) {
    if (![1, 6, 12].includes(every) || (every > 1 && !longerOn())) return 'Choose every month, every 6 months or every 12 months.';
    if (agreed !== true && !(every === 1 && await freeMonth(owner.id))) return AGREE;
    return null;
  }

  // My Account's subscription, asked for by the person's computer. Each answers
  // null when there is nothing to do it to.
  // Polar's form for the card, framed on the personal URL: a short session
  // for this account's customer at Polar, which can do nothing else here.
  async function cardSession(ownerId) {
    const sub = await row(ownerId);
    if (!sub || !LIVE.includes(sub.status)) return null;
    const made = await api('/v1/customer-sessions/', 'POST', { external_customer_id: ownerId });
    if (typeof made?.token !== 'string') throw new Error('Polar did not return a session');
    return { token: made.token, web: WEB };
  }
  // The card the subscription is paid with, as Polar shows it to its own
  // customer: brand, last four digits and expiry, never kept here. Read
  // through a short customer session, the only way Polar gives it.
  async function cardOnFile(ownerId) {
    const sub = await row(ownerId);
    if (!sub || !LIVE.includes(sub.status)) return null;
    const made = await api('/v1/customer-sessions/', 'POST', { external_customer_id: ownerId });
    if (typeof made?.token !== 'string') return null;
    const portal = async (path) => {
      const response = await request(API + path, { headers: { Authorization: 'Bearer ' + made.token, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      return response.ok ? response.json() : null;
    };
    const [me, list] = await Promise.all([portal('/v1/customer-portal/customers/me'), portal('/v1/customer-portal/customers/me/payment-methods?limit=10')]);
    const cards = (list?.items || []).filter(m => /^\d{4}$/.test(String(m?.method_metadata?.last4 || '')));
    const card = cards.find(m => m.id === me?.default_payment_method_id) || cards[0];
    if (!card) return null;
    const { brand, last4, exp_month: month, exp_year: year } = card.method_metadata;
    return {
      brand: typeof brand === 'string' ? brand.slice(0, 20) : null,
      last4,
      expires: Number.isInteger(month) && Number.isInteger(year) ? String(month).padStart(2, '0') + '/' + String(year).slice(-2) : null,
    };
  }
  // Cancelling keeps the subscription to the end of the paid month, and until then
  // it can be kept after all.
  async function setCancel(ownerId, cancel) {
    const sub = await row(ownerId);
    if (!sub || !LIVE.includes(sub.status)) return null;
    const now = await api('/v1/subscriptions/' + encodeURIComponent(sub.polar_subscription_id), 'PATCH', { cancel_at_period_end: cancel === true });
    await db.query('UPDATE plus_subscriptions SET cancel_at_period_end = $3, updated_at = now() WHERE owner_id = $1 AND polar_subscription_id = $2',
      [ownerId, sub.polar_subscription_id, now?.cancel_at_period_end === true]);
    return state(ownerId);
  }
  // The customer Polar knows this account as, from its subscription, or null.
  const customerOf = async ownerId => (await row(ownerId))?.polar_customer_id || null;
  // What this account paid for, newest first: when, which and how much, by
  // card and in crypto.
  async function payments(ownerId) {
    const customer = await customerOf(ownerId);
    const list = customer ? await api('/v1/orders/?customer_id=' + encodeURIComponent(customer) + '&sorting=-created_at&limit=24') : null;
    const card = (list?.items || [])
      .filter(o => typeof o.id === 'string' && ours(o.product_id) && ['paid', 'refunded', 'partially_refunded'].includes(o.status))
      .map(o => ({ id: o.id, at: o.created_at, what: o.product_id === extendProduct ? 'extend' : 'plus',
        ...(everyOf(o.product_id) > 1 ? { months: everyOf(o.product_id) } : {}), amount: money(o.total_amount, o.currency), refunded: o.status === 'refunded' }));
    const coins = ahead ? await ahead.cryptoPayments(ownerId) : [];
    return [...card, ...coins].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 24);
  }
  // One payment's invoice to download, made the first time it is asked for;
  // its receipt when Polar can't make an invoice for it.
  async function invoice(ownerId, orderId, wait = ms => new Promise(r => setTimeout(r, ms))) {
    if (!/^[0-9a-f-]{36}$/.test(String(orderId))) return null;
    const customer = await customerOf(ownerId);
    if (!customer) return null;
    const path = '/v1/orders/' + encodeURIComponent(orderId);
    let order;
    try { order = await api(path); } catch (e) { if (e.status === 404) return null; throw e; }
    if (order?.customer_id !== customer) return null;
    let made = order.is_invoice_generated === true;
    if (!made) {
      try { await api(path + '/invoice', 'POST'); made = true; }
      catch (e) { if (e.status !== 409 && e.status !== 422) throw e; made = e.status === 409; }
    }
    for (let i = 0; made && i < 6; i++) {
      try { const got = await api(path + '/invoice'); if (typeof got?.url === 'string' && got.url.startsWith('https://')) return got.url; }
      catch (e) { if (e.status !== 404) throw e; }
      await wait(1000);
    }
    const receipt = await api(path + '/receipt').catch(() => null);
    return typeof receipt?.url === 'string' && receipt.url.startsWith('https://') ? receipt.url : null;
  }

  // Polar's customer portal, where the person changes their card, sees their
  // invoices or cancels.
  async function portal(owner) {
    const made = await api('/v1/customer-sessions/', 'POST', { external_customer_id: owner.id, return_url: baseUrl + '/account' });
    if (typeof made?.customer_portal_url !== 'string') throw new Error('Polar did not return a portal');
    return made.customer_portal_url;
  }

  // The key made to match the subscription, now or by the hourly sweep. A
  // subscription that never went through leaves the free use alone; only one
  // that was active and has ended stops the key.
  async function sync(ownerId) {
    // With Managed Models switched off nothing can be set: left for the sweep.
    if (!includedAi.enabled()) return;
    const sub = (await db.query('SELECT status, started_at, updated_at::text AS stamp FROM plus_subscriptions WHERE owner_id = $1', [ownerId])).rows[0];
    if (!sub) return;
    if (LIVE.includes(sub.status)) await includedAi.subscribe(ownerId);
    else if (sub.started_at) await includedAi.end(ownerId);
    // Only if nothing changed meanwhile; a newer event syncs again.
    await db.query('UPDATE plus_subscriptions SET key_synced = true WHERE owner_id = $1 AND updated_at::text = $2', [ownerId, sub.stamp]);
  }
  const syncLater = ownerId => { sync(ownerId).catch(e => console.error('[plus] key not set yet:', e.message)); };

  // Which account an event is about: the ID it was sold under, or the
  // checkout's metadata. Only accounts that still exist.
  async function ownerOf(data) {
    const id = data?.customer?.external_id || data?.metadata?.owner_id;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
    return (await db.query('SELECT id FROM owners WHERE id = $1', [id])).rows[0]?.id || null;
  }

  // One webhook event. Returns what was done, for the log.
  async function handle(event) {
    const type = String(event?.type || ''), data = event?.data || {};
    if (type.startsWith('subscription.')) {
      const every = everyOf(data.product_id);
      if (!every) return 'another product';
      const ownerId = await ownerOf(data);
      const status = String(data.status || '');
      if (typeof data.id !== 'string') return 'no account';
      // Bought for an account that no longer exists (deleted during checkout):
      // it gives nothing, so it is stopped and nobody is charged again.
      if (!ownerId) {
        if (!LIVE.includes(status)) return 'no account';
        await revoke(data.id);
        return 'no account, stopped';
      }
      // Two checkouts at once: the second subscription is stopped, and its
      // payment is given back as it arrives (order.paid).
      if (LIVE.includes(status) && await holdsAnother(ownerId, data.id)) {
        await revoke(data.id);
        return 'a second subscription, stopped';
      }
      const at = data.modified_at || data.created_at || event.timestamp || null;
      // A newer event wins; an older one for the same subscription, or an
      // ended old subscription after a new one began, changes nothing.
      const saved = await db.query(
        `INSERT INTO plus_subscriptions (owner_id, polar_customer_id, polar_subscription_id, status, current_period_end, cancel_at_period_end, started_at, key_synced, event_at, updated_at, current_period_start, every_months)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 = ANY($8::text[]) THEN now() END, false, $7, now(), $9, $10)
         ON CONFLICT (owner_id) DO UPDATE SET polar_customer_id = EXCLUDED.polar_customer_id, polar_subscription_id = EXCLUDED.polar_subscription_id,
           status = EXCLUDED.status, current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           every_months = EXCLUDED.every_months,
           started_at = COALESCE(plus_subscriptions.started_at, EXCLUDED.started_at), key_synced = false, event_at = EXCLUDED.event_at, updated_at = now()
         WHERE (plus_subscriptions.polar_subscription_id = EXCLUDED.polar_subscription_id
                AND (plus_subscriptions.event_at IS NULL OR EXCLUDED.event_at IS NULL OR EXCLUDED.event_at >= plus_subscriptions.event_at))
            OR (plus_subscriptions.polar_subscription_id <> EXCLUDED.polar_subscription_id
                AND (EXCLUDED.status = ANY($8::text[]) OR NOT plus_subscriptions.status = ANY($8::text[])))
         RETURNING owner_id`,
        [ownerId, data.customer_id || data.customer?.id || null, data.id, status, data.current_period_end || null, data.cancel_at_period_end === true, at, LIVE, data.current_period_start || null, every]);
      if (!saved.rowCount) return 'older than what is known';
      syncLater(ownerId);
      return 'subscription ' + status;
    }
    // A payment that bought nothing is given back in full: one for an account
    // that no longer exists, for a second subscription, or a carry-on that
    // can't carry anything on. Sent again, the same order changes nothing.
    if (type === 'order.paid') {
      const product = data.product_id || data.product?.id;
      if (!ours(product)) return 'another product';
      const ownerId = await ownerOf(data);
      if (everyOf(product)) {
        if (!ownerId || (data.subscription_id && await holdsAnother(ownerId, data.subscription_id))) {
          if (data.subscription_id) await revoke(data.subscription_id);
          await refund(data, ownerId ? 'duplicate' : 'other');
          return ownerId ? 'a second subscription, given back' : 'no account, given back';
        }
        return 'paid';
      }
      // Carrying on is for the month of fair use running now.
      const held = ownerId && await row(ownerId);
      const month = held && LIVE.includes(held.status) ? fairUseMonth(held) : null;
      const updated = month && await db.query(
        `UPDATE plus_subscriptions SET extended_for = $4, extended_order = $3, key_synced = false, updated_at = now()
          WHERE owner_id = $1 AND status = ANY($2::text[]) AND (extended_for IS DISTINCT FROM $4 OR extended_order = $3) RETURNING owner_id`,
        [ownerId, LIVE, String(data.id || ''), month.from]);
      if (!updated?.rowCount) {
        await refund(data, ownerId ? 'duplicate' : 'other');
        return 'nothing to carry on, given back';
      }
      syncLater(ownerId);
      return 'carried on to the end of the month';
    }
    // A payment given back in full stops what it paid for: the subscription,
    // when it paid for the period running now (Polar's revoked event then
    // stops the key), or this month's carry-on. Part given back changes nothing.
    if (type === 'order.refunded') {
      const product = data.product_id || data.product?.id;
      if (data.status !== 'refunded' || !ours(product)) return 'nothing to stop';
      const ownerId = await ownerOf(data);
      const held = ownerId && await row(ownerId);
      if (!held) return 'no account';
      if (everyOf(product)) {
        if (!data.subscription_id || held.polar_subscription_id !== data.subscription_id || !LIVE.includes(held.status)) return 'nothing to stop';
        const sub = await atPolar(data.subscription_id);
        const from = Date.parse(sub?.current_period_start || '');
        if (Number.isFinite(from) && Date.parse(data.created_at || '') < from - 86400000) return 'an earlier month, nothing to stop';
        await revoke(data.subscription_id);
        return 'given back, stopped';
      }
      const ended = await db.query(
        'UPDATE plus_subscriptions SET extended_for = NULL, extended_order = NULL, key_synced = false, updated_at = now() WHERE owner_id = $1 AND extended_order = $2 RETURNING owner_id',
        [ownerId, String(data.id || '')]);
      if (!ended.rowCount) return 'nothing to stop';
      syncLater(ownerId);
      return 'given back, carry-on ended';
    }
    return 'not used';
  }

  // Run hourly: a subscription whose paid month should have rolled over an
  // hour ago is read from Polar again, in case its renewal (or its end) never
  // reached closedhand.com; then any key not yet set to match its
  // subscription (NEAR AI was unreachable) is tried again.
  async function sweep() {
    if (!enabled()) return 0;
    const overdue = (await db.query(
      `SELECT owner_id, polar_subscription_id FROM plus_subscriptions
        WHERE status = ANY($1::text[]) AND current_period_end < now() - interval '1 hour' ORDER BY current_period_end LIMIT 50`, [LIVE])).rows;
    for (const { owner_id: ownerId, polar_subscription_id: id } of overdue) {
      try {
        const now = await atPolar(id);
        if (!now) continue;
        await db.query(
          `UPDATE plus_subscriptions SET status = $3, current_period_start = $4, current_period_end = $5, cancel_at_period_end = $6, key_synced = false, updated_at = now()
            WHERE owner_id = $1 AND polar_subscription_id = $2`,
          [ownerId, id, String(now.status || ''), now.current_period_start || null, now.current_period_end || null, now.cancel_at_period_end === true]);
      } catch (e) { console.error('[plus] could not read a subscription from Polar:', e.message); }
    }
    const unsynced = (await db.query('SELECT owner_id FROM plus_subscriptions WHERE NOT key_synced ORDER BY updated_at LIMIT 50')).rows;
    for (const { owner_id: ownerId } of unsynced) await sync(ownerId).catch(e => console.error('[plus] sweep:', e.message));
    // A subscription paid for 6 or 12 months begins each month's fair use as
    // that month begins.
    const long = (await db.query(
      `SELECT s.owner_id, s.current_period_start, s.current_period_end, s.every_months, k.base_for FROM plus_subscriptions s
         JOIN included_ai_keys k ON k.owner_id = s.owner_id WHERE s.status = ANY($1::text[]) AND s.every_months > 1 LIMIT 500`, [LIVE])).rows;
    for (const held of long) {
      const month = fairUseMonth(held);
      if (!month || (held.base_for && new Date(held.base_for).getTime() === month.from.getTime())) continue;
      await includedAi.subscribe(held.owner_id).catch(e => console.error('[plus] month not begun:', e.message));
    }
    return unsynced.length;
  }

  // Deleting an account first stops its subscription at Polar, so nobody is
  // charged for an account that no longer exists. Throws when Polar could not
  // be reached, so the deletion waits for a retry.
  async function forget(ownerId) {
    const sub = await row(ownerId);
    if (!sub || !LIVE.includes(sub.status)) return false;
    // A refusal keeps the account, so nobody is billed for one that no longer exists.
    await revoke(sub.polar_subscription_id);
    return true;
  }

  // The account page's buttons, for the signed-in person on closedhand.com.
  function register(app, { sessions }) {
    const signedIn = async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const ownerId = sessions.owner(req);
      if (!ownerId) { res.status(401).json({ error: 'Sign in to your Closedhand account first.' }); return null; }
      if (req.headers.origin !== baseUrl) { res.status(403).json({ error: 'Open this on closedhand.com.' }); return null; }
      if (!enabled()) { res.status(503).json({ error: 'Subscribing is not available yet.' }); return null; }
      const owner = (await db.query('SELECT id, email FROM owners WHERE id = $1', [ownerId])).rows[0];
      if (!owner) { res.status(401).json({ error: 'Sign in to your Closedhand account first.' }); return null; }
      return owner;
    };
    const route = (path, fn) => app.post(path, async (req, res) => {
      try {
        const owner = await signedIn(req, res);
        if (owner) await fn(owner, req, res);
      } catch (e) {
        console.error('[plus]', path, e.message);
        res.status(503).json({ error: 'Could not reach the payment service just now. Please try again.' });
      }
    });
    route('/api/plus/checkout', async (owner, req, res) => {
      const now = await state(owner.id);
      if (now.active) return res.status(409).json({ error: 'You already subscribe to Managed Models.' });
      if (now.ahead_until) return res.status(409).json({ error: 'Closedhand Managed Models are paid ahead in crypto for your account, so there is no subscription by card to start.' });
      const address = (await db.query("SELECT 1 FROM addresses WHERE owner_id = $1 AND state <> 'revoked'", [owner.id])).rowCount;
      if (!address) return res.status(409).json({ error: 'Claim your personal URL from Closedhand on your computer first.' });
      const every = Number(req.body?.months || 1);
      const why = await cannotSubscribe(owner, every, req.body?.agreed);
      if (why) return res.status(400).json({ error: why });
      res.json({ url: await checkout(owner, undefined, every) });
    });
    route('/api/plus/extend', async (owner, req, res) => {
      const now = await state(owner.id);
      if (!now.active) return res.status(409).json({ error: 'Carrying on by card is for a subscription by card.' });
      if (now.extended || !extendProduct) return res.status(409).json({ error: 'You can already carry on to the end of this month.' });
      if (req.body?.agreed !== true) return res.status(400).json({ error: AGREE });
      res.json({ url: await extend(owner) });
    });
    // Carrying on, from the link in Closedhand's chat: the account page,
    // which opens My Account where the person's Closedhand answers. Paying to
    // carry on starts straight away, so the box is ticked there first.
    app.get('/carry-on', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.redirect(302, '/account');
    });
    // Subscribing, from the link in Closedhand's chat: signed in, one tap
    // goes to Polar's page, to manage the subscription while it runs or else
    // to take it out with the free days first; signed out, it is sign in
    // first, then on. Anything else goes to the account page, which says why,
    // and where subscribing that charges at once has its box to tick first.
    app.get('/subscribe', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const ownerId = sessions.owner(req);
        if (!ownerId) return res.redirect(302, '/account?then=subscribe');
        const owner = enabled() && (await db.query('SELECT id, email FROM owners WHERE id = $1', [ownerId])).rows[0];
        if (!owner) return res.redirect(302, '/account');
        // The maintainer's own account has Managed Models for good: nothing to buy.
        if (await require('./maintainer').isMaintainer(db, env, owner.id)) return res.redirect(302, '/account');
        const now = await state(owner.id);
        if (now.active) return res.redirect(302, await portal(owner));
        if (now.ahead_until || !now.free_month) return res.redirect(302, '/account');
        const address = (await db.query("SELECT 1 FROM addresses WHERE owner_id = $1 AND state <> 'revoked'", [owner.id])).rowCount;
        if (!address) return res.redirect(302, '/account');
        res.redirect(302, await checkout(owner));
      } catch (e) {
        console.error('[plus] subscribe:', e.message);
        res.redirect(302, '/account');
      }
    });
    // What the Managed Models page shows (views/managed-models.html): the
    // prices where the person is (monthly, every 6 or 12 months, and in
    // crypto), the LLM Closedhand picks for them, and, when they are signed in
    // with a Closedhand of their own, whether to offer subscribing (nothing
    // when they already have it).
    app.get('/api/managed-models', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const ownerId = sessions.owner(req);
        const owner = ownerId && (await db.query('SELECT id FROM owners WHERE id = $1', [ownerId])).rows[0];
        const closedhand = !!owner && (await db.query("SELECT 1 FROM addresses WHERE owner_id = $1 AND state <> 'revoked'", [owner.id])).rowCount > 0;
        const mine = closedhand && await require('./maintainer').isMaintainer(db, env, owner.id);
        const now = closedhand && !mine ? await state(owner.id) : null;
        res.json({
          price: (await prices(req.get('cf-ipcountry')))?.plus || null,
          longer: await longerPrices(req.get('cf-ipcountry')),
          crypto: ahead ? ahead.options().crypto || [] : [],
          model: includedAi?.current()?.name || null,
          days: includedAi?.trialDays || 14,
          subscribe: !!now && now.available && !now.active && !now.ahead_until,
          subscribed: !!now?.active || !!mine,
          ...(now?.free_month ? { freeDays: true } : {}),
        });
      } catch (e) {
        console.error('[plus] managed models page:', e.message);
        res.json({ price: null, model: null, days: includedAi?.trialDays || 14, subscribe: false, subscribed: false });
      }
    });
    route('/api/plus/manage', async (owner, req, res) => {
      if (!(await row(owner.id))) return res.status(409).json({ error: 'You have not subscribed to Managed Models.' });
      res.json({ url: await portal(owner) });
    });
    // Polar's webhooks: the raw body is kept (server.js) for the signature.
    // Answered at once; the key follows in the background, as Polar asks.
    app.post('/api/plus/webhook', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!verify(req.headers, req.body, webhookSecret)) return res.status(403).json({ error: 'Invalid signature' });
      let event;
      try { event = JSON.parse(req.body.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'Invalid body' }); }
      try {
        const done = await handle(event);
        console.log(`[plus] ${String(event?.type).slice(0, 40)}: ${done}`);
        res.status(202).json({ ok: true });
      } catch (e) {
        // Polar tries again later.
        console.error('[plus] webhook:', e.message);
        res.status(500).json({ error: 'Could not record the event' });
      }
    });
  }

  return { enabled, state, prices, longerPrices, checkout, cannotSubscribe, extend, portal, cardSession, cardOnFile, setCancel, payments, invoice, row, handle, sweep, sync, forget, register, AGREE };
}

module.exports = { create, verify, signingKeys, currencyFor };
