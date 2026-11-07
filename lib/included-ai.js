// included-ai.js: vendored. lib/included-ai.js and webapp/included-ai.js are
// byte-identical (scripts/vendored-manifest.json).
//
// The uncensored LLM closedhand.com provides (Managed Models in the code's
// words): a NEAR AI API key of the person's own, made by
// closedhand.com when they claimed their personal URL
// (closedhand-com/lib/included-ai.js). It is kept sealed in the settings
// (included_api_key) and used like any key the person pastes in, straight to
// NEAR, so closedhand.com never sees it being used. A NEAR key can't read
// what is left on it, so closedhand.com says that with the plan each hour
// (included-ai-setup.js).

// Closedhand is answering with the uncensored LLM closedhand.com provides right now.
function inUse(settings) {
  return !!(settings?.model_config?.included && settings?.included_api_key);
}

// What is left on the key, { limit, used, left } in dollars, or null when
// that isn't known. For a subscription it counts this paid month. Never
// shown, only compared.
async function credit(settings) {
  const usage = settings?.included_ai?.usage;
  const limit = Number(usage?.limit), used = Number(usage?.used);
  if (!settings?.included_api_key || !Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0) return null;
  return { limit, used, left: Math.max(0, limit - used) };
}

// The person is told once a period, when this share of the fair use is used.
const NEARLY_USED = 0.8;

// What a period of fair use is called, so each is warned about once: a first
// month by when it ends, a month of a subscription or of a plan paid ahead by
// when its fair use renews or the plan ends, and again once the person paid
// to carry on in it. None otherwise.
function period(plan) {
  if (plan?.name === "first-month") return "first-month:" + (plan.ends_at || "");
  if (plan?.name === "plus" || plan?.name === "ahead") return plan.name + ":" + (plan.fair_use_renews_at || plan.ends_at || "") + (plan.extended ? ":extended" : "");
  if (plan?.name === "maintainer") return "maintainer:" + (plan.fair_use_renews_at || "");
  return null;
}

// The day as people say it ("21 November"), where they are.
function day(iso, timeZone) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "the end of the month";
  try { return at.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone }); }
  catch (_) { return at.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }); }
}
// When this month's fair use comes back: the day it renews. A plan in its
// last month has no renewal to name.
function until(plan, timeZone) {
  return plan?.fair_use_renews_at ? `so I can't reply until ${day(plan.fair_use_renews_at, timeZone)}` : "so I can't reply for now";
}
// Subscribing in one tap (closedhand.com/subscribe): signed in there,
// straight to Polar's page to take it out.
function account(web) {
  return web ? "[closedhand.com/subscribe](https://closedhand.com/subscribe)" : "closedhand.com/subscribe";
}
// Carrying on to the end of the month: My Account, through
// closedhand.com/carry-on, where the box is ticked first; on the words in the
// web chat.
function carryOn(web, first) {
  const words = (first ? "C" : "c") + "arry on to the end of the month";
  return web ? `[${words}](https://closedhand.com/carry-on)` : `${words} at closedhand.com/carry-on`;
}


// Where to go: the dashboard's Settings, as a link the chat can show (the
// web chat shows links on words; chat apps show the address).
function dashboard(link, web) {
  return link ? (web ? `[dashboard](${link})` : `dashboard (${link})`) : "dashboard's Settings";
}

