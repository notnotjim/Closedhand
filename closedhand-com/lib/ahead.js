// Closedhand Managed Models paid ahead in crypto: 3, 6 or 9 months, once,
// through closedhand.com's own BTCPay Server, which watches the maintainer's wallets
// and can spend nothing. A payment starts a plan, or moves the end of one
// running on; it never renews by itself. Each month of it has the same fair
// use as a month of the subscription, from the day the plan began, with the
// same carry-over (lib/included-ai.js), carrying on past it is another
// month's fair use for this month, paid the same way, and Closedhand's own
// email address comes with it (migration 026). Paying ahead is for an account
// without a subscription by card; the maintainer's own account needs neither.
// Card plans, monthly or every 6 or 12 months, are subscriptions (lib/plus.js).
//
// What closedhand.com keeps of each payment (ahead_payments): BTCPay's invoice
// id, what it paid for, the amount and when. Nothing about the payer: an
// invoice carries only the account's id and what it is for.
//
// Using Closedhand anonymously is paid for first: the invoice names a claim
// waiting for its payment instead of an account (lib/addresses.js makes the
// account, its personal URL and its plan once the invoice settles, through
// onPendingClaim), and an invoice that expires or turns invalid discards it.
const crypto = require('crypto');
const { equal } = require('./session');
const { addMonths, monthIn } = require('./months');

const LIVE = ['active', 'trialing', 'past_due'];
const CRYPTO_MONTHS = [3, 6, 9];

