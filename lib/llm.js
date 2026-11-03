// lib/llm.js — LLM abstraction layer
// All backends return { messages: { create(anthropicParams) -> anthropicResponse } }
// Internally translates to/from each provider's format so the rest of the codebase
// only ever deals with Anthropic-shaped params and responses.

// Each job's model is the person's choice in Settings (model_config): the
// chat model, the support model for background work, and the image model.
// With none chosen, chat and jobs say so; there is no model of Closedhand's own.

// An error written for the person: the chat shows its message as it stands.
function userError(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

// The settings to choose a model from. When the profile could not be read
// (the database restarting, say) the settings are unknown, not empty: falling
// through to a default then would send messages to a provider the person may
// never have chosen, so every model lookup stops and says so instead.
function settingsOf(store) {
  if (store?.settingsUnread) throw userError("I couldn't read my settings just now, so I won't guess which LLM to use. Try again in a minute.");
  return store?.profile?.settings || {};
}

// =============================================================================
// Provider-aware helpers for internal + user-facing LLM calls
// =============================================================================

/**
 * Resolve the correct model name for a given tier based on the current user's provider.
 * @param {string} userId - User ID (uses ctx.activeUserStore)
 * @param {"fast"|"default"|"strong"} tier - Model tier
 * @returns {string} Model name
 */
function resolveUserModel(userId, tier = "default", userStore) {
  const store = userStore || require("./context").activeUserStore;
  const selected = require("./model-policy").getRole(settingsOf(store), "chat");
  if (!selected) throw userError("Choose a chat model in Settings.");
  return selected.model;
}

// Internal jobs use the checked background role at fast effort. A configured
// role never falls through to another provider after an error.
function getInternalClient(userId, userStore) {
  const configured = getConfiguredRole("background", userStore);
  if (!configured) throw userError("Choose a model for summaries in Settings.");
  return configured;
}

/**
 * Get an LLM client + model for the main conversation (default tier).
 */
function getUserLLMClient(userId, userStore) {
  const configured = getConfiguredRole("chat", userStore);
  if (!configured) throw userError("Choose a chat model in Settings.");
  return configured;
}

// The client for a role chosen in Settings: undefined with no model settings
// at all, null when that role has no model.
function getConfiguredRole(role, userStore) {
  const store = userStore || require("./context").activeUserStore;
  const pick = require("./model-policy").getRole(settingsOf(store), role);
  if (pick === undefined || pick === null) return pick;
  const vision = role === "chat" ? require("./model-policy").getRole(settingsOf(store), "vision") : null;
  return { client: createLLMClient({ ...pick, effort: role === "background" ? "fast" : "default",
    stripImages: role === "background", routeImages: role === "chat" && (!vision || pick.capabilities?.vision !== true),
    vision,
    userId: store?.userId || store?.profile?.id,
    usageFeature: role === "background" ? "machinery" : role === "vision" ? "vision" : "chat" }), model: pick.model };
}

// Public entry: builds the backend client, then wraps it so every
// messages.create records its usage block under a feature label
// (opts.usageFeature, default "chat") for Usage in My Account.
function createLLMClient(opts = {}) {
  const { withUsageTracking } = require("./usage");
  return require("./model-capabilities").attachCapabilities(withUsageTracking(_createLLMClientRaw(opts), opts.usageFeature || "chat", opts.model), opts);
}

function _createLLMClientRaw(opts = {}) {
  const policy = require("./model-policy");
  const backend = opts.backend || "anthropic";
  const conn = {
    backend,
    baseUrl: String(opts.baseUrl || policy.BASES[backend] || "").replace(/\/+$/, ""),
    apiKey: opts.apiKey,
    fallback: opts.fallback || null,
  };
  return { messages: { create: async (params, options = {}) => {
    const model = backend === "custom" ? opts.model : params.model || opts.model;
    const effort = params.effort || (params.thinking?.type === "enabled" ? "strong" : opts.effort || "default");
    const messages = opts.stripImages ? (params.messages || []).map(m => ({ ...m, content: Array.isArray(m.content)
      ? m.content.map(b => b.type === "image" ? { type: "text", text: "[Image not supplied to this text model]" } : b) : m.content })) : params.messages;
    const routed = opts.routeImages || opts.stripImages ? await require("./model-images").substituteImages(messages, opts.routeImages ? opts.vision : null, opts.userId) : messages;
    return require("./model-wire").request({ ...conn, capabilities: opts.capabilities }, { ...params, model, effort, messages: routed }, options);
  } } };
}

// Whether the person's chat model can see images, as its check in Settings
// found: a wrong yes crashes the request, while a wrong no still works by
// describing the images to it.
function chatModelSupportsVision(userStore) {
  const settings = settingsOf(userStore);
  const selected = require("./model-policy").getRole(settings, "chat");
  return !!selected && !!settings.model_config.roles.vision && selected.capabilities?.vision === true;
}

module.exports = {
  ...require("./model-wire"),
  getConfiguredRole,
  settingsOf,
  userError,
  createLLMClient,
  resolveUserModel,
  getInternalClient,
  getUserLLMClient,
  chatModelSupportsVision,
};
