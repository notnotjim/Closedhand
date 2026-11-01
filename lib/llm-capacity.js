// How many of a team's agents the person's LLM can serve at once, per person
// and model. Never a list of providers: what each one can take comes from
// how it answers. Anthropic, OpenAI, Groq and others say on every reply how
// many requests and tokens are left this minute (model-wire limitsFrom);
// where a provider says nothing, every agent starts and the first refusal,
// or a reply that never came because the server was working through a queue
// (a model on the computer itself), sets the number. A refusal is remembered
// for the next team and eased by one each half hour without another.
const state = new Map();
const EASE_MS = 30 * 60 * 1000;
// About four calls a minute per agent: a tool loop answers, runs its tools
// and asks again every 10 to 20 seconds.
const CALLS_PER_MINUTE = 4;
// Room left for the person's chat and anything else on the same key.
const SHARE = 0.8;

function key(userId, model) { return `${userId || "-"}|${model || "-"}`; }
function entry(k) {
  if (!state.has(k)) state.set(k, { running: 0, atOnce: null, refusedAt: 0, limits: null, input: 0 });
  return state.get(k);
}

// A reply's limit headers, and the size of what was sent, so later sizing
// knows what one agent's call weighs.
function observe(k, limits, inputTokens) {
  const s = entry(k);
  if (limits) s.limits = { ...limits, at: Date.now() };
  if (inputTokens > 0) s.input = s.input ? Math.round(s.input * 0.7 + inputTokens * 0.3) : inputTokens;
}

// The provider said to slow down (or a reply never came while several ran):
// one fewer than were running then, never below one.
function refused(k) {
  const s = entry(k);
  s.atOnce = Math.max(1, Math.min(s.atOnce || Infinity, Math.max(1, s.running) - 1));
  s.refusedAt = Date.now();
}

function learned(s, now = Date.now()) {
  if (!s.atOnce) return null;
  const eased = Math.floor((now - s.refusedAt) / EASE_MS);
  return eased > 0 ? s.atOnce + eased : s.atOnce;
}

// From the headers: how many agents' worth of calls fit in a minute, leaving
// a share for chat. Null when the provider sent no limits.
function fromLimits(s) {
  const l = s.limits;
  if (!l) return null;
  const perAgentTokens = Math.max(1, s.input || 20000) * CALLS_PER_MINUTE;
  const byTokens = (l.tokensLimit ?? l.tokensLeft) != null ? Math.floor((SHARE * (l.tokensLimit ?? l.tokensLeft)) / perAgentTokens) : null;
  const byRequests = (l.requestsLimit ?? l.requestsLeft) != null ? Math.floor((SHARE * (l.requestsLimit ?? l.requestsLeft)) / CALLS_PER_MINUTE) : null;
  const both = [byTokens, byRequests].filter((n) => n != null);
  return both.length ? Math.max(1, Math.min(...both)) : null;
}

// How many of a team of `size` run at once now.
function atOnce(k, size, now = Date.now()) {
  const s = entry(k);
  const caps = [size, learned(s, now), fromLimits(s)].filter((n) => n != null);
  return Math.max(1, Math.min(...caps));
}

function begin(k) { entry(k).running++; }
function end(k) { const s = entry(k); s.running = Math.max(0, s.running - 1); }
function running(k) { return entry(k).running; }
function reset() { state.clear(); }

module.exports = { key, observe, refused, atOnce, begin, end, running, reset, fromLimits, CALLS_PER_MINUTE, SHARE, EASE_MS };
