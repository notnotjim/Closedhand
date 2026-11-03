// webapp/provider-capabilities.js — the LLM providers a key may belong to:
// their names, where their models are listed and how a key is checked. A
// chat model choice prefers the provider's live model list; the static entry
// is the fallback, so a fetch hiccup or a renamed model never blocks setup.

const PROVIDERS = {
  deepinfra: {
    label: "DeepInfra",
    publicModels: true, // the list answers without a key, so it proves nothing about one
    base: "https://api.deepinfra.com/v1/openai",
    auth: "bearer",
    chat: { prefer: [/^deepseek-ai\/DeepSeek-V4$/, /DeepSeek-V4(?!-Flash)/], fallback: "deepseek-ai/DeepSeek-V4" },
  },
  openai: {
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    auth: "bearer",
  },
  gemini: {
    label: "Google Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    auth: "bearer",
  },
  anthropic: {
    label: "Anthropic",
    modelsUrl: "https://api.anthropic.com/v1/models",
    auth: "anthropic",
  },
  groq: {
    label: "Groq",
    base: "https://api.groq.com/openai/v1",
    auth: "bearer",
    chat: { prefer: [/^llama-3\.3-70b-versatile$/, /llama-3\.3/, /llama/i], fallback: "llama-3.3-70b-versatile" },
  },
  xai: {
    label: "xAI (Grok)",
    base: "https://api.x.ai/v1",
    auth: "bearer",
    // Purpose-built key check: GET returns key info on a valid key, 400/401 on
    // a bad one. Decisive without invoking a reasoning model (a one-token chat
    // probe against grok can spend the whole timeout thinking).
    keyProbe: "https://api.x.ai/v1/api-key",
    chat: { prefer: [/^grok-4\.5$/, /^grok-4/, /grok(?!.*vision)/], fallback: "grok-4.5" },
  },
  deepseek: {
    label: "DeepSeek",
    base: "https://api.deepseek.com/v1",
    auth: "bearer",
    // One exact model for chat, images and background work, chosen for the
    // best balance of capability and cost and changed only by hand: nothing
    // here picks a newer model by itself.
    chat: { prefer: [/^deepseek-flash$/], fallback: "deepseek-flash" },
  },
  openrouter: {
    label: "OpenRouter",
    publicModels: true,
    base: "https://openrouter.ai/api/v1",
    auth: "bearer",
    // Hundreds of models behind one key. The default is one exact model for
    // chat, images and background work (background runs it at a lower
    // effort), chosen for the best balance of capability and cost and changed
    // only by hand: nothing here picks a newer model by itself.
    chat: { prefer: [/^deepseek\/deepseek-v4\.1-flash$/], fallback: "deepseek/deepseek-v4.1-flash" },
  },
  moonshot: {
    label: "Moonshot",
    base: "https://api.moonshot.ai/v1",
    auth: "bearer",
    chat: { prefer: [/^kimi-k2/, /kimi/i, /moonshot/i], fallback: "kimi-k2-0905-preview" },
  },
  ollama: {
    label: "Ollama",
    auth: "none", // base comes from the user
    chat: { prefer: [/llama3/i, /qwen/i, /mistral/i, /^(?!.*embed)(?!.*llava)/], fallback: null },
  },
};

// Fetch the provider's live model list. Succeeding IS the key verification.
// Returns an array of model ids; throws { status } style errors on rejection.
async function listModels(provider, { apiKey, base } = {}) {
  const p = PROVIDERS[provider];
  const url = p.modelsUrl || `${base || p.base}/models`;
  const headers = {};
  if (p.auth === "bearer" && apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (p.auth === "anthropic") { headers["x-api-key"] = apiKey || ""; headers["anthropic-version"] = "2023-06-01"; }
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!r.ok) { const e = new Error(`models list ${r.status}`); e.status = r.status; throw e; }
  const j = await r.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
}

// First live id matching a preference wins; the static fallback otherwise.
function pickModel(cap, liveIds) {
  if (!cap) return null;
  for (const re of cap.prefer || []) {
    const hit = (liveIds || []).find((id) => re.test(id));
    if (hit) return hit;
  }
  return cap.fallback || null;
}

// Ground-truth key check: a one-token chat call to the endpoint the key will
// actually be used for. Providers scope keys per endpoint (an x.ai key can be
// valid for chat while its models list refuses), so the models probe alone
// can reject working keys. Returns true when the response is anything other
// than a credential failure — a model-not-found still proves the key
// authenticated.
// Returns { valid, status } so callers can SAY what the provider answered
// instead of reporting a mystery.
async function verifyChatKey(provider, { apiKey, base } = {}) {
  const p = PROVIDERS[provider];
  if (!p) return { valid: false, status: null };
  // A dedicated key-info endpoint beats any model call when the provider has
  // one: fast, free, and immune to reasoning-model latency.
  if (p.keyProbe) {
    try {
      const r = await fetch(p.keyProbe, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      return { valid: r.ok, status: r.status };
    } catch (_) {
      return { valid: false, status: 0 };
    }
  }
  const model = (p.chat && p.chat.fallback) || "test";
  let url, headers, body;
  if (p.auth === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers = { "x-api-key": apiKey || "", "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
    body = { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
  } else {
    url = `${base || p.base}/chat/completions`;
    headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    body = { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
  }
  try {
    // Generous timeout: several providers' cheap models reason by default and
    // can sit thinking before the first token even with max_tokens: 1.
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    if (r.ok || r.status === 404 || r.status === 429) return { valid: true, status: r.status }; // 404/429: authed far enough
    if (r.status === 401 || r.status === 403) return { valid: false, status: r.status };
    const text = await r.text().catch(() => "");
    // 400s split: "incorrect api key" is a credential failure; a model or
    // param complaint means the key itself passed.
    return { valid: !/api[ -]?key|credential|unauthoriz|authenticat/i.test(text), status: r.status };
  } catch (_) {
    return { valid: false, status: 0 };
  }
}

module.exports = { PROVIDERS, listModels, pickModel, verifyChatKey };
