// lib/refusal-offer.js: when the person's own LLM provider turns down what
// they asked, Closedhand says once that the uncensored LLM would answer, as a
// follow-on message after the reply. Only a clear refusal counts: one that
// opens the reply, short, and not about something Closedhand could not reach
// or find ("I can't help with that, your calendar isn't connected"). Said at
// most once in 30 days, so it never becomes a line under every answer.

const included = require("./included-ai");

const REFUSED = [
  /\b(?:sorry,? but |unfortunately,? )?I(?: can(?:no|['’])t| won['’]t| am not able to|['’]m not able to| am unable to|['’]m unable to| must decline to| have to decline to) (?:help|assist|provide|create|write|generate|give|share|engage|discuss|comply|go into|offer|produce|describe)\b/i,
  /\bI (?:must|have to|need to) decline\b/i,
  /\bagainst my (?:guidelines|policies|principles|programming)\b/i,
  /\bI['’]m not (?:comfortable|able to be) (?:helping|providing|writing|discussing|creating)\b/i,
];
// A reply about something missing, not a refusal.
const MISSING = /\b(connect|connected|access to|permission|couldn['’]t find|can['’]t find|cannot find|not found|don['’]t have (?:any|a|the)|isn['’]t available|not available|sign in|signed in|offline)\b/i;
const EVERY = 30 * 24 * 3600 * 1000;

function refused(reply) {
  const text = String(reply || "").trim();
  if (!text || text.length > 1200) return false;
  const opening = text.slice(0, 300);
  return REFUSED.some((r) => r.test(opening)) && !MISSING.test(text);
}

// Where to get them: back in Settings while they are the person's, paying
// ahead again after a plan paid ahead, otherwise the subscription.
function where(plan, hasKey, link, web, name) {
  const live = hasKey && ["first-month", "plus", "ahead", "maintainer"].includes(plan?.name);
  if (live) return `Switch to ${included.llm({ llm: name })} in the ${link ? (web ? `[dashboard](${link})` : `dashboard (${link})`) : "dashboard's Settings"}.`;
  if (plan?.name === "ended" && plan.was === "ahead") return "Pay ahead again in My Account.";
  return web ? "[closedhand.com/subscribe](https://closedhand.com/subscribe)" : "closedhand.com/subscribe";
}

function offerText(settings, link, web) {
  const name = settings?.included_ai?.name;
  return `Your LLM provider chose not to answer that. With ${included.llm({ llm: name })}, what Closedhand answers is up to you, and nobody but you can read anything that goes in or comes out. ${where(settings?.included_ai?.plan, !!settings?.included_api_key, link, web, name)}`;
}

// The reply, with the offer after it when it is due. `now` and `link` stand
// in for the clock and the dashboard link in tests.
async function addOffer({ store, reply, platform, now = Date.now(), link }) {
  const settings = store?.profile?.settings;
  if (!settings || included.inUse(settings) || !refused(reply)) return reply;
  const last = Date.parse(settings.refusal_offer_at || "");
  if (Number.isFinite(last) && now - last < EVERY) return reply;
  const web = (platform || "web") === "web";
  if (link === undefined) link = await require("./dashboard-links").dashboardUrl(platform || "web", "settings").catch(() => null);
  settings.refusal_offer_at = new Date(now).toISOString();
  return String(reply).trim() + "\n\n[[next]]\n\n" + offerText(settings, link, web);
}

module.exports = { addOffer, refused, offerText };
