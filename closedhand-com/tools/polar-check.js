// Whether the Polar token closedhand.com holds may do each thing Closedhand+
// needs, and the prices people are charged. For the maintainer. Each check is
// a request that changes nothing: a read, or a write Polar refuses for an
// order, subscription or body that doesn't exist, which it answers only once
// the token is allowed. Never prints the token or what Polar answered.
//
// Run inside the closedhand-com service:
//   railway ssh --service closedhand-com -- node tools/polar-check.js

const crypto = require('crypto');

const NOBODY = () => crypto.randomUUID();

// Allowed: answered (or refused for the made-up thing). Missing: 401 or 403
// for the token's rights. Polar's error code (a word like "insufficient_scope",
// never its message) says which refusal it was.
function verdict({ status, json }, ok) {
  if (ok.includes(status)) return 'allowed';
  const code = /^[A-Za-z_]{1,40}$/.test(String(json?.error || '')) ? ` (${json.error})` : '';
  if (status === 401 || (status === 403 && /scope|permi|forbidden|unauthori/i.test(code || 'scope'))) return 'MISSING' + code;
  return `unclear: Polar answered ${status}${code}`;
}

async function check(env = process.env, request = fetch) {
  const token = String(env.POLAR_ACCESS_TOKEN || '');
  if (!token) return 'POLAR_ACCESS_TOKEN is not set.';
  const api = env.POLAR_SERVER === 'sandbox' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh';
  const call = async (path, method = 'GET', body) => {
    const response = await request(api + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    let json = null;
    try { json = await response.json(); } catch (_) { /* not JSON */ }
    return { status: response.status, json };
  };
  const lines = [];
  const scopes = [
    ['products:read (prices)', () => call('/v1/products/?limit=1'), [200]],
    ['checkouts:write (subscribing)', () => call('/v1/checkouts/', 'POST', {}), [422]],
    ['customer_sessions:write (Manage)', () => call('/v1/customer-sessions/', 'POST', {}), [422]],
    ['subscriptions:read', () => call('/v1/subscriptions/?limit=1'), [200]],
    ['subscriptions:write (stopping one)', () => call('/v1/subscriptions/' + NOBODY(), 'DELETE'), [404, 422]],
    ['refunds:write (giving a payment back)', () => call('/v1/refunds/', 'POST', { order_id: NOBODY(), reason: 'other', amount: 1 }), [404, 422]],
    ['orders:read (payments and invoices in My Account)', () => call('/v1/orders/?limit=1'), [200]],
  ];
  for (const [name, run, ok] of scopes) {
    try { lines.push(`${name}: ${verdict(await run(), ok)}`); }
    catch (e) { lines.push(`${name}: could not reach Polar (${e.message})`); }
  }
  for (const [name, id] of [['Closedhand+', env.POLAR_PLUS_PRODUCT_ID], ['Carrying on past fair use', env.POLAR_EXTEND_PRODUCT_ID]]) {
    if (!id) { lines.push(`${name}: no product set`); continue; }
    try {
      const { status, json } = await call('/v1/products/' + encodeURIComponent(id));
      if (status !== 200) { lines.push(`${name}: Polar answered ${status}`); continue; }
      const prices = (json?.prices || []).filter(p => p.amount_type === 'fixed' && !p.is_archived && Number.isInteger(p.price_amount))
        .map(p => `${(p.price_amount / 100).toFixed(2)} ${String(p.price_currency).toUpperCase()}`);
      const every = json?.recurring_interval ? `, every ${json.recurring_interval}` : ', once';
      lines.push(`${name}: ${prices.join(', ') || 'no fixed price'}${every}`);
    } catch (e) { lines.push(`${name}: could not reach Polar (${e.message})`); }
  }
  return lines.join('\n');
}

if (require.main === module) {
  check().then((out) => console.log(out)).catch((e) => { console.error(`polar-check: ${e.message}`); process.exit(1); });
}

module.exports = { check, verdict };
