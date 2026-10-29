// webapp/model-prices.js: what an LLM costs per million tokens, for Usage's
// costs with the person's own LLM provider. From OpenRouter's public price
// list, which has most models from every provider and, for each, the price
// each company serving it charges. Only public lists are read, never
// anything about the person, and no account or key is needed.
const BASE = "https://openrouter.ai/api/v1/models";
const DAY = 24 * 60 * 60 * 1000;

// The company an address belongs to, as OpenRouter names it, so someone
// using DeepSeek directly sees DeepSeek's own price rather than the cheapest
// company's. Read from the address, or from the provider's name in Settings
// when its connection keeps no address (Anthropic's): no provider is preferred.
const COMPANIES = {
  "api.deepseek.com": "DeepSeek", "api.openai.com": "OpenAI", "api.anthropic.com": "Anthropic",
  "generativelanguage.googleapis.com": "Google AI Studio", "api.x.ai": "xAI", "api.mistral.ai": "Mistral",
  "api.groq.com": "Groq", "api.together.xyz": "Together", "api.fireworks.ai": "Fireworks",
  "api.cerebras.ai": "Cerebras", "api.moonshot.ai": "Moonshot AI", "api.z.ai": "Z.AI", "api.deepinfra.com": "DeepInfra",
  deepseek: "DeepSeek", openai: "OpenAI", anthropic: "Anthropic", gemini: "Google AI Studio", xai: "xAI",
  groq: "Groq", moonshot: "Moonshot AI", deepinfra: "DeepInfra",
};
// An LLM on the person's own computer (Ollama, or any address on it) has no
// charge per token.
const onThisComputer = (host) => host === "ollama" || /^(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal|[^.]+\.local)(:\d+)?$/.test(String(host || ""));

let kept = { at: 0, models: null };
const endpointsKept = new Map();
async function read(url, request) {
  const response = await request(url, { signal: AbortSignal.timeout(15000) });
  return response.ok ? response.json() : null;
}
async function listed(request, now) {
  if (kept.models && now - kept.at < DAY) return kept.models;
  try {
    const data = await read(BASE, request);
    if (Array.isArray(data?.data)) kept = { at: now, models: data.data };
  } catch (_) { /* the last list read, or none */ }
  return kept.models || [];
}
// Each company's price for one model.
async function endpointsOf(id, request, now) {
  const hit = endpointsKept.get(id);
  if (hit && now - hit.at < DAY) return hit.list;
  let list = [];
  try { list = (await read(BASE + "/" + id.split("/").map(encodeURIComponent).join("/") + "/endpoints", request))?.data?.endpoints || []; }
  catch (_) { list = hit?.list || []; }
  endpointsKept.set(id, { at: now, list });
  return list;
}

// A model's own name, without its maker, variant or "latest":
// "~deepseek/deepseek-flash-latest" and "deepseek-flash" are both
// "deepseekflash"; "anthropic/claude-sonnet-4.5" and "claude-sonnet-4-5"
// are both "claudesonnet45".
function nameOf(id) {
  return String(id || "").toLowerCase().replace(/^~/, "").replace(/:.*$/, "").split("/").pop()
    .replace(/-latest$/, "").replace(/[^a-z0-9]/g, "");
}

// Dollars per million tokens: sent, answered, and sent again (cached).
function perMillion(pricing) {
  const at = (v) => {
    const n = Number(v);
    return v !== undefined && v !== null && Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : null;
  };
  const sent = at(pricing?.prompt), answered = at(pricing?.completion);
  if (sent === null || answered === null) return null;
  return { in: sent, out: answered, cached: at(pricing.input_cache_read) ?? sent };
}

// The price the person pays for a model: an OpenRouter model's own; else, at
// a company's own address, that company's price for the newest model whose
// id has every word of the name ("deepseek-flash" is DeepSeek's latest
// Flash); else the list's price for the model with the same name. by: the
// company whose price it is, for the page to say. Null when not listed.
async function priceOf(model, host, { request = fetch, now = Date.now() } = {}) {
  if (onThisComputer(host)) return { in: 0, out: 0, cached: 0, listed: null, by: null, local: true };
  const models = await listed(request, now);
  const exact = models.find((m) => m.id === model);
  if (exact && (!host || host === "openrouter.ai")) {
    const price = perMillion(exact.pricing);
    return price && { ...price, listed: exact.id, by: host === "openrouter.ai" ? "OpenRouter" : null };
  }
  const company = COMPANIES[host];
  if (company) {
    const words = String(model).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const candidates = models
      .filter((m) => !m.id.startsWith("~") && !m.id.includes(":") && words.every((w) => m.id.toLowerCase().includes(w)))
      .sort((a, b) => (nameOf(b.id) === nameOf(model)) - (nameOf(a.id) === nameOf(model)) || (b.created || 0) - (a.created || 0))
      .slice(0, 4);
    for (const m of candidates) {
      const own = (await endpointsOf(m.id, request, now)).find((e) => String(e.provider_name || "").toLowerCase() === company.toLowerCase());
      const price = own && perMillion(own.pricing);
      if (price) return { ...price, listed: m.id, by: company };
    }
  }
  const named = models.find((m) => nameOf(m.id) && nameOf(m.id) === nameOf(model));
  const price = named && perMillion(named.pricing);
  return price ? { ...price, listed: named.id, by: null } : null;
}

// Prices for the models used, each with the address it was used at.
async function pricesFor(modelHosts, request) {
  const out = {};
  for (const [model, host] of Object.entries(modelHosts)) {
    const price = await priceOf(model, host, request ? { request } : {}).catch(() => null);
    if (price) out[model] = price;
  }
  return out;
}

module.exports = { pricesFor, priceOf, nameOf, COMPANIES };
