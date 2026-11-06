// lib/recipient-guard.js — mail goes only to addresses that came from somewhere.
//
// A background task drafting a viewing request made up an estate agent's
// name, built an address from it, and said it had read it off the listing:
// nothing checked where a recipient came from. An address Closedhand writes
// to (a message sent, a draft, an invitation) must appear in something it
// has read: this conversation and the work so far (what the person wrote,
// pages and mail a tool brought back), or the person's own data (mail,
// chats, Pinned Facts, files). One that appears nowhere is not used, and the
// model is told so, to use an address it found or to ask. It guards the
// action only: any address the person or their data gives goes through.

const ADDRESS = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const TOOLS = new Set(["send_mail", "reply_to_mail", "create_mail_draft", "update_mail_draft",
  "gmail_send", "gmail_create_draft", "gmail_draft_update", "outlook_send", "outlook_create_draft", "outlook_draft_update",
  "gcal_create_event", "outlook_cal_create_event"]);
const FIELDS = ["to", "cc", "bcc", "attendees"];

// The addresses a tool call writes to, lower-cased.
function recipients(toolName, input) {
  if (!TOOLS.has(toolName) || !input) return [];
  const text = FIELDS.map((f) => input[f]).filter((v) => v != null).map((v) => (Array.isArray(v) ? v.join(",") : String(v))).join(",");
  return [...new Set((text.match(ADDRESS) || []).map((a) => a.toLowerCase()))];
}

// What a run has seen so far, as one lower-cased text: every message, the
// tool results included.
function seenText(messages) {
  return (messages || []).map((m) => (m && typeof m.content === "string" ? m.content : JSON.stringify(m && m.content))).join("\n").toLowerCase();
}

// Whether the address is in the person's own data. A lookup that fails says
// yes, so a database hiccup never stops their mail.
async function inPersonsData(userId, address) {
  try {
    const { supabase } = require("./db");
    const like = `%${address.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    const looks = ["data->>from", "data->>to", "data->>cc", "data->>body", "data->>text", "data->>snippet"]
      .map((field) => supabase.from("data_cache").select("id").eq("user_id", userId).ilike(field, like).limit(1))
      .concat([supabase.from("facts").select("id").eq("user_id", userId).ilike("value", like).limit(1),
        supabase.from("rag_chunks").select("id").eq("user_id", userId).ilike("content", like).limit(1)]);
    const found = await Promise.all(looks);
    if (found.some((r) => r && r.error)) return true;
    return found.some((r) => r && Array.isArray(r.data) && r.data.length > 0);
  } catch (_) { return true; }
}

// The error for a call writing to addresses seen nowhere, or null when every
// address came from somewhere. `lookup` stands in for inPersonsData in tests.
async function check(userId, toolName, input, messages, lookup = inPersonsData) {
  const wanted = recipients(toolName, input);
  if (!wanted.length) return null;
  const seen = seenText(messages);
  const unseen = [];
  for (const a of wanted) if (!seen.includes(a) && !(await lookup(userId, a))) unseen.push(a);
  if (!unseen.length) return null;
  return `Not done. ${unseen.join(", ")} ${unseen.length === 1 ? "appears" : "appear"} nowhere in what you have read or in the person's mail, chats or files, so ${unseen.length === 1 ? "it" : "they"} may be made up. Write only to an address you found, and say where you found it; if there is none, ask the person for it.`;
}

module.exports = { check, recipients, seenText, inPersonsData, TOOLS };
