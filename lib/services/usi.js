// lib/services/usi.js -- Universal Semantic Index
// Indexes all connected service data into pgvector for cross-service semantic search.
// Plain code files each item and the local embedding model (lib/local-models.js)
// turns its own words into a vector; no language model writes into the index or
// decides what it finds.

const { supabase } = require("../../user-store");
const { MEDIA_MATCH } = require("./doc-search");

const ENRICH_DAILY_CAP = parseInt(process.env.ENRICH_DAILY_CAP || "50000", 10); // global, all users
const ENRICH_USER_DAILY_CAP = parseInt(process.env.ENRICH_USER_DAILY_CAP || "5000", 10); // per user
// The embedder holds the whole batch in memory as tensors, and a self-host
// box is usually a few GB. Small batches also mean the pass writes rows every
// few seconds, so if the process dies mid-mailbox the work already done stays
// done instead of restarting from nothing.
const BATCH_SIZE = 8;
// A CPU embedder's cost scales with tokens, and full-length bodies turned a
// pass into hours. Subject, sender and opening lines carry nearly all of the
// retrieval signal, so it reads far less and finishes.
const MAX_TEXT_LEN = 1200;
function maxTextLen() { return MAX_TEXT_LEN; }
const EMBED_DIMS = 1536; // Matryoshka truncation from native 4096 (fits pgvector index limit)

// ============================================================================
// LOCAL EMBEDDING
// ============================================================================

/**
 * Embed one or more texts with the local embedding model. Returns array of vectors.
 * opts.quick: a query someone is waiting on (search, passive recall), framed as
 * a query and put ahead of background indexing.
 * opts.urgent: documents someone is waiting on go ahead of background indexing
 * too, framed as documents all the same.
 */
async function embedBatch(texts, opts = {}) {
  if (texts.length === 0) return [];
  require("../idle").touch();
  // Failures surface in LOCAL_MODELS_STATUS (setup and the dashboard) and the
  // next call retries the load.
  try {
    const { localEmbed } = require("../local-models");
    return await localEmbed(texts.map(t => t.substring(0, MAX_TEXT_LEN)), { query: !!opts.quick, urgent: !!(opts.quick || opts.urgent), dims: EMBED_DIMS });
  } catch (e) {
    console.log(`[USI] Local embed failed: ${e.message}`);
    return [];
  }
}
/** Embed a single text. Returns vector array or null. */
async function embedText(text, opts = {}) {
  if (!text) return null;
  const results = await embedBatch([text], opts);
  return results[0] || null;
}

/** Embed a document (alias for embedText) */
async function embedDocument(text) {
  return embedText(text);
}

// ============================================================================
// PHASE 1 — Local Embedding
// ============================================================================

/**
 * Embed a batch of items from any service into data_vectors.
 * Only embeds items that are new or changed (checks existing vectors).
 */
// Every connection's items come through here. An item names the cached rows
// it is made of (`rows`: the rows themselves, or { source, external_id }), and
// their files are read here by the one file step (lib/item-files.js) and kept
// with the item: an email's attachments, a chat's photos, a page's files, a
// connected app's. A connection only lists its items' files on their rows and
// gives data-access a way to fetch them (AGENTS.md).
async function indexItems(userId, service, itemType, items, opts = {}) {
  if (!items?.length) return { indexed: 0 };
  await withRowFiles(userId, items);
  return modelJobs.withSettings(userId, () => indexItemsWithModels(userId, service, itemType, items, opts));
}

// Reads the files of the rows each item names and adds what they said to the
// item's files. Rows given whole are used as given; the rest are read from
// the cache.
async function withRowFiles(userId, items) {
  const named = items.filter((i) => Array.isArray(i.rows) && i.rows.length);
  if (!named.length) return;
  const files = require("../item-files");
  const key = (r) => `${r.source}\n${r.external_id}`;
  const rows = new Map();
  for (const i of named) for (const r of i.rows) if (!rows.has(key(r)) || r.data) rows.set(key(r), r);
  const missing = [...rows.values()].filter((r) => !r.data);
  for (const source of new Set(missing.map((r) => r.source))) {
    const ids = missing.filter((r) => r.source === source).map((r) => String(r.external_id));
    for (let at = 0; at < ids.length; at += 200) {
      const { data } = await supabase.from("data_cache").select("source, external_id, data")
        .eq("user_id", userId).eq("source", source).in("external_id", ids.slice(at, at + 200));
      for (const row of data || []) rows.set(key(row), row);
    }
  }
  await files.readFor(userId, [...rows.values()].filter((r) => r.data));
  for (const i of named) {
    const texts = i.rows.flatMap((r) => files.textsOf(rows.get(key(r))?.data));
    if (texts.length) i.files = [...(i.files || []), ...texts];
    delete i.rows;
  }
}

// What is indexed already for these ids (or all of a service's, ids null):
// each one's content hash and source, and the MD5-era entries, whose SHA-256
// is written back. Null when it can't be read: fail closed, since without the
// full set everything looks new and is summarised and embedded again.
async function readIndexed(userId, service, ids) {
  const out = { hashes: {}, sources: {}, meta: {} };
  const keep = (rows) => {
    for (const e of rows || []) {
      out.hashes[e.external_id] = e.source_metadata?._content_hash || null;
      out.sources[e.external_id] = e.source_metadata?.source || null;
      if (e.source_metadata?._content_hash?.length === 32) out.meta[e.external_id] = e.source_metadata;
    }
  };
  if (ids) {
    // Exactly these ids, in chunks. The full read below once ran per page of
    // the daily sweep, 27 times per five-minute pass (the egress leak).
    for (let from = 0; from < ids.length; from += 200) {
      const { data, error } = await supabase.from("data_vectors").select("external_id, source_metadata")
        .eq("user_id", userId).eq("service", service).in("external_id", ids.slice(from, from + 200));
      if (error) { console.log(`[USI] Scoped hash fetch failed (${error.message}), skipping indexing pass`); return null; }
      keep(data);
    }
    return out;
  }
  // MUST paginate: selects stop at 1000 rows, and a truncated set made
  // everything past row 1000 look new on every sync (cost incident
  // 2026-07-19). Pages go in id order, each after the last id read: pages
  // read by offset in no order came back in whatever order Postgres scanned,
  // which changes as rows are written, and while a pass rewrote entries a
  // third of 23,000 were never seen and were embedded again on every pass.
  const PAGE = 1000;
  let after = null;
  for (;;) {
    let q = supabase.from("data_vectors").select("id, external_id, source_metadata").eq("user_id", userId).eq("service", service);
    if (after) q = q.gt("id", after);
    const { data, error } = await q.order("id", { ascending: true }).limit(PAGE);
    if (error) { console.log(`[USI] Hash fetch failed (${error.message}), skipping indexing pass`); return null; }
    keep(data);
    if (!data || data.length < PAGE) return out;
    after = data[data.length - 1].id;
  }
}

