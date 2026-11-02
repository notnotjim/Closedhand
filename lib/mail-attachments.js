// lib/mail-attachments.js — what an email's attachments say, for the scanners.
//
// An itinerary forwarded by a family member is often all in a PDF while the
// mail says "attached". The flight and booking scanners read an email's
// attachments when its body is thin. Reading them is the one step every
// source's files go through (lib/item-files.js): each file is read once,
// whole, and kept on the cached email row, so the index, the word search and
// the scanners all read the same text and nothing is fetched twice.

const { supabase } = require("./db");

const THIN_BODY = 400;
// What a scanner reads of attachments, for its LLM's prompt; the index keeps
// them whole.
const MAX_TEXT = 6000;

// What a scanner reads of an email's attachments: its first two.
async function attachmentTextFor(userId, email) {
  if (!email || !email.id || !(email.attachments || []).length) return "";
  const { data: row, error } = await supabase.from("data_cache").select("source, external_id, data").eq("user_id", userId).eq("external_id", email.id).limit(1).maybeSingle();
  if (error || !row) return "";
  const files = require("./item-files");
  await files.readFor(userId, [row]);
  return files.textsOf(row.data).slice(0, 2).map((t) => `[Attachment ${t.name}] ${t.text}`).join("\n\n").slice(0, MAX_TEXT);
}

// Characters that print nothing are taken out (readable-text.js).
const { readable } = require("./readable-text");

// Search results carry a window of about 800 characters around the words
// searched for, not the email. A reader that takes facts out of an email (a
// stay's dates, a flight's new times) reads the whole cached email instead:
// the window around "booking" near the top of a confirmation stopped before
// its dates, and the reader made up a stay's dates and room. One-time codes
// stay hidden, as they are in search results.
async function withWholeBodies(userId, emails) {
  const ids = [...new Set((emails || []).map((e) => e && e.id).filter(Boolean))];
  if (!ids.length) return emails;
  const { data, error } = await supabase.from("data_cache").select("external_id, data").eq("user_id", userId).eq("type", "email").in("external_id", ids);
  if (error) { console.error("[mail] whole emails unavailable:", error.message); return emails; }
  const byId = new Map((data || []).map((row) => [row.external_id, row.data || {}]));
  const { redactEmail } = require("./otp-guard");
  return emails.map((e) => {
    const full = e && byId.get(e.id);
    if (!full || !full.body) return e;
    const whole = redactEmail({ ...e, body: full.body }, userId);
    return { ...e, body: whole.body, attachments: e.attachments && e.attachments.length ? e.attachments : full.attachments || e.attachments, date: e.date || full.date };
  });
}

// The body a scanner should read: the mail's own text, plus its attachments
// when the mail itself says little.
async function bodyForScan(userId, email, cap = 2200) {
  const body = readable(email.summary || email.body || "");
  if (body.trim().length >= THIN_BODY) return body.slice(0, cap);
  const extra = await attachmentTextFor(userId, email);
  return (body + (extra ? "\n\n" + extra : "")).slice(0, Math.max(cap, 5000));
}

module.exports = { attachmentTextFor, bodyForScan, readable, withWholeBodies, THIN_BODY };
