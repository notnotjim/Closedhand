// lib/services/wa-digest.js — one entry per WhatsApp chat per day.
//
// The raw messages land in data_cache as they arrive and are keyword-searchable
// immediately; that side needs nothing from this file. This is the meaning
// layer, and it deliberately does NOT work per message: a ten-word chat message
// has no standalone meaning, and embedding each one would pay per-message model
// costs to index noise. The unit of a chat is a stretch of conversation, so
// once a day each chat that had activity gets ONE entry, its transcript, and
// ONE embedding covering everything said in it. No language model writes it.
//
// Rules:
//   - forward-only: buckets exist from linking day on; historic chats stay
//     keyword-only, with no backfill and no opt-in button
//   - a day is digested only once it is COMPLETE in the user's timezone
//   - runs are idempotent and resumable: a bucket is skipped if its vector
//     already exists, so downtime is caught up on the next pass
//
// Self-host only in practice: the cloud edition never loads the linked-device
// adapter, so it never has whatsapp rows and every pass here no-ops.

const LOOKBACK_DAYS = 5;        // how far back a pass looks for undigested days
const MAX_BUCKETS_PER_RUN = 100;
const MIN_BUCKET_CHARS = 120;   // below this a day is chit-chat; keyword covers it
const MIN_BUCKET_MSGS = 3;
const RUN_EVERY_MS = 60 * 60 * 1000;

let _running = false;
let _timer = null;

function dayInTz(iso, tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(iso));
  } catch (_) {
    return String(iso).substring(0, 10);
  }
}

async function runWhatsAppDigest() {
  if (_running) return;
  _running = true;
  try {
    const { supabase } = require("../../user-store");

    // Who has WhatsApp rows at all. Self-host is one user; on anything bigger
    // this stays a bounded read of recent rows, not a table scan.
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const { data: rows, error } = await supabase
      .from("data_cache")
      .select("user_id, data")
      .eq("source", "whatsapp")
      .eq("type", "message")
      .gte("synced_at", cutoff)
      .limit(20000);
    if (error || !rows || rows.length === 0) return;

    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push(r.data || {});
    }

    for (const [userId, msgs] of byUser) {
      await _digestForUser(supabase, userId, msgs);
    }
  } catch (e) {
    console.error(`[wa-digest] pass failed: ${e.message}`);
  } finally {
    _running = false;
  }
}

// A chat stored under a number is named from what its rows know (migration
// 053), and the days written while it had no name are renamed and
// re-embedded, so recall finds "Dental Clinic" where it used to see digits.
// No model call: the text keeps its words, with the number replaced.
const RENAMES_PER_RUN = 40;
const NUMBERED = /^[\d+() -]*$/;

async function nameChats(supabase, userId) {
  const { data, error } = await supabase.rpc("name_whatsapp_chats", { match_user_id: userId });
  if (error) { console.error(`[wa-digest] naming chats failed: ${error.message}`); return new Map(); }
  return new Map((data || []).map((r) => [r.chat, r.name]));
}

