// Public descriptions of effective models. Never return credentials or full provider URLs.
const policy = require("./model-policy");
const HERE = "On the computer running Closedhand";
function location(model, baseUrl) {
  let host;
  try { host = new URL(baseUrl).hostname; } catch { return "Provider not recorded"; }
  if (["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(host)) return HERE;
  return ({ "api.x.ai": "xAI", "api.deepinfra.com": "DeepInfra", "api.deepseek.com": "DeepSeek",
    "api.anthropic.com": "Anthropic", "api.openai.com": "OpenAI", "openrouter.ai": "OpenRouter",
    "generativelanguage.googleapis.com": "Google Gemini", "api.groq.com": "Groq", "api.moonshot.ai": "Moonshot" })[host] || host;
}
function modelSummary(settings, read = key => process.env[key], local = false) {
  const runtime = read;
  read = key => runtime(key) || (local ? settings.self_host_config?.[key] : undefined);
  const config = settings.model_config;
  const rows = [];
  const add = (label, model, baseUrl) => rows.push({ label, model: model || "Not enabled", provider: model ? location(model, baseUrl) : "" });
  const configured = (label, role) => {
    const pick = policy.getRole(settings, role);
    if (pick?.provider === "here") return rows.push({ label, model: pick.model, provider: HERE });
    add(label, pick?.model, pick?.baseUrl);
  };
  // Pictures with no image model chosen, and every picture indexed, are
  // described by the VLM (lib/local-models.js).
  const vlm = () => rows.push({ label: "Images", model: "Florence-2", provider: HERE });
  if (config) {
    configured("Chat model", "chat");
    configured("Support model", "background");
    if (config.roles?.vision) configured("Images", "vision"); else vlm();
  } else {
    const requested = settings.llm_provider;
    const provider = requested === "custom" && settings.custom_base_url && settings.custom_model ? requested
      : ["anthropic", "openai", "gemini"].includes(requested) && settings[requested + "_api_key"] ? requested : "xai";
    const fallback = { xai: "grok-4.5", anthropic: "claude-sonnet-5", openai: "gpt-4o", gemini: "gemini-pro-latest" };
    const model = provider === "custom" ? settings.custom_model : provider === "xai"
      ? (read("XAI_API_KEY") ? fallback.xai : null) : settings.byok_models?.default || fallback[provider];
    add("Chat model", model, provider === "custom" ? settings.custom_base_url : policy.BASES[provider]);
    const internalKey = (local && read("INTERNAL_LLM_API_KEY")) || read("DEEPINFRA_API_KEY");
    add("Support model", internalKey ? read("INTERNAL_LLM_MODEL") || "deepseek-ai/DeepSeek-V4-Flash" : read("XAI_API_KEY") ? "grok-4.5" : null,
      internalKey ? read("INTERNAL_LLM_URL") || policy.BASES.deepinfra : policy.BASES.xai);
    vlm();
  }
  // Recall and its ranking run on the computer running Closedhand (lib/local-models.js).
  rows.push({ label: "Recall", model: read("LOCAL_EMBED_MODEL_ID") || "EmbeddingGemma 2", provider: HERE });
  rows.push({ label: "Search ranking", model: read("LOCAL_RERANK_MODEL_ID") || "Jina Reranker v1 Turbo", provider: HERE });
  return rows;
}
module.exports = { modelSummary };