async function indexItemsWithModels(userId, service, itemType, items, opts = {}) {
  if (!items || items.length === 0) return { indexed: 0 };

  // Check which items already exist and their content hashes.
  const existing = await readIndexed(userId, service, opts.scoped ? items.map(i => i.external_id).filter(Boolean) : null);
  if (!existing) return { indexed: 0 };
  const { hashes: existingHashes, sources: existingSources, meta: existingMeta } = existing;

  // Generate content hash for each item, only embed if new or content changed
  const crypto = require("crypto");
  for (const item of items) {
    // A file's vectors count only where it has some, so an item without them
    // keeps the hash it had before they were kept.
    const files = (item.files || []).map((x) => (x.media && x.media.length ? [x.name, x.text.length, x.media.length] : [x.name, x.text.length]));
    item._content_hash = crypto.createHash("sha256").update(item.text + (files.length ? JSON.stringify(files) : "")).digest("hex");
  }

  // Hashes stored before SHA-256 are MD5's 32 hex characters, and MD5 is no
  // longer computed anywhere. Such an item is taken as unchanged and given its
  // SHA-256 below: treating it as changed would embed every
  // indexed item again. A change made since its last sync shows at its next.
  const adopted = [];
  const newItems = items.filter(i => {
    const existingHash = existingHashes[i.external_id];
    if (!existingHash) return true; // new item
    if (existingHash === i._content_hash) return false;
    // One invite lands in every calendar of yours that was invited, and each
    // account's copy of it reads a little differently (its own time zone,
    // its own reply status). The vector is keyed by event id, so two copies
    // took turns re-embedding the same event on every
    // sync. An event already indexed from another account is left to it.
    const src = i.metadata && i.metadata.source;
    const owner = existingSources[i.external_id];
    if (src && owner && owner !== src) return false;
    if (existingHash.length === 32) { adopted.push(i); return false; }
    return true; // content changed
  });
  for (const i of adopted) {
    const { error } = await supabase.from("data_vectors")
      .update({ source_metadata: { ...(existingMeta[i.external_id] || {}), _content_hash: i._content_hash } })
      .eq("user_id", userId).eq("service", service).eq("external_id", i.external_id);
    if (error) { console.log(`[USI] Could not store a SHA-256 hash (${error.message})`); break; }
  }
  if (newItems.length === 0) {
    console.log(`[USI] Phase 1: 0 new ${service}/${itemType} items (${items.length} already indexed)`);
    return { indexed: 0 };
  }

  // A source that has finished a pass before is catching up, not being read
  // for the first time; installs from before last_sync was kept get it from
  // their last finished pass.
  try {
    const { data: prev } = await supabase.from("index_progress").select("status, last_sync, updated_at").eq("user_id", userId).eq("service", service).maybeSingle();
    if (prev && !prev.last_sync && ["indexed", "enriching", "enriched"].includes(prev.status)) await upsertProgress(userId, service, { last_sync: prev.updated_at });
  } catch (_) { /* the dashboard only shows a fuller card */ }
  // Older mail read back in the background (mail-history.js) says how far
  // back it has got on its own, so it never shows as new mail.
  const progress = opts.quiet ? async () => {} : upsertProgress;
  await progress(userId, service, { phase1_total: newItems.length, status: "indexing" });
  let indexed = 0;

  // Each item is embedded from its own words (the subject and the email
  // itself, an event's details, a chat's transcript) in pieces the embedder
  // reads in full, each headed by what the item is, and the piece that
  // matched is what the model is shown. Two rounds: every item's first piece,
  // so all of it can be found by meaning as soon as it can, then the rest of
  // each item, the whole text of its files included (lib/item-files.js reads
  // them, for every source, before the item comes here). Bulk mail (newsletters,
  // promotions, notifications) keeps its first piece only; every word of it
  // is still found by the word search over the stored mail. A background LLM
  // once summarised most items first: it sent every synced item to the LLM's
  // provider, read at most 4,000 characters and kept a few sentences of them.
  let consecutiveEmbedFailures = 0;
  const later = [];
  const BATCH = BATCH_SIZE;
  for (let i = 0; i < newItems.length; i += BATCH) {
    if (consecutiveEmbedFailures >= 2) {
      console.log(`[USI] Embedder failing repeatedly (overloaded?), stopping ${service} pass. Will retry next cycle.`);
      break;
    }
    const batch = newItems.slice(i, i + BATCH);

    try {
      const firsts = batch.map((item) => {
        const body = piecesOf(item.gist || item.text);
        return { item, body, embed: (item.head ? item.head + "\n" : "") + body[0] };
      });
      const vectors = pad(await embedBatch(firsts.map((x) => x.embed)), firsts.length);

      if (!vectors.some(Boolean)) {
        console.log(`[USI] Batch embed returned 0 vectors for ${batch.length} items`);
        consecutiveEmbedFailures++;
        continue;
      }
      consecutiveEmbedFailures = 0;

      for (let j = 0; j < firsts.length; j++) {
        if (!vectors[j]) continue;
        const x = firsts[j];
        const more = (!x.item.bulk && x.body.length > 1) || (x.item.files || []).length > 0;
        const id = await writeFirst(userId, service, itemType, x.item, x.body[0], vectors[j], !more, !!existingHashes[x.item.external_id]);
        if (!id) continue;
        if (more) later.push({ ...x, id }); else indexed++;
      }
      await progress(userId, service, { phase1_done: i + batch.length });
    } catch (e) {
      console.error(`[USI] Batch embed error: ${e.message}`);
    }
  }

  // The rest of each item, newest first: its other pieces and its files'
  // whole text, each piece headed by the file's name and what the item is,
  // and its files' pictures, video frames and stretches of sound by what they
  // are, with the vectors lib/item-files.js kept for them, as File Search
  // keeps them. Whole or not at all: an item with a piece left unembedded
  // keeps no hash, so the next pass does it again.
  for (const x of later) {
    const head = x.item.head || String(x.item.text).split("\n")[0].slice(0, 150);
    const rest = x.item.bulk ? [] : x.body.slice(1).map((p) => ({ content: p, embed: head + "\n" + p }));
    for (const file of x.item.files || []) {
      const fHead = (`File: ${String(file.name).slice(0, 60)}\n` + head).slice(0, 290);
      for (const p of piecesOf(file.text)) rest.push({ content: `[File ${file.name}] ${p}`, embed: fHead + "\n" + p });
      for (const m of file.media || []) {
        rest.push({ content: `[File ${file.name}] ${m.label}`, vector: padVector(m.vector),
          meta: { modality: m.modality, ...(m.time != null ? { time: m.time } : {}), ...(m.start != null ? { start: m.start, end: m.end } : {}) } });
      }
    }
    const todo = rest.filter((r) => !r.vector);
    for (let k = 0; k < todo.length; k += BATCH) {
      const vecs = pad(await embedBatch(todo.slice(k, k + BATCH).map((r) => r.embed)), Math.min(BATCH, todo.length - k));
      vecs.forEach((v, n) => { todo[k + n].vector = v; });
    }
    if (rest.some((r) => !r.vector)) continue;
    if (await writeRest(userId, service, itemType, x.item, x.id, rest, true)) indexed++;
  }

  await progress(userId, service, { phase1_done: newItems.length, status: indexed > 0 ? "indexed" : "error", ...(indexed > 0 ? { last_sync: new Date().toISOString() } : {}) });
  console.log(`[USI] Phase 1: ${indexed} new ${service}/${itemType} items indexed (${items.length - newItems.length} already existed)`);
  return { indexed };
}

