// lib/services/data-sync.js -- Background data cache sync service
// Syncs recent emails and calendar events from all connected sources into Supabase data_cache.
// Runs on timers, never blocks user message processing.

const ctx = require("../context");
const { acquireUserMutex } = require("../user-mutex");
const { UserStore, supabase } = require("../../user-store");
const { swapToCloudStore, syncAdapterBack, cleanupUserContext } = require("../storage");
const { isGoogleConnected, googleApiRequest, loadGoogleTokens, listGoogleAccounts, markGoogleScopeFailure } = require("./google");
const { isMicrosoftConnected, microsoftApiRequest, listMicrosoftAccounts } = require("./microsoft");
const { bridgeRequest } = require("./bridge-relay");
const { emailRecord, gmailWebLink, SHAPE } = require("./email-record");

// --- Gmail body extraction (full body variant, not truncated) ---
const { peek } = require("../log-text");

// An event's description, whole: written in a calendar's editor it is HTML,
// read as text with its links beside their words.
function eventText(s) {
  return /<[a-z][^>]*>/i.test(String(s)) ? stripHtml(String(s)) : String(s);
}

// HTML mail as text, whole, by the one reader (lib/file-reader.js htmlText):
// its links beside their words. Nothing is cut: a signature, a disclaimer, a
// quoted reply are the mail; what of it is the person's own is decided where
// it is indexed (usi.js ownWords). Cut here, "This email is intended to
// confirm..." lost the rest of a booking, and every link lost its address.
function stripHtml(html) {
  if (!html) return "";
  return require("../file-reader").htmlText(html);
}

function extractGmailBodyFull(payload) {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractGmailBodyFull(part);
      if (result) return result;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    const html = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    return stripHtml(html);
  }
  return "";
}

// Metadata only, never the bytes: knowing a message has "invoice.pdf" and
// "Screenshot 16.47.28.jpg" costs a few dozen characters per email, while the
// images themselves would be megabytes in the cache and thousands of tokens in
// every prompt that touched them. Fetch the content on demand, when it matters.
function extractGmailAttachments(payload, out = []) {
  if (!payload) return out;
  const headers = payload.headers || [];
  const cid = headers.find(h => h.name.toLowerCase() === "content-id")?.value || null;
  const disposition = headers.find(h => h.name.toLowerCase() === "content-disposition")?.value || "";

  if (payload.filename && payload.body?.attachmentId) {
    out.push({
      filename: payload.filename,
      mimeType: payload.mimeType || "application/octet-stream",
      size: payload.body.size || 0,
      attachmentId: payload.body.attachmentId,
      // Inline parts are the images sitting in the body text, which is what a
      // reader sees as part of the message rather than as a separate file.
      inline: /inline/i.test(disposition) || Boolean(cid),
    });
  }
  for (const part of payload.parts || []) extractGmailAttachments(part, out);
  return out;
}

function getGmailHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

// --- Concurrency limiter ---
function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  function next() {
    while (active < concurrency && queue.length > 0) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(resolve, reject).finally(() => { active--; next(); });
    }
  }
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

// Supabase caps selects at 1000 rows; dedup ID sets MUST paginate or items past
// row 1000 look "new" every sync and get re-fetched/re-embedded (cost incident 2026-07-19)
// Pages go in id order, each after the last id read: by offset in no order,
// rows written meanwhile reorder the table and some are never seen
// (usi.js readIndexed, where it cost a third of the index).
async function fetchCachedIds(userId, source, type) {
  const ids = new Set();
  const PAGE = 1000;
  let after = null;
  for (;;) {
    let q = supabase
      .from("data_cache")
      .select("id, external_id")
      .eq("user_id", userId)
      .eq("source", source)
      .eq("type", type)
      // Tombstones do not count as cached: if a trashed mail is restored, it
      // reappears in the live list, reads as new, and re-syncs over its own
      // tombstone with the real content.
      .is("data->tombstone", null);
    if (after) q = q.gt("id", after);
    const { data: page, error } = await q.order("id", { ascending: true }).limit(PAGE);
    if (error) throw new Error(`cached-id fetch failed: ${error.message}`);
    for (const r of (page || [])) ids.add(r.external_id);
    if (!page || page.length < PAGE) break;
    after = page[page.length - 1].id;
  }
  return ids;
}

// --- Timeout wrapper ---
function withTimeout(promise, ms, label) {
  // Listed as running until it ends, after its limit too: work that ran on
  // past it once stacked up under the next sync.
  const end = require("../doing").start(label);
  Promise.resolve(promise).then(end, end);
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ============================================================================
// UPSERT + EVICTION
// ============================================================================

async function upsertCacheItems(userId, source, type, items) {
  if (!items || items.length === 0) return;

  // No embedding here, deliberately. data_cache used to carry its own 768-dim
  // vector per email, written on every sync (one API call per message, with
  // rate-limit sleeps) and read by exactly one RPC, match_cached_emails, whose
  // last caller was removed when explicit search moved to usi.search. The
  // proper 1536-dim embedding lives in data_vectors via the USI indexer; this
  // one cost every sync real time and money to keep an index nothing read.
  const rows = items.map((item) => {
    const row = {
      user_id: userId,
      source,
      type,
      external_id: String(item.external_id || item.id || ""),
      data: item,
      synced_at: new Date().toISOString(),
      received_at: (() => {
        if (!item.date) return null;
        let d = new Date(item.date);
        if (!isNaN(d.getTime())) return d.toISOString();
        const cleaned = String(item.date).replace(/^\w+,\s*/, "").replace(" at ", " ");
        d = new Date(cleaned);
        return isNaN(d.getTime()) ? null : d.toISOString();
      })(),
    };
    return row;
  });

  // What was read from an item's files stays with it when the item is saved
  // again (lib/item-files.js), for the files it still has: a sync that saves
  // its rows anew each pass (every calendar event, a chat's recent messages)
  // had every one of their files fetched and read again each time.
  const files = require("../item-files");
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200).filter((r) => r.data.file_texts === undefined && files.filesOf(r).length);
    if (!batch.length) continue;
    const { data: had } = await supabase.from("data_cache").select("external_id, file_texts:data->file_texts")
      .eq("user_id", userId).eq("source", source).in("external_id", batch.map((r) => r.external_id));
    const read = new Map((had || []).filter((h) => Array.isArray(h.file_texts)).map((h) => [h.external_id, h.file_texts]));
    for (const r of batch) {
      const listed = new Set(files.filesOf(r).map((f) => f.key));
      const still = (read.get(r.external_id) || []).filter((t) => t && listed.has(t.key));
      if (still.length) r.data = { ...r.data, file_texts: still };
    }
  }

  // Batch upsert in chunks of 50
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase
      .from("data_cache")
      .upsert(batch, { onConflict: "user_id,source,external_id" });
    if (error) {
      console.error(`[data-sync] Upsert error for ${source}/${type}: ${error.message}`);
    }
  }
}

// Which of these cached emails were written before every mailbox shared one
// shape (email-record.js).
async function staleShape(userId, sourceTag, ids) {
  const stale = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from("data_cache").select("external_id, shape:data->>shape")
      .eq("user_id", userId).eq("source", sourceTag).eq("type", "email").in("external_id", ids.slice(i, i + 200));
    if (error) { console.log(`[data-sync] shape check skipped for ${sourceTag}: ${error.message}`); return stale; }
    for (const r of data || []) if (String(r.shape) !== String(SHAPE)) stale.add(r.external_id);
  }
  return stale;
}

// Gmail and IMAP records cached in an older shape already hold everything
// the shape needs, so they are rewritten from their own data, a batch per
// sync, with no mail fetched. (Outlook's need the attachment list, so they
// are rewritten from the next sync's list instead.)
async function upgradeCachedEmails(userId, sourceTag, extra = () => ({})) {
  const { data: marks, error } = await supabase.from("data_cache").select("external_id, shape:data->>shape")
    .eq("user_id", userId).eq("source", sourceTag).eq("type", "email").limit(10000);
  if (error) { console.log(`[data-sync] shape upgrade skipped for ${sourceTag}: ${error.message}`); return; }
  const old = (marks || []).filter((r) => String(r.shape) !== String(SHAPE)).map((r) => r.external_id).slice(0, 500);
  for (let i = 0; i < old.length; i += 100) {
    const { data: rows, error: readErr } = await supabase.from("data_cache").select("external_id, data")
      .eq("user_id", userId).eq("source", sourceTag).eq("type", "email").in("external_id", old.slice(i, i + 100));
    if (readErr) { console.log(`[data-sync] shape upgrade read failed for ${sourceTag}: ${readErr.message}`); return; }
    await upsertCacheItems(userId, sourceTag, "email", (rows || []).map((r) => emailRecord({ ...r.data, id: r.external_id, ...extra(r.data || {}) })));
  }
  if (old.length) console.log(`[data-sync] ${sourceTag}: ${old.length} cached emails brought to the shared shape`);
}

/**
 * Remove cached events that Google no longer returns for a window we fully
 * synced. Only ever deletes inside that window, and only ids that were absent
 * from a complete fetch, so a shortened sync cannot wipe real events.
 */