// BTCPay signs each webhook: BTCPay-Sig is "sha256=" and the HMAC-SHA256 of
// the body, in hex, with the webhook's secret.
function verifyBtcpay(signature, raw, secret) {
  if (!secret || !Buffer.isBuffer(raw) || typeof signature !== 'string') return false;
  return equal(signature, 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'));
}

function create({ db, env = process.env, request = fetch, includedAi, baseUrl = 'https://closedhand.com' }) {
  const btcpay = {
    url: String(env.BTCPAY_URL || '').trim().replace(/\/+$/, ''),
    store: String(env.BTCPAY_STORE_ID || '').trim(),
    key: String(env.BTCPAY_API_KEY || '').trim(),
    secret: String(env.BTCPAY_WEBHOOK_SECRET || ''),
  };
  // Prices in US dollars, a month's worth a little dearer than by card for the
  // same length, which covers moving the coins on; carrying on costs a month.
  const cryptoUsd = { 3: Number(env.CRYPTO_3_MONTHS_USD || 90), 6: Number(env.CRYPTO_6_MONTHS_USD || 168), 9: Number(env.CRYPTO_9_MONTHS_USD || 243) };
  const extendUsd = Number(env.CRYPTO_EXTEND_USD || 30);
  // What an invoice may be paid with: USDT on Ethereum and Polygon, whose free
  // public servers keep up while BTCPay reads every block of an open invoice.
  // Tron's throttles that reading unless signed up for a key, and BSC makes
  // more than a block a second. Bitcoin is left out for now: its own node cost
  // far more to run than the payments it would take.
  const payWith = String(env.BTCPAY_PAYMENT_METHODS || 'USDT-ETHEREUM,USDT-POLYGON').split(',').map(s => s.trim()).filter(Boolean);
  const cryptoOn = () => btcpay.url.startsWith('https://') && !!btcpay.store && !!btcpay.key && !!btcpay.secret && !!includedAi?.enabled();
  // lib/addresses.js: what to do with a paid claim, and with one whose invoice lapsed.
  let pending = null;
  const onPendingClaim = handlers => { pending = handlers; };
  const usd = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);

  // The plan running now, or null.
  async function running(ownerId, now = new Date()) {
    if (!ownerId) return null;
    return (await db.query('SELECT starts_at, ends_at, extended_for FROM ahead_plans WHERE owner_id = $1 AND starts_at <= $2 AND ends_at > $2 AND ended_at IS NULL', [ownerId, now])).rows[0] || null;
  }
  // The month of a running plan: the fair use renews as the next begins.
  const monthOf = (plan, now = new Date()) => monthIn(plan.starts_at, now);
  // Whether this month of a running plan has been carried on already.
  const extended = (plan, now = new Date()) => !!plan?.extended_for && new Date(plan.extended_for).getTime() === monthOf(plan, now).from.getTime();

  // A payment for months ahead: starts a plan, or moves a running plan's end
  // on. The same payment twice changes nothing. True when it was new.
  async function grant(ownerId, months, { id, cents = null, currency = null }) {
    if (!ownerId || !Number.isInteger(months) || months < 1 || typeof id !== 'string') return false;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const fresh = await client.query(
        "INSERT INTO ahead_payments (id, owner_id, kind, months, amount_cents, currency) VALUES ($1, $2, 'plan', $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING id",
        [id, ownerId, months, Number.isInteger(cents) ? cents : null, currency ? String(currency).toLowerCase().slice(0, 3) : null]);
      if (!fresh.rowCount) { await client.query('ROLLBACK'); return false; }
      const now = new Date();
      const held = (await client.query('SELECT starts_at, ends_at, ended_at FROM ahead_plans WHERE owner_id = $1 FOR UPDATE', [ownerId])).rows[0];
      if (held && !held.ended_at && new Date(held.ends_at) > now) {
        await client.query('UPDATE ahead_plans SET ends_at = $2, updated_at = now() WHERE owner_id = $1', [ownerId, addMonths(held.ends_at, months)]);
      } else {
        await client.query(
          `INSERT INTO ahead_plans (owner_id, starts_at, ends_at) VALUES ($1, $2, $3)
             ON CONFLICT (owner_id) DO UPDATE SET starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, ended_at = NULL, extended_for = NULL, updated_at = now()`,
          [ownerId, now, addMonths(now, months)]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    // The key to this month now; failing that, the hourly sweep tries again.
    await includedAi.subscribe(ownerId).catch(e => console.error('[ahead] key not set yet:', e.message));
    return true;
  }

  // A payment to carry on past this month's fair use: another month's fair
  // use for the month running now. Counted once; a plan already carried on
  // this month, or not running, takes nothing more (the payment is kept and
  // the maintainer sorts it out with the person).
  async function carryOn(ownerId, { id, cents = null, currency = null }) {
    const fresh = await db.query(
      "INSERT INTO ahead_payments (id, owner_id, kind, months, amount_cents, currency) VALUES ($1, $2, 'extend', 0, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id",
      [id, ownerId, Number.isInteger(cents) ? cents : null, currency ? String(currency).toLowerCase().slice(0, 3) : null]);
    if (!fresh.rowCount) return 'already counted';
    const plan = await running(ownerId);
    if (!plan || extended(plan)) {
      console.error('[ahead] a carry-on paid with nothing to carry on: ' + id);
      return 'nothing to carry on';
    }
    await db.query('UPDATE ahead_plans SET extended_for = $2, updated_at = now() WHERE owner_id = $1', [ownerId, monthOf(plan).from]);
    await includedAi.subscribe(ownerId).catch(e => console.error('[ahead] key not set yet:', e.message));
    return 'carried on to the end of the month';
  }

  // A plan past its end stops the key where it stands, unless a subscription
  // has taken over.
  async function endIfOver(ownerId) {
    const over = await db.query('UPDATE ahead_plans SET ended_at = now(), updated_at = now() WHERE owner_id = $1 AND ended_at IS NULL AND ends_at <= now() RETURNING owner_id', [ownerId]);
    if (!over.rowCount) return false;
    const sub = (await db.query('SELECT 1 FROM plus_subscriptions WHERE owner_id = $1 AND status = ANY($2::text[])', [ownerId, LIVE])).rowCount;
    if (!sub) await includedAi.end(ownerId);
    return true;
  }

  // Run hourly: plans that have ended stop their keys, and a plan whose next
  // month has begun gets that month's fair use.
  async function sweep() {
    if (!includedAi?.enabled()) return 0;
    const over = (await db.query('SELECT owner_id FROM ahead_plans WHERE ended_at IS NULL AND ends_at <= now() ORDER BY ends_at LIMIT 100')).rows;
    for (const { owner_id: ownerId } of over) await endIfOver(ownerId).catch(e => console.error('[ahead] plan not ended:', e.message));
    const now = new Date();
    const live = (await db.query(
      `SELECT p.owner_id, p.starts_at, k.base_for FROM ahead_plans p JOIN included_ai_keys k ON k.owner_id = p.owner_id
        WHERE p.ended_at IS NULL AND p.starts_at <= now() AND p.ends_at > now() LIMIT 500`)).rows;
    for (const row of live) {
      if (row.base_for && new Date(row.base_for).getTime() === monthOf(row, now).from.getTime()) continue;
      await includedAi.subscribe(row.owner_id).catch(e => console.error('[ahead] month not begun:', e.message));
    }
    return over.length;
  }

  // What paying ahead in crypto costs, in US dollars: each length with its
  // price a month, and carrying on. Empty while crypto is off.
  function options() {
    if (!cryptoOn()) return {};
    return {
      crypto: CRYPTO_MONTHS.filter(m => cryptoUsd[m] > 0).map(m => ({ months: m, price: usd(cryptoUsd[m]), monthly: usd(Math.round(cryptoUsd[m] / m * 100) / 100) })),
      extend: usd(extendUsd),
    };
  }

  // Why this account can't pay ahead now, as words for it, or null when it can.
  async function refused(owner) {
    if (await require('./maintainer').isMaintainer(db, env, owner.id)) return 'The Closedhand subscription is already on for your account as the maintainer.';
    if ((await db.query('SELECT 1 FROM plus_subscriptions WHERE owner_id = $1 AND status = ANY($2::text[])', [owner.id, LIVE])).rowCount) {
      return 'You have the Closedhand subscription by card. Paying ahead in crypto is instead of a subscription by card.';
    }
    if (!(await db.query('SELECT 1 FROM addresses WHERE owner_id = $1', [owner.id])).rowCount) return 'Claim your personal URL from Closedhand on your computer first.';
    return null;
  }

  // A crypto payment's page: months ahead, or carrying on past this month's
  // fair use. Agreeing that it starts straight away comes first. Throws with
  // a status and words for the person.
  async function checkout(owner, { months, extend = false, agreed } = {}) {
    const no = (status, message) => Object.assign(new Error(message), { status });
    if (agreed !== true) throw no(400, 'Tick the box first: this payment starts straight away.');
    if (!cryptoOn()) throw no(503, 'Paying in crypto is not available just now.');
    if (extend) {
      const plan = await running(owner.id);
      if (!plan) throw no(409, 'Carrying on in crypto is for an account paid ahead in crypto.');
      if (extended(plan)) throw no(409, 'You can already carry on to the end of this month.');
      return invoice(owner, extendUsd, { extend: true });
    }
    const why = await refused(owner);
    if (why) throw no(409, why);
    const n = Number(months);
    if (!CRYPTO_MONTHS.includes(n)) throw no(400, 'Choose 3, 6 or 9 months.');
    return invoice(owner, cryptoUsd[n], { months: n });
  }

  // BTCPay's Greenfield API, with the store's own key.
  async function btcpayApi(path, method = 'GET', body) {
    const response = await request(btcpay.url + '/api/v1/stores/' + encodeURIComponent(btcpay.store) + path, {
      method,
      headers: { Authorization: 'token ' + btcpay.key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!response.ok) throw Object.assign(new Error(`BTCPay answered ${response.status} to ${method} ${path.split('/').slice(0, 2).join('/')}`), { status: response.status });
    return json;
  }

  // An invoice in US dollars for this account and what it is for, then its
  // checkout. Nothing about the payer: no email, no name.
  async function invoice(owner, amount, what) {
    const made = await btcpayApi('/invoices', 'POST', {
      amount: String(amount),
      currency: 'USD',
      metadata: { ownerId: owner.id, ...what },
      checkout: { redirectURL: baseUrl + '/account?plus=' + (what.extend ? 'carrying' : 'ahead'), redirectAutomatically: true, paymentMethods: payWith },
    });
    if (typeof made?.id !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(made.id)) throw new Error('BTCPay did not return an invoice');
    return baseUrl + '/pay/' + made.id;
  }

  // An invoice for a claim waiting to be paid, months ahead: its id and
  // checkout. Nothing about the payer, and no account yet.
  async function invoiceForClaim(claimId, months) {
    if (!cryptoOn()) throw Object.assign(new Error('Paying in crypto is not available just now.'), { status: 503 });
    if (!CRYPTO_MONTHS.includes(months)) throw Object.assign(new Error('Choose 3, 6 or 9 months.'), { status: 400 });
    const made = await btcpayApi('/invoices', 'POST', { amount: String(cryptoUsd[months]), currency: 'USD', metadata: { pendingClaim: claimId, months }, checkout: { paymentMethods: payWith } });
    if (typeof made?.id !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(made.id)) throw new Error('BTCPay did not return an invoice');
    return { id: made.id, url: baseUrl + '/pay/' + made.id };
  }

  // A settled invoice, read back from BTCPay itself rather than trusted from
  // the webhook: months ahead start or move on the plan, carrying on adds a
  // month's fair use to this month. An invoice expired, invalid or for
  // another store changes nothing.
  async function settled(invoiceId) {
    if (typeof invoiceId !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(invoiceId)) return 'no invoice';
    // BTCPay answers an invoice id it has never made with 403, not 404.
    const found = await btcpayApi('/invoices/' + encodeURIComponent(invoiceId)).catch(e => { if (e.status === 404 || e.status === 403) return null; throw e; });
    if (!found || found.status !== 'Settled') return 'not settled';
    const cents = Math.round(Number(found.amount) * 100);
    const paid = { id: 'btcpay:' + invoiceId, cents: Number.isFinite(cents) ? cents : null, currency: found.currency || 'USD' };
    const claimId = String(found.metadata?.pendingClaim || '');
    if (claimId) {
      const months = Number(found.metadata?.months);
      if (!/^[0-9a-f-]{36}$/.test(claimId) || !CRYPTO_MONTHS.includes(months) || !pending) return 'not ours';
      return pending.paid(claimId, months, paid);
    }
    const ownerId = String(found.metadata?.ownerId || '');
    if (!/^[0-9a-f-]{36}$/.test(ownerId)) return 'not ours';
    if (!(await db.query('SELECT 1 FROM owners WHERE id = $1', [ownerId])).rowCount) return 'no account';
    if (found.metadata?.extend === true) return carryOn(ownerId, paid);
    const months = Number(found.metadata?.months);
    if (!CRYPTO_MONTHS.includes(months)) return 'not ours';
    return await grant(ownerId, months, paid) ? `paid ahead ${months} months` : 'already counted';
  }

  // Crypto payments for an account, newest first, for My Account (card ones
  // are listed from Polar, lib/plus.js). Nothing about how but that it was crypto.
  async function cryptoPayments(ownerId) {
    const rows = (await db.query('SELECT id, kind, months, amount_cents, currency, paid_at FROM ahead_payments WHERE owner_id = $1 ORDER BY paid_at DESC LIMIT 24', [ownerId])).rows;
    return rows.map(r => ({ id: r.id, at: new Date(r.paid_at).toISOString(), what: r.kind === 'extend' ? 'extend' : 'ahead', ...(r.kind === 'plan' ? { months: r.months } : {}), crypto: true,
      amount: Number.isInteger(r.amount_cents) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: String(r.currency || 'usd').toUpperCase() }).format(r.amount_cents / 100) : null, refunded: false }));
  }

  function register(app, { sessions }) {
    // Paying in crypto from the account page on closedhand.com, signed in.
    app.post('/api/ahead/checkout', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const ownerId = sessions.owner(req);
      if (!ownerId) return res.status(401).json({ error: 'Sign in to your Closedhand account first.' });
      if (req.headers.origin !== baseUrl) return res.status(403).json({ error: 'Open this on closedhand.com.' });
      try {
        const owner = (await db.query('SELECT id FROM owners WHERE id = $1', [ownerId])).rows[0];
        if (!owner) return res.status(401).json({ error: 'Sign in to your Closedhand account first.' });
        res.json({ url: await checkout(owner, { months: req.body?.months, extend: req.body?.extend === true, agreed: req.body?.agreed === true }) });
      } catch (e) {
        if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message });
        console.error('[ahead] checkout:', e.message);
        res.status(503).json({ error: 'Could not reach the payment service just now. Please try again.' });
      }
    });
    // A crypto invoice's checkout, on closedhand.com's own payment server.
    app.get('/pay/:invoice', (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!cryptoOn() || !/^[A-Za-z0-9]{8,64}$/.test(req.params.invoice)) return res.redirect(302, '/account');
      res.redirect(302, btcpay.url + '/i/' + encodeURIComponent(req.params.invoice));
    });
    // BTCPay's webhooks: the raw body is kept (server.js) for the signature.
    app.post('/api/ahead/btcpay', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!cryptoOn() || !verifyBtcpay(req.headers['btcpay-sig'], req.body, btcpay.secret)) return res.status(403).json({ error: 'Invalid signature' });
      let event;
      try { event = JSON.parse(req.body.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'Invalid body' }); }
      try {
        const ours = !event?.storeId || event.storeId === btcpay.store;
        const done = event?.type === 'InvoiceSettled' && ours ? await settled(event.invoiceId)
          // A claim waiting on an invoice that will never be paid is let go.
          : ['InvoiceExpired', 'InvoiceInvalid'].includes(event?.type) && ours && pending ? await pending.lapsed(String(event.invoiceId || '').slice(0, 64))
          : 'not used';
        console.log(`[ahead] ${String(event?.type).slice(0, 40)}: ${done}`);
        res.json({ ok: true });
      } catch (e) {
        // BTCPay sends it again.
        console.error('[ahead] webhook:', e.message);
        res.status(500).json({ error: 'Could not record the payment' });
      }
    });
  }

  return { running, monthOf, extended, grant, carryOn, sweep, options, checkout, invoiceForClaim, onPendingClaim, settled, cryptoPayments, register, refused, cryptoOn, CRYPTO_MONTHS };
}

module.exports = { create, verifyBtcpay, CRYPTO_MONTHS };