// An item's words in pieces the embedder reads whole: about 900 characters
// each, overlapping by a little so a sentence cut between two is in both,
// broken at a space. Together with a head of up to 250 characters, a piece
// stays inside the 1,200 a local embedder reads.
const PIECE_CHARS = 900;
const PIECE_OVERLAP = 120;
function piecesOf(text) {
  const t = String(text || "").trim();
  if (t.length <= PIECE_CHARS) return [t];
  const out = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(t.length, start + PIECE_CHARS);
    if (end < t.length) {
      const space = t.lastIndexOf(" ", end);
      if (space > start + PIECE_CHARS / 2) end = space;
    }
    out.push(t.slice(start, end).trim());
    if (end >= t.length) break;
    let next = end - PIECE_OVERLAP;
    const space = t.indexOf(" ", next);
    next = space !== -1 && space < end ? space + 1 : next;
    start = next > start ? next : end;
  }
  return out.filter(Boolean);
}
const pad = (list, n) => Array.from({ length: n }, (_, i) => list[i] || null);
// A kept picture or sound vector, stored without its trailing zeros, at the
// index's length.
const padVector = (v) => (v.length >= EMBED_DIMS ? v.slice(0, EMBED_DIMS) : v.concat(new Array(EMBED_DIMS - v.length).fill(0)));

// An item's rows: its first piece is the row everything else knows it by
// (its external id, its hash); each further piece is a row of its own that
// points at it (migration 085), so deleting the item deletes them. The hash
// is written last, so an item cut off partway is done again next pass.
const vectorMeta = (item) => ({
  ...(item.metadata || {}),
  _source_table: "data_cache",
  _lookup: `Full raw data in data_cache (accessed via search_cache/search_calendar). For actual attachment files use fetch_attachment.`,
});
async function writeFirst(userId, service, itemType, item, content, vector, final, existed) {
  const { data: first, error } = await supabase.from("data_vectors").upsert({
    user_id: userId, service, item_type: itemType, enrichment_level: "basic",
    external_id: item.external_id, content, embedding: JSON.stringify(vector), updated_at: new Date().toISOString(),
    source_metadata: { ...vectorMeta(item), ...(final ? { _content_hash: item._content_hash } : { _pieces: "pending" }) },
  }, { onConflict: "user_id,service,external_id" }).select("id").single();
  if (error || !first) { if (error) console.log(`[USI] Could not index ${item.external_id}: ${error.message}`); return null; }
  // A changed item may have had more pieces before.
  if (final && existed) {
    const { error: dropErr } = await supabase.from("data_vectors").delete().eq("piece_of", first.id);
    if (dropErr) { console.log(`[USI] Could not clear old pieces of ${item.external_id}: ${dropErr.message}`); return null; }
  }
  return first.id;
}
async function writeRest(userId, service, itemType, item, firstId, rest, complete) {
  const { error: dropErr } = await supabase.from("data_vectors").delete().eq("piece_of", firstId);
  if (dropErr) { console.log(`[USI] Could not clear old pieces of ${item.external_id}: ${dropErr.message}`); return false; }
  const meta = vectorMeta(item);
  if (rest.length) {
    const rows = rest.map((r, k) => ({
      user_id: userId, service, item_type: itemType, enrichment_level: "basic",
      external_id: `${item.external_id}#${k + 1}`, content: r.content, embedding: JSON.stringify(r.vector),
      piece_of: firstId, source_metadata: { ...meta, ...(r.meta || {}), _piece_of: item.external_id, _piece: k + 1 }, updated_at: new Date().toISOString(),
    }));
    for (let at = 0; at < rows.length; at += 100) {
      const { error } = await supabase.from("data_vectors").upsert(rows.slice(at, at + 100), { onConflict: "user_id,service,external_id" });
      if (error) { console.log(`[USI] Could not index the rest of ${item.external_id}: ${error.message}`); return false; }
    }
  }
  if (!complete) return true;
  const { error: hashErr } = await supabase.from("data_vectors").update({ source_metadata: { ...meta, _pieces: rest.length + 1, _content_hash: item._content_hash } }).eq("id", firstId);
  if (hashErr) { console.log(`[USI] Could not finish ${item.external_id}: ${hashErr.message}`); return false; }
  return true;
}
// ============================================================================
// ATTACHMENT TEXT EXTRACTION// ============================================================================
// ATTACHMENT TEXT EXTRACTION
// ============================================================================

/** Extract text from an attachment buffer based on file type */
const modelJobs = require("../model-jobs");


// An attachment's text for the email index and the scans that read mail:
// read whole by lib/file-reader.js, the one reader, then cut to what an index
// entry keeps. The model reads the whole file with view_attachment.
const INDEXED_ATTACHMENT_CHARS = 20000;
async function extractAttachmentText(buffer, filename, { maxChars = INDEXED_ATTACHMENT_CHARS } = {}) {
  try {
    const { readFile, kindOf } = require("../file-reader");
    if (kindOf(buffer, filename) === "image") {
      if (buffer.length < 10 * 1024) return null; // tracking pixels and logos
      // A picture's words and what it shows are both read here, on this
      // computer, and both kept, as File Search keeps them. A photo of a
      // shopfront is its sign and its street.
      const read = await readFile(buffer, filename);
      const words = read.text.replace(/\s/g, "").length >= 20 ? read.text : "";
      const shown = await describeAttachmentImage(buffer, filename);
      const both = [words, shown].filter(Boolean).join("\n\n");
      return both ? both.slice(0, maxChars) : null;
    }
    const read = await readFile(buffer, filename);
    return read.text ? read.text.slice(0, maxChars) : null;
  } catch (e) {
    console.log(`[USI] Attachment extraction failed for ${filename}: ${e.message}`);
  }
  return null;
}