async function reconcileDeletedEvents(userId, source, items, windowStart, windowEnd, syncedCalendars) {
  try {
    const liveIds = new Set(items.map(i => String(i.external_id || i.id || "")));

    const { data: cached, error } = await supabase
      .from("data_cache")
      // Plain columns only: the self-host Postgres shim does not speak
      // PostgREST's "alias:expression" select, so asking for
      // calendar:data->>calendar made every reconcile fail with
      // column "calendar:data" does not exist, on every calendar source.
      // Reading the json and picking the field in JS works on both.
      .select("external_id, data")
      .eq("user_id", userId)
      .eq("source", source)
      .eq("type", "event")
      .gte("received_at", windowStart.toISOString())
      .lte("received_at", windowEnd.toISOString());

    if (error) {
      console.error(`[data-sync] Reconcile read failed for ${source}: ${error.message}`);
      return;
    }

    const gone = (cached || [])
      // Only judge calendars this run actually read. Anything else is unknown,
      // not deleted, and unknown must never mean delete.
      .filter(r => !syncedCalendars || !r.data?.calendar || syncedCalendars.has(r.data.calendar))
      .map(r => r.external_id)
      .filter(id => id && !liveIds.has(id));
    if (gone.length === 0) return;

    for (let i = 0; i < gone.length; i += 100) {
      const chunk = gone.slice(i, i + 100);
      await supabase.from("data_cache").delete()
        .eq("user_id", userId).eq("source", source).eq("type", "event").in("external_id", chunk);
      // The semantic index holds its own copy, so a deleted event would still
      // surface through recall even once the cache row is gone.
      await supabase.from("data_vectors").delete()
        .eq("user_id", userId).eq("service", "calendar").in("external_id", chunk);
    }
    console.log(`[data-sync] GCal: removed ${gone.length} deleted event(s) for ${userId} (${source})`);
  } catch (e) {
    console.error(`[data-sync] Reconcile failed for ${source}: ${e.message}`);
  }
}

// keepSince: nothing received after it goes either, however many there are.
// Mail keeps its last year (mail-history.js reads it in for recall).
// `listed`: what the mailbox's own list just named (its newest inbox and sent
// mail) is never deleted here. An old sent email among the newest 300 was
// deleted as soon as it was fetched, and fetched again on every sync: 206 of
// them every five minutes on one mailbox, and their index entries remade daily.
// Rows past the newest `keepCount` and older than `keepSince` go, unless just
// listed. With `personalSince`, mail older than keepSince goes only when it is
// bulk, and a person's own mail stays until personalSince (sync-depth.js).
async function evictOldItems(userId, source, type, keepCount, keepSince = null, listed = null, { personalSince = null } = {}) {
  // Get IDs to keep (most recent by received_at)
  const { data: keep, error: keepErr } = await supabase
    .from("data_cache")
    .select("id")
    .eq("user_id", userId)
    .eq("source", source)
    .eq("type", type)
    .order("received_at", { ascending: false })
    .limit(keepCount);

  if (keepErr) {
    console.error(`[data-sync] Eviction query error: ${keepErr.message}`);
    return;
  }

  if (!keep || keep.length < keepCount) return; // Nothing to evict

  const keepIds = keep.map(r => r.id);

  // Delete everything not in the keep set, and not just listed
  const unlisted = (q) => (listed && listed.size ? q.not("external_id", "in", `(${[...listed].join(",")})`) : q);
  const older = async (since, bulkOnly = false) => {
    const gone = supabase.from("data_cache").delete().eq("user_id", userId).eq("source", source).eq("type", type).not("id", "in", `(${keepIds.join(",")})`);
    const aged = since ? gone.lt("received_at", since) : gone;
    const { error: delErr } = await unlisted(bulkOnly ? aged.eq("data->>bulk", "true") : aged);
    if (delErr) console.error(`[data-sync] Eviction delete error: ${delErr.message}`);
  };
  if (personalSince && keepSince) {
    await older(keepSince, true);
    await older(personalSince);
  } else await older(keepSince);
}

// ============================================================================
// GMAIL SYNC
// ============================================================================

// A Gmail message (format=full) as the cache keeps it. Shared with the reader
// of older mail (mail-history.js), so every email has the one shape.
function gmailItem(detail, accountEmail, draftIdByMessage = {}) {
  const headers = detail.payload?.headers || [];
  // The whole body: the word search reads every word of it.
  const body = extractGmailBodyFull(detail.payload);
  return emailRecord({
    id: detail.id,
    threadId: detail.threadId,
    from: getGmailHeader(headers, "From"),
    to: getGmailHeader(headers, "To"),
    subject: getGmailHeader(headers, "Subject"),
    date: getGmailHeader(headers, "Date"),
    messageId_header: getGmailHeader(headers, "Message-ID"),
    snippet: detail.snippet,
    body,
    labels: detail.labelIds,
    is_draft: (detail.labelIds || []).includes("DRAFT"),
    // The id gmail_draft_update needs. Null for anything that is not a draft.
    draft_id: draftIdByMessage[detail.id] || null,
    account: accountEmail,
    attachments: extractGmailAttachments(detail.payload),
    webLink: gmailWebLink(accountEmail, detail.threadId),
  });
}

async function syncGmail(userId, userStore, serviceKey = "google", sourceTag = "gmail") {
  if (!loadGoogleTokens(userStore, serviceKey)) return;
  // Which mailbox these belong to. Without it a cached draft says nothing about
  // where it lives, so a write defaults to the primary account and lands in the
  // wrong inbox, which is exactly how an edit to a draft on one account created
  // a new draft on another.
  const accountEmail = userStore?.getConnection?.(serviceKey)?.metadata?.email || null;

  try {
    // Get IDs already in cache to avoid re-fetching (paginated: >1000 rows)
    const cachedIds = await fetchCachedIds(userId, sourceTag, "email");

    // Fetch recent inbox AND sent message IDs (both needed for thread context)
    // Drafts matter as much as received mail: an unsent reply is the clearest
    // signal the user owes someone an answer, and without it "what is
    // outstanding" silently misses the thing they are most likely chasing.
    const [inboxData, sentData, draftData] = await Promise.all([
      withTimeout(googleApiRequest("GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=500&labelIds=INBOX", null, userStore, serviceKey), 20000, "Gmail inbox"),
      withTimeout(googleApiRequest("GET", "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=300&labelIds=SENT", null, userStore, serviceKey), 20000, "Gmail sent"),
      // drafts.list, not messages?labelIds=DRAFT. A draft has TWO ids: the
      // message id, which is what the messages endpoint returns, and the draft
      // id, which is the only one drafts.update accepts. Caching the message id
      // and calling it the draft is why editing a draft 404'd and the agent
      // ended up creating a new draft just to have an id that worked.
      withTimeout(googleApiRequest("GET", "https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=100", null, userStore, serviceKey), 45000, "Gmail drafts")
        .catch((e) => {
          // Say it out loud. A silent catch here would look identical to "this
          // account has no drafts", which is the failure mode that hid the
          // missing reply in the first place.
          console.error(`[data-sync] Gmail(${sourceTag}) drafts fetch failed: ${e.message}`);
          // failed, not empty. Anything that reasons about which drafts exist
          // has to be able to tell those two apart, because treating a timeout
          // as an empty mailbox means concluding every draft was deleted.
          return { drafts: [], failed: true };
        }),
    ]);
    // drafts.list returns { id: <draft id>, message: { id: <message id> } }
    const draftIdByMessage = {};
    for (const d of (draftData.drafts || [])) {
      if (d?.message?.id) draftIdByMessage[d.message.id] = d.id;
    }
    const draftIds = new Set(Object.keys(draftIdByMessage));
    const allIds = [...new Set([
      ...(inboxData.messages || []).map(m => m.id),
      ...(sentData.messages || []).map(m => m.id),
      ...draftIds,
    ])];

    // Before the early return below, which is exactly the path taken when every
    // draft has been deleted and there is nothing new to fetch.
    //
    // Only when this run actually saw the whole draft list. A timed-out fetch
    // returns nothing, and a truncated one returns some, and in both cases the
    // drafts not mentioned are unknown rather than deleted.
    if (!draftData.failed && !draftData.nextPageToken) {
      await reconcileDeletedDrafts(userId, sourceTag, new Set(allIds));
    } else if (draftData.failed) {
      console.log(`[data-sync] Gmail(${sourceTag}): draft list unavailable, skipping draft reconcile`);
    }

    // Same-cycle deletion mirroring for regular mail, window-scoped. Reaching
    // here means the inbox and sent lists both succeeded (their timeouts
    // throw), so absence from the union is meaningful inside the window.
    await reconcileDeletedMail(userId, sourceTag, new Set(allIds), userStore, serviceKey);

    // Only fetch details for messages NOT already in cache. A draft is no
    // exception: saving it again gives it a new message id (tried on a real
    // mailbox, 2026-11-04), so an edited draft reads as new by itself. Fetching
    // every draft each cycle re-read an account's 63 drafts every five
    // minutes and ran its sync past its time limit. A cached draft row from
    // before draft_id was kept is fetched once more to gain it.
    const undrafted = await draftsWithoutDraftId(userId, sourceTag, [...draftIds].filter(id => cachedIds.has(id)));
    const newIds = allIds.filter(id => !cachedIds.has(id) || undrafted.has(id));

    if (newIds.length === 0) {
      // Counts included, because "all cached" on an account that is actually
      // receiving mail means the API is handing back a stale or partial list,
      // and that is invisible when the line only reports a single total.
      console.log(`[data-sync] Gmail(${sourceTag}): ${allIds.length} messages (${(inboxData.messages || []).length} inbox, ${(sentData.messages || []).length} sent, ${draftIds.size} drafts), all cached. No new fetches needed.`);
      return;
    }

    console.log(`[data-sync] Syncing Gmail(${sourceTag}) for ${userId}: ${newIds.length} new of ${allIds.length} total`);

    // Fetch full message details only for NEW messages
    const limit = pLimit(10);
    const results = await Promise.allSettled(
      newIds.map(id => limit(() =>
        withTimeout(
          googleApiRequest("GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, null, userStore, serviceKey),
          10000, "Gmail fetch"
        )
      ))
    );

    const items = [];
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      items.push(gmailItem(result.value, accountEmail, draftIdByMessage));
    }

    await upsertCacheItems(userId, sourceTag, "email", items);
    // Index what was just written, instead of letting the sweep rediscover it
    // by re-reading the whole cache (see the daily gate at the sweep call).
    try {
      const idxNow = new Date().toISOString();
      await require("./usi").indexSyncedCacheRows(userId, "email",
        items.map(i => ({ external_id: String(i.external_id || i.id || ""), source: sourceTag, data: i, synced_at: idxNow })));
    } catch (e) { console.log(`[data-sync] incremental index skipped: ${e.message}`); }
    await evictOldItems(userId, sourceTag, "email", 5000, require("./mail-history").horizon(), new Set(allIds), { personalSince: require("./mail-history").personalHorizon() });
    console.log(`[data-sync] Gmail(${sourceTag}): synced ${items.length} messages for ${userId}`);
  } catch (e) {
    console.error(`[data-sync] Gmail(${sourceTag}) sync error for ${userId}: ${e.message}`);
    await markGoogleScopeFailure(e, userStore, serviceKey);
  }
}

