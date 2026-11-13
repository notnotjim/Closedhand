// image-providers.js: the picture model of each LLM provider that has one,
// for when Closedhand can't make a picture privately (lib/image-generation.js
// picture) and the person has said their provider may. Vendored: lib/ and
// webapp/ (scripts/vendored-manifest.json): the dashboard names it, the bot
// makes the picture with it.
//
// Each is that provider's best picture model when it was set (2026-11-14),
// by its exact id and changed by hand: a pattern picking the newest could
// move people's pictures to a pricier model nobody chose. way: how it is
// asked, its OpenAI-style images endpoint, Gemini's generateContent, or a
// chat completion that answers with a picture.
const MODELS = {
  openai: { name: "OpenAI", model: "gpt-image-2.6-sunburst", way: "images" },
  xai: { name: "xAI", model: "grok-imagine-image-2.0", way: "images" },
  deepinfra: { name: "DeepInfra", model: "black-forest-labs/FLUX-2-pro", way: "images" },
  gemini: { name: "Google Gemini", model: "gemini-3-pro-image", way: "gemini" },
  openrouter: { name: "OpenRouter", model: "google/gemini-3-pro-image", way: "chat" },
};

// The provider behind the person's chat, as model-policy reads a connection.
function providerOf(settings) {
  const config = settings?.model_config;
  const pick = config?.roles?.chat;
  const conn = pick && config.connections?.[pick.connection];
  if (!conn) return null;
  try { return require("./model-policy").connection(conn).provider; } catch { return null; }
}

// The picture model of the provider behind the person's chat, or null.
function forSettings(settings) {
  const provider = providerOf(settings);
  return MODELS[provider] ? { provider, ...MODELS[provider] } : null;
}

module.exports = { MODELS, providerOf, forSettings };