// What a picture from a connection shows, for the index: always written by
// the VLM on this computer, whatever image model is chosen for chat, so
// indexing never sends a picture anywhere. Its words are read already.
async function describeAttachmentImage(buffer, filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  if (!["jpg", "jpeg", "png", "gif", "webp"].includes(ext) || buffer.length < 10 * 1024) return null; // tracking pixels and logos
  return describeHere([{ mediaType: ext === "jpg" ? "image/jpeg" : "image/" + ext, base64: buffer.toString("base64") }], { detailed: true, background: true, wordsRead: true });
}

// Pictures in chat, described by the image model chosen in Settings, and by
// the VLM on this computer where none is chosen or it can't read them: chat
// image descriptions, and substitution text when the chat model cannot see.
async function describeImages(images, opts = {}) {
  if (!images?.length) return null;
  if (modelJobs.role("vision")) {
    try {
      const said = await modelJobs.complete("vision", null, [
        ...images.map(img => ({ type: "image", source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.base64 } })),
        { type: "text", text: opts.detailed ? "Describe these images and transcribe visible text accurately." : "Describe each image briefly." },
      ], opts.detailed ? 1200 : 512, 60000);
      return said || await describeHere(images, opts);
    } catch (error) {
      console.log("[USI] Image model unavailable: " + error.message);
      return describeHere(images, opts);
    }
  }
  return describeHere(images, opts);
}

// Pictures seen on this computer, by the VLM (lib/local-models.js): every
// picture indexed, and in chat where no image model is chosen or it failed.
// What each shows and, for a full description the caller hasn't read the
// words of, its words, read by lib/file-reader.js. Indexing (opts.background)
// waits behind anyone waiting on a picture.
async function describeHere(images, opts = {}) {
  const { localDescribeImage } = require("../local-models");
  const said = [];
  for (const [i, img] of images.entries()) {
    try {
      const bytes = Buffer.from(img.base64, "base64");
      const shows = await localDescribeImage(bytes, { urgent: !opts.background });
      const words = opts.detailed && !opts.wordsRead ? ((await require("../file-reader").ocrImage(bytes).catch(() => null)) || "").trim() : "";
      const one = [shows, words && `Words in it: ${words}`].filter(Boolean).join("\n");
      if (one) said.push(images.length > 1 ? `${i + 1}. ${one}` : one);
    } catch (e) { console.log(`[USI] VLM: ${e.message}`); }
  }
  return said.join("\n\n") || null;
}

/** Fetch attachment content from the source service */
async function fetchAttachmentBuffer(userId, source, messageId, attachmentId, filename) {
  try {
    if (source.startsWith("gmail")) {
      const { googleApiRequest, serviceKeyForSourceTag } = require("./google");
      const data = await googleApiRequest("GET",
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
        null, null, serviceKeyForSourceTag(source)
      );
      if (data?.data) return Buffer.from(data.data, "base64url");
    }
    if (source.startsWith("outlook")) {
      const { microsoftApiRequest, msServiceKeyForSourceTag } = require("./microsoft");
      const data = await microsoftApiRequest("GET",
        `https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments/${attachmentId}/$value`,
        null, null, msServiceKeyForSourceTag(source)
      );
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === "string") return Buffer.from(data, "base64");
    }
  } catch (e) {
    console.log(`[USI] Attachment fetch failed (${source}/${filename}): ${e.message}`);
  }
  return null;
}

// --- Background chat (cheapChat) and image descriptions, with daily cost guardrails ---
// Two layers: per-user cap (fairness, sized to be invisible in normal use) and a global cap
// (wallet ceiling). Counters are in-memory (reset on redeploy); these are runaway-cost
// safety nets, not meters.
let _enrichDay = "";
let _enrichCount = 0;
let _enrichCapLogged = false;
let _enrichUserCounts = new Map();

function _rollDayIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _enrichDay) {
    _enrichDay = today; _enrichCount = 0;
    _enrichCapLogged = false; _enrichUserCounts = new Map();
  }
}

function _enrichBudgetOk(userId) {
  _rollDayIfNeeded();
  if (_enrichCount >= ENRICH_DAILY_CAP) {
    if (!_enrichCapLogged) {
      console.log(`[USI] Global enrichment cap reached (${ENRICH_DAILY_CAP}/day). Items index un-enriched until tomorrow.`);
      _enrichCapLogged = true;
    }
    return false;
  }
  const userCount = _enrichUserCounts.get(userId) || 0;
  if (userCount >= ENRICH_USER_DAILY_CAP) {
    if (userCount === ENRICH_USER_DAILY_CAP) {
      console.log(`[USI] Per-user enrichment cap reached for ${userId} (${ENRICH_USER_DAILY_CAP}/day).`);
      _enrichUserCounts.set(userId, userCount + 1);
    }
    return false;
  }
  return true;
}

// One completion on the support model chosen in Settings, inside the daily
// caps above. Used by pulse triage. Returns text or null.
async function _enrichCompletion(systemPrompt, userContent, maxTokens, timeoutMs) {
  try { return (await modelJobs.complete("background", systemPrompt, userContent, Math.max(maxTokens, 1024), timeoutMs)) || null; }
  catch (error) { console.log("[USI] Summaries model unavailable: " + error.message); return null; }
}

async function cheapChat(userId, systemPrompt, userContent, maxTokens = 512, timeoutMs = 20000) {
  return modelJobs.withSettings(userId, () => _cheapChat(userId, systemPrompt, userContent, maxTokens, timeoutMs));
}
async function _cheapChat(userId, systemPrompt, userContent, maxTokens = 512, timeoutMs = 20000) {
  if (!modelJobs.role("background") || !_enrichBudgetOk(userId)) return null;
  _enrichCount++;
  _enrichUserCounts.set(userId, (_enrichUserCounts.get(userId) || 0) + 1);
  return _enrichCompletion(systemPrompt, userContent, maxTokens, timeoutMs);
}

// ============================================================================
// UNIFIED SEARCH
// ============================================================================

// Tokenising and match windows live in ./lexical.js, vendored into the webapp
// so File Search runs the same lexical arm over rag_chunks that this runs over
// data_cache. Mail is the corpus here, so the mail stop words apply.
const { lexicalTokens: _lexicalTokens, matchWindow } = require("./lexical");
const lexicalTokens = (query) => _lexicalTokens(query, { corpus: "mail" });

