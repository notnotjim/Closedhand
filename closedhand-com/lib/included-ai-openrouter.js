// OpenRouter as the provider of Closedhand Managed Models' keys
// (lib/included-ai.js, INCLUDED_AI_PROVIDER=openrouter), kept so Managed
// Models can move back without a rewrite. Each key is made with OpenRouter's
// provisioning key (OPENROUTER_PROVISIONING_KEY, only ever from the settings)
// and attached to one guardrail: it can use only the models Closedhand chose,
// and only on providers that keep nothing and train on nothing. OpenRouter
// does not encrypt into sealed hardware: on a switch, the Privacy page and
// every "nobody but you can read it" line must change with it.

const API = 'https://openrouter.ai/api/v1';
const GUARDRAIL = 'Closedhand included AI';
const cents = n => Math.round(n * 100) / 100;
// A limit OpenRouter holds to: never 0, whose meaning it doesn't promise.
const atLeastACent = n => Math.max(0.01, cents(n));

function create({ env = process.env, request = fetch }) {
  const managementKey = String(env.OPENROUTER_PROVISIONING_KEY || '');
  const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  const defaults = { models: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', vision: 'xiaomi/mimo-v2.6-flash' };
  // Models being switched away from stay allowed for a while
  // (INCLUDED_AI_RETIRING_MODELS), so no computer is cut off between the
  // change and its next look.
  const vision = String(env.INCLUDED_AI_VISION_MODEL ?? defaults.vision).trim();
  const allowed = [...new Set([...list(env.INCLUDED_AI_MODELS || defaults.models), ...(vision ? [vision] : []), ...list(env.INCLUDED_AI_RETIRING_MODELS)])];

  async function api(path, method = 'GET', body) {
    const response = await request(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + managementKey, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://closedhand.com', 'X-Title': 'Closedhand' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!response.ok) throw Object.assign(new Error(`OpenRouter answered ${response.status} to ${method} ${path.split('?')[0]}`), { status: response.status });
    return json;
  }

  // The one guardrail every key made here is attached to, made the first time
  // and brought up to date with the chosen models after each start.
  let guardrailId = null;
  async function guardrail() {
    if (guardrailId) return guardrailId;
    const rules = {
      allowed_models: allowed,
      enforce_zdr_anthropic: true, enforce_zdr_openai: true, enforce_zdr_google: true, enforce_zdr_xai: true, enforce_zdr_other: true,
      allow_safety_retention_google: false, allow_safety_retention_other: false,
      enable_free_model_training: false, enable_paid_model_training: false, enable_free_model_publication: false,
    };
    const listed = await api('/guardrails?limit=100');
    const found = (listed?.data || []).find(g => g.name === GUARDRAIL);
    if (found) {
      await api('/guardrails/' + found.id, 'PATCH', rules);
      guardrailId = found.id;
    } else {
      const made = await api('/guardrails', 'POST', { name: GUARDRAIL, description: 'Keys made for Closedhand accounts: the models Closedhand chose, on providers that keep nothing.', ...rules });
      guardrailId = made?.data?.id || made?.id || null;
    }
    if (!guardrailId) throw new Error('OpenRouter did not return the guardrail');
    return guardrailId;
  }

  // Every key of the OpenRouter account, as OpenRouter lists them, a page of
  // up to 100 at a time.
  async function listed() {
    const all = [];
    for (let offset = 0, page = 0; page < 100; page++) {
      const keys = (await api('/keys?offset=' + offset))?.data || [];
      all.push(...keys);
      if (!keys.length) break;
      offset += keys.length;
    }
    return all;
  }
  const shape = k => ({ id: k.hash, name: String(k.name || ''), limit: k.limit == null ? null : Number(k.limit), usage: Number(k.usage) || 0 });

  return {
    provider: 'openrouter',
    label: 'OpenRouter',
    defaults,
    configured: () => managementKey.startsWith('sk-or-'),
    // Keys already given can use the models chosen since: the guardrail is
    // brought up to date as closedhand.com starts and each hour.
    settle: () => guardrail(),
    async makeKey(name, usd, { monthly = false } = {}) {
      const made = await api('/keys', 'POST', { name, limit: atLeastACent(usd), ...(monthly ? { limit_reset: 'monthly' } : {}) });
      const key = made?.key, hash = made?.data?.hash;
      if (typeof key !== 'string' || !key.startsWith('sk-or-') || typeof hash !== 'string') throw new Error('OpenRouter did not return a key');
      try {
        await api('/guardrails/' + await guardrail() + '/assignments/keys', 'POST', { key_hashes: [hash] });
      } catch (error) {
        // A key without its guardrail could use any model: it never leaves here.
        await api('/keys/' + hash, 'DELETE').catch(() => {});
        throw error;
      }
      return { key, id: hash };
    },
    // A key as OpenRouter has it now, or null when it is gone.
    async keyNow(hash) {
      try {
        const data = (await api('/keys/' + hash))?.data;
        return data ? shape({ ...data, hash }) : null;
      } catch (error) { if (error.status === 404) return null; throw error; }
    },
    setLimit: (hash, usd) => api('/keys/' + hash, 'PATCH', { limit: atLeastACent(usd), limit_reset: null }),
    drop: hash => api('/keys/' + hash, 'DELETE').catch(e => { if (e.status !== 404) throw e; }),
    allKeys: async () => (await listed()).map(shape),
    // This month's OpenRouter spend across every key of the account, or on the given keys.
    spentThisMonth: async () => cents((await listed()).reduce((total, k) => total + Number(k.usage_monthly || 0), 0)),
    spentByKeys: async ids => cents((await listed()).filter(k => ids.includes(k.hash)).reduce((total, k) => total + Number(k.usage_monthly || 0), 0)),
    // What is left of the account's credit, which every key draws on, with the
    // days it lasts at the pace of the last 30 days, as OpenRouter reports
    // them a completed UTC day at a time, counted from the first day with any
    // use so a young account's pace isn't spread thin.
    async credit(now = new Date()) {
      const [credits, activity] = await Promise.all([api('/credits'), api('/activity').catch(() => null)]);
      const left = Number(credits?.data?.total_credits) - Number(credits?.data?.total_usage);
      if (!Number.isFinite(left)) return null;
      const rows = activity?.data || [];
      const used = rows.reduce((total, r) => total + Number(r.usage || 0), 0);
      if (!(used > 0)) return { left: cents(left), days: null };
      const first = Math.min(...rows.map(r => Date.parse(String(r.date).slice(0, 10) + 'T00:00:00Z')));
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const span = Math.min(30, Math.max(1, Math.round((today - first) / 86400000)));
      return { left: cents(left), days: Math.max(0, Math.floor(left / (used / span))) };
    },
    topUp: 'Add credit at openrouter.ai',
    chat: { base: API, headers: { 'HTTP-Referer': 'https://closedhand.com', 'X-Title': 'Closedhand' } },
  };
}

module.exports = { create };
