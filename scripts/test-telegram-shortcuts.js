// Telegram gets the same pinned dashboard link and shortcuts as WhatsApp, as
// a button that opens the dashboard inside Telegram, plus what only Telegram
// has: a Dashboard button beside the message box and /bug in the command list.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.join(__dirname, "..");

const BASE = "https://amber-lake-12.closedhand.ai";

function harness({ base = BASE, introduced = true, phoneAccess = "0", token = "111:abc" } = {}) {
  const calls = [];
  let nextId = 40;
  const bot = {
    setMyCommands: async (commands) => calls.push(["commands", commands]),
    setChatMenuButton: async (form) => calls.push(["menu", JSON.parse(form.menu_button)]),
    sendMessage: async (chatId, text, options) => { calls.push(["send", chatId, text, options]); return { message_id: ++nextId }; },
    pinChatMessage: async (chatId, id, options) => calls.push(["pin", chatId, id, options]),
    unpinChatMessage: async (chatId, form) => calls.push(["unpin", chatId, form.message_id]),
  };
  const rows = {
    profiles: { settings: introduced ? { onboarding_step: "done" } : {} },
    chat_links: [{ platform_user_id: "555" }],
    facts: [],
  };
  const supabase = { from(table) {
    const q = { select: () => q, eq: () => q, limit: async () => ({ data: rows[table] }), single: async () => ({ data: rows[table] }) };
    return q;
  } };
  const conf = { PHONE_ACCESS: phoneAccess, TELEGRAM_BOT_TOKEN: token };
  const state = { base };
  const stubs = {
    "lib/context.js": { bot },
    "user-store.js": { supabase },
    "lib/admin.js": { ensureAdmin: async () => "owner" },
    "lib/config.js": { getConf: async (k) => conf[k], setConf: async (patch) => Object.assign(conf, patch), dashboardBase: async () => state.base },
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const file = require.resolve(path.join(root, rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  }
  for (const rel of ["lib/telegram-shortcuts.js", "lib/telegram-in-app.js"]) delete require.cache[require.resolve(path.join(root, rel))];
  delete process.env.TELEGRAM_BOT_TOKEN;
  const { keepShortcuts } = require(path.join(root, "lib/telegram-shortcuts.js"));
  return { keepShortcuts, calls, conf, state };
}

test("with a personal URL: /bug in the command list, a Dashboard button by the message box, and the shortcuts pinned once", async () => {
  const h = harness();
  await h.keepShortcuts();
  assert.deepEqual(h.calls.find((c) => c[0] === "commands")[1], [{ command: "bug", description: "Report a problem" }]);
  assert.deepEqual(h.calls.find((c) => c[0] === "menu")[1], { type: "web_app", text: "Dashboard", web_app: { url: BASE + "/tg/open?to=%2Fdashboard" } });
  const send = h.calls.find((c) => c[0] === "send");
  assert.equal(send[1], "555");
  assert.match(send[2], /^I’m pinning this so your dashboard is easy to find\.\n\nYour dashboard: https:\/\/amber-lake-12\.closedhand\.ai\/dashboard\n/);
  assert.equal(send[3].disable_notification, true);
  assert.deepEqual(h.calls.find((c) => c[0] === "pin").slice(1, 3), ["555", 41]);
  assert.equal(h.conf.TELEGRAM_SHORTCUTS.messageId, 41);
  // Nothing changed: nothing sent or set again.
  const before = h.calls.length;
  await h.keepShortcuts();
  assert.equal(h.calls.length, before);
  // A personal URL claimed anew: the new words pinned, the old message unpinned.
  h.state.base = "https://quiet-isle-7.closedhand.ai";
  await h.keepShortcuts();
  assert.ok(h.calls.some((c) => c[0] === "unpin" && c[2] === 41));
  assert.ok(h.calls.some((c) => c[0] === "pin" && c[2] === 42));
  assert.ok(h.calls.some((c) => c[0] === "menu" && c[1].web_app?.url === "https://quiet-isle-7.closedhand.ai/tg/open?to=%2Fdashboard"));
});

test("the pin waits for introductions, and for the personal URL while phone access is on", async () => {
  const early = harness({ introduced: false });
  await early.keepShortcuts();
  assert.ok(!early.calls.some((c) => c[0] === "send"), "not before introductions");
  const waiting = harness({ base: null, phoneAccess: "1" });
  await waiting.keepShortcuts();
  assert.ok(!waiting.calls.some((c) => c[0] === "send"), "the address is on its way");
  assert.deepEqual(waiting.calls.find((c) => c[0] === "menu")[1], { type: "default" }, "the command list until there is an https page to open");
  const local = harness({ base: null });
  await local.keepShortcuts();
  assert.match(local.calls.find((c) => c[0] === "send")[2], /Your dashboard opens on the computer running Closedhand\./);
});

test("a new bot is pinned afresh, without touching the old bot's message", async () => {
  const h = harness({ token: "222:def" });
  h.conf.TELEGRAM_SHORTCUTS = { bot: "111", chatId: "555", messageId: 7, text: "I’m pinning this so your dashboard and shortcuts are easy to find.\n\nYour dashboard: " + BASE + "/dashboard" };
  await h.keepShortcuts();
  assert.ok(h.calls.some((c) => c[0] === "send"));
  assert.ok(!h.calls.some((c) => c[0] === "unpin"));
  assert.equal(h.conf.TELEGRAM_SHORTCUTS.bot, "222");
});

test("on Telegram the dashboard line becomes an Open dashboard button, as WhatsApp's stays a link", async () => {
  harness();
  const { pageButtons } = require(path.join(root, "lib/telegram-in-app.js"));
  const { shortcutsText } = require(path.join(root, "lib/shortcuts.js"));
  const shaped = await pageButtons(BASE, shortcutsText(BASE + "/dashboard"));
  assert.deepEqual(shaped.buttons, [[{ text: "Open dashboard", web_app: { url: BASE + "/tg/open?to=%2Fdashboard" } }]]);
  assert.doesNotMatch(shaped.text, /closedhand\.ai|Your dashboard/);
  assert.match(shaped.text, /^I’m pinning this so your dashboard is easy to find\.\n\nA project can be created for any topic that is likely to run for a while\. I’ll offer to set one up when one comes up\. You can also view and create projects from your Closedhand dashboard\.\n\nIf something goes wrong, send \/bug and say what happened\.$/, "every line a sentence");
});

test("it is kept when the bot starts, and once introductions finish or /start greets someone already introduced", () => {
  const fs = require("node:fs");
  const telegram = fs.readFileSync(path.join(root, "lib/platforms/telegram.js"), "utf8");
  assert.match(telegram, /require\("\.\.\/telegram-shortcuts"\)\.startShortcuts\(\);/);
  assert.match(telegram, /onboarding_step === "done"\) \{\n\s+setTimeout\(\(\) => require\("\.\.\/telegram-shortcuts"\)\.keepShortcuts\(\), 1500\);/);
  assert.match(telegram, /hereTooLine\("Telegram"\)\);\n\s+setTimeout\(\(\) => require\("\.\.\/telegram-shortcuts"\)\.keepShortcuts\(\), 1500\);/);
  assert.match(fs.readFileSync(path.join(root, "lib/platforms/whatsapp-linked.js"), "utf8"), /const \{ shortcutsText \} = require\("\.\.\/shortcuts"\);/, "one message for both chat apps");
});