// Which of these cached drafts were saved without their draft id.
async function draftsWithoutDraftId(userId, source, ids) {
  const missing = new Set(ids);
  if (!ids.length) return missing;
  const { data, error } = await supabase.from("data_cache").select("external_id")
    .eq("user_id", userId).eq("source", source).eq("type", "email").in("external_id", ids).not("data->>draft_id", "is", null);
  if (error) return missing;
  for (const r of data || []) missing.delete(r.external_id);
  return missing;
}

/**
 * Remove cached drafts that no longer exist in Gmail.
 *
 * Calendar events have had this since deleted events kept surfacing; drafts
 * never did, so a draft deleted in Gmail stayed in the cache forever. That is
 * not merely untidy: Closedhand reads the cache to find a draft's id, so it
 * would offer to delete, or try to edit, something that had not existed for
 * days.
 *
 * A row is only removed when its message id is absent from everything this run
 * saw live. Vanishing from drafts.list alone is not enough, because that is
 * also what happens when a draft is sent, and a sent mail must be kept.
 */
async function reconcileDeletedDrafts(userId, source, liveMessageIds) {
  try {
    const { data: cached, error } = await supabase
      .from("data_cache")
      .select("external_id")
      .eq("user_id", userId)
      .eq("source", source)
      .eq("type", "email")
      .not("data->>draft_id", "is", null);

    if (error) {
      console.error(`[data-sync] Draft reconcile read failed for ${source}: ${error.message}`);
      return;
    }

    const gone = (cached || []).map(r => r.external_id).filter(id => id && !liveMessageIds.has(id));
    if (gone.length === 0) return;

    for (let i = 0; i < gone.length; i += 100) {
      const chunk = gone.slice(i, i + 100);
      await supabase.from("data_cache").delete()
        .eq("user_id", userId).eq("source", source).eq("type", "email").in("external_id", chunk);
      // The semantic index keeps its own copy, so recall would still return it.
      await supabase.from("data_vectors").delete()
        .eq("user_id", userId).eq("service", "email").in("external_id", chunk);
    }
    console.log(`[data-sync] Gmail(${source}): removed ${gone.length} deleted draft(s) for ${userId}`);
  } catch (e) {
    console.error(`[data-sync] Draft reconcile failed for ${source}: ${e.message}`);
  }
}

// A message that vanishes from inside the listed window is only a CANDIDATE
// for deletion: Gmail archiving removes the INBOX label, so an archived mail
// disappears from the list identically to a deleted one, and users archive
// constantly. Each candidate gets one cheap per-id check. 404 means deleted;
// a TRASH label means the user binned it; both become tombstones. Anything
// else is an archive: left alone and stamped in memory so it is not re-asked
// for a week (a restart just re-checks, which costs one GET).
//
// The tombstone keeps the envelope, sender, subject and date, and drops the
// body, so "the email from Acme Supplies about the invoice" still finds the stub
// by keyword and can answer that it was deleted. The meaning fingerprint is
// deleted outright: a tombstone surfacing in meaning search as if it were
// content would be the opposite of deleted.
const MAIL_RECHECK_MS = 7 * 24 * 3600 * 1000;
const _mailCheckStamps = new Map(); // `${source}:${id}` -> archived-check ms

async function reconcileDeletedMail(userId, sourceTag, liveIds, userStore, serviceKey) {
  try {
    // Window boundary from the listed-and-cached rows: anything cached but
    // older than the oldest listed message merely fell off the 500-message
    // window, and its absence proves nothing. received_at is the parsed
    // timestamp column, so comparisons are real dates, not RFC strings.
    const liveArr = [...liveIds];
    let boundaryMs = null, boundaryIso = null, anchored = 0;
    for (let i = 0; i < liveArr.length; i += 150) {
      const { data: page, error } = await supabase
        .from("data_cache")
        .select("external_id, received_at")
        .eq("user_id", userId).eq("source", sourceTag).eq("type", "email")
        .in("external_id", liveArr.slice(i, i + 150));
      if (error) { console.error(`[data-sync] Mail reconcile boundary read failed: ${error.message}`); return; }
      for (const row of (page || [])) {
        if (!row.received_at) continue;
        anchored++;
        const ms = Date.parse(row.received_at);
        if (!boundaryMs || ms < boundaryMs) { boundaryMs = ms; boundaryIso = row.received_at; }
      }
    }
    // Too few anchored rows means the window's reach is unknown, and deciding
    // deletions against an unknown boundary is how archives get vandalised.
    if (!boundaryIso || anchored < 20) return;

    const { data: recent, error: candErr } = await supabase
      .from("data_cache")
      .select("external_id, received_at, mfrom:data->>from, msubject:data->>subject, mdate:data->>date, tomb:data->>tombstone, isdraft:data->>is_draft, account:data->>account")
      .eq("user_id", userId).eq("source", sourceTag).eq("type", "email")
      .gte("received_at", boundaryIso)
      .limit(2000);
    if (candErr) { console.error(`[data-sync] Mail reconcile read failed: ${candErr.message}`); return; }

    const now = Date.now();
    const candidates = (recent || []).filter(row =>
      !liveIds.has(row.external_id)
      && row.tomb !== "true"
      && row.isdraft !== "true"
      && (now - (_mailCheckStamps.get(`${sourceTag}:${row.external_id}`) || 0)) > MAIL_RECHECK_MS
    ).slice(0, 15); // bound the per-cycle API calls; the rest wait their turn

    for (const row of candidates) {
      let verdict = null; // "deleted" | "archived" | null (inconclusive)
      try {
        const msg = await googleApiRequest("GET",
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(row.external_id)}?format=minimal`,
          null, userStore, serviceKey);
        verdict = (msg.labelIds || []).includes("TRASH") ? "deleted" : "archived";
      } catch (e) {
        if (/Google API 404/.test(e.message)) verdict = "deleted";
        // Anything else, a timeout, a 401, a 5xx, is inconclusive: leave the
        // candidate alone and let a later cycle ask again.
      }
      if (verdict === "archived") { _mailCheckStamps.set(`${sourceTag}:${row.external_id}`, now); continue; }
      if (verdict !== "deleted") continue;

      const { error: tombErr } = await supabase.from("data_cache")
        .update({
          data: {
            tombstone: true,
            deleted_at: new Date().toISOString(),
            from: row.mfrom || null,
            subject: row.msubject || null,
            date: row.mdate || null,
            account: row.account || null,
            text: `Deleted email. From ${row.mfrom || "unknown"}, subject "${row.msubject || ""}", ${row.mdate || ""}. The user deleted it from their mailbox; the content is gone.`,
          },
          synced_at: new Date().toISOString(),
        })
        .eq("user_id", userId).eq("source", sourceTag).eq("type", "email").eq("external_id", row.external_id);
      if (tombErr) { console.error(`[data-sync] Tombstone write failed for ${row.external_id}: ${tombErr.message}`); continue; }
      const { error: vecErr } = await supabase.from("data_vectors").delete()
        .eq("user_id", userId).eq("service", "email").eq("external_id", row.external_id);
      if (vecErr) console.error(`[data-sync] Tombstone vector delete failed for ${row.external_id}: ${vecErr.message}`);
      console.log(`[data-sync] Gmail(${sourceTag}): tombstoned deleted mail ${row.external_id}`);
    }
  } catch (e) {
    console.error(`[data-sync] Mail reconcile failed for ${sourceTag}: ${e.message}`);
  }
}

// ============================================================================
// GOOGLE CALENDAR SYNC
// ============================================================================

async function syncGoogleCalendar(userId, userStore, serviceKey = "google", sourceTag = "gcal") {
  if (!loadGoogleTokens(userStore, serviceKey)) return;
  console.log(`[data-sync] Syncing Google Calendar(${sourceTag}) for ${userId}`);

  try {
    // How far back and ahead: lib/services/sync-depth.js. The far past is
    // read once a day, the year either side of today on every sync.
    const depth = require("./sync-depth");
    for (const w of depth.calendarWindows(`${userId}:${sourceTag}`)) {
      const start = new Date(w.from);
      const end = new Date(w.to);
      const timeMin = encodeURIComponent(start.toISOString());
      const timeMax = encodeURIComponent(end.toISOString());

      // The Google grant is deliberately events-only (see the OAuth scope note in
      // the webapp): it reads and writes events but cannot enumerate calendars, so
      // a calendarList call always 403s. Sync the primary calendar directly, which
      // is addressable without the list, rather than make a doomed call and log
      // its failure every cycle. Beyond-primary calendars are holiday calendars
      // and other noise the product intentionally leaves out.
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&maxResults=2500&singleEvents=true&orderBy=startTime`;
      // Page after page: years of a busy calendar run past one.
      const events = [];
      for (let pageToken = null, first = true; first || pageToken; first = false) {
        const data = await withTimeout(googleApiRequest("GET", url + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""), null, userStore, serviceKey), 15000, "GCal primary");
        events.push(...(data.items || []));
        pageToken = data.nextPageToken || null;
      }
      const items = events
        .filter(e => e.status !== "cancelled")
        .map(e => ({
          external_id: e.id, id: e.id, summary: e.summary,
          start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
          location: e.location || null,
          description: e.description ? eventText(e.description) : null,
          attachments: (e.attachments || []).map(a => ({ name: a.title || "", url: a.fileUrl || "", fileId: a.fileId || "", mimeType: a.mimeType || "" })).filter(a => a.name || a.url),
          attendees: (e.attendees || []).map(a => ({ email: a.email, name: a.displayName || "", status: a.responseStatus || "" })),
          status: e.status, calendar: "primary", uid: e.iCalUID || e.id, date: e.start?.dateTime || e.start?.date,
        }));

      await upsertCacheItems(userId, sourceTag, "event", items);
      // Incremental index; see the Gmail site for the reasoning.
      try {
        const idxNow = new Date().toISOString();
        await require("./usi").indexSyncedCacheRows(userId, "event",
          items.map(i => ({ external_id: String(i.external_id || i.id || ""), source: sourceTag, data: i, synced_at: idxNow })));
      } catch (e) { console.log(`[data-sync] incremental index skipped: ${e.message}`); }
      // The date range scopes what we FETCH, but upsert only adds and updates, so
      // an event deleted in Google would stay cached forever and keep being
      // reported as upcoming. Anything inside the window we just synced that
      // Google did not return has been deleted there, so drop it here too.
      await reconcileDeletedEvents(userId, sourceTag, items, start, end, new Set(["primary"]));
      if (w.far) depth.farRead(`${userId}:${sourceTag}`);
      console.log(`[data-sync] GCal: synced ${items.length} events for ${userId}${w.far ? " (the years before)" : ""}`);
    }
  } catch (e) {
    console.error(`[data-sync] GCal sync error for ${userId}: ${e.message}`);
    await markGoogleScopeFailure(e, userStore, serviceKey);
  }
}

