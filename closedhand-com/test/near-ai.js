// A stand-in NEAR AI for closedhand.com's tests (lib/included-ai.js,
// lib/near-session.js): nothing leaves this machine.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DAY = 24 * 3600 * 1000;
// The sign-in handed over (NEAR_REFRESH_TOKEN), invented.
const SIGN_IN = 'rt_' + 'a1'.repeat(24);
// The browser it was made in: NEAR renews a sign-in only for that browser.
const BROWSER = 'Mozilla/5.0 (Macintosh) TestBrowser/1.0';

// NEAR AI as far as Closedhand uses it: a sign-in whose refresh token is
// replaced each time it is used, keys in one workspace with a spending limit
// and what they have used, and the organisation's credit and spend.
function nearAi({ balance = { remaining: 0 }, series = [], byModel = [], ends = 30 } = {}) {
  const keys = new Map(), calls = [];
  // down: unreachable; deleteFails: refuses to delete keys; refuse: no longer
  // takes the sign-in.
  const state = { refresh: SIGN_IN, access: null, renewals: 0, refuse: false, down: false, deleteFails: false };
  const reply = (status, body) => new Response(status === 204 ? null : body === undefined ? '' : JSON.stringify(body), { status });
  const price = usd => ({ amount: Math.round(usd * 1e9), scale: 9, currency: 'USD' });
  const shown = (id, k) => ({ id, name: k.name, key_prefix: k.key.slice(0, 6), workspace_id: 'ws-1', created_by_user_id: 'u-1', created_at: new Date().toISOString(), is_active: true, spend_limit: price(k.limit), usage: price(k.usage) });
  const request = async (url, opts = {}) => {
    const method = opts.method || 'GET', where = url.replace('https://cloud-api.near.ai', '');
    calls.push(method + ' ' + where);
    if (state.down) throw new Error('fetch failed');
    if (method === 'POST' && where === '/v1/users/me/access-tokens') {
      if (state.refuse || opts.headers.Authorization !== 'Bearer ' + state.refresh || opts.headers['User-Agent'] !== BROWSER) return reply(401, { error: { message: 'Invalid refresh token', type: 'unauthorized' } });
      state.renewals++;
      state.refresh = 'rt_' + crypto.randomBytes(24).toString('hex');
      state.access = 'x.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.' + state.renewals;
      return reply(200, { access_token: state.access, refresh_token: state.refresh, refresh_token_expiration: new Date(Date.now() + ends * DAY).toISOString() });
    }
    assert.equal(opts.headers.Authorization, 'Bearer ' + state.access, 'only the sign-in\'s access token is used');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === 'GET' && where === '/v1/organizations?limit=100') return reply(200, { organizations: [{ id: 'org-1', name: 'Closedhand' }], total: 1, limit: 100, offset: 0 });
    if (method === 'GET' && where === '/v1/organizations/org-1/workspaces?limit=100') return reply(200, { workspaces: [{ id: 'ws-1', organization_id: 'org-1' }], total: 1, limit: 100, offset: 0 });
    if (method === 'POST' && where === '/v1/workspaces/ws-1/api-keys') {
      assert.equal(body.spendLimit.currency, 'USD');
      assert.ok(Number.isInteger(body.spendLimit.amount), 'in whole nano-dollars');
      const id = crypto.randomUUID(), k = { name: body.name, limit: body.spendLimit.amount / 1e9, usage: 0, key: 'sk-' + crypto.randomBytes(16).toString('hex') };
      keys.set(id, k);
      return reply(201, { ...shown(id, k), key: k.key });
    }
    let m = where.match(/^\/v1\/workspaces\/ws-1\/api-keys\?limit=100&offset=(\d+)&order_by=created_at&order_direction=asc$/);
    if (m && method === 'GET') {
      const all = [...keys], offset = Number(m[1]);
      return reply(200, { api_keys: all.slice(offset, offset + 100).map(([id, k]) => shown(id, k)), total: all.length, limit: 100, offset });
    }
    m = where.match(/^\/v1\/workspaces\/ws-1\/api-keys\/([^/?]+)\/spend-limit$/);
    if (m && method === 'PATCH') {
      const k = keys.get(m[1]);
      if (!k) return reply(404, { error: { message: 'not found', type: 'not_found' } });
      k.limit = body.spendLimit.amount / 1e9;
      return reply(200, shown(m[1], k));
    }
    m = where.match(/^\/v1\/workspaces\/ws-1\/api-keys\/([^/?]+)$/);
    if (m && method === 'DELETE') {
      if (state.deleteFails) return reply(500, { error: { message: 'unavailable', type: 'server_error' } });
      return keys.delete(m[1]) ? reply(204) : reply(404, { error: { message: 'not found', type: 'not_found' } });
    }
    if (method === 'GET' && where === '/v1/organizations/org-1/usage/balance') return reply(200, balance);
    if (method === 'GET' && where.startsWith('/v1/organizations/org-1/usage/timeseries?granularity=day&start=')) return series ? reply(200, { data: series }) : reply(403, { error: { message: 'forbidden', type: 'forbidden' } });
    if (method === 'GET' && where.startsWith('/v1/organizations/org-1/usage/by-model?period=custom&start=')) return reply(200, { period: 'custom', data: byModel });
    throw new Error('unexpected ' + method + ' ' + url);
  };
  return { request, keys, calls, state };
}

module.exports = { nearAi, SIGN_IN, BROWSER };
