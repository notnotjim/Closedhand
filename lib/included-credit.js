// While Closedhand answers with its Managed Models (included-ai.js), what
// the person needs to hear about them is looked at every half hour and said
// once, where they get their updates: the free 14 days in their last three days,
// and most of a period's fair use used, so it never stops mid-task
// unannounced. When the fair use is reached, the chat says so as each message
// arrives (engine.js). Notices closedhand.com sent this account
// (included-ai-setup.js keeps them) go out the same way, each once.
const included = require("./included-ai");
const { getAdminUserId } = require("./admin");

const EVERY = 30 * 60 * 1000;
// The free days' end is said in their last three days; a plan paid ahead's in its last week.
const ENDING_SAID = { "first-month": 3 * 24 * 3600 * 1000, ahead: 7 * 24 * 3600 * 1000 };

async function check() {
  const { UserStore } = require("../user-store");
  const userId = getAdminUserId();
  const store = await UserStore.load(userId);
  const settings = store?.profile?.settings || {};
  const alert = require("./connection-alert");
  const { supabase } = require("./db");
  const patch = (set) => require("./settings-patch").patchSettings(supabase, userId, { set });
  let said = 0;

  // Only the ids are kept once sent, so the list the webapp adds to and the
  // record of what went out are never written by both.
  const sent = settings.included_notices_sent || [];
  const out = [];
  for (const notice of settings.included_notices || []) {
    if (!notice?.id || !notice.text || sent.includes(notice.id) || out.includes(notice.id)) continue;
    if (await alert.notifyFromClosedhand(userId, store, notice.text)) out.push(notice.id);
  }
  if (out.length) { await patch({ included_notices_sent: [...sent, ...out].slice(-50) }); said += out.length; }

  // The plan, with the LLM's name for what Closedhand says about it.
  const plan = settings.included_ai?.plan && { ...settings.included_ai.plan, llm: settings.included_ai.name };
  if (!included.inUse(settings) || !plan) return said;
  const told = { ...(settings.included_told || {}) };
  const timeZone = require("./timezone").getUserTimezone(store);
  if (ENDING_SAID[plan.name] && plan.ends_at && told.ending !== plan.ends_at) {
    const left = Date.parse(plan.ends_at) - Date.now();
    if (left > 0 && left <= ENDING_SAID[plan.name] && await alert.notifyAboutAi(userId, store, (link, web) => included.endingText(plan, link, web, timeZone))) {
      told.ending = plan.ends_at;
      said++;
    }
  }
  const period = included.period(plan);
  if (period && told.nearly !== period) {
    const credit = await included.credit(settings);
    if (credit && credit.used >= credit.limit * included.NEARLY_USED && await alert.notifyAboutAi(userId, store, (link, web) => included.nearlyUsedText(plan, link, web))) {
      told.nearly = period;
      said++;
    }
  }
  if (told.ending !== settings.included_told?.ending || told.nearly !== settings.included_told?.nearly) await patch({ included_told: told });
  return said;
}

// Every half hour, or every five minutes on the maintainer's own Closedhand,
// so closedhand.com's notices to them go out soon after they arrive.
function start() {
  let last = 0;
  const run = async () => {
    const { UserStore } = require("../user-store");
    const often = (await UserStore.load(getAdminUserId()))?.profile?.settings?.included_ai?.plan?.name === "maintainer";
    if (!often && Date.now() - last < EVERY - 60 * 1000) return;
    last = Date.now();
    await check();
  };
  const go = () => run().catch(e => console.error("[included ai] check:", e.message));
  setTimeout(go, 60 * 1000).unref?.();
  setInterval(go, 5 * 60 * 1000).unref?.();
}

module.exports = { start, check };
