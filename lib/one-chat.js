// lib/one-chat.js: one conversation, whole wherever it is opened.
//
// Closedhand has one conversation with the person across every app, but each
// app showed only what passed through it: a question asked on WhatsApp was
// missing from the web chat, and an answer read in the web chat was missing
// from WhatsApp, so carrying on in another app meant carrying on half blind.
// After every turn, each app that can show it gets it:
// - the web chat, Closedhand's own, shows every message from every app, live,
//   with the app it came from;
// - WhatsApp linked to the person's own account gets the turn in their chat
//   with themselves: their words as theirs, the reply as its replies are,
//   silently (nothing they send themselves buzzes);
// - an app where Closedhand is a bot (Telegram, Slack, Discord, LINE, WhatsApp
//   by a business number) cannot show the person's words as theirs, and
//   copying private chats onto it is not wanted, so the first reply there
//   after a switch opens with a line on where they left off.
// Status lines ("Thinking…") and proactive messages stay where they went;
// the web chat shows proactive messages too.

const NAMES = { web: "the web chat", whatsapp_linked: "WhatsApp", whatsapp: "WhatsApp", telegram: "Telegram", slack: "Slack", discord: "Discord", line: "LINE" };
const BOT_APPS = new Set(["telegram", "whatsapp", "slack", "discord", "line"]);
const PICK_UP_WITHIN_MS = 12 * 3600 * 1000;

// What the person wrote, as they wrote it: a reply's quoted message and
// Closedhand's own notes are not their words.
function theirWords(text) {
  return require("./project-rules").splitReply(String(text || "")).rest.replace(/\s+/g, " ").trim();
}

// The line a bot app's reply opens with when the person's last message was
// in another app, not long ago. Read before the turn adds this message.
function pickUpLine(conversation, via, now = Date.now()) {
  if (!BOT_APPS.has(via)) return "";
  const last = [...(conversation || [])].reverse().find((m) => m && m.role === "user" && typeof m.content === "string");
  if (!last || !last.via || last.via === via || !NAMES[last.via]) return "";
  if (!last.ts || now - Date.parse(last.ts) > PICK_UP_WITHIN_MS) return "";
  const said = theirWords(last.content);
  if (!said || /^\[[^\]]*\]$/.test(said)) return "";
  const short = said.length > 90 ? said.slice(0, 90).replace(/\s+\S*$/, "") + "…" : said;
  return `Carrying on from ${NAMES[last.via]}, where you said: "${short}"`;
}

// Every message the turn added carries the app it came from.
function tag(conversation, before, via) {
  let n = 0;
  for (const m of conversation || []) if (m && typeof m === "object" && !before.has(m) && !m.via) { m.via = via; n++; }
  return n;
}

// The turn, to the apps that did not see it.
async function after({ userId, via, said, reply, fileData = null, project = null }) {
  const words = theirWords(said) || (fileData ? `(${/^image\//.test(fileData.mimeType || "") ? "a photo" : "a file"})` : "");
  const answer = typeof reply === "string" ? reply.trim() : "";
  if (!words && !answer) return;
  if (via !== "web") toWeb(userId, [words && { role: "user", content: words, via }, answer && { role: "assistant", content: answer, via }].filter(Boolean), project);
  if (via !== "whatsapp_linked") await toWhatsApp(userId, { said: words, reply: answer }).catch((e) => console.warn(`[one-chat] WhatsApp not updated: ${e.message}`));
}

// Open web chat tabs, live; their history reads the same conversation.
function toWeb(userId, messages, project = null) {
  try {
    const web = require("./web-chat-ws");
    if (messages.length && web.hasWebChatConnection(userId)) web.sendToUser(userId, { type: "elsewhere", messages, project: project ? { id: project.id || null, emoji: project.emoji || null } : null });
  } catch (_) { /* no web chat open */ }
}

// The person's own chat with themselves, when WhatsApp is linked to their account.
async function toWhatsApp(userId, { said, reply }) {
  const wa = require("./platforms/whatsapp-linked");
  const self = wa.selfChat(userId);
  if (!self) return;
  if (said) await wa.mirrorPersonToSelf(said);
  if (reply) await wa.sendLinkedMessage(self, reply);
}

// A message Closedhand sent on its own (Pulse, a finished task, a reminder):
// the web chat shows it too.
function sentElsewhere(userId, via, text) {
  if (!userId || via === "web" || !String(text || "").trim()) return;
  toWeb(userId, [{ role: "assistant", content: String(text).trim(), via }]);
}

module.exports = { after, tag, pickUpLine, sentElsewhere, theirWords, NAMES, BOT_APPS };