// Reported once: a missing lexical index degrades search rather than breaking
// it, but it should not do so silently.
let _lexUnavailableReported = false;

async function lexicalSearch(userId, tokens, opts = {}) {
  if (!tokens.length) return [];
  try {
    // Across kinds, none may take more than half: twenty emails with a
    // person's name left no room for the chat message from them that the
    // question was about (migration 087).
    const count = opts.maxResults || 20;
    const { data, error } = await supabase.rpc("search_data_cache_lexical", {
      match_user_id: userId,
      query_tokens: tokens,
      match_count: count,
      filter_type: opts.cacheType || null,
      per_type: opts.cacheType ? null : Math.ceil(count / 2),
    });
    if (error) {
      if (!_lexUnavailableReported) {
        _lexUnavailableReported = true;
        console.log(`[USI] Lexical search unavailable (${error.message}); running vector-only. Apply migration 030 to enable it.`);
      }
      return [];
    }
    // Taken in turn, each kind's best first: the word arm's order is what
    // fusion ranks it by, and ten emails ahead of the chats cut every chat
    // from the candidates even with the share.
    const kinds = new Map();
    for (const r of data || []) { if (!kinds.has(r.type)) kinds.set(r.type, []); kinds.get(r.type).push(r); }
    const turns = opts.cacheType ? (data || []) : [];
    for (let i = 0; !opts.cacheType && turns.length < (data || []).length; i++) for (const list of kinds.values()) if (list[i]) turns.push(list[i]);
    return turns.map(r => {
      const d = r.data || {};
      const isEvent = r.type === "event";
      // The cache holds more than mail now. Rows are labelled by what they
      // are, and message-shaped rows (whatsapp, archived conversation, slack)
      // read their text from the keys those writers use, or the match window
      // came back empty and the result showed a bare title.
      const service = isEvent ? "calendar"
        : r.source === "whatsapp" ? "whatsapp"
        : r.source === "conversation" ? "conversation"
        : r.source === "slack" ? "slack"
        : r.source === "notion" ? "notion"
        : /^(connected:|mcp:)/.test(r.source || "") ? r.source
        : "email";
      const title = d.subject || d.summary || d.title
        || (d.sender && d.chat_name ? `${d.sender} (${d.chat_name})` : "");
      const body = d.body || d.description || d.snippet || d.text || d.content || "";
      const window = matchWindow(body, tokens);
      return {
        service,
        type: isEvent ? "event" : r.type || "email",
        id: r.external_id,
        content: [title, window].filter(Boolean).join("\n").substring(0, 400),
        metadata: {
          ...(d.metadata || {}),
          subject: d.subject || undefined,
          summary: d.summary || undefined,
          from: d.from || undefined,
          date: d.date || d.start || undefined,
        },
        enriched: false,
        _lexical: true,
        _rank: r.rank,
      };
    });
  } catch (e) {
    if (!_lexUnavailableReported) {
      _lexUnavailableReported = true;
      console.log(`[USI] Lexical search failed (${e.message}); running vector-only.`);
    }
    return [];
  }
}

/**
 * Hybrid retrieval: a vector arm and a lexical arm as co-equal retrievers over
 * the same corpus, fused by Reciprocal Rank Fusion.
 *
 * RRF rather than a weighted score blend because cosine similarity and
 * ts_rank_cd are on incomparable, query-dependent scales; any fixed alpha needs
 * calibration that drifts. RRF reads only ordinal position, needs no tuning,
 * and degrades to "whatever the other arm found" when one returns nothing.
 * An item both arms find scores the sum of its two contributions, so agreement
 * promotes it rather than costing it a second slot in a fixed budget.
 *
 * WHAT THE RRF SCORE IS NOT: a relevance signal. This step decides which
 * candidates the cross-encoder gets to see, and nothing more. Observed on a
 * real query, the RRF order came back close to the REVERSE of the reranker's:
 * the three items both arms agreed on scored highest on RRF and lowest on
 * rerank, and the second-best answer was a keyword-only hit near the bottom of
 * the RRF list. That is not a defect to tune out. Agreement between a semantic
 * and a lexical retriever means "both noticed this", which is a good reason to
 * show it to a judge and a poor reason to believe it. The cross-encoder is the
 * only component here that reads the query and the document together, so it is
 * the only one whose ordering is a quality judgement.
 *
 * Do not sort, threshold, truncate or report on _rrf as though it ranked
 * anything. It exists to fill the candidate set.
 */
const RRF_K = 60;

