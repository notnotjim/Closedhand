// lib/usage.js — BYOK spend accounting (tokens, not money).
//
// Every LLM/embedding response carries a usage block; this buffers those counts
// in memory keyed by feature|model and flushes them to token_usage every 30s
// via the atomic record_token_usage RPC. Pure accounting: no LLM calls of its
// own, no retries beyond keeping the buffer, and a hard cap so a dead DB can
// never grow memory unbounded. Features: chat / machinery / enrichment /
// vision / embeddings.

const FLUSH_MS = 30_000;
const MAX_BUFFER_KEYS = 200;

const _buffer = new Map(); // "feature|model" -> { calls, tin, tout, cached, cost, costed }
let _timer = null;

// Accepts either Anthropic-shaped ({input_tokens, output_tokens}) or
// OpenAI-shaped ({prompt_tokens, completion_tokens}) usage blocks. Every
// reply also says how many of the tokens sent the provider had already seen
// (cached, charged far less), and some what the call cost: kept too, so
// Usage shows what the person's own LLM provider charges. Anthropic counts
// cache reads and writes apart from input_tokens; OpenAI-style replies, and
// the ones model-wire converts (input_includes_cache), count them inside.
function recordUsage(feature, model, usage) {
  if (!usage) return;
  const cached = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  const inside = usage.input_includes_cache || usage.prompt_tokens != null;
  const tin = (usage.input_tokens ?? usage.prompt_tokens ?? 0) + (inside ? 0 : cached + (usage.cache_creation_input_tokens || 0));
  const tout = usage.output_tokens ?? usage.completion_tokens ?? 0;
  if (!tin && !tout) return;
  const cost = typeof usage.cost_usd === "number" && usage.cost_usd >= 0 ? usage.cost_usd : typeof usage.cost === "number" && usage.cost >= 0 ? usage.cost : null;

  const key = `${feature}|${model || "unknown"}`;
  if (!_buffer.has(key) && _buffer.size >= MAX_BUFFER_KEYS) return; // cap, drop
  const cur = _buffer.get(key) || { calls: 0, tin: 0, tout: 0, cached: 0, cost: 0, costed: 0 };
  cur.calls += 1;
  cur.tin += tin;
  cur.tout += tout;
  cur.cached += Math.min(cached, tin);
  if (cost !== null) { cur.cost += cost; cur.costed += 1; }
  _buffer.set(key, cur);

  if (!_timer) {
    _timer = setInterval(() => { flushUsage().catch(() => {}); }, FLUSH_MS);
    if (_timer.unref) _timer.unref();
  }
}

