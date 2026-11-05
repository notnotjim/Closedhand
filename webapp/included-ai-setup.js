// Setting up Closedhand Managed Models (included-ai.js) on this
// computer, when claiming the personal URL brings its key
// (phone-registration.js). The key is kept sealed, then checked and saved as
// the models the way a key the person pastes in is (model-config.js), so it
// works exactly like their own: through NEAR AI, the provider closedhand.com
// names today, that is private inference (near-private.js), and pictures go to
// the vision language model on this computer. A person who has set up an LLM
// provider of their own keeps it; the included key waits beside it.
const KEY = /^sk-[A-Za-z0-9_-]{20,200}$/;
const MODEL = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9._:-]+$/i;
// A provider closedhand.com names, one whose address Closedhand knows.
const knownProvider = (name) => typeof name === "string" && Object.prototype.hasOwnProperty.call(require("./model-policy").BASES, name);

// The chat model's name as people read it ("DeepSeek V4.1 Flash,
// uncensored"), as closedhand.com gives it, else its ID's last part.
function modelName(models) {
  const given = typeof models?.name === "string" ? models.name.replace(/[<>]/g, "").trim().slice(0, 80) : "";
  return given || String(models?.chat || "").split("/").pop();
}

// Which provider and models do which job, as closedhand.com gave them:
// support falls back to the chat model; pictures and videos go to their own
// only when one is given.
function pickOf(models) {
  const valid = (id) => MODEL.test(String(id || ""));
  return { provider: models.provider, chat: models.chat, background: valid(models.background) ? models.background : models.chat, ...(valid(models.vision) ? { vision: models.vision } : {}), name: modelName(models) };
}

async function settings() {
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  const { data, error } = await supabase.from("profiles").select("settings").eq("id", getAdminUserId()).single();
  if (error || !data) throw new Error("Could not load the settings.");
  return data.settings || {};
}

// Keep the key a claim brought (or closedhand.com later handed over), and set
// the models up with it in the background: the claim never waits for the
// model check. keep: what is already known about it (its plan).
async function receive(included, { keep = {} } = {}) {
  const chat = included?.models?.chat;
  if (!KEY.test(String(included?.key || "")) || !MODEL.test(String(chat || "")) || !knownProvider(included.models.provider)) return false;
  const models = pickOf(included.models);
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  await require("./settings-patch").patchSettings(supabase, getAdminUserId(), { set: {
    included_api_key: require("./model-policy").sealKey(included.key),
    included_ai: { ...keep, models, name: models.name, at: new Date().toISOString() },
  } });
  // A check that fails is recorded, so setup asks for an LLM provider instead
  // of waiting for one that will not come.
  use({ unlessOwn: true, fresh: true }).catch(async (e) => {
    console.error("[included ai] the models were not set up:", e.message);
    await require("./settings-patch").patchSettings(supabase, getAdminUserId(), { set: { included_ai: { ...keep, models, at: new Date().toISOString(), error: String(e.message || "check failed").slice(0, 200) } } }).catch(() => {});
  });
  return true;
}