// The query's embedding gets a few seconds. On a computer short of memory it
// took 20 to 30 s, while the keyword arm answered in half a second, so a
// "what's on today?" sat for 46 s on one email search. Past the budget the
// search goes ahead on keywords alone, which is a genuine result set (see
// below); the embedding is left to finish in the background.
const QUERY_EMBED_BUDGET_MS = 5000;
function embedWithinBudget(query) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.log(`[USI] query embedding passed ${QUERY_EMBED_BUDGET_MS / 1000}s; searching by keywords alone`);
      resolve(null);
    }, QUERY_EMBED_BUDGET_MS);
  });
  const work = embedText(query, { quick: true }).catch(() => null);
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function search(userId, query, opts = {}) {
  // A person named in the question brings their other names and addresses
  // (lib/people.js): "dad" also finds what came as Rowan and from his email.
  const asked = lexicalTokens(query);
  const tokens = asked.length ? asked.concat(await require("../people").load(userId).then((p) => p.expand(asked)).catch(() => [])) : asked;
  // Both arms in parallel: the lexical arm is a GIN index scan and the vector
  // arm is dominated by the query embed, so hybrid costs one round trip, not
  // the sum of the two.
  const [embedding, lexRows] = await Promise.all([
    opts.queryEmbedding === undefined ? embedWithinBudget(query) : opts.queryEmbedding,
    lexicalSearch(userId, tokens, opts),
  ]);

  let vecRows = [];
  let vecError = null;
  if (embedding) {
    // Twice as many rows, since several pieces of one item can match: each
    // item counts once, by its best piece, which is what is shown.
    const { data, error } = await supabase.rpc("search_data_vectors", {
      query_embedding: JSON.stringify(embedding),
      match_user_id: userId,
      match_threshold: opts.threshold || 0.3,
      match_count: (opts.maxResults || 30) * 2,
      filter_service: opts.service || null,
    });
    const seenItems = new Set();
    if (error) vecError = error.message;
    // A picture, a video frame or a stretch of sound is found by what it is,
    // under the line File Search uses (doc-search.js MEDIA_MATCH): below it,
    // it is dropped before it can stand for its item.
    else vecRows = (data || []).filter((r) => !r.source_metadata?.modality || r.similarity >= MEDIA_MATCH).filter((r) => {
      const key = r.service + ":" + (r.source_metadata?._piece_of || r.external_id);
      if (seenItems.has(key)) return false;
      seenItems.add(key);
      return true;
    }).slice(0, opts.maxResults || 30).map(r => ({
      service: r.service,
      type: r.item_type,
      id: r.source_metadata?._piece_of || r.external_id,
      content: r.content,
      // The content hash only tells the indexer an item changed; it is not
      // for the model, which once got it even for text withheld from it.
      metadata: r.source_metadata && typeof r.source_metadata === "object" ? (({ _content_hash, ...rest }) => rest)(r.source_metadata) : r.source_metadata,
      enriched: r.enrichment_level === "full",
      similarity: r.similarity,
      // The reranker reads only its label, so it scores it as clearly about
      // the query (reranker.js).
      ...(r.source_metadata?.modality ? { _media: true } : {}),
    }));
  }

  // A dead embedder no longer means a dead search: lexical alone is a genuine
  // result set, not a consolation prize.
  if (!embedding && !lexRows.length) {
    return { results: [], error: "Semantic search temporarily unavailable. Fall back to search_cache keyword search now." };
  }
  if (vecError && !lexRows.length) return { results: [], error: vecError };

  const fused = new Map();
  const contribute = (row, rank, arm) => {
    const key = row.id ? `${row.service}:${row.id}` : `${arm}:${rank}`;
    const prev = fused.get(key);
    const score = 1 / (RRF_K + rank + 1);
    if (!prev) {
      fused.set(key, { score, vec: arm === "vec" ? row : null, lex: arm === "lex" ? row : null });
      return;
    }
    prev.score += score;
    if (arm === "vec") prev.vec = prev.vec || row;
    else prev.lex = prev.lex || row;
  };
  vecRows.forEach((r, i) => contribute(r, i, "vec"));
  lexRows.forEach((r, i) => contribute(r, i, "lex"));

  const merged = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ score, vec, lex }) => {
      // Prefer the vector arm's content, the item's opening words. Except when
      // the matched token is absent from it: then it cannot show why this row
      // was retrieved, and the word arm's window around the match can.
      let base = vec || lex;
      if (vec && lex) {
        const summary = String(vec.content || "").toLowerCase();
        const missing = tokens.length && !tokens.some(t => summary.includes(t.toLowerCase()));
        base = missing ? { ...vec, content: lex.content } : vec;
      }
      // _rrf is candidate-generation bookkeeping, not a score anyone should
      // rank on. See the note above the function.
      return { ...base, _rrf: score, _arms: vec && lex ? "both" : vec ? "vector" : "lexical" };
    })
    .slice(0, opts.maxResults || 30)
    // Sign-in codes and reset links stay out of recall unless asked for.
    .map((r) => require("../otp-guard").redactRecall(r, userId));

  return { results: merged };
}

// ============================================================================
// EMAIL/CALENDAR INDEXING HOOKS
// ============================================================================

// One mapper per cache row shape, shared by the full sweep and the
// incremental path so the two can never disagree about what gets embedded.
// An email's own words: quoted earlier mail and anything after a sign-off
// marker go, and the whitespace is collapsed.
function ownWords(body) {
  const kept = [];
  for (const line of String(body || "").split("\n")) {
    const l = line.trim();
    if (/^>/.test(l)) continue;
    if (/^On .{5,200} wrote:$/.test(l) || /^-{2,}\s*(Original Message|Forwarded message)/i.test(l) || /^Sent from my /.test(l)) break;
    kept.push(line);
  }
  return kept.join("\n").replace(/\s+/g, " ").trim();
}

function _emailRowToIndexItem(e) {
      const d = e.data || {};
      const attNames = (d.attachments || []).map(a => a.name || a.filename || "").filter(Boolean);
      const text = [
        `From: ${d.from || d.sender || ""}`,
        `To: ${d.to || ""}`,
        `Subject: ${d.subject || ""}`,
        `Date: ${d.date || ""}`,
        `Account: ${d.account || ""}`,
        d.body || d.snippet || "",
        attNames.length > 0 ? `Attachments: ${attNames.join(", ")}` : "",
      ].filter(Boolean).join("\n");

      // What the search shows of it and embeds: the subject, then the email's
      // own words without quoted earlier mail or a sign-off line, and its
      // attachments' names. The label beside it gives the sender and date.
      const words = ownWords(d.body || d.snippet || "");
      const attached = attNames.length > 0 ? `Attachments: ${attNames.join(", ")}` : "";
      return {
        external_id: e.external_id || d.id || d.messageId || "",
        text,
        // Bulk mail (email-record.js) is found by meaning by its first piece.
        bulk: !!d.bulk || (d.labels || []).some((l) => /^CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)$/.test(l)),
        rows: [e],
        gist: [d.subject || "", words, attached].filter(Boolean).join("\n"),
        head: [`Subject: ${d.subject || ""}`, `From: ${d.from || d.sender || ""}`].join("\n").slice(0, 250),
        metadata: {
          from: d.from || d.sender,
          to: d.to,
          subject: d.subject,
          date: d.date,
          source: e.source,
          has_attachments: !!(d.attachments && d.attachments.length > 0),
          attachment_names: (d.attachments || []).map(a => a.name || a.filename).filter(Boolean),
          _cache_updated_at: e.synced_at,
        },
      };
  }

function _eventRowToIndexItem(e) {
      const d = e.data || {};
      const attendeeStr = (d.attendees || []).map(a =>
        typeof a === "string" ? a : `${a.name || a.email || ""} (${a.status || ""})`
      ).join(", ");

      let durationStr = "";
      try {
        const s = new Date(d.start || d.date);
        const en = new Date(d.end);
        if (!isNaN(s.getTime()) && !isNaN(en.getTime())) {
          const mins = Math.round((en - s) / 60000);
          if (mins > 0 && mins < 1440) durationStr = `${mins} minutes`;
          else if (mins >= 1440) durationStr = `${Math.round(mins / 1440)} day(s)`;
        }
      } catch (_) {}

      const text = [
        `Event: ${d.summary || ""}`,
        `When: ${d.start || d.date || ""} to ${d.end || ""}`,
        durationStr ? `Duration: ${durationStr}` : "",
        `Location: ${d.location || ""}`,
        `Calendar: ${d.calendar || ""}`,
        `Attendees: ${attendeeStr}`,
        `Description: ${d.description || ""}`,
        (d.attachments && d.attachments.length) ? `Attachments: ${d.attachments.map(a => a.name).filter(Boolean).join(", ")}` : "",
        d.recurrence ? `Recurrence: ${d.recurrence}` : "",
      ].filter(Boolean).join("\n");

      return {
        external_id: e.external_id || d.id || d.uid || "",
        text,
        rows: [e],
        metadata: {
          summary: d.summary,
          start: d.start || d.date,
          end: d.end,
          location: d.location,
          calendar: d.calendar,
          source: e.source,
          attendees: d.attendees,
          canceled: d.canceled || false,
          has_attachments: !!(d.attachments && d.attachments.length),
          attachments: d.attachments || [],
          _cache_updated_at: e.synced_at,
        },
      };
  }