// ============================================================================
// MICROSOFT OUTLOOK SYNC
// ============================================================================

// The fields an Outlook message is read with, and the message as the cache
// keeps it. Shared with the reader of older mail (mail-history.js).
const OUTLOOK_FIELDS = "$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,hasAttachments,internetMessageId,webLink,conversationId,inferenceClassification&$expand=attachments($select=id,name,contentType,size,isInline)";
function outlookItem(msg, label, accountEmail) {
  const draft = label === "DRAFT";
  let body = msg.body?.content || msg.bodyPreview || "";
  if (msg.body?.contentType === "html") body = stripHtml(body);
  return emailRecord({
    id: msg.id,
    threadId: msg.conversationId,
    account: accountEmail,
    from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ""} <${msg.from.emailAddress.address}>` : "",
    to: (msg.toRecipients || []).map(r => r.emailAddress?.address || "").join(", "),
    subject: msg.subject || "",
    date: msg.receivedDateTime || "",
    messageId_header: msg.internetMessageId || "",
    body,
    snippet: (msg.bodyPreview || "").substring(0, 200),
    labels: [label],
    is_draft: draft,
    draft_id: draft ? msg.id : null,
    version: draft ? msg.changeKey || null : null,
    attachments: (msg.attachments || []).map((a) => ({ filename: a.name, mimeType: a.contentType, size: a.size, attachmentId: a.id, inline: a.isInline })),
    webLink: msg.webLink,
    bulk: msg.inferenceClassification === "other",
  });
}

async function syncOutlookMail(userId, userStore, serviceKey = "microsoft", sourceTag = "outlook") {
  if (!isMicrosoftConnected(userStore, serviceKey)) return;

  try {
    // Check what's already cached (paginated: >1000 rows)
    const cachedIds = await fetchCachedIds(userId, sourceTag, "email");

    // Fetch inbox + sent for thread context
    // The attachment list comes in the same request ($expand), without the
    // files themselves, so Outlook mail is kept in the same shape as Gmail's.
    // Drafts too, so Closedhand can find, edit and send them as it does
    // Gmail's.
    const [inboxData, sentData, draftData] = await Promise.all([
      withTimeout(microsoftApiRequest("GET", "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=500&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,hasAttachments,internetMessageId,webLink,conversationId,inferenceClassification&$orderby=receivedDateTime desc&$expand=attachments($select=id,name,contentType,size,isInline)", null, userStore, serviceKey), 20000, "Outlook inbox"),
      withTimeout(microsoftApiRequest("GET", "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$top=300&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,hasAttachments,internetMessageId,webLink,conversationId,inferenceClassification&$orderby=receivedDateTime desc&$expand=attachments($select=id,name,contentType,size,isInline)", null, userStore, serviceKey), 20000, "Outlook sent"),
      withTimeout(microsoftApiRequest("GET", "https://graph.microsoft.com/v1.0/me/mailFolders/drafts/messages?$top=100&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,hasAttachments,internetMessageId,webLink,conversationId,inferenceClassification,changeKey&$orderby=receivedDateTime desc&$expand=attachments($select=id,name,contentType,size,isInline)", null, userStore, serviceKey), 20000, "Outlook drafts")
        // Failed, not empty: a timeout must not read as every draft deleted.
        .catch((e) => { console.error(`[data-sync] Outlook(${sourceTag}) drafts fetch failed: ${e.message}`); return { value: [], failed: true }; }),
    ]);
    const accountEmail = userStore?.getConnection?.(serviceKey)?.metadata?.email || null;
    const fromFolder = (list, label) => (list?.value || []).map((msg) => ({ msg, label }));
    const items = [...fromFolder(inboxData, "INBOX"), ...fromFolder(sentData, "SENT"), ...fromFolder(draftData, "DRAFT")].map(({ msg, label }) => outlookItem(msg, label, accountEmail));
    // A draft sent or deleted since leaves the copy; one edited is rewritten
    // below, since drafts change and the rest of the mail does not.
    if (!draftData.failed && !draftData["@odata.nextLink"]) await reconcileDeletedDrafts(userId, sourceTag, new Set((draftData.value || []).map((m) => m.id)));
    const draftIds = new Set((draftData.value || []).map((m) => m.id));

    // Mail cached in an older shape is rewritten from this same list, with no
    // extra calls; everything else only when it's new.
    const stale = await staleShape(userId, sourceTag, items.map(i => i.external_id).filter(id => cachedIds.has(id)));
    const newItems = items.filter(i => !cachedIds.has(i.external_id) || stale.has(i.external_id) || draftIds.has(i.external_id));
    if (newItems.length === 0) {
      console.log(`[data-sync] Outlook: ${items.length} messages, all cached.`);
      return;
    }
    await upsertCacheItems(userId, sourceTag, "email", newItems);
    // Incremental index; see the Gmail site for the reasoning.
    try {
      const idxNow = new Date().toISOString();
      await require("./usi").indexSyncedCacheRows(userId, "email",
        newItems.map(i => ({ external_id: String(i.external_id || i.id || ""), source: sourceTag, data: i, synced_at: idxNow })));
    } catch (e) { console.log(`[data-sync] incremental index skipped: ${e.message}`); }
    await evictOldItems(userId, sourceTag, "email", 5000, require("./mail-history").horizon(), new Set(items.map(i => String(i.external_id))), { personalSince: require("./mail-history").personalHorizon() });
    console.log(`[data-sync] Outlook: ${newItems.length} new of ${items.length} total for ${userId}`);
  } catch (e) {
    console.error(`[data-sync] Outlook mail sync error for ${userId}: ${e.message}`);
  }
}

// ============================================================================
// MICROSOFT OUTLOOK CALENDAR SYNC
// ============================================================================

async function syncOutlookCalendar(userId, userStore, serviceKey = "microsoft", sourceTag = "mscal") {
  if (!isMicrosoftConnected(userStore, serviceKey)) return;
  console.log(`[data-sync] Syncing Outlook Calendar(${sourceTag}) for ${userId}`);

  try {
    // How far back and ahead: lib/services/sync-depth.js. The far past is
    // read once a day, the year either side of today on every sync.
    const depth = require("./sync-depth");
    for (const w of depth.calendarWindows(`${userId}:${sourceTag}`)) {
      const start = new Date(w.from).toISOString();
      const end = new Date(w.to).toISOString();
      // Page after page: years of a busy calendar run past one.
      const events = [];
      for (let url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=1000&$select=id,subject,start,end,location,attendees,body,hasAttachments,iCalUId&$expand=attachments($select=id,name,contentType,size,isInline)`; url;) {
        const data = await withTimeout(microsoftApiRequest("GET", url, null, userStore, serviceKey), 15000, "Outlook Calendar");
        events.push(...(data.value || []));
        url = data["@odata.nextLink"] || null;
      }

      const items = events.map(e => ({
        external_id: e.id,
        id: e.id,
        summary: e.subject || "",
        start: e.start?.dateTime ? e.start.dateTime + (e.start.timeZone === "UTC" ? "Z" : "") : "",
        end: e.end?.dateTime ? e.end.dateTime + (e.end.timeZone === "UTC" ? "Z" : "") : "",
        location: e.location?.displayName || null,
        description: e.body?.content ? (e.body.contentType === "html" ? stripHtml(e.body.content) : e.body.content) : null,
        attachments: (e.attachments || []).map((a) => ({ filename: a.name, mimeType: a.contentType, size: a.size, attachmentId: a.id, inline: a.isInline })),
        attendees: (e.attendees || []).map(a => a.emailAddress?.address || ""),
        status: e.responseStatus?.response || "",
        calendar: "Outlook",
        uid: e.iCalUId || e.id,
        date: e.start?.dateTime || "",
      }));

      await upsertCacheItems(userId, "outlook_cal", "event", items);
      // Incremental index; see the Gmail site for the reasoning.
      try {
        const idxNow = new Date().toISOString();
        await require("./usi").indexSyncedCacheRows(userId, "event",
          items.map(i => ({ external_id: String(i.external_id || i.id || ""), source: "outlook_cal", data: i, synced_at: idxNow })));
      } catch (e) { console.log(`[data-sync] incremental index skipped: ${e.message}`); }
      // No eviction cap for calendar events
      if (w.far) depth.farRead(`${userId}:${sourceTag}`);
      console.log(`[data-sync] Outlook Calendar: synced ${items.length} events for ${userId}${w.far ? " (the years before)" : ""}`);
    }
  } catch (e) {
    console.error(`[data-sync] Outlook Calendar sync error for ${userId}: ${e.message}`);
  }
}