async function renameDaySummaries(supabase, userId, names, embedDocument) {
  if (!names.size) return 0;
  const { data: rows, error } = await supabase.from("data_vectors")
    .select("id, content, source_metadata")
    .eq("user_id", userId).eq("service", "whatsapp").eq("item_type", "chat_day");
  if (error) { console.error(`[wa-digest] reading summaries failed: ${error.message}`); return 0; }
  let renamed = 0;
  for (const row of rows || []) {
    if (renamed >= RENAMES_PER_RUN) break;
    const meta = row.source_metadata || {};
    const name = names.get(meta.chat);
    if (!name || (meta.chat_name && !NUMBERED.test(meta.chat_name))) continue;
    const number = meta.chat_name || String(meta.chat).split("@")[0];
    const content = number ? String(row.content || "").split(number).join(name) : row.content;
    const embedding = await embedDocument(content).catch(() => null);
    if (!embedding) continue;
    const { error: writeErr } = await supabase.from("data_vectors").update({
      content, embedding: JSON.stringify(embedding),
      source_metadata: { ...meta, chat_name: name }, updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (writeErr) { console.error(`[wa-digest] renaming a summary failed: ${writeErr.message}`); continue; }
    renamed++;
  }
  if (renamed) console.log(`[wa-digest] named ${renamed} chat-day summar${renamed === 1 ? "y" : "ies"} for ${userId}`);
  return renamed;
}

async function _digestForUser(supabase, userId, msgs) {
  const names = await nameChats(supabase, userId);
  await renameDaySummaries(supabase, userId, names, require("./usi").embedDocument);
  const { data: profile } = await supabase
    .from("profiles").select("timezone").eq("id", userId).single();
  const tz = profile?.timezone || "Europe/London";
  const today = dayInTz(new Date().toISOString(), tz);

  // Bucket by (chat, local day). Today's bucket is still being written to, so
  // it waits for tomorrow's pass.
  const buckets = new Map();
  for (const m of msgs) {
    if (!m.chat || !m.date || !m.text) continue;
    const day = dayInTz(m.date, tz);
    if (day >= today) continue;
    const key = `${m.chat}|${day}`;
    if (!buckets.has(key)) buckets.set(key, { chat: m.chat, chat_name: names.get(m.chat) || m.chat_name, day, items: [] });
    buckets.get(key).items.push(m);
  }
  if (buckets.size === 0) return;

  // Skip buckets already digested. The external id is the idempotence key.
  const wanted = [...buckets.values()].map(b => `wa-day-${b.chat}-${b.day}`);
  const { data: existing } = await supabase
    .from("data_vectors").select("external_id")
    .eq("user_id", userId).eq("service", "whatsapp")
    .in("external_id", wanted);
  const done = new Set((existing || []).map(e => e.external_id));

  // A day's files (photos, documents, voice notes) are read before the day
  // is indexed (lib/item-files.js); a day with a file not read yet is done
  // again on a later pass, while it is in the lookback.
  const files = require("../item-files");
  const rowOf = (m) => ({ source: "whatsapp", external_id: m.id || m.external_id, data: m });
  const days = [];
  for (const b of buckets.values()) {
    if (days.length >= MAX_BUCKETS_PER_RUN) break;
    const extId = `wa-day-${b.chat}-${b.day}`;
    if (done.has(extId) && !b.items.some((m) => files.unread(rowOf(m)).length)) continue;

    b.items.sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const totalChars = b.items.reduce((n, m) => n + (m.text || "").length, 0);

    // A day of "ok" and "on my way" is not a memory. The raw rows stay
    // keyword-searchable; there is just nothing here worth a fingerprint.
    if (b.items.length < MIN_BUCKET_MSGS && totalChars < MIN_BUCKET_CHARS) continue;

    // The self-chat is the user talking TO Closedhand; those exchanges are
    // already conversation memory through the engine, and digesting them
    // again here would put the same dialogue into recall twice. A bucket
    // where every line is the user's own is that chat (or notes-to-self,
    // which keep keyword search and lose little).
    if (b.items.every(m => m.sender === "me")) continue;

    // The whole day, indexed in pieces like any other item (lib/services/
    // usi.js): no part of a long day is out of reach. A day not embedded is
    // not written, so the next pass simply retries it.
    const transcript = b.items.map(m => `${m.sender}: ${m.text}`).join("\n");
    const read = await files.readFor(userId, b.items.filter((m) => m.file).map(rowOf));
    for (const r of read) Object.assign(b.items.find((m) => (m.id || m.external_id) === r.external_id) || {}, { file_texts: r.data.file_texts });
    days.push({
      external_id: extId,
      text: `[WhatsApp ${b.chat_name || b.chat}, ${b.day}] ${transcript}`,
      files: b.items.flatMap((m) => files.textsOf(m)),
      metadata: { chat: b.chat, chat_name: b.chat_name || null, date: b.day, message_count: b.items.length },
    });
  }
  if (!days.length) return;
  const { indexed } = await require("./usi").indexItems(userId, "whatsapp", "chat_day", days, { scoped: true, quiet: true });
  if (indexed > 0) console.log(`[wa-digest] wrote ${indexed} chat day(s) for ${userId}`);
}

// Hourly, not at literal midnight: a pass only digests days that are complete
// in the user's timezone, so running often just means downtime is caught up
// quickly and every timezone gets its midnight within the hour.
function startWhatsAppDigest() {
  if (_timer) return;
  _timer = setInterval(() => runWhatsAppDigest().catch(() => {}), RUN_EVERY_MS);
  setTimeout(() => runWhatsAppDigest().catch(() => {}), 2 * 60 * 1000);
}

module.exports = { runWhatsAppDigest, startWhatsAppDigest, _test: { nameChats, renameDaySummaries } };
