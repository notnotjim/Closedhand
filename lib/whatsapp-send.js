// lib/whatsapp-send.js: a message in one of the person's WhatsApp chats, sent
// as them, after their yes.
//
// Linked WhatsApp answers only in the person's own chat. Writing in any other
// is Closedhand speaking to their contacts as them, so it happens only through
// whatsapp_send, which lib/send-gate.js holds for a yes like an email (unless
// "Ask before sending messages to other people" is unticked). The question
// names the chat the way the person knows it: its name, or, for a chat
// WhatsApp gave no name, the last thing the other side wrote there.

const JID = /^[0-9]+(-[0-9]+)?@(s\.whatsapp\.net|lid|g\.us)$/;
const NUMBER_NAME = /^\+?[\d\s()-]+$/;

// The chats recall has, from its rows newest first: each chat's id, its name
// and the last message from the other side.
function chatsFrom(rows) {
  const chats = new Map();
  for (const r of rows || []) {
    const d = (r && r.data) || r || {};
    if (!d.chat) continue;
    let c = chats.get(d.chat);
    if (!c) chats.set(d.chat, (c = { jid: d.chat, name: null, last: null }));
    if (!c.name && d.chat_name && !NUMBER_NAME.test(d.chat_name)) c.name = String(d.chat_name);
    if (!c.last && d.sender !== "me" && d.text) c.last = String(d.text);
  }
  return [...chats.values()];
}

// "to" as the LLM gives it: a chat id, a phone number with its country code,
// or a chat's name. (A message id is turned into its chat before this.)
function pickChat(to, chats) {
  const t = String(to || "").trim();
  if (!t) return { error: "Say which chat: its name as search results give it, the id of a message in it (wa-...), or a phone number with its country code." };
  if (JID.test(t)) return { chat: chats.find((c) => c.jid === t) || { jid: t } };
  const digits = t.replace(/[\s()+-]/g, "");
  if (NUMBER_NAME.test(t) && /^\d{8,15}$/.test(digits)) {
    const jid = `${digits}@s.whatsapp.net`;
    return { chat: chats.find((c) => c.jid === jid) || { jid } };
  }
  const want = t.toLowerCase();
  const whole = chats.filter((c) => c.name && c.name.toLowerCase() === want);
  const found = whole.length ? whole : chats.filter((c) => c.name && c.name.toLowerCase().includes(want));
  if (found.length === 1) return { chat: found[0] };
  if (found.length > 1) return { error: `More than one WhatsApp chat matches "${t}": ${found.slice(0, 6).map((c) => c.name).join(", ")}. Give the whole name or a message id from the right one.` };
  return { error: `No WhatsApp chat called "${t}". Find it with search_cache (source "whatsapp") and give a message id from it (wa-...), its chat name, or a phone number with its country code.` };
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

// The chat as the question names it.
function labelFor(c) {
  if (c.name) return c.name;
  if (c.last) return `the chat where they last wrote "${clip(c.last.replace(/\s+/g, " ").trim(), 70)}"`;
  const n = c.jid.split("@")[0];
  return c.jid.endsWith("@s.whatsapp.net") ? `+${n}` : "a chat with no name";
}

const RECENT_ROWS = 3000;

// The chat a send goes to, from the person's own recall: { jid, label } or
// { error } for the LLM to fix before anyone is asked.
async function resolve(userId, to, db = require("../user-store").supabase) {
  let target = String(to || "").trim();
  if (/^wa-/.test(target)) {
    const { data } = await db.from("data_cache").select("data").eq("user_id", userId).eq("source", "whatsapp").eq("external_id", target).limit(1);
    const chat = data && data[0] && data[0].data && data[0].data.chat;
    if (!chat) return { error: `No WhatsApp message ${target} in recall. Search for it again with search_cache (source "whatsapp").` };
    target = chat;
  }
  const { data: rows } = await db.from("data_cache").select("data").eq("user_id", userId).eq("source", "whatsapp")
    .order("received_at", { ascending: false }).limit(RECENT_ROWS);
  const picked = pickChat(target, chatsFrom(rows));
  if (picked.error) return picked;
  if (require("./platforms/whatsapp-linked").isOwnChat(picked.chat.jid)) return { error: "That is the person's own chat with Closedhand. Answer there as usual, not with whatsapp_send." };
  return { jid: picked.chat.jid, label: labelFor(picked.chat) };
}

// After the yes (or with the box unticked): the message goes as the person's
// own, with nothing to say Closedhand wrote it, as an email would.
async function send(userId, input) {
  const body = String(input.body || "").trim();
  if (!body) return { error: "Nothing to send: body is empty." };
  const chat = await resolve(userId, input.to);
  if (chat.error) return chat;
  await require("./platforms/whatsapp-linked").sendAsPerson(chat.jid, body);
  return { success: true, sent_to: chat.label };
}

module.exports = { chatsFrom, pickChat, labelFor, resolve, send };