// ============================================================================
// BRIDGE CALENDAR SYNC
// ============================================================================

async function syncBridgeCalendar(userId) {
  const { data: bridge } = await supabase.from("user_bridges").select("status").eq("user_id", userId).single();
  if (!bridge || bridge.status !== "connected") return;
  console.log(`[data-sync] Syncing Bridge calendar for ${userId}`);
  // How far back and ahead, as every calendar (lib/services/sync-depth.js): the
  // year either side of today on every sync, the years before once a day. The
  // Mac answers at most four years at a time (EventKit shortens a longer span
  // to its first four), which each stretch is within.
  const depth = require("./sync-depth");
  for (const w of depth.calendarWindows(`${userId}:mac_calendar`)) {
    const day = 86400000, now = Date.now();
    const ok = await syncBridgeWindow(userId, Math.round((now - w.from) / day), Math.round((w.to - now) / day), w.from, w.to);
    if (ok && w.far) depth.farRead(`${userId}:mac_calendar`);
  }
}

// One stretch of the Mac's calendar, put in place of what the cache had for it.
async function syncBridgeWindow(userId, daysBack, daysAhead, from, to) {
  try {
    // Bridge reads the calendar store itself (lib/services/mac-calendar.js).
    let events = null;
    for (let attempt = 0; attempt < 2 && !events; attempt++) {
      try {
        events = await require("./mac-calendar").readMacCalendar(userId, { daysBack, daysAhead, timeoutMs: 45000 });
      } catch (e) {
        console.log(`[data-sync] Bridge calendar attempt ${attempt + 1} failed: ${e.message}`);
        if (attempt === 0) await new Promise(r => setTimeout(r, 3000)); // brief pause before retry
      }
    }
    if (!events) return false;

    const items = events.map((e) => ({
      external_id: e.id,
      id: e.id,
      uid: e.id,
      summary: e.summary,
      start: e.start,
      end: e.end,
      all_day: e.all_day,
      location: e.location,
      description: e.description,
      attendees: e.attendees.map((name) => ({ name, email: "", status: "" })),
      calendar: e.calendar,
      date: e.start,
    }));

    // Flag duplicate-titled events at different times (likely rescheduled, one may be stale)
    const titleCounts = {};
    for (const item of items) { if (item.summary) titleCounts[item.summary] = (titleCounts[item.summary] || 0) + 1; }
    for (const item of items) {
      if (titleCounts[item.summary] > 1) {
        item.possible_duplicate = true;
      }
    }
    const dedupedItems = items;

    // This stretch's events, cleared then inserted fresh
    const { error: delErr } = await supabase.from("data_cache").delete().eq("user_id", userId).eq("source", "mac_calendar").eq("type", "event")
      .gte("received_at", new Date(from).toISOString()).lt("received_at", new Date(to).toISOString());
    if (delErr) console.log(`[data-sync] Bridge cal delete error: ${delErr.message}`);

    // Insert one at a time to handle any constraint issues gracefully
    let inserted = 0;
    for (const item of dedupedItems) {
      const row = {
        user_id: userId, source: "mac_calendar", type: "event",
        external_id: item.external_id,
        data: item,
        synced_at: new Date().toISOString(),
        received_at: (() => {
          const raw = item.date || item.start || "";
          let d = new Date(raw);
          if (isNaN(d.getTime()) && raw) {
            d = new Date(String(raw).replace(/^\w+,\s*/, "").replace(" at ", " "));
          }
          return isNaN(d.getTime()) ? null : d.toISOString();
        })(),
      };
      const { error } = await supabase.from("data_cache").insert(row);
      if (error) { console.log(`[data-sync] Bridge cal insert failed for "${(item.summary || "").substring(0, 40)}": ${error.message}`); }
      else { inserted++; }
    }
    // No eviction cap for calendar events
    console.log(`[data-sync] Bridge calendar: ${inserted}/${dedupedItems.length} events stored for ${userId}`);
    return true;
  } catch (e) {
    console.error(`[data-sync] Bridge calendar sync error for ${userId}: ${e.message}`);
    return false;
  }
}

// ============================================================================
// PER-USER ORCHESTRATOR
// ============================================================================

