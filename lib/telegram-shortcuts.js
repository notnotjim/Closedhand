// Telegram's way to the dashboard and the shortcuts, with what Telegram has
// and WhatsApp doesn't:
// - the same pinned message as WhatsApp (lib/shortcuts.js), its dashboard
//   link a button that opens the dashboard inside Telegram
//   (lib/telegram-in-app.js turns the link into it);
// - a Dashboard button beside the message box, there in every chat;
// - /bug in the "/" command list.
// The pin waits for introductions, as on WhatsApp. Telegram pins don't lapse,
// so it is sent again only when its words change (a personal URL claimed
// later), or for a new bot or chat. Runs when the bot starts, every ten
// minutes and once introductions finish on Telegram.
const ctx = require("./context");
const { supabase } = require("../user-store");
const { ensureAdmin } = require("./admin");
const { getConf, setConf, dashboardBase } = require("./config");
const { shortcutsText } = require("./shortcuts");
const { throughSignIn } = require("./telegram-in-app");

const KEY = "TELEGRAM_SHORTCUTS";
const CHECK_MS = 10 * 60 * 1000;
let _menu = null, _commands = false, _running = null;

async function introduced(id) {
  const { data } = await supabase.from("profiles").select("settings").eq("id", id).single();
  if (data?.settings?.onboarding_step === "done") return true;
  const { data: fact } = await supabase.from("facts").select("key").eq("user_id", id).eq("key", "_onboarded").limit(1);
  return !!fact?.length;
}

async function keep() {
  if (!ctx.bot) return;
  const base = await dashboardBase().catch(() => null);
  if (!_commands) {
    await ctx.bot.setMyCommands([{ command: "bug", description: "Report a problem" }]);
    _commands = true;
  }
  // Telegram opens only https pages inside it: the dashboard button waits
  // for the personal URL, and until then the menu is the command list.
  const menu = JSON.stringify(base ? { type: "web_app", text: "Dashboard", web_app: { url: throughSignIn(base, base + "/dashboard") } } : { type: "default" });
  if (_menu !== menu) {
    await ctx.bot.setChatMenuButton({ menu_button: menu });
    _menu = menu;
  }

  const id = await ensureAdmin();
  const { data: link } = await supabase.from("chat_links").select("platform_user_id").eq("platform", "telegram").eq("user_id", id).limit(1);
  const chatId = link?.[0]?.platform_user_id;
  if (!chatId || !(await introduced(id))) return;
  const bot = String(process.env.TELEGRAM_BOT_TOKEN || (await getConf("TELEGRAM_BOT_TOKEN")) || "").split(":")[0];
  const prior = await getConf(KEY);
  const same = prior?.messageId && prior.bot === bot && prior.chatId === chatId;
  // No address right now is a moment's failure, not a change of address: a
  // message already pinned stays, and a first one waits for it while phone
  // access is on (as on WhatsApp).
  if (!base) {
    if (same) return;
    if (String(await getConf("PHONE_ACCESS")) === "1") return;
  }
  const text = shortcutsText(base ? base + "/dashboard" : null);
  if (same && prior.text === text) return;
  const sent = await ctx.bot.sendMessage(chatId, text, { disable_notification: true });
  if (!sent?.message_id) return;
  if (same) { try { await ctx.bot.unpinChatMessage(chatId, { message_id: prior.messageId }); } catch (_) {} }
  await ctx.bot.pinChatMessage(chatId, sent.message_id, { disable_notification: true });
  await setConf({ [KEY]: { bot, chatId, messageId: sent.message_id, text, pinnedAt: new Date().toISOString() } });
  console.log("[telegram] shortcuts pinned");
}

// One check at a time: the timer, a restart and introductions can coincide.
function keepShortcuts() {
  if (!_running) _running = keep().catch((e) => console.error("[telegram] shortcuts:", e.message)).finally(() => { _running = null; });
  return _running;
}

function startShortcuts() {
  setTimeout(keepShortcuts, 5000);
  const timer = setInterval(keepShortcuts, CHECK_MS);
  if (timer.unref) timer.unref();
}

module.exports = { keepShortcuts, startShortcuts };