// Use the included key for the models. unlessOwn: leave an LLM provider the
// person set up themselves in place. fresh: the key was only just made.
async function use({ unlessOwn = false, fresh = false } = {}) {
  const before = await settings();
  const key = require("./model-policy").openKey(before.included_api_key);
  const models = before.included_ai?.models;
  if (!key || !models?.chat || !knownProvider(models.provider)) throw new Error("This Closedhand has no Managed Models to switch to.");
  const own = () => unlessOwn && !!before.model_config && !before.model_config.included;
  if (own()) return false;
  const modelConfig = require("./model-config");
  const input = {
    primary: { provider: models.provider, apiKey: key }, model: models.chat,
    backgroundMode: models.background === models.chat ? "same" : "separate", backgroundModel: models.background,
  };
  // NEAR takes a few seconds to accept a key it has just made (seven to nine
  // when tried): refused then, it is checked again a few times before giving up.
  let waits = fresh ? 4 : 0;
  const prepare = async (vision) => {
    for (;;) {
      try { return await modelConfig.prepare({ ...input, ...vision }, before); }
      catch (error) {
        if (!waits || error.status !== 401) throw error;
        waits--;
        await new Promise((resolve) => setTimeout(resolve, NEW_KEY_WAIT));
      }
    }
  };
  // Pictures and videos by the model Closedhand picks for them, checked with
  // a real image and clip; else by the chat LLM when it reads images; else by
  // the vision language model on this computer, so an image check never stops
  // the models being used.
  const tries = [...(models.vision ? [{ visionMode: "separate", visionModel: models.vision }] : []), { visionMode: "same" }, { visionMode: "off" }];
  let config;
  for (const vision of tries) {
    try { config = await prepare(vision); break; }
    catch (error) { if (!error.visionNeeded || vision.visionMode === "off") throw error; }
  }
  config.included = true;
  // Saved against the settings as they are now, unless the person set up an
  // LLM provider of their own while this was being checked. Their own setup,
  // with its key, is kept beside it, so switching back (useOwn) is one step
  // and nothing they entered is lost.
  const now = await settings();
  if (unlessOwn && now.model_config && !now.model_config.included) return false;
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  const { diff, patchSettings } = require("./settings-patch");
  const next = modelConfig.withConfig(now, config);
  const kept = now.model_config && !now.model_config.included ? now.model_config : now.own_model_config;
  if (kept) next.own_model_config = kept;
  await patchSettings(supabase, getAdminUserId(), diff(now, next));
  return true;
}

// Back to the person's own LLM provider, as it was before Closedhand Managed
// Models took over. False when none was kept (they set one up in Models).
async function useOwn() {
  const now = await settings();
  const own = now.own_model_config;
  if (!own?.connections || own.included) return false;
  const { openKey } = require("./model-policy");
  const open = { ...own, connections: Object.fromEntries(Object.entries(own.connections).map(([id, c]) => [id, c && c.apiKey ? { ...c, apiKey: openKey(c.apiKey) } : c])) };
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  const { diff, patchSettings } = require("./settings-patch");
  await patchSettings(supabase, getAdminUserId(), diff(now, require("./model-config").withConfig(now, open)));
  return true;
}

const NEW_KEY_WAIT = 5000;

// The plan closedhand.com gives this computer's account, as Closedhand keeps
// it: what it is, when it ends or renews, whether this month was carried on,
// and whether Closedhand's own email comes with it. An ended plan remembers
// what it was, so the words for it fit. Anything unknown keeps what was known.
const PLANS = ["first-month", "plus", "ended", "none"];
function cleanPlan(plan, previous) {
  if (!plan || !PLANS.includes(plan.name)) return previous || null;
  const date = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
  const out = { name: plan.name, email: plan.email === true };
  if (date(plan.ends_at)) out.ends_at = date(plan.ends_at);
  if (date(plan.renews_at)) out.renews_at = date(plan.renews_at);
  if (plan.extended === true) out.extended = true;
  // A subscription in its free first month; or, never had the free month, able to start with one.
  if (plan.name === "plus" && plan.trial === true) out.trial = true;
  if (plan.name !== "plus" && plan.plus_trial === true) out.plus_trial = true;
  if (plan.name === "ended") {
    const was = ["first-month", "plus"].includes(plan.was) ? plan.was : previous?.name === "ended" ? previous.was : previous?.name;
    if (was === "first-month" || was === "plus") out.was = was;
    if (date(plan.ended_at)) out.ended_at = date(plan.ended_at);
  }
  return out;
}