// Incremental indexing: the sync loop hands over exactly the rows it just
// wrote, so nothing re-reads the whole cache to discover what is new. The
// full sweep (runPostSyncIndex) survives as a daily safety net for backlog,
// retries and bridge-import dedupe; it is no longer the delivery path. Only
// API-synced sources come through here, so the sweep's bridge-versus-cloud
// dedupe filter is unnecessary: these rows ARE the cloud copies.
// Newest mail first: a first sync of a whole mailbox takes minutes to embed,
// and what someone asks about in their first chat is nearly always recent, so
// that is what becomes searchable by meaning first. Sent mail and drafts
// otherwise waited behind the full inbox.
function newestFirst(rows) {
  const when = (r) => { const t = Date.parse(r?.data?.date || r?.data?.receivedDateTime || ""); return Number.isFinite(t) ? t : 0; };
  return [...rows].sort((a, b) => when(b) - when(a));
}

async function indexSyncedCacheRows(userId, type, rows, opts = {}) {
  try {
    const items = (type === "email" ? newestFirst(rows || []) : (rows || []))
      .map(type === "event" ? _eventRowToIndexItem : _emailRowToIndexItem)
      .filter(i => i.external_id && i.text.length > 20);
    if (items.length === 0) return { indexed: 0 };
    return await indexItems(userId,
      type === "event" ? "calendar" : "email",
      type === "event" ? "event" : "email",
      items, { scoped: true, ...opts });
  } catch (e) {
    console.error(`[USI] incremental index failed (${type}): ${e.message}`);
    return { indexed: 0 };
  }
}

// Vectors whose email or event is gone from the cache, among those a pass did
// not see. Not being seen is only a reason to look: a pass can miss a row,
// and deleting the vector of mail that is still there loses it from recall.
async function staleVectors(userId, service, cacheType, seen) {
  const { data: vectors } = await supabase.from("data_vectors").select("id, external_id, piece_of").eq("user_id", userId).eq("service", service);
  const unseen = (vectors || []).filter((v) => !v.piece_of && !seen.has(v.external_id));
  const present = new Set();
  const ids = [...new Set(unseen.map((v) => v.external_id))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from("data_cache").select("external_id").eq("user_id", userId).eq("type", cacheType).in("external_id", ids.slice(i, i + 200));
    if (error) return []; // can't tell, so nothing is stale
    for (const r of data || []) present.add(r.external_id);
  }
  return unseen.filter((v) => !present.has(v.external_id));
}