// Counted as busy (lib/idle.js) while it runs.
async function syncUserData(userId, mode) {
  return require("../idle").during(() => syncUserDataNow(userId, mode));
}
async function syncUserDataNow(userId, mode) {
  console.log(`[data-sync] Syncing user ${userId}, mode=${mode}`);
  const startedAt = Date.now();

  let store;
  try {
    store = await UserStore.load(userId);
    if (!store) {
      console.log(`[data-sync] No store for user ${userId}`);
      return;
    }
    // NOTE: No swapToCloudStore here. The store is passed explicitly to all
    // sync functions so multiple users can sync in parallel without racing
    // on the shared ctx.activeUserStore singleton.
  } catch (e) {
    console.error(`[data-sync] Failed to load context for ${userId}: ${e.message}`);
    return;
  }

  try {
    if (mode === "cloud" || mode === "all") {
      await withTimeout(syncGmail(userId, store), 60000, "Gmail").catch(e => console.error(`[data-sync] Gmail failed for ${userId}: ${e.message}`));
      // Older cached Gmail records are brought to the shape every mailbox shares.
      const gmailLink = (d) => ({ webLink: d.webLink || gmailWebLink(d.account, d.threadId) });
      await upgradeCachedEmails(userId, "gmail", gmailLink).catch(e => console.error(`[data-sync] Gmail shape upgrade failed: ${e.message}`));
      await withTimeout(syncGoogleCalendar(userId, store), 120000, "GCal").catch(e => console.error(`[data-sync] GCal failed for ${userId}: ${e.message}`));
      // Extra Google accounts: same syncs, per-account source tags (gmail_<slug>/gcal_<slug>)
      for (const acct of listGoogleAccounts(store).filter(a => !a.primary)) {
        await withTimeout(syncGmail(userId, store, acct.serviceKey, "gmail_" + acct.slug), 60000, "Gmail extra").catch(e => console.error(`[data-sync] Gmail(${acct.slug}) failed for ${userId}: ${e.message}`));
        await upgradeCachedEmails(userId, "gmail_" + acct.slug, gmailLink).catch(e => console.error(`[data-sync] Gmail(${acct.slug}) shape upgrade failed: ${e.message}`));
        await withTimeout(syncGoogleCalendar(userId, store, acct.serviceKey, "gcal_" + acct.slug), 120000, "GCal extra").catch(e => console.error(`[data-sync] GCal(${acct.slug}) failed for ${userId}: ${e.message}`));
      }
      await withTimeout(syncOutlookMail(userId, store), 20000, "Outlook").catch(e => console.error(`[data-sync] Outlook mail failed for ${userId}: ${e.message}`));
      await withTimeout(syncOutlookCalendar(userId, store), 120000, "Outlook cal").catch(e => console.error(`[data-sync] Outlook cal failed for ${userId}: ${e.message}`));
      // Extra Microsoft accounts: same syncs, per-account tags (outlook_<slug>/mscal_<slug>)
      for (const acct of listMicrosoftAccounts(store).filter(a => !a.primary)) {
        await withTimeout(syncOutlookMail(userId, store, acct.serviceKey, "outlook_" + acct.slug), 20000, "Outlook extra").catch(e => console.error(`[data-sync] Outlook(${acct.slug}) failed for ${userId}: ${e.message}`));
        await withTimeout(syncOutlookCalendar(userId, store, acct.serviceKey, "mscal_" + acct.slug), 120000, "Outlook cal extra").catch(e => console.error(`[data-sync] MsCal(${acct.slug}) failed for ${userId}: ${e.message}`));
      }
      // The last year of each mailbox, read in the background (mail-history.js).
      require("./mail-history").kick(userId, store);
      // Zero-project tiers: IMAP mail and secret-ICS calendar land in the same
      // cache and index as the API syncs above.
      await withTimeout(require("./imap-mail").syncImapMail(userId, store), 150000, "IMAP").catch(e => console.error(`[data-sync] IMAP failed for ${userId}: ${e.message}`));
      await upgradeCachedEmails(userId, "imap").catch(e => console.error(`[data-sync] IMAP shape upgrade failed: ${e.message}`));
      await withTimeout(require("./ics-calendar").syncIcsCalendar(userId, store), 20000, "ICS cal").catch(e => console.error(`[data-sync] ICS failed for ${userId}: ${e.message}`));
      // CalDAV rides the mailbox's app password, so a user who connected mail
      // has a read-write calendar without connecting anything else.
      await withTimeout(require("./caldav").syncCalDAVCalendar(userId, store), 30000, "CalDAV").catch(e => console.error(`[data-sync] CalDAV failed for ${userId}: ${e.message}`));
      // Banks, read-only. Each connection keeps its own timetable (a few runs
      // a day), so most cycles this only checks the clock.
      await withTimeout(require("./bank-sync").syncBanks(userId, store), 120000, "Bank").catch(e => console.error(`[data-sync] Bank failed for ${userId}: ${e.message}`));
    }
    if (mode === "bridge" || mode === "all") {
      // Calendar only: iCloud calendars have no cloud API route. Apple Mail sync was
      // removed 2026-07 (AppleScript-fragile, cloud mail already covered by Gmail/Outlook APIs).
      await withTimeout(syncBridgeCalendar(userId), 45000, "Bridge cal").catch(e => console.error(`[data-sync] Bridge cal failed for ${userId}: ${e.message}`));
    }
    // The bot owns background readers and discovers connections in the shared
    // database, including ones saved by the separately deployed webapp.
    if (mode === "cloud" || mode === "all") {
      try {
        await require("./usi-connector").syncConnectedServices(userId);
      } catch (e) {
        console.error(`[Recall sync] ${userId}: ${e.message}`);
      }
    }
    console.log(`[data-sync] Finished user ${userId}`);
    // The full-corpus sweep used to run after EVERY sync cycle, and its cost
    // grew with the corpus: ~27 cache pages plus the complete vector hash set
    // fetched once per page, every five minutes. Measured at roughly 10GB a
    // day of egress on an 8k-email account, which is the September 2026 quota
    // breach. New rows are indexed incrementally at the moment each sync
    // writes them (see the upsert sites), so the sweep is now a daily safety
    // net for backlog, retries and bridge-import dedupe. First sync after
    // boot still sweeps, so downtime is caught up immediately.
    try {
      const last = _lastFullSweep.get(userId) || 0;
      if (Date.now() - last > 24 * 3600 * 1000) {
        _lastFullSweep.set(userId, Date.now());
        await require("./usi").runPostSyncIndex(userId);
      }
    } catch (e) {
      console.error(`[USI] Hook error for ${userId}: ${e.message}`);
    }

    // A confirmation that just arrived is read now, not on the next timer.
    try {
      await require("../mail-noticing").noticeNewMail(userId, startedAt - 30000);
    } catch (e) {
      console.error(`[noticing] ${userId}: ${e.message}`);
    }
  } catch (e) {
    console.error(`[data-sync] User ${userId} sync error: ${e.message}`);
  } finally {
    try { if (store) store.save().catch(() => {}); } catch (_) {}
  }
}

// ============================================================================
// ALL-USERS SYNC
// ============================================================================

const _lastFullSweep = new Map();

async function syncAllUsers(mode) {
  console.log(`[data-sync] Starting ${mode} sync for all users`);

  try {
    // A mail account is not a prerequisite for recall. Include people with
    // only another service or a custom MCP, and page past the DB's row limit.
    const connectedUsers = new Set();
    for (const table of ["connections", "user_mcps"]) {
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabase.from(table).select("id, user_id")
          .order("id").range(offset, offset + 499);
        if (error) throw new Error(`Could not list ${table}: ${error.message}`);
        for (const row of data || []) connectedUsers.add(row.user_id);
        if (!data || data.length < 500) break;
      }
    }
    const userIds = [...connectedUsers];

    // Also include users with bridge connected (check profiles)
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, settings")
      .not("settings", "is", null);

    for (const profile of (profiles || [])) {
      if (profile.settings?.bridge_connected && !userIds.includes(profile.id)) {
        userIds.push(profile.id);
      }
    }

    console.log(`[data-sync] Found ${userIds.length} users to sync (mode=${mode})`);

    // Parallel sync is safe: each user's store is loaded independently and passed
    // through the call chain. No shared ctx.activeUserStore in this path.
    // Concurrency tunable without a deploy; capped to avoid thundering-herd
    // 429s and memory spikes (each user fans out ~10 fetches + 10 enrichments).
    const limit = pLimit(parseInt(process.env.SYNC_USER_CONCURRENCY || "10", 10));
    await Promise.allSettled(
      userIds.map(userId => limit(() =>
        Promise.race([
          syncUserData(userId, mode),
          new Promise((_, rej) => setTimeout(() => rej(new Error("User sync timeout (5min)")), 300000)),
        ]).catch(e => console.error(`[data-sync] Failed to sync user ${userId}: ${e.message}`))
      ))
    );

    console.log(`[data-sync] ${mode} sync complete for ${userIds.length} users`);
  } catch (e) {
    console.error(`[data-sync] syncAllUsers error: ${e.message}`);
  }
}

// ============================================================================
// CACHE QUERY HELPERS (used by data-access.js)
// ============================================================================

// Whether the synced mail holds every email back to `since` in every
// mailbox: each one's complete stretch (mail_coverage, kept by
// mail-history.js) starts no later, and within the year that is kept. The
// oldest email cached says nothing: one sent in 2020 made the copy "cover"
// six years it held three weeks of, and search answered "no match" for mail
// the mailbox had.
async function cacheCovers(userId, since) {
  const t = new Date(since).getTime();
  if (t < Date.parse(require("./mail-history").horizon())) return false;
  const { data: conns } = await supabase.from("connections").select("service").eq("user_id", userId);
  const sources = (conns || []).map((c) => c.service === "google" ? "gmail" : c.service === "microsoft" ? "outlook"
    : c.service.startsWith("google_extra_") ? "gmail_" + c.service.slice("google_extra_".length)
    : c.service.startsWith("microsoft_extra_") ? "outlook_" + c.service.slice("microsoft_extra_".length)
    : c.service === "imap" ? "imap" : null).filter(Boolean);
  if (!sources.length) return false;
  const { data, error } = await supabase.from("mail_coverage").select("source, complete_since").eq("user_id", userId);
  if (error) return false;
  const since_ = new Map((data || []).map((r) => [r.source, r.complete_since]));
  return sources.every((s) => since_.get(s) && Date.parse(since_.get(s)) <= t);
}