// Notices for this account not yet kept or sent: each { id, text }, said as
// written. The ones already sent (included-credit.js records them) are let go.
function keptNotices(given, before) {
  const sent = new Set(before.included_notices_sent || []);
  const kept = (before.included_notices || []).filter((n) => n?.id && !sent.has(n.id));
  const known = new Set(kept.map((n) => n.id));
  const fresh = (Array.isArray(given) ? given : [])
    .filter((n) => n && typeof n.id === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(n.id) && typeof n.text === "string" && n.text.trim() && !sent.has(n.id) && !known.has(n.id))
    .slice(0, 10).map((n) => ({ id: n.id, text: n.text.trim().slice(0, 1000) }));
  return { list: [...kept, ...fresh].slice(-20), changed: fresh.length > 0 || kept.length !== (before.included_notices || []).length };
}

// Every hour this computer asks closedhand.com about Closedhand Managed
// Models for it (phone-registration.js): the provider and models Closedhand
// picks, switched to when they change (if they are in use) and named; its
// account's plan, for what Closedhand says and the dashboard shows, and how
// much of its fair use is used, in dollars, never shown (included-ai.js
// credit); a key waiting for it, kept as a claim's is; and notices for its
// account, left for the bot to send (included-credit.js). True when anything
// changed.
async function refresh() {
  const answer = await require("./phone-registration").includedAiState();
  if (!answer) return false;
  const before = await settings();
  const had = before.included_ai || {};
  const plan = cleanPlan(answer.plan, had.plan);
  const pick = MODEL.test(String(answer.models?.chat || "")) && knownProvider(answer.models?.provider) ? pickOf(answer.models) : null;
  const amount = (v) => Number.isFinite(Number(v)) && v !== null && v !== "" && Number(v) >= 0 ? Math.round(Number(v) * 100) / 100 : null;
  const usage = answer.usage && amount(answer.usage.limit) > 0 && amount(answer.usage.used) !== null ? { limit: amount(answer.usage.limit), used: amount(answer.usage.used) } : null;
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  const patch = (set) => require("./settings-patch").patchSettings(supabase, getAdminUserId(), { set });
  const notices = keptNotices(answer.notices, before);
  // What the subscription and carrying on cost, as closedhand.com shows them ("$10").
  const price = (v) => typeof v === "string" && /^[^\s<>]{1,12}$/.test(v) ? v : null;
  const prices = answer.prices && price(answer.prices.plus) ? { plus: price(answer.prices.plus), ...(price(answer.prices.extend) ? { extend: price(answer.prices.extend) } : {}) } : null;
  if (notices.changed) await patch({ included_notices: notices.list });
  // A key closedhand.com kept for this computer (a subscriber's account held
  // none): taken once, and set up exactly as a claim's.
  if (pick && KEY.test(String(answer.key || ""))) {
    await receive({ key: answer.key, models: pick }, { keep: { ...(plan ? { plan } : {}), ...(prices ? { prices } : {}), ...(usage ? { usage } : {}) } });
    return true;
  }
  const next = { ...had };
  if (plan && JSON.stringify(plan) !== JSON.stringify(had.plan)) next.plan = plan;
  if (prices && JSON.stringify(prices) !== JSON.stringify(had.prices)) next.prices = prices;
  if (usage && JSON.stringify(usage) !== JSON.stringify(had.usage)) next.usage = usage;
  let switchTo = false;
  if (before.included_api_key && pick && (had.models?.provider !== pick.provider || had.models?.chat !== pick.chat || had.models?.background !== pick.background || had.models?.vision !== pick.vision || had.name !== pick.name)) {
    next.models = pick;
    next.name = pick.name;
    switchTo = !!before.model_config?.included;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(had);
  if (changed) await patch({ included_ai: next });
  if (switchTo) await use();
  return changed || notices.changed;
}

function start() {
  const run = () => refresh().catch(e => console.error("[included ai] could not check with closedhand.com:", e.message));
  setTimeout(run, 2 * 60 * 1000).unref?.();
  setInterval(run, 60 * 60 * 1000).unref?.();
}

module.exports = { receive, use, useOwn, refresh, start, modelName };
