// Replying to an earlier message picks its topic back up, in the one Chat:
// every chat app (and the web chat) puts the message replied to in front of
// the new one ("[replying to …: "…"]", lib/project-rules.js splitReply). When
// that message is still in the conversation the LLM reads, the quote is
// enough. When it has left it (condensed into a Context Note), the exchange
// around it comes back word for word from the archive every trimmed turn is
// kept in (lib/conversation.js _archiveTurns): the lead-up, the message and
// what followed, so the reply is read against what was actually said rather
// than a summary of it.
const BEFORE = 6, AFTER = 3, EACH_CHARS = 1200, MAX_CHARS = 6000;

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
const textOf = (c) => typeof c === "string" ? c
  : Array.isArray(c) ? c.map((b) => (b && b.type === "text" ? b.text : "")).join(" ") : "";
const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => "\\" + c)}%`;

// What a quote is found by: a chat app may cut a long quote short, so the
// start of it is what is sure. Null when too short to tell.
function quoteKey(quoted) {
  const key = norm(quoted).replace(/(\.\.\.|…)$/, "").slice(0, 80);
  return key.length < 12 ? null : key;
}
const holds = (m, key) => norm(textOf(m && m.content)).includes(key);

// The turns around a quoted message in the archive, oldest first, or null:
// `before` turns ahead of it, it, and `after` turns after it. /bug uses it
// too (lib/bug-reports.js).
async function archived(userId, quoted, { before = BEFORE, after = AFTER, supabase } = {}) {
  const key = quoteKey(quoted);
  if (!key) return null;
  const db = supabase || require("../user-store").supabase;
  const { data: hits } = await db.from("data_cache").select("external_id, data")
    .eq("user_id", userId).eq("source", "conversation").ilike("data->>text", like(key)).limit(5);
  const hit = (hits || []).map((h) => ({ ...h, at: Number(String(h.external_id).match(/-(\d+)$/)?.[1]) }))
    .filter((h) => Number.isFinite(h.at)).sort((a, b) => b.at - a.at)[0];
  if (!hit) return null;
  const chat = hit.data?.chat || "no-thread";
  const ids = [];
  for (let n = Math.max(0, hit.at - before); n <= hit.at + after; n++) ids.push(`conv-${chat}-${n}`);
  const { data: rows } = await db.from("data_cache").select("external_id, data")
    .eq("user_id", userId).eq("source", "conversation").in("external_id", ids);
  const turns = (rows || []).map((r) => ({ at: Number(String(r.external_id).match(/-(\d+)$/)?.[1]), role: r.data?.sender === "Closedhand" ? "assistant" : "user", text: String(r.data?.text || "") }))
    .filter((t) => Number.isFinite(t.at) && t.text).sort((a, b) => a.at - b.at)
    .map((t) => ({ ...t, quoted: t.at === hit.at }));
  return turns.length ? turns : null;
}

// The note for this turn, or null: nothing quoted, the quote still in view,
// or nothing in the archive matches it.
async function noteFor(userId, text, { conversation, supabase } = {}) {
  const { quoted } = require("./project-rules").splitReply(String(text || ""));
  const key = quoteKey(quoted);
  if (!key) return null;
  const live = conversation || require("./conversation").getConversation(userId);
  if ((live || []).some((m) => holds(m, key))) return null;
  const turns = await archived(userId, quoted, { supabase });
  if (!turns) return null;
  let body = "";
  for (const t of turns) {
    const line = `${t.role === "assistant" ? "You (Closedhand)" : "The user"}${t.quoted ? " (the message being replied to)" : ""}: ${t.text.length > EACH_CHARS ? t.text.slice(0, EACH_CHARS) + "…" : t.text}\n`;
    if (body.length + line.length > MAX_CHARS) break;
    body += line;
  }
  return `[The user is replying to an earlier message that has left the conversation you can see. Here is the exchange it was in, word for word from the chat's history, so you can pick that topic up where it was:]\n${body}[End of that earlier exchange.]`;
}

module.exports = { noteFor, archived, quoteKey, holds };