async function queryCacheEmails(userId, query, days = 7) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Fetch ALL cached emails (don't filter by received_at since Bridge emails have null dates)
    // Filter by date in JS instead, treating null dates as recent
    const { data, error } = await supabase
      .from("data_cache")
      .select("*")
      .eq("user_id", userId)
      .eq("type", "email")
      .order("synced_at", { ascending: false })
      .limit(500);

    if (error) {
      console.error(`[data-sync] Cache email query error: ${error.message}`);
      return null;
    }

    if (!data || data.length === 0) return null;

    // Check freshness
    const newestSync = data.reduce((max, r) => {
      const t = new Date(r.synced_at).getTime();
      return t > max ? t : max;
    }, 0);
    const cacheAgeMs = Date.now() - newestSync;
    const cacheAgeMin = Math.round(cacheAgeMs / 60000);

    // Filter by keyword if query is specific (names, subjects, companies)
    // Broad/semantic queries ("outstanding tasks", "anything important", "what should I do") should be treated as generic
    const broadPatterns = /^(urgent|task|action|required|pending|outstanding|important|todo|to.do|follow.up|what.*do|anything.*aware|should.*know|coming.*up|this.*week|need.*to|items|things)/i;
    const isGeneric = !query || query === "*" || /^(all|recent|latest|new|unread|today|inbox|email|emails)$/i.test(query.trim()) || broadPatterns.test(query.trim());

    let results = data.map(r => ({ ...r.data, source: r.source }));

    // A specific query goes through the same retriever passive recall uses,
    // rather than a private one. Three things were wrong with having its own:
    // it searched only the 500 rows loaded above, out of 8,000 cached; it ran
    // the vector arm alone, so an invoice number was matched by meaning and
    // never by the number; and it carried a third stop-word list that had
    // drifted from the one the lexical index is built with, so the tool and
    // passive recall disagreed about what a query even contained.
    //
    // usi.search fuses the vector and lexical arms by RRF over the whole
    // cache. It returns summaries, so the ids are rehydrated to full rows
    // here: writes downstream need account, thread_id and attachments, which
    // a summary does not carry.
    if (!isGeneric) {
      try {
        const { search } = require("./usi");
        const found = await search(userId, query, { cacheType: "email", service: "email", maxResults: 30 });
        const ids = [...new Set((found.results || []).map(r => r.id).filter(Boolean))];
        if (ids.length > 0) {
          const { data: rows, error: rehydrateErr } = await supabase
            .from("data_cache")
            .select("external_id, source, data")
            .eq("user_id", userId)
            .eq("type", "email")
            .in("external_id", ids);
          if (rehydrateErr) {
            console.error(`[data-sync] Email rehydrate failed: ${rehydrateErr.message}`);
          } else {
            // Ranked order comes from the fusion, not from the database.
            const byId = new Map((rows || []).map(row => [row.external_id, row]));
            const ordered = ids.map(id => byId.get(id)).filter(Boolean)
              .map(row => ({ ...row.data, source: row.source }));
            if (ordered.length > 0) {
              console.log(`[data-sync] Hybrid email search: ${ordered.length} of ${ids.length} matches for ${peek(query)}`);
              // Specific matches stay valid far longer than the 30-min
              // "anything new?" freshness window: old email does not go stale.
              return { results: ordered, cacheAgeMin, fresh: cacheAgeMin < 1440, covers: await cacheCovers(userId, since), source: "data_cache_hybrid" };
            }
          }
        }
        // Specific query, nothing matched. Inside the stretch of time the
        // synced copy holds, that is the answer: the copy is the mailbox. Only
        // a search reaching further back than the copy may need the provider,
        // so the caller is told whether the copy covers the period asked.
        return { results: [], cacheAgeMin, fresh: cacheAgeMin < 1440, covers: await cacheCovers(userId, since), source: "data_cache_hybrid" };
      } catch (e) {
        console.error(`[data-sync] Hybrid email search failed, falling back to recent: ${e.message}`);
      }
    }

    // Only generic queries reach here ("recent", "anything new?"), and those
    // want the newest mail rather than a ranked match, so there is nothing
    // left to filter. The substring matcher that used to live here, with the
    // third stop-word list, is what the hybrid path above replaces.
    return {
      results,
      cacheAgeMin,
      fresh: cacheAgeMin < 30,
      covers: true,
      source: "data_cache",
    };
  } catch (e) {
    console.error(`[data-sync] queryCacheEmails error: ${e.message}`);
    return null;
  }
}

const CALENDAR_COPY_FRESH_MS = 60 * 1000;

async function queryCacheCalendar(userId, start, end) {
  try {
    const startISO = new Date(start).toISOString();
    const endISO = new Date(end).toISOString();

    // Calendar events: received_at holds each event's start. Those starting
    // by the end of these dates, newest first, so the cap never cuts the ones
    // asked about: read oldest first, a calendar past 1,000 saved events lost
    // its newest. An event with no start kept (an Outlook all-day one) is read
    // too, and the dates below decide.
    const { data, error } = await supabase
      .from("data_cache")
      .select("*")
      .eq("user_id", userId)
      .eq("type", "event")
      .or(`received_at.lte.${endISO},received_at.is.null`)
      .order("received_at", { ascending: false, nullsFirst: true })
      .limit(1000);

    if (error) {
      console.error(`[data-sync] Cache calendar query error: ${error.message}`);
      return null;
    }

    if (!data || data.length === 0) return null;
    data.reverse(); // oldest first, as the answer lists them

    // Check freshness
    const newestSync = data.reduce((max, r) => {
      const t = new Date(r.synced_at).getTime();
      return t > max ? t : max;
    }, 0);
    const cacheAgeMs = Date.now() - newestSync;
    const cacheAgeMin = Math.round(cacheAgeMs / 60000);

    // Filter events by date range in JS
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();

    const macEvents = data.filter(r => r.source === "mac_calendar");
    const gcalEvents = data.filter(r => r.source === "gcal");
    console.log(`[data-sync] queryCacheCalendar: ${data.length} total (${gcalEvents.length} gcal, ${macEvents.length} mac_calendar), range ${start} to ${end}`);
    for (const r of macEvents) {
      const d = r.data || {};
      console.log(`[data-sync]   mac_cal: "${d.summary}" | start="${d.start}" | date="${d.date}" | received_at=${r.received_at}`);
    }
    // Google's all-day events by their last day (calendar-dates.js); the copy
    // keeps Google's own form, so the overlap below still reads its end.
    const { shownTimes } = require("../calendar-dates");
    const results = data
      .map(r => ({ ...r.data, _cache_source: r.source }))
      .filter(evt => {
        const raw = evt.start || evt.date || "";
        let d = new Date(raw);
        if (isNaN(d.getTime()) && raw) {
          const cleaned = String(raw).replace(/^\w+,\s*/, "").replace(" at ", " ");
          d = new Date(cleaned);
        }
        const evtStart = d.getTime();
        if (isNaN(evtStart)) { console.log(`[data-sync] Event date parse failed: "${raw}" -> "${evt.summary}"`); return false; }
        // A stay or trip that began before these dates and is still going on
        // is part of them too: overlapping counts, not only starting inside.
        const evtEnd = evt.end ? new Date(evt.end).getTime() : NaN;
        if (evtStart > endMs || (isNaN(evtEnd) ? evtStart : evtEnd) < startMs) return false;
        // Mark canceled events (Google uses "cancelled", Apple uses title prefix)
        const status = (evt.status || "").toLowerCase();
        const title = (evt.summary || "").toLowerCase();
        if (status === "cancelled" || title.startsWith("canceled:") || title.startsWith("cancelled:")) {
          evt.canceled = true;
        }
        return true;
      })
      .map(evt => evt._cache_source === "mac_calendar" ? evt : shownTimes(evt));

    return {
      events: results,
      cacheAgeMin,
      // A calendar changes under Closedhand's feet: the person deletes or
      // moves an event in Google Calendar, or a guest does. The copy was
      // trusted for 30 minutes while syncs run every 5, so a deleted event
      // stayed "already on your calendar" and Closedhand refused to add it
      // again. Answer from the copy only just after a sync; otherwise the
      // caller asks Google, which is one quick call.
      fresh: cacheAgeMs < CALENDAR_COPY_FRESH_MS,
      source: "data_cache",
    };
  } catch (e) {
    console.error(`[data-sync] queryCacheCalendar error: ${e.message}`);
    return null;
  }
}

// ============================================================================
// STARTUP
// ============================================================================

let cloudTimer = null;
let bridgeTimer = null;
let connectionTimer = null;

// A connection the dashboard saves (a Google or Microsoft sign-in in setup, a
// service added later) used to wait for the next five-minute cycle, so a new
// person's mail and calendar stayed unknown for minutes after setup and a
// reconnected account kept answering from before. The dashboard cannot call
// the bot directly, so the bot looks for new connection rows every few
// seconds and syncs their owner straight away. The first look only learns
// what exists: the sync after boot covers those.
function createConnectionWatch({ listConnections, syncUser, log = () => {} }) {
  const seen = new Set();
  const syncing = new Set();
  let primed = false;
  return async function check() {
    let rows;
    try { rows = await listConnections(); } catch (e) { log(`[data-sync] Could not check for new connections: ${e.message}`); return []; }
    const owners = new Set();
    for (const row of rows || []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (primed) owners.add(row.user_id);
    }
    primed = true;
    const started = [];
    for (const userId of owners) {
      if (syncing.has(userId)) continue;
      syncing.add(userId);
      log(`[data-sync] New connection for ${userId}: syncing now`);
      started.push(Promise.resolve().then(() => syncUser(userId)).catch(e => log(`[data-sync] New connection sync failed for ${userId}: ${e.message}`)).finally(() => syncing.delete(userId)));
    }
    await Promise.all(started);
    return [...owners];
  };
}

async function listConnectionRows() {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from("connections").select("id, user_id").order("id").range(offset, offset + 499);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  return rows;
}

