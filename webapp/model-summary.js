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
  configured("Chat model", "chat");
  configured("Support model", "background");
  if (config?.roles?.vision) configured("Images", "vision"); else vlm();
  // Recall and its ranking run on the computer running Closedhand (lib/local-models.js).
  rows.push({ label: "Recall", model: read("LOCAL_EMBED_MODEL_ID") || "EmbeddingGemma 2", provider: HERE });
  rows.push({ label: "Search ranking", model: read("LOCAL_RERANK_MODEL_ID") || "Jina Reranker v1 Turbo", provider: HERE });
  return rows;
}
module.exports = { modelSummary };
