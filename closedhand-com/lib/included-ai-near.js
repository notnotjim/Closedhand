// NEAR AI as the provider of Closedhand Managed Models' keys
// (lib/included-ai.js, INCLUDED_AI_PROVIDER=near, the default). Each key is
// made with closedhand.com's sign-in at NEAR (lib/near-session.js) in its
// organisation; the person's computer then talks to NEAR directly, encrypted
// into the sealed hardware the model runs in.
//
// A key's spending limit is all NEAR holds it to: it has no monthly reset and
// no list of models. Limits are lifetime totals in nano-dollars. A new key
// takes NEAR a few seconds to accept; the computer that gets one waits and
// checks again (webapp/included-ai-setup.js).

// NEAR counts money in nano-dollars.
const NANO = 1e9;
const nano = usd => Math.round(usd * NANO);
const dollars = price => (price && Number.isFinite(Number(price.amount)) ? Number(price.amount) / 10 ** Number(price.scale ?? 9) : null);
const cents = n => Math.round(n * 100) / 100;
// A limit NEAR holds to: never 0 or none, which would mean no limit; at least
// a billionth of a dollar, the smallest it takes.
const atLeastANano = n => Math.max(1 / NANO, n);

function create({ db, env = process.env, request = fetch, notices = null }) {
  const session = require('./near-session').create({ db, env, request, notices });

  async function api(path, method = 'GET', body, again = false) {
    const response = await request(session.base + path, {
      method,
      headers: { Authorization: 'Bearer ' + await session.token(), 'User-Agent': session.agent, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    // An access token NEAR stopped taking early is renewed, once.
    if (response.status === 401 && !again) { session.forget(); return api(path, method, body, true); }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!response.ok) throw Object.assign(new Error(`NEAR AI answered ${response.status} to ${method} ${path.split('?')[0]}`), { status: response.status });
    return json;
  }

  // The organisation whose credit every key draws on, and the workspace the
  // keys are made in: as set, else the only one there is.
  let ids = null;
  async function where() {
    if (ids) return ids;
    let org = String(env.NEAR_ORG_ID || '').trim(), workspace = String(env.NEAR_WORKSPACE_ID || '').trim();
    if (!org) {
      const orgs = (await api('/v1/organizations?limit=100'))?.organizations || [];
      if (orgs.length !== 1) throw new Error(orgs.length ? 'NEAR AI has several organisations for this sign-in: set NEAR_ORG_ID' : 'NEAR AI has no organisation for this sign-in');
      org = orgs[0].id;
    }
    if (!workspace) {
      const spaces = (await api('/v1/organizations/' + encodeURIComponent(org) + '/workspaces?limit=100'))?.workspaces || [];
      if (spaces.length !== 1) throw new Error(spaces.length ? 'NEAR AI has several workspaces here: set NEAR_WORKSPACE_ID' : 'NEAR AI has no workspace here');
      workspace = spaces[0].id;
    }
    return (ids = { org: encodeURIComponent(org), workspace: encodeURIComponent(workspace) });
  }

  // A key as NEAR lists it, in dollars.
  const shape = k => ({ id: k.id, name: String(k.name || ''), limit: dollars(k.spend_limit), usage: dollars(k.usage) || 0 });
  // Every live key in the workspace (not deleted or switched off). NEAR has no
  // way to read one key alone, only pages of them, so the list is kept five
  // minutes for the account page and each computer's hourly look; a key not
  // in it is looked for afresh.
  let listed = { at: 0, keys: null };
  async function keys({ fresh = false } = {}) {
    if (!fresh && listed.keys && Date.now() - listed.at < 5 * 60000) return listed.keys;
    const { workspace } = await where();
    const found = new Map();
    for (let offset = 0, page = 0; page < 1000; page++) {
      const got = await api(`/v1/workspaces/${workspace}/api-keys?limit=100&offset=${offset}&order_by=created_at&order_direction=asc`);
      const batch = got?.api_keys || [];
      for (const k of batch) if (!k.deleted_at && k.is_active !== false && typeof k.id === 'string') found.set(k.id, shape(k));
      offset += batch.length;
      if (!batch.length || offset >= Number(got?.total ?? 0)) break;
    }
    listed = { at: Date.now(), keys: found };
    return found;
  }
  const remember = k => { if (listed.keys && typeof k?.id === 'string') listed.keys.set(k.id, shape(k)); };

  return {
    provider: 'near',
    label: 'NEAR AI',
    // Text only: NEAR's encryption carries words, so pictures and videos are
    // described by the vision language model on the person's computer.
    defaults: { models: 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated', name: 'DeepSeek V4.1 Flash Abliterated', vision: '' },
    configured: () => session.configured(),
    // The sign-in, renewed as closedhand.com starts and each hour, so one NEAR
    // stopped taking is told to the maintainer before anyone needs a key.
    settle: () => session.token(),
    async makeKey(name, usd) {
      const { workspace } = await where();
      const made = await api(`/v1/workspaces/${workspace}/api-keys`, 'POST', { name, spendLimit: { amount: nano(atLeastANano(cents(usd))), currency: 'USD' } });
      if (typeof made?.key !== 'string' || !made.key.startsWith('sk-') || typeof made.id !== 'string') throw new Error('NEAR AI did not return a key');
      remember(made);
      return { key: made.key, id: made.id };
    },
    // A key as NEAR has it now, or null when it is gone.
    async keyNow(id, { fresh = false } = {}) {
      return (await keys({ fresh })).get(id) || (fresh ? null : (await keys({ fresh: true })).get(id) || null);
    },
    async setLimit(id, usd) {
      const { workspace } = await where();
      remember(await api(`/v1/workspaces/${workspace}/api-keys/${encodeURIComponent(id)}/spend-limit`, 'PATCH', { spendLimit: { amount: nano(atLeastANano(usd)), currency: 'USD' } }));
    },
    async drop(id) {
      const { workspace } = await where();
      await api(`/v1/workspaces/${workspace}/api-keys/${encodeURIComponent(id)}`, 'DELETE').catch(e => { if (e.status !== 404) throw e; });
      listed.keys?.delete(id);
    },
    allKeys: async () => [...(await keys({ fresh: true })).values()],
    // This calendar month's spend at NEAR, across every key.
    async spentThisMonth(now = new Date()) {
      const { org } = await where();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const rows = (await api(`/v1/organizations/${org}/usage/by-model?period=custom&start=${encodeURIComponent(start)}`))?.data || [];
      return cents(rows.reduce((total, r) => total + Number(r.total_cost || 0), 0) / NANO);
    },
    // This calendar month's spend on the given keys, from NEAR's record of each
    // request, a page at a time (for the insights page's split, lib/insights.js).
    async spentByKeys(ids, now = new Date()) {
      if (!ids.length) return 0;
      const { org } = await where();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      let total = 0;
      for (const id of ids) {
        for (let offset = 0, page = 0; page < 200; page++) {
          const got = await api(`/v1/organizations/${org}/usage/history?api_key_id=${encodeURIComponent(id)}&start_time=${encodeURIComponent(start)}&limit=1000&offset=${offset}`);
          const rows = got?.data || [];
          total += rows.reduce((t, r) => t + Number(r.total_cost || 0), 0);
          offset += rows.length;
          if (!rows.length || offset >= Number(got?.total ?? 0)) break;
        }
      }
      return cents(total / NANO);
    },
    // What is left of the organisation's credit, which every key draws on,
    // with the days it lasts at the pace of the last 30 days, counted from
    // the first day with any use so a young account's pace isn't spread thin.
    // The organisation's spend limit stops every key at once too: what is
    // left is whichever ends first.
    async credit(now = new Date()) {
      const { org } = await where();
      const start = new Date(now.getTime() - 30 * 86400000).toISOString();
      const [balance, series] = await Promise.all([
        api(`/v1/organizations/${org}/usage/balance`),
        api(`/v1/organizations/${org}/usage/timeseries?granularity=day&start=${encodeURIComponent(start)}`).catch(() => null),
      ]);
      const limits = Array.isArray(balance?.credit_limits) ? balance.credit_limits : null;
      const nanoLeft = balance?.remaining != null ? Number(balance.remaining) : limits ? limits.reduce((t, l) => t + Number(l.available || 0), 0) : NaN;
      const underLimit = balance?.spend_limit != null && balance?.total_spent != null ? Number(balance.spend_limit) - Number(balance.total_spent) : NaN;
      const left = (Number.isFinite(underLimit) ? Math.min(Number.isFinite(nanoLeft) ? nanoLeft : underLimit, underLimit) : nanoLeft) / NANO;
      if (!Number.isFinite(left)) return null;
      const rows = (series?.data || []).filter(r => Number(r.cost_usd) > 0);
      const used = rows.reduce((total, r) => total + Number(r.cost_usd), 0);
      if (!(used > 0)) return { left: cents(left), days: null };
      const first = Math.min(...rows.map(r => Date.parse(String(r.date).slice(0, 10) + 'T00:00:00Z')));
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const span = Math.min(30, Math.max(1, Math.round((today - first) / 86400000)));
      return { left: cents(left), days: Math.max(0, Math.floor(left / (used / span))) };
    },
    // What the maintainer does when the credit runs low (lib/capacity.js).
    topUp: 'Add credit, or raise the organisation\'s spend limit, at cloud.near.ai',
    // Where closedhand.com's own key asks the LLM (lib/misuse.js).
    chat: { base: session.base + '/v1', headers: {} },
  };
}

module.exports = { create };