function startDataSync() {
  console.log("[data-sync] Starting data sync service");

  // Initial sync 30s after boot
  setTimeout(() => {
    syncAllUsers("all").catch(e => console.error(`[data-sync] Initial sync error: ${e.message}`));
  }, 30000);

  // Cloud sync every 5 minutes
  cloudTimer = setInterval(() => {
    syncAllUsers("cloud").catch(e => console.error(`[data-sync] Cloud sync error: ${e.message}`));
  }, 5 * 60 * 1000);

  // Bridge calendar sync every 15 minutes (no-op unless a bridge is connected)
  bridgeTimer = setInterval(() => {
    syncAllUsers("bridge").catch(e => console.error(`[data-sync] Bridge sync error: ${e.message}`));
  }, 15 * 60 * 1000);

  // New connections, synced within seconds instead of at the next cycle.
  const checkConnections = createConnectionWatch({
    listConnections: listConnectionRows,
    syncUser: (userId) => syncUserData(userId, "all"),
    log: (line) => console.log(line),
  });
  checkConnections();
  connectionTimer = setInterval(() => { checkConnections(); }, 15 * 1000);
}

function stopDataSync() {
  if (cloudTimer) { clearInterval(cloudTimer); cloudTimer = null; }
  if (bridgeTimer) { clearInterval(bridgeTimer); bridgeTimer = null; }
  if (connectionTimer) { clearInterval(connectionTimer); connectionTimer = null; }
  console.log("[data-sync] Stopped data sync service");
}

/**
 * Universal cache search across ALL data types and sources in data_cache.
 * For email type, delegates to queryCacheEmails (which has semantic search + keyword fallback).
 * For other types, does keyword search across the data jsonb field.
 */
async function queryCacheUniversal(userId, { query, type, source, days = 30, max_results = 50 }) {
  // Email queries get the full queryCacheEmails pipeline (semantic + keyword + distillation)
  if (type === "email" || (!type && !source)) {
    const emailResults = await queryCacheEmails(userId, query, days);
    if (emailResults && emailResults.results && emailResults.results.length > 0) {
      // If no type filter, also search non-email types and merge
      if (!type) {
        const otherResults = await _searchCacheGeneric(userId, query, source, days, max_results, "email");
        if (otherResults.length > 0) {
          emailResults.results = [...emailResults.results, ...otherResults].slice(0, max_results);
          emailResults.mixed = true;
        }
      }
      return emailResults;
    }
    if (type === "email") return emailResults; // Explicitly asked for email, return even if empty
  }

  // Non-email type search
  const results = await _searchCacheGeneric(userId, query, source, days, max_results, null, type);
  if (results.length === 0) return null;

  const newestSync = results.reduce((max, r) => Math.max(max, new Date(r._synced_at || 0).getTime()), 0);
  const cacheAgeMin = Math.round((Date.now() - newestSync) / 60000);

  const sourceCounts = {};
  const typeCounts = {};
  for (const r of results) {
    sourceCounts[r._source || "unknown"] = (sourceCounts[r._source || "unknown"] || 0) + 1;
    typeCounts[r._type || "item"] = (typeCounts[r._type || "item"] || 0) + 1;
  }

  return {
    results,
    cacheAgeMin,
    fresh: cacheAgeMin < 30,
    source: "data_cache",
    source_counts: sourceCounts,
    type_counts: typeCounts,
  };
}

// Everything synced except mail, for a search that names no source.
function searchOtherSources(userId, query, maxResults = 20) {
  return _searchCacheGeneric(userId, query, null, null, maxResults, "email");
}

// One chat read as a conversation: its messages in order, oldest first. A
// search finds only the lines that share a word with the question, so asked
// to "see my chat with dad" about an estate agent, a task never saw the
// agent's address he had sent on its own line. The chat is named as search
// results name it (chat_name), or by the id of any message in it. With
// words, the lines that hold them; with none matching, or '*', the newest.
const CHAT_FIELDS = ["id", "date", "sender", "text", "files"];
async function queryChat(userId, { chat, query, days = 30, max_results = 50 }) {
  const name = String(chat || "").trim();
  let jid = name.includes("@") ? name : null, chatName = null;
  if (!jid && /^wa-/.test(name)) {
    const { data } = await supabase.from("data_cache").select("data").eq("user_id", userId).eq("external_id", name).limit(1);
    jid = data?.[0]?.data?.chat || null; chatName = data?.[0]?.data?.chat_name || null;
  }
  for (const pattern of jid ? [] : [name, `%${name}%`]) {
    const { data } = await supabase.from("data_cache").select("data").eq("user_id", userId).eq("type", "message")
      .ilike("data->>chat_name", pattern).order("received_at", { ascending: false }).limit(1);
    if (data?.[0]?.data?.chat) { jid = data[0].data.chat; chatName = data[0].data.chat_name || name; break; }
  }
  if (!jid) {
    // Named by who it is ("dad"), not what it is called: the chats to choose from.
    const { data } = await supabase.from("data_cache").select("data").eq("user_id", userId).eq("type", "message")
      .order("received_at", { ascending: false }).limit(500);
    const names = [...new Set((data || []).map((r) => r.data?.chat_name).filter(Boolean))].slice(0, 15);
    return { results: [], message: `No chat called "${name}".${names.length ? ` Recent chats: ${names.join(", ")}.` : ""}` };
  }
  chatName = chatName || name;
  const since = new Date(Date.now() - Math.min(Number(days) || 30, 365) * 86400000).toISOString();
  const { data: rows, error } = await supabase.from("data_cache").select("data, source, external_id").eq("user_id", userId)
    .eq("type", "message").eq("data->>chat", jid).gte("received_at", since).order("received_at", { ascending: false }).limit(1000);
  if (error) throw new Error(error.message);
  chatName = rows?.[0]?.data?.chat_name || chatName;
  const words = String(query || "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const has = (r) => words.some((w) => String(r.data?.text || "").toLowerCase().includes(w));
  const matched = words.length && query !== "*" ? (rows || []).filter(has) : [];
  const picked = (matched.length ? matched : rows || []).slice(0, Math.min(Number(max_results) || 50, 100)).reverse();
  const slim = (r) => Object.fromEntries(CHAT_FIELDS.filter((k) => r.data?.[k] != null).map((k) => [k, k === "id" ? r.external_id : r.data[k]]));
  return {
    chat: chatName, source: picked[0]?.source || "whatsapp", count: picked.length, total_in_days: (rows || []).length,
    ...(words.length && query !== "*" && !matched.length ? { note: "Nothing in this chat holds those words; these are its newest messages." } : {}),
    results: picked.map(slim),
  };
}

/** Generic cache search for non-email types */
async function _searchCacheGeneric(userId, query, source, days, maxResults, excludeType, type = null) {
  try {
    // A specific query searches the WHOLE cache through the lexical index,
    // exactly as the email path does. This used to load the 500 most recent
    // rows of any type and substring-match them in memory, on the reasoning
    // that non-email types were small. WhatsApp ingestion ends that: an
    // active account is hundreds of messages a day, so the 500-row window
    // would be a few days deep within a week, which is the same defect
    // explicit email search had. The source and type filters run inside the
    // query, before its limit: applied to the rows it returned, a name common
    // in mail filled every slot with email and a WhatsApp search for that
    // person found nothing (migration 087).
    if (query && query !== "*") {
      const { lexicalTokens } = require("./lexical");
      const tokens = lexicalTokens(query, { corpus: "files" });
      if (tokens.length > 0) {
        try {
          const { data: rows, error } = await supabase.rpc("search_data_cache_lexical", {
            match_user_id: userId,
            query_tokens: tokens,
            match_count: maxResults,
            filter_type: type || null,
            exclude_type: excludeType || null,
            filter_source: source || null,
            // Across kinds, each gets a share: events with the name must not
            // push out the chat that said it.
            per_type: type || source ? null : Math.ceil(maxResults / 2),
          });
          if (!error && rows) {
            return rows
              .slice(0, maxResults)
              .map(r => ({ ...r.data, _source: r.source, _type: r.type, _external_id: r.external_id, _synced_at: r.synced_at }));
          }
          // No lexical index on this install (pre-030 self-host): fall
          // through to the recent-rows path below rather than return nothing.
        } catch (e) { /* same fall-through */ }
      }
    }

    // Generic or unfilterable query: newest rows, no matching. Recency is
    // what that question wants.
    let q = supabase
      .from("data_cache")
      .select("*")
      .eq("user_id", userId)
      .order("synced_at", { ascending: false })
      .limit(500);

    if (excludeType) q = q.neq("type", excludeType);
    if (type) q = q.eq("type", type);
    if (source) q = q.ilike("source", source + "%");

    const { data, error } = await q;
    if (error || !data || data.length === 0) return [];

    return data
      .map(r => ({ ...r.data, _source: r.source, _type: r.type, _external_id: r.external_id, _synced_at: r.synced_at }))
      .slice(0, maxResults);
  } catch (e) {
    console.log(`[data-sync] Generic cache search error: ${e.message}`);
    return [];
  }
}

module.exports = {
  gmailItem,
  outlookItem,
  OUTLOOK_FIELDS,
  cacheCovers,
  evictOldItems,
  fetchCachedIds,
  reconcileDeletedMail,
  startDataSync,
  stopDataSync,
  syncAllUsers,
  createConnectionWatch,
  syncUserData,
  queryCacheEmails,
  queryCacheCalendar,
  queryCacheUniversal,
  queryChat,
  searchOtherSources,
  upsertCacheItems,
  reconcileDeletedEvents,
  _test: { eventText },
};
