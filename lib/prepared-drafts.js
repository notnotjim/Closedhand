// lib/prepared-drafts.js: reply drafts Closedhand puts in the person's
// mailbox on its own, when Pulse sees a reply they owe by email and knows
// everything the reply needs. Never sent: the person sends it, edits it or
// lets it go. Each goes from the address the mail was sent to, aliases
// included, in the same thread, and is removed after 24 hours if untouched
// unless they said to keep it. One they edited is theirs and stays. "Keep
// it" or "remove it" in chat reaches here through the prepared_draft tool.

const ctx = require("./context");
const { supabase } = require("./db");

const DAY = 86400000;
const toolFor = (source) => (/^gmail/.test(source) ? "gmail_reply" : /^outlook/.test(source) ? "outlook_reply" : /^imap/.test(source) ? "reply_to_mail" : null);
const WHERE = { gmail_reply: "your Gmail drafts", outlook_reply: "your Outlook drafts", reply_to_mail: "your mailbox's Drafts folder" };
const addresses = (text) => (String(text || "").match(/[^\s<>",;]+@[^\s<>",;]+/g) || []).map((a) => a.toLowerCase());

// The line that goes under the message when a draft was made.
function draftLine({ place, from }) {
  return `I've put a reply in ${place}, from ${from}. I'll remove it in 24 hours unless you edit it or tell me to keep it.`;
}

// Makes the draft for a cached email, inside the person's context. row: the
// email being answered, as cached. Returns { place, from } or null.
async function prepare(userId, row, body) {
  const tool = toolFor(row?.source);
  const d = row?.data || {};
  if (!tool || !String(body || "").trim()) return null;
  const h = require("./tools/handlers");
  // One draft per thread: a second would leave them choosing between two.
  if (await h.draftOnThread(d.threadId)) { console.log("[prepared-drafts] a draft is already on that thread"); return null; }
  const own = (await h.ownAddresses(tool, d.account).catch(() => [])).map((a) => String(a).toLowerCase());
  const from = addresses(d.to).find((a) => own.includes(a)) || null;
  const made = await h.predraft(tool, {
    account: d.account,
    message_id: tool === "reply_to_mail" ? row.external_id : d.id,
    thread_id: d.threadId,
    body: String(body).trim(),
    ...(from ? { from, from_alias: from } : {}),
  });
  if (!made || made.error || !made.draftId) { console.log(`[prepared-drafts] no draft: ${made?.error || "nothing made"}`); return null; }
  const { error } = await supabase.from("prepared_drafts").insert({
    user_id: userId, tool, account: d.account || null, draft_id: String(made.draftId),
    version: String(made.messageId || made.changeKey || made.draftId), thread_id: d.threadId || null,
  });
  // Untracked, it could never be removed as promised: taken away again.
  if (error) { console.error("[prepared-drafts] could not record a draft:", error.message); await h.dropPredraft(tool, d.account, made.draftId); return null; }
  return { place: WHERE[tool], from: from || d.account || "your address" };
}

// Drafts past 24 hours, not kept: removed when untouched, forgotten when the
// person edited, sent or deleted them. Inside the person's context.
async function sweep(userId, now = Date.now()) {
  const { data: rows, error } = await supabase.from("prepared_drafts").select("id, tool, account, draft_id, version")
    .eq("user_id", userId).eq("kept", false).lt("created_at", new Date(now - DAY).toISOString());
  if (error) { console.error("[prepared-drafts] could not read drafts:", error.message); return 0; }
  const h = require("./tools/handlers");
  let removed = 0;
  for (const r of rows || []) {
    let version;
    try { version = await h.draftVersion(r.tool, r.account, r.draft_id); } catch (e) { console.error("[prepared-drafts] could not read a draft, trying later:", e.message); continue; }
    if (version && version === r.version) { await h.dropPredraft(r.tool, r.account, r.draft_id); removed++; }
    const { error: delError } = await supabase.from("prepared_drafts").delete().eq("id", r.id);
    if (delError) console.error("[prepared-drafts] could not clear a draft record:", delError.message);
  }
  return removed;
}

// The prepared_draft tool: keep one, or remove it now. Without draft_id, the
// most recent.
async function act({ action, draft_id }) {
  const { data: rows, error } = await supabase.from("prepared_drafts").select("id, tool, account, draft_id, kept")
    .eq("user_id", ctx.activeUserId).order("created_at", { ascending: false }).limit(20);
  if (error) return { error: "Could not read the drafts just now: " + error.message };
  const r = draft_id ? (rows || []).find((x) => x.draft_id === String(draft_id)) : (rows || [])[0];
  if (!r) return { error: "There is no reply draft Closedhand prepared on its own to keep or remove." };
  if (action === "keep") {
    const { error: e } = await supabase.from("prepared_drafts").update({ kept: true }).eq("id", r.id);
    return e ? { error: e.message } : { kept: true, note: "It stays in their drafts until they send or delete it." };
  }
  if (action === "remove") {
    await require("./tools/handlers").dropPredraft(r.tool, r.account, r.draft_id);
    const { error: e } = await supabase.from("prepared_drafts").delete().eq("id", r.id);
    if (e) console.error("[prepared-drafts] could not clear a draft record:", e.message);
    return { removed: true };
  }
  return { error: 'action is "keep" or "remove".' };
}

// Every half hour, any draft whose 24 hours are up.
function start() {
  const run = async () => {
    try {
      const userId = require("./admin").getAdminUserId();
      const { acquireUserMutex } = require("./user-mutex");
      const { UserStore } = require("../user-store");
      const { swapToCloudStore, cleanupUserContext } = require("./storage");
      await acquireUserMutex(userId, () => ctx.runWithInheritedContext(async () => {
        swapToCloudStore(await UserStore.load(userId), userId, userId);
        try { await sweep(userId); } finally { cleanupUserContext(); }
      }));
    } catch (e) { console.error("[prepared-drafts] sweep:", e.message); }
  };
  setTimeout(run, 5 * 60 * 1000).unref?.();
  setInterval(run, 30 * 60 * 1000).unref?.();
}

module.exports = { prepare, sweep, act, start, draftLine, toolFor };