async function indexCachedEmails(userId) {
  let offset = 0;
  const PAGE_SIZE = 300;
  let totalIndexed = 0;
  const allIndexedIds = new Set();

  // DEDUP: Build cloud Message-ID set ONCE across ALL emails (not per page)
  const { data: connections } = await supabase.from("connections").select("service").eq("user_id", userId);
  const cloudEmailSources = new Set();
  for (const c of (connections || [])) {
    if (c.service === "google") cloudEmailSources.add("gmail");
    if (c.service.startsWith("google_extra_")) cloudEmailSources.add("gmail_" + c.service.slice("google_extra_".length));
    if (c.service === "microsoft") cloudEmailSources.add("outlook");
    if (c.service.startsWith("microsoft_extra_")) cloudEmailSources.add("outlook_" + c.service.slice("microsoft_extra_".length));
  }

  const cloudMessageIds = new Set();
  if (cloudEmailSources.size > 0) {
    const cloudSources = [...cloudEmailSources];
    const { data: cloudEmails } = await supabase
      .from("data_cache")
      .select("data")
      .eq("user_id", userId)
      .eq("type", "email")
      .in("source", cloudSources);
    for (const e of (cloudEmails || [])) {
      const d = e.data || {};
      const msgId = d.messageId_header || d.messageId || d.id || "";
      if (msgId) cloudMessageIds.add(msgId);
    }
  }

  while (true) {
    const { data: emails } = await supabase
      .from("data_cache")
      .select("external_id, data, source, synced_at")
      .eq("user_id", userId)
      .eq("type", "email")
      .order("synced_at", { ascending: false })
      // Rows saved together share synced_at, and tied rows come back in any
      // order from one page to the next: without a unique second key the
      // pass skipped some, then deleted their vectors as stale.
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (!emails || emails.length === 0) break;

    // Debug: log source breakdown on first page
    if (offset === 0) {
      const sources = {};
      for (const e of emails) { sources[e.source] = (sources[e.source] || 0) + 1; }
      console.log(`[USI] Email page 0: ${emails.length} total, sources: ${JSON.stringify(sources)}, cloudSources: [${[...cloudEmailSources]}], cloudMsgIds: ${cloudMessageIds.size}`);
    }

    const dedupedEmails = emails.filter(e => {
      if (e.source.startsWith("gmail") || e.source === "outlook") return true;
      const d = e.data || {};
      const msgId = d.messageId_header || d.messageId || d.id || "";
      if (msgId && cloudMessageIds.has(msgId)) return false;
      const account = (d.account || "").toLowerCase();
      if (account.includes("gmail") && cloudEmailSources.has("gmail")) return false;
      if ((account.includes("outlook") || account.includes("exchange")) && cloudEmailSources.has("outlook")) return false;
      return true;
    });

    const items = dedupedEmails.map(_emailRowToIndexItem).filter(i => i.external_id && i.text.length > 20);

    // Debug: log filtering pipeline on first page
    if (offset === 0) {
      const noExtId = dedupedEmails.filter(e => !(e.external_id || (e.data || {}).id || (e.data || {}).messageId)).length;
      console.log(`[USI] Email pipeline: ${emails.length} raw -> ${dedupedEmails.length} after dedup -> ${items.length} after filter (${noExtId} missing external_id)`);
    }

    for (const item of items) allIndexedIds.add(item.external_id);

    // Each page checks its own emails only (readIndexed).
    const result = await indexItems(userId, "email", "email", items, { scoped: true });
    totalIndexed += result.indexed;

    if (emails.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // Clean up vectors for emails that no longer exist in cache
  if (allIndexedIds.size > 0) {
    const toDelete = await staleVectors(userId, "email", "email", allIndexedIds);
    if (toDelete.length > 0) {
      for (const v of toDelete) {
        const { error: delError } = await supabase.from("data_vectors").delete().eq("id", v.id);
        if (delError) console.error(`[USI] could not delete stale vector ${v.id}: ${delError.message}`);
      }
      console.log(`[USI] Cleaned ${toDelete.length} stale email vectors`);
    }
  }

  return { indexed: totalIndexed };
}

async function indexCachedCalendar(userId) {
  let offset = 0;
  const PAGE_SIZE = 300;
  let totalIndexed = 0;
  const allIndexedIds = new Set();

  // DEDUP: Build cloud iCalUID set upfront
  const { data: cloudEvents } = await supabase
    .from("data_cache")
    .select("data")
    .eq("user_id", userId)
    .eq("type", "event")
    .in("source", ["gcal", "outlook_cal"]);
  const cloudUIDs = new Set();
  for (const e of (cloudEvents || [])) {
    const uid = e.data?.uid || e.data?.iCalUID || "";
    if (uid) cloudUIDs.add(uid);
  }

  while (true) {
    const { data: events } = await supabase
      .from("data_cache")
      .select("external_id, data, source, synced_at")
      .eq("user_id", userId)
      .eq("type", "event")
      .order("synced_at", { ascending: false })
      // Rows saved together share synced_at, and tied rows come back in any
      // order from one page to the next: without a unique second key the
      // pass skipped some, then deleted their vectors as stale.
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (!events || events.length === 0) break;

    const dedupedEvents = events.filter(e => {
      if (e.source.startsWith("gcal") || e.source === "outlook_cal") return true;
      const uid = e.data?.uid || e.data?.iCalUID || "";
      if (uid && cloudUIDs.has(uid)) return false;
      return true;
    });

    const items = dedupedEvents.map(_eventRowToIndexItem).filter(i => i.external_id && i.text.length > 20);

    for (const item of items) allIndexedIds.add(item.external_id);

    const result = await indexItems(userId, "calendar", "event", items, { scoped: true });
    totalIndexed += result.indexed;

    if (events.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // Clean up vectors for events no longer in cache
  if (allIndexedIds.size > 0) {
    const toDelete = await staleVectors(userId, "calendar", "event", allIndexedIds);
    if (toDelete.length > 0) {
      for (const v of toDelete) {
        const { error: delError } = await supabase.from("data_vectors").delete().eq("id", v.id);
        if (delError) console.error(`[USI] could not delete stale vector ${v.id}: ${delError.message}`);
      }
      console.log(`[USI] Cleaned ${toDelete.length} stale calendar vectors`);
    }
  }

  return { indexed: totalIndexed };
}

// ============================================================================
// PROGRESS TRACKING
// ============================================================================

async function upsertProgress(userId, service, updates) {
  const row = { user_id: userId, service, ...updates, updated_at: new Date().toISOString() };
  try {
    const { error } = await supabase.from("index_progress").upsert(row, { onConflict: "user_id,service" });
    // Progress drives the wizard's indexing display. A lost write makes the
    // dashboard report a stall that is not happening, or hide one that is.
    if (error) console.log(`[USI] progress write failed for ${service}: ${error.message}`);
  } catch (e) { console.log(`[USI] progress write failed for ${service}: ${e.message}`); }
}

async function getProgress(userId) {
  const { data } = await supabase.from("index_progress").select("*").eq("user_id", userId);
  return data || [];
}

// ============================================================================
// SYNC HOOKS
// ============================================================================

// A pass over a large mailbox takes minutes and the sync loop comes round every
// few. Without this guard each cycle piled another pass on top of the unfinished
// one; on a local CPU embedder they fought for the same core and none of them
// reached its first write, so an install could sync for an hour and index
// nothing.
//
// A start time rather than a flag, because a pass that hangs would otherwise
// hold the lock for the life of the process and stop that user ever being
// indexed again, which is a worse failure than the overlap this prevents. The
// token check stops a late-finishing stale pass from clearing its successor.
const STALE_PASS_MS = 30 * 60 * 1000;
const _passStartedAt = new Map();

// Counted as busy (lib/idle.js) while it runs.
async function runPostSyncIndex(userId) {
  return require("../idle").during(() => postSyncIndexPass(userId));
}
async function postSyncIndexPass(userId) {
  const startedAt = _passStartedAt.get(userId);
  if (startedAt && Date.now() - startedAt < STALE_PASS_MS) {
    console.log(`[USI] pass already running for ${userId}, skipping this cycle`);
    return;
  }
  if (startedAt) {
    console.log(`[USI] previous pass for ${userId} has been running ${Math.round((Date.now() - startedAt) / 60000)}min; treating it as stuck and starting a fresh one`);
  }
  const token = Date.now();
  _passStartedAt.set(userId, token);
  console.log(`[USI] runPostSyncIndex starting for ${userId}`);
  try {
    const { count: emailCount } = await supabase.from("data_cache").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("type", "email");
    const { count: calCount } = await supabase.from("data_cache").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("type", "event");
    console.log(`[USI] data_cache for ${userId}: emails=${emailCount || 0}, events=${calCount || 0}`);
    const indexResults = await Promise.allSettled([
      indexCachedEmails(userId),
      indexCachedCalendar(userId),
    ]);
    for (const r of indexResults) {
      if (r.status === "rejected") console.error(`[USI] Index task rejected: ${r.reason?.message || r.reason}`);
      else console.log(`[USI] Index task completed: indexed=${r.value?.indexed || 0}`);
    }
  } catch (e) {
    console.error(`[USI] Post-sync index error for ${userId}: ${e.message}`);
  } finally {
    if (_passStartedAt.get(userId) === token) _passStartedAt.delete(userId);
  }
}

module.exports = {
  piecesOf,
  maxTextLen,
  fetchAttachmentBuffer,
  indexSyncedCacheRows,
  _emailRowToIndexItem,
  _withRowFiles: withRowFiles,
  _readIndexed: readIndexed,
  _eventRowToIndexItem,
  cheapChat,
  describeImages,
  describeHere,
  extractAttachmentText,
  embedDocument,
  embedText,
  embedBatch,
  indexItems,
  search,
  indexCachedEmails,
  indexCachedCalendar,
  runPostSyncIndex,
  getProgress,
};