// Use on Closedhand Managed Models is kept under that name alone, so Usage
// never names the LLMs Closedhand picked for them, even after the person
// moves to their own LLM provider: the models its settings run them on.
const MANAGED = "managed";
async function managedModels(supabase, userId) {
  try {
    const { data } = await supabase.from("profiles").select("settings").eq("id", userId).maybeSingle();
    const settings = data?.settings || {};
    if (!settings.model_config?.included) return new Set();
    return new Set([...Object.values(settings.model_config.roles || {}).map((r) => r?.model), ...Object.values(settings.included_ai?.models || {})].filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

async function flushUsage() {
  if (_buffer.size === 0) return;
  const { supabase, isDbConfigured } = require("./db");
  if (!isDbConfigured()) { _buffer.clear(); return; } // setup mode: nothing to bill against

  const { getAdminUserId } = require("./admin");
  const adminId = getAdminUserId();
  const day = new Date().toISOString().slice(0, 10);
  const managed = await managedModels(supabase, adminId);

  const entries = [..._buffer.entries()];
  _buffer.clear();
  for (const [key, v] of entries) {
    const [feature, model] = key.split("|");
    const { error } = await supabase.rpc("record_token_usage", {
      p_user_id: adminId,
      p_day: day,
      p_feature: feature,
      p_model: managed.has(model) ? MANAGED : model,
      p_calls: v.calls,
      p_tokens_in: v.tin,
      p_tokens_out: v.tout,
      p_tokens_cached: v.cached,
      p_cost_usd: v.cost,
      p_costed_calls: v.costed,
    });
    if (error) {
      // Put it back for the next flush (unless the cap says drop).
      const cur = _buffer.get(key) || { calls: 0, tin: 0, tout: 0, cached: 0, cost: 0, costed: 0 };
      if (_buffer.has(key) || _buffer.size < MAX_BUFFER_KEYS) {
        _buffer.set(key, { calls: cur.calls + v.calls, tin: cur.tin + v.tin, tout: cur.tout + v.tout, cached: cur.cached + v.cached, cost: cur.cost + v.cost, costed: cur.costed + v.costed });
      }
      console.error(`[usage] flush failed for ${key}: ${error.message || error.code}`);
    }
  }
}

// Where the LLM's tokens go, once an hour in the log: for each part of
// Closedhand that called it, the calls, tokens read, how many of those the
// provider already had cached, and tokens written. The part is the first
// file outside the LLM plumbing on the call's stack (lib/pulse.js is
// "pulse"). Names and counts only, never anything from a prompt.
const JOB_LOG_MS = 60 * 60 * 1000;
const PLUMBING = /^(llm|usage|model-wire|model-capabilities|model-jobs|services\/usi)$/;
const _jobs = new Map(); // "feature job" -> { calls, tin, cached, tout }
let _jobTimer = null;
function jobOf(stack) {
  for (const line of String(stack || "").split("\n").slice(1)) {
    const m = line.match(/[\\/]lib[\\/]([\w/.-]+)\.js:/);
    if (m && !PLUMBING.test(m[1])) return m[1];
  }
  return "other";
}
// USAGE_EACH_CALL=1 also says each call as it happens, for finding out at
// once rather than an hour later.
function recordJob(feature, job, usage, env = process.env) {
  if (!usage) return;
  const tin = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const cached = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const tout = usage.output_tokens ?? usage.completion_tokens ?? 0;
  if (env.USAGE_EACH_CALL === "1") console.log(`[usage] ${feature} ${job}: ${tin} in (${tin ? Math.round((100 * cached) / tin) : 0}% cached), ${tout} out`);
  const key = `${feature} ${job}`;
  if (!_jobs.has(key) && _jobs.size >= MAX_BUFFER_KEYS) return;
  const cur = _jobs.get(key) || { calls: 0, tin: 0, cached: 0, tout: 0 };
  cur.calls += 1;
  cur.tin += tin;
  cur.cached += cached;
  cur.tout += tout;
  _jobs.set(key, cur);
  if (!_jobTimer) {
    _jobTimer = setInterval(logJobs, JOB_LOG_MS);
    if (_jobTimer.unref) _jobTimer.unref();
  }
}
function logJobs() {
  if (_jobs.size === 0) return "";
  const line = "[usage] last hour by job: " + [..._jobs].sort((a, b) => b[1].tin - a[1].tin)
    .map(([key, v]) => `${key} ${v.calls} calls, ${v.tin} in (${v.tin ? Math.round((100 * v.cached) / v.tin) : 0}% cached), ${v.tout} out`).join("; ");
  _jobs.clear();
  console.log(line);
  return line;
}

// Wrap an LLM client so every messages.create records under `feature`.
// Covers both the adapter clients and the raw Anthropic SDK: only
// messages.create is used anywhere in this codebase.
function withUsageTracking(client, feature, fallbackModel) {
  if (!client || !client.messages || typeof client.messages.create !== "function") return client;
  return {
    ...client,
    messages: {
      ...client.messages,
      create: async (params, options) => {
        const stack = new Error().stack;
        const response = await client.messages.create(params, options);
        try { recordUsage(feature, fallbackModel || params?.model || response?.model, response?.usage); } catch (_) {}
        try { recordJob(feature, jobOf(stack), response?.usage); } catch (_) {}
        return response;
      },
    },
  };
}

module.exports = { recordUsage, flushUsage, withUsageTracking, jobOf, logJobs, recordJob, MANAGED };