// What the person is told, in fixed words: when the fair use is reached there
// is no model left to write them. Keeping the uncensored LLM comes first,
// then their own LLM provider, free ones included.
// The uncensored LLM by the name closedhand.com gives it: callers put it on
// the plan as llm.
function llm(plan) {
  return plan?.llm || "DeepSeek V4.1 Flash Abliterated";
}
function endingText(plan, link, web, timeZone) {
  // Paid ahead: paying ahead again, or the monthly subscription, carries on.
  if (plan?.name === "ahead") return `${llm(plan)} is paid until ${day(plan.ends_at, timeZone)}. To carry on without a break, pay ahead again in My Account before then, or connect your own LLM provider in the ${dashboard(link, web)} (free ones work too).`;
  return `${llm(plan)}, the LLM I've been using since you set me up, stays on until ${day(plan?.ends_at, timeZone)}. After that, keep it with a subscription${plan?.email ? ", which also keeps Closedhand's own email address," : ""} at ${account(web)}, or connect your own LLM provider in the ${dashboard(link, web)} (free ones work too).`;
}
function nearlyUsedText(plan, link, web) {
  // The maintainer's own: nothing to pay, so their own LLM provider is the way on.
  if (plan?.name === "maintainer") return `You've used most of this month's fair use of ${llm(plan)}. To carry on without a break, connect your own LLM provider in the ${dashboard(link, web)}.`;
  if ((plan?.name === "plus" || plan?.name === "ahead") && plan.extended) return `You've used most of this month's fair use of ${llm(plan)}. To carry on without a break, connect your own LLM provider in the ${dashboard(link, web)}.`;
  if (plan?.name === "plus" || plan?.name === "ahead") return `You've used most of this month's fair use of ${llm(plan)}. To carry on without a break, ${carryOn(web)}, or connect your own LLM provider in the ${dashboard(link, web)}.`;
  return `You've used most of the fair use of ${llm(plan)}. To carry on without a break, keep it with a subscription at ${account(web)}, or connect your own LLM provider in the ${dashboard(link, web)} (free ones work too).`;
}
// The key was refused for its limit: by what the plan was last known to be.
function usedUpText(plan, link, web, timeZone) {
  if (plan?.name === "maintainer") return `You've reached this month's fair use of ${llm(plan)}, ${until(plan, timeZone)}. Connect your own LLM provider in the ${dashboard(link, web)} to carry on before then.`;
  if ((plan?.name === "plus" || plan?.name === "ahead") && plan.extended) return `You've reached this month's fair use of ${llm(plan)}, ${until(plan, timeZone)}. Connect your own LLM provider in the ${dashboard(link, web)} to carry on${plan.fair_use_renews_at ? " before then" : ""}.`;
  if (plan?.name === "plus" || plan?.name === "ahead") return `You've reached this month's fair use of ${llm(plan)}, ${until(plan, timeZone)}. ${carryOn(web, true)}, or connect your own LLM provider in the ${dashboard(link, web)}.`;
  if (plan?.name === "ended" && plan.was === "ahead") return `Your plan paid ahead has ended, so I can't reply for now. Pay ahead again or subscribe at ${account(web)} and I'll carry on, or connect your own LLM provider in the ${dashboard(link, web)} (free ones work too).`;
  if (plan?.name === "ended" && plan.was === "plus") return `Your subscription has ended, so I can't reply for now. Subscribe again at ${account(web)} and I'll carry on, or connect your own LLM provider in the ${dashboard(link, web)} (free ones work too).`;
  if (plan?.name === "ended") return `Your free 14 days of ${llm(plan)} have ended, so I can't reply for now. Keep it with a subscription at ${account(web)} and I'll carry on, or connect your own LLM provider in the ${dashboard(link, web)} (free ones work too).`;
  return `You've reached the fair use of ${llm(plan)}, so I can't reply for now. Keep it with a subscription at ${account(web)} and I'll carry on, or connect your own LLM provider in the ${dashboard(link, web)} (free ones work too).`;
}
// The person's own LLM provider refused: out of credit, or the key rejected.
function accountProblemText(status, link, web) {
  return status === 402
    ? `Your LLM provider says the account needs payment or more credit, so I can't reply for now. Top it up with them, or connect another LLM provider in the ${dashboard(link, web)}.`
    : `Your LLM provider rejected Closedhand's API key, so I can't reply for now. Check the key under Models in the ${dashboard(link, web)}.`;
}

module.exports = { inUse, credit, NEARLY_USED, period, day, until, llm, endingText, nearlyUsedText, usedUpText, accountProblemText };
