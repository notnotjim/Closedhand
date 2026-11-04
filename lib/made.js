// lib/made.js: what Closedhand made in the person's accounts, as it is now.
//
// A task drafted an email; the person edited it in Gmail and sent it, and the
// reply had already come, but asked later the chat said the draft was "still
// sat in" their drafts: it knew what it had done, not what happened after.
// What Closedhand makes (a mail draft, a calendar event) is noted as it is
// made, by the one place every tool call passes (tools/handlers.js), and each
// turn reads every recent one as it is now in their synced data: sent,
// replied to, moved, gone. Another kind joins by naming its tool here and how
// to read it now.

const KINDS = {
  gmail_create_draft: "draft", gmail_draft_update: "draft",
  gcal_create_event: "event", gcal_update_event: "event",
};
const KEEP_DAYS = 7;
const SHOW = 6;
const SYNC_GRACE_MS = 3 * 60 * 1000;

// The record for a successful call, or null.
function madeBy(toolName, input = {}, result = {}) {
  const kind = KINDS[toolName];
  if (!kind || !result || result.error || result.success !== true) return null;
  if (kind === "draft") {
    const ref = result.draft_id || input.draft_id;
    if (!ref) return null;
    return { kind, source: "gmail", ref: String(ref), thread: result.thread_id || input.thread_id || null,
      title: input.subject || null, account: result.account && result.account !== "primary" ? result.account : null };
  }
  const ref = result.id || input.event_id;
  if (!ref) return null;
  return { kind, source: "gcal", ref: String(ref), title: result.summary || input.summary || null, detail: result.start || null };
}

async function note(userId, toolName, input, result) {
  const r = madeBy(toolName, input, result);
  if (!r || !userId) return;
  const row = { user_id: userId, made_at: new Date().toISOString() };
  // A later change keeps what the first call knew (a draft's thread).
  for (const [k, v] of Object.entries(r)) if (v != null) row[k] = v;
  const { supabase } = require("../user-store");
  const { error } = await supabase.from("made_items").upsert(row, { onConflict: "user_id,kind,ref" });
  if (error) console.warn(`[made] not noted: ${error.message}`);
}

const when = (iso, tz) => {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || "");
  try { return d.toLocaleString("en-GB", { timeZone: tz || undefined, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
  catch { return d.toISOString().slice(0, 16).replace("T", " "); }
};
const from = (f) => String(f || "").replace(/\s*<[^>]+>\s*$/, "").replace(/^"|"$/g, "").trim() || String(f || "");

// How long ago their data last came in from that source: what was not seen
// since then cannot be said to be gone.
async function syncedSince(db, userId, prefix, at) {
  const { data } = await db.from("data_cache").select("synced_at").eq("user_id", userId).like("source", prefix + "%")
    .order("synced_at", { ascending: false }).limit(1);
  const last = data?.[0]?.synced_at;
  return !!last && Date.parse(last) > Date.parse(at) + SYNC_GRACE_MS;
}

async function draftNow(db, userId, m, tz) {
  const rows = m.thread ? (await db.from("data_cache").select("received_at, data").eq("user_id", userId).eq("type", "email")
    .like("source", "gmail%").eq("data->>threadId", m.thread).order("received_at", { ascending: true }).limit(50)).data || [] : [];
  const since = Date.parse(m.made_at) - 60000;
  const after = rows.filter((r) => Date.parse(r.received_at) >= since);
  const labels = (r) => (Array.isArray(r.data?.labels) ? r.data.labels : []);
  const sent = after.filter((r) => labels(r).includes("SENT") && !r.data?.is_draft).pop();
  const still = after.filter((r) => r.data?.is_draft).pop();
  const replies = after.filter((r) => !labels(r).includes("SENT") && !r.data?.is_draft && (!sent || Date.parse(r.received_at) > Date.parse(sent.received_at)));
  const parts = [];
  if (sent) parts.push(`sent from their account ${when(sent.received_at, tz)}${still ? "" : ", so it is no longer a draft"}`);
  else if (still) parts.push(`still an unsent draft (last saved ${when(still.received_at, tz)})`);
  else if (await syncedSince(db, userId, "gmail", m.made_at)) parts.push("not in their synced mail any more: sent from elsewhere or deleted");
  else parts.push("not synced yet");
  if (replies.length) parts.push(`${replies.length === 1 ? "a reply" : `${replies.length} replies`} since, last from ${from(replies[replies.length - 1].data?.from)} ${when(replies[replies.length - 1].received_at, tz)}`);
  return parts.join("; ");
}

async function eventNow(db, userId, m, tz) {
  const { data } = await db.from("data_cache").select("data").eq("user_id", userId).eq("type", "event").like("source", "gcal%").eq("external_id", m.ref).limit(1);
  const e = data?.[0]?.data;
  if (!e) return (await syncedSince(db, userId, "gcal", m.made_at)) ? "no longer in their calendar" : "not synced yet";
  if (String(e.status || "") === "cancelled") return "cancelled";
  const start = typeof e.start === "object" ? e.start?.dateTime || e.start?.date : e.start;
  if (m.detail && start && Date.parse(start) !== Date.parse(m.detail)) return `moved: now ${when(start, tz)} (was ${when(m.detail, tz)})`;
  return `as made${start ? `, ${when(start, tz)}` : ""}`;
}

// What the chat is shown each turn: the last week's, newest first.
async function nowLine(userId, { tz, db = null } = {}) {
  if (!userId) return "";
  try {
    db = db || require("../user-store").supabase;
    const { data } = await db.from("made_items").select("kind, source, ref, thread, title, account, detail, made_at").eq("user_id", userId)
      .gte("made_at", new Date(Date.now() - KEEP_DAYS * 86400000).toISOString()).order("made_at", { ascending: false }).limit(SHOW);
    if (!data || !data.length) return "";
    const lines = [];
    for (const m of data) {
      const now = m.kind === "draft" ? await draftNow(db, userId, m, tz) : await eventNow(db, userId, m, tz);
      const what = m.kind === "draft" ? `Mail draft "${m.title || "untitled"}"${m.account ? ` (${m.account})` : ""}` : `Calendar event "${m.title || "untitled"}"`;
      lines.push(`- ${what}, made ${when(m.made_at, tz)}: ${now}.`);
    }
    return "WHAT YOU MADE IN THEIR ACCOUNTS LATELY, AS IT IS NOW (from their synced mail and calendar; this is what is true now, whatever the conversation said about it):\n" + lines.join("\n");
  } catch (e) {
    console.warn(`[made] could not read: ${e.message}`);
    return "";
  }
}

module.exports = { note, nowLine, madeBy, KINDS };
