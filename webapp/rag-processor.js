// webapp/rag-processor.js -- RAG document processing pipeline
// Extracts text, chunks, embeds with the local embedding model in the bot,
// stores in Supabase pgvector

const path = require("path");
const { supabase } = require("./db");
// Parts small enough that the embedder reads each whole, its heading (file
// name and opening, up to 250 characters) included: at most 750 characters
// and the 150 carried over from the part before, inside the 1,200 a local
// embedder reads. A 3,200-character part was embedded from its first 1,200.
const CHUNK_SIZE = 750;
const CHUNK_OVERLAP = 150;
const EMBED_BATCH_SIZE = 32;

// Dependency injection for sandbox/bridge access
let _getSandboxInfo, _sandboxFetch, _bridgeRequest;

function init({ getSandboxInfo, sandboxFetch, bridgeRequest }) {
  _getSandboxInfo = getSandboxInfo;
  _sandboxFetch = sandboxFetch;
  _bridgeRequest = bridgeRequest;
}

// --- OAuth token helpers for cloud storage ---

const { encryptTokens, decryptTokens } = require("./crypto-tokens");

async function getServiceToken(userId, service) {
  const { data } = await supabase.from("connections").select("tokens").eq("user_id", userId).eq("service", service).single();
  const tokens = decryptTokens(data?.tokens);
  if (!tokens?.access_token) throw new Error(service + " not connected");
  return tokens.access_token;
}

// The person's own Google app, from .env or saved during setup, as the
// dashboard's sign-in reads it.
const ownGoogleClientId = () => process.env.GOOGLE_CLIENT_ID || require("./config").getConfCached("GOOGLE_CLIENT_ID");
const ownGoogleClientSecret = () => process.env.GOOGLE_CLIENT_SECRET || require("./config").getConfCached("GOOGLE_CLIENT_SECRET");

async function refreshGoogleToken(userId, serviceKey = "google") {
  const { data: conn } = await supabase.from("connections").select("tokens").eq("user_id", userId).eq("service", serviceKey).single();
  const tokens = decryptTokens(conn?.tokens);
  if (!tokens?.refresh_token) throw new Error("No Google refresh token");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      ...require("./google-app").clientFor(tokens, ownGoogleClientId(), ownGoogleClientSecret()),
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("Google token refresh failed");
  const newTokens = { ...tokens, access_token: data.access_token };
  // Checked, not fire-and-forget: the refreshed token is returned either way,
  // so a failed write leaves the caller working and the NEXT call using a
  // stale token. That surfaces later as an auth error with no connection to
  // its cause.
  const { error: tokenWriteError } = await supabase.from("connections")
    .update({ tokens: encryptTokens(newTokens) }).eq("user_id", userId).eq("service", serviceKey);
  if (tokenWriteError) console.error(`[rag] Google token refreshed but NOT saved: ${tokenWriteError.message}. The next call will use a stale token.`);
  return data.access_token;
}

async function refreshMicrosoftToken(userId, serviceKey = "microsoft") {
  const { data: conn } = await supabase.from("connections").select("tokens").eq("user_id", userId).eq("service", serviceKey).single();
  const tokens = decryptTokens(conn?.tokens);
  if (!tokens?.refresh_token) throw new Error("No Microsoft refresh token");
  const request = require("./microsoft-app").refreshRequest(tokens);
  if (!request) throw new Error("Microsoft OAuth not configured (missing client ID/secret)");
  const resp = await fetch(`https://login.microsoftonline.com/${request.authority}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(request.body),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("Microsoft token refresh failed");
  // Microsoft may rotate the refresh token; keeping the old one would let the
  // sign-in lapse once the old one expires.
  const newTokens = { ...tokens, access_token: data.access_token, expiry: Date.now() + (data.expires_in || 3600) * 1000,
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}) };
  // Checked, not fire-and-forget: the refreshed token is returned either way,
  // so a failed write leaves the caller working and the NEXT call using a
  // stale token. That surfaces later as an auth error with no connection to
  // its cause.
  const { error: tokenWriteError } = await supabase.from("connections")
    .update({ tokens: encryptTokens(newTokens) }).eq("user_id", userId).eq("service", serviceKey);
  if (tokenWriteError) console.error(`[rag] Microsoft token refreshed but NOT saved: ${tokenWriteError.message}. The next call will use a stale token.`);
  return data.access_token;
}

// Fetch with token refresh on 401
async function fetchWithRefresh(userId, service, url, options = {}) {
  let token = await getServiceToken(userId, service);
  options.headers = { ...options.headers, Authorization: "Bearer " + token };
  let resp = await fetch(url, options);
  if (resp.status === 401) {
    if (/^google/.test(service)) token = await refreshGoogleToken(userId, service);
    else if (/^microsoft/.test(service)) token = await refreshMicrosoftToken(userId, service);
    else throw new Error(service + " token expired");
    options.headers.Authorization = "Bearer " + token;
    resp = await fetch(url, options);
  }
  return resp;
}

// The files File Search picks up in a folder: every kind file-reader.js
// reads, and recordings and videos, which the bot hears. Programs are left
// alone.
const RAG_FILE_TYPES = Object.fromEntries([
  "pdf", "doc", "docx", "odt", "rtf", "pages", "txt", "md", "markdown", "csv", "tsv", "log",
  "xls", "xlsx", "ods", "numbers", "ppt", "pptx", "odp", "key",
  "html", "htm", "xhtml", "json", "xml", "yaml", "yml", "ini", "toml", "eml", "msg", "epub", "zip",
  "jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "bmp", "heic", "heif",
  "mp3", "m4a", "wav", "aac", "flac", "ogg", "oga", "opus", "aiff", "mp4", "m4v", "mov", "webm",
].map((t) => ["." + t, t]));

// Which reading of pictures a file had: the one whose description says only
// colours the picture has (lib/picture-colours.js in the bot), after the one
// that kept only words Tesseract is sure of (file-reader.js sureText). One
// read before it is read again; one read by the reading before, only if what
// was kept of it names a colour, as nothing else of it changes.
const PICTURE_READER = "colours-1";
const BEFORE_COLOURS = "sure-lines-1";
const COLOUR_WORD = /\b(red|orange|yellow|green|blue|purple|pink|brown|black|white|gr[ae]y|navy|turquoise|teal|violet|maroon|tan|beige|gold|silver)\b/i;

// Files a computer or an app makes beside the person's own, which nobody
// chose to keep: Office's "~$" lock files, Finder's .DS_Store and "._"
// copies, Windows' Thumbs.db and desktop.ini. Never listed or read: a lock
// file read as a presentation showed as a file that couldn't be read.
const SYSTEM_FILE = /^(~\$|\._)|^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

// What takes longest to read: pictures, sound and video, read after documents.
const MEDIA_TYPES = new Set(["jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "bmp", "heic", "heif",
  "mp3", "m4a", "wav", "aac", "flac", "ogg", "oga", "opus", "aiff", "mp4", "m4v", "mov", "webm"]);
// Of those, what is heard: recordings and videos, heard after a folder is read,
// one at a time while Closedhand is otherwise idle (hearWaiting below).
const HEARD_TYPES = new Set(["mp3", "m4a", "wav", "aac", "flac", "ogg", "oga", "opus", "aiff", "mp4", "m4v", "mov", "webm"]);

// --- Text extraction ---

// Read whole by file-reader.js, the one reader, scans and photos of
// documents included. A picture also gets a description, so photos can be
// found by what they show, written by the VLM in the bot: indexing never
// sends a picture anywhere, whatever image model is chosen for chat.

async function extractText(buffer, fileType, fileName, userId, media = null) {
  const reader = require("./file-reader");
  const read = await reader.readFile(buffer, fileName || "file." + fileType);
  if (read.kind === "audio" || read.kind === "video") return hearFile(buffer, fileName || "file." + fileType, read.kind === "video", userId, media);
  if (read.kind === "image" && media) media.push({ modality: "image", buffer, label: "(picture)" });
  // A PDF with no words in it, or a few letters (a logo's), scanned pages read
  // too, is a picture saved as a PDF: a logo, a drawing. Its first page goes
  // in as one.
  if (read.kind === "pdf" && String(read.text || "").replace(/\s+/g, "").length < 20 && media) {
    const page = await reader.pdfPicture(buffer);
    if (page) media.push({ modality: "image", buffer: page, label: "(picture)" });
  }
  if (read.kind !== "image") {
    if (!read.text && read.error) throw new Error(read.note);
    return read.text;
  }
  const description = await describeInBot(buffer, userId).catch((e) => { console.log(`[RAG] VLM: ${e.message}`); return ""; });
  const said = [read.text, description].filter((t) => t && t.trim()).join("\n\n");
  if (media && media.length) media[media.length - 1].label = `(picture) ${said.replace(/\s+/g, " ").slice(0, 300)}`.trim();
  // A picture with neither words nor a description is still found by what it
  // shows, when the model can see it (media above).
  if (!said && !(media && media.length)) throw new Error("Closedhand couldn't see this picture just now.");
  return said;
}

// What a picture shows, written by the VLM in the bot (lib/local-models.js,
// through lib/hear-route.js). It may still be downloading the first time, so
// this waits for it.
async function describeInBot(buffer, userId) {
  const { BOT_INTERNAL_URL, botToken } = require("./bot-call");
  const res = await fetch(`${BOT_INTERNAL_URL}/internal/describe-image`, {
    method: "POST", body: buffer, signal: AbortSignal.timeout(60 * 60000),
    headers: { "Content-Type": "application/octet-stream", "x-closedhand-token": botToken(userId) },
  });
  const seen = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(seen.error || "The vision language model didn't answer.");
  return seen.text || "";
}

// What's said in a recording or video, each line with its time, written out
// by the bot (lib/hear-route.js), which has the speech to text. A video's
// frames are read like photos and placed at their times, so "the clip with
// the tree" finds it too.
const VIDEO_FRAMES = 6;
// 7:55, or 1:07:55 past the hour, as lib/video.js writes times.
function clock(seconds) {
  const t = Math.max(0, Math.round(Number(seconds) || 0)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(t % 60).padStart(2, "0");
}
// A POST answered whenever the work is done, up to `ms`: fetch gives up when
// no answer has begun within five minutes, and a 17-minute 4K video took
// longer than that to arrive and be heard ("fetch failed"). `body` is bytes,
// or a stream of them (a web stream from fetch, or Node's).
function waitedPost(url, body, headers, ms) {
  const { Readable } = require("stream");
  const client = require(url.startsWith("https:") ? "https" : "http");
  return new Promise((resolve, reject) => {
    const req = client.request(url, { method: "POST", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(ms, () => req.destroy(new Error("hearing took too long")));
    req.on("error", reject);
    if (Buffer.isBuffer(body)) return req.end(body);
    const stream = typeof body.pipe === "function" ? body : Readable.fromWeb(body);
    stream.on("error", (e) => req.destroy(e));
    stream.pipe(req);
  });
}

// `file` is its bytes, or a stream of them as they arrive from where it is
// kept, passed straight on: the bot writes it to disk (lib/hear-route.js), so
// neither holds a file of any size whole.
async function hearFile(file, fileName, video, userId, media = null) {
  const { BOT_INTERNAL_URL, botToken } = require("./bot-call");
  const query = new URLSearchParams({ name: fileName, ...(video ? { video: "1", frames: String(VIDEO_FRAMES) } : {}), ...(media ? { vectors: "1" } : {}) });
  const res = await waitedPost(`${BOT_INTERNAL_URL}/internal/hear?${query}`, file,
    { "Content-Type": "application/octet-stream", "x-closedhand-token": botToken(userId) }, 12 * 3600000);
  let heard = {};
  try { heard = JSON.parse(res.text); } catch (_) {}
  if (!res.ok) throw new Error(heard.error || "Closedhand couldn't hear this file just now.");
  const seen = [];
  for (const f of heard.frames || []) {
    const jpeg = Buffer.from(f.jpeg, "base64");
    const words = await require("./file-reader").ocrImage(jpeg).catch(() => null);
    const shows = await describeInBot(jpeg, userId).catch(() => "");
    const text = [shows, words && words.trim() && !String(shows).includes(words.trim()) ? `Words on screen: ${words.trim()}` : ""].filter(Boolean).join("\n");
    if (text) seen.push(`[${clock(f.time)}] (on screen) ${text}`);
    if (media && f.vector) media.push({ modality: "frame", time: f.time, vector: f.vector, label: `[${clock(f.time)}] (on screen)${text ? " " + text.replace(/\s+/g, " ").slice(0, 300) : ""}` });
  }
  // Each stretch of sound, with the words said in it.
  if (media && Array.isArray(heard.sound)) {
    const lines = String(heard.text || "").split("\n").map((l) => { const m = /^\[(?:(\d+):)?(\d+):(\d+)\] (.*)$/.exec(l); return m ? { at: (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]), text: m[4] } : null; }).filter(Boolean);
    for (const w of heard.sound) {
      const words = lines.filter((l) => l.at >= w.start && l.at < w.end).map((l) => l.text).join(" ");
      media.push({ modality: "sound", start: w.start, end: w.end, vector: w.vector, label: `[${clock(w.start)}–${clock(w.end)}] (sound)${words ? " " + words.slice(0, 400) : ""}` });
    }
  }
  const parts = [heard.text ? `What's said:\n${heard.text}` : "", seen.length ? `What's on screen:\n${seen.join("\n")}` : "", heard.note || ""].filter(Boolean);
  if (!parts.length && !(media && media.length)) throw new Error(video ? "Nothing is said in this video and nothing could be read from it." : "Nothing is said in this recording.");
  return parts.join("\n\n");
}

// The chunks for pictures, sound and frames: their words where there are any
// (so they read in results and match a typed word), and the vector of the
// thing itself. A picture is embedded here through the bot; sound and frames
// came with their vectors from hearing.
async function mediaRows(media, { documentId, userId, fileName, residency, after, sourceContext }) {
  if (!media || !media.length) return [];
  const rows = [];
  for (const m of media) {
    let vector = m.vector || null;
    if (m.modality === "image" && !vector) {
      let image = m.buffer;
      if (/ftyp(heic|heix|hevc|mif1|msf1|avif)/.test(image.toString("latin1", 4, 12))) image = (await require("./file-reader").toJpeg(image)) || image;
      try {
        const { BOT_INTERNAL_URL, botToken } = require("./bot-call");
        // Its own bytes, whatever its size: the bot shrinks it for the model.
        const res = await fetch(`${BOT_INTERNAL_URL}/internal/embed`, {
          method: "POST", signal: AbortSignal.timeout(300000), body: image,
          headers: { "Content-Type": "application/octet-stream", "x-closedhand-token": botToken("file-search") },
        });
        const out = await res.json().catch(() => ({}));
        vector = res.ok && Array.isArray(out.vectors) ? out.vectors[0] : null;
      } catch (e) { console.log(`[RAG] ${fileName}: picture not embedded (${e.message})`); }
    }
    if (!vector) continue;
    rows.push({
      document_id: documentId, user_id: userId, chunk_index: after + rows.length,
      content: residency === "zero" ? "[Zero residency - text not stored]" : `${fileName} ${m.label || ""}`.trim(),
      embedding: JSON.stringify(vector),
      metadata: { source_file: fileName, modality: m.modality, ...(m.start != null ? { start: m.start, end: m.end } : {}), ...(m.time != null ? { time: m.time } : {}), ...(sourceContext || {}) },
    });
  }
  return rows;
}

// --- Chunking ---

// A document's own opening: its first two paragraphs, up to 200 characters,
// which usually say what it is (a title, who it is from, what it is about).
function docOpening(text) {
  return String(text || "").split(/\n\s*\n/).slice(0, 2).join(" ").replace(/\s+/g, " ").trim().substring(0, 200);
}

function chunkText(text) {
  if (!text || text.trim().length === 0) return [];

  // Split on paragraph boundaries first
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 2 <= CHUNK_SIZE) {
      current += (current ? "\n\n" : "") + trimmed;
    } else {
      if (current) chunks.push(current);
      // If single paragraph exceeds chunk size, split on sentences
      if (trimmed.length > CHUNK_SIZE) {
        const sentences = trimmed.match(/[^.!?]+[.!?]+\s*/g) || [trimmed];
        let sentChunk = "";
        for (const sent of sentences) {
          if (sentChunk.length + sent.length <= CHUNK_SIZE) {
            sentChunk += sent;
          } else {
            if (sentChunk) chunks.push(sentChunk.trim());
            sentChunk = sent;
          }
        }
        if (sentChunk) current = sentChunk.trim();
      } else {
        current = trimmed;
      }
    }
  }
  if (current) chunks.push(current);

  // Add overlap: prepend last N chars from previous chunk
  const overlapped = chunks.map((chunk, i) => {
    if (i === 0) return chunk;
    const prev = chunks[i - 1];
    const overlap = prev.slice(-CHUNK_OVERLAP);
    return overlap + "\n\n" + chunk;
  });

  return overlapped;
}

// --- Embedding ---

// Is this Closedhand's embedder the local one? Then the bot embeds, since
// the model runs there (lib/embed-route.js).
/** Embed a batch of texts with the local embedding model, through the bot. */
async function embedBatch(texts, opts = {}) {
  if (texts.length === 0) return [];
  // An answer that is not there is not a failure: a chunk saved without a
  // vector is given one by the bot's backfill (lib/embed-backfill.js).
  try {
    const { BOT_INTERNAL_URL, botToken } = require("./bot-call");
    const res = await fetch(`${BOT_INTERNAL_URL}/internal/embed`, {
      method: "POST", signal: AbortSignal.timeout(opts.query ? 15000 : 10 * 60000),
      headers: { "Content-Type": "application/json", "x-closedhand-token": botToken("file-search") },
      body: JSON.stringify({ texts: texts.map((t) => String(t || "").substring(0, 8000)), query: !!opts.query }),
    });
    const out = await res.json().catch(() => ({}));
    return res.ok && Array.isArray(out.vectors) ? out.vectors : [];
  } catch (e) {
    console.log(`[RAG] Local embed through the bot failed: ${e.message}`);
    return [];
  }
}

/** Embed a search: one text, as a query. Returns vector array or null. */
async function embedSingle(text) {
  if (!text) return null;
  const results = await embedBatch([text], { query: true });
  return results[0] || null;
}

// --- Folder scanning ---

// Every file is listed and read, the newest first, so what is most likely
// to be searched for is found soonest.
function byRecency(files) {
  files.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
}

// Every file and folder under `root` on a computer listed one folder at a
// time (the sandbox computer, a Mac), each with where it sits below the
// chosen folder (rel). Hidden folders and the ones tools make (node_modules)
// are not the person's files and are left out. A folder that cannot be
// listed is passed over, never the whole scan, and named in `unlisted` so
// what was read from it is kept, not taken for gone.
async function underneath(root, list) {
  const out = [], queue = [""];
  out.unlisted = [];
  while (queue.length) {
    const rel = queue.shift();
    let entries;
    try { entries = await list(rel ? root.replace(/\/$/, "") + "/" + rel : root); }
    catch (e) { if (!rel) throw e; console.error(`[RAG] Folder ${rel} could not be listed: ${e.message}`); out.unlisted.push(rel); continue; }
    for (const f of entries) {
      if (!f.name || f.name.startsWith(".")) continue;
      const at = rel ? rel + "/" + f.name : f.name;
      if (f.type === "directory" || f.type === "dir") { if (f.name === "node_modules") continue; queue.push(at); }
      out.push({ ...f, rel: at });
    }
  }
  byRecency(out);
  return out;
}

async function scanFolder(userId, origin, folderPath, opts = {}) {
  // origin says WHICH kind of store (gdrive/onedrive); account (a connection
  // service key) says WHICH account of it. Null account -> primary.
  const gKey = opts.account || "google";
  const msKey = opts.account || "microsoft";
  if (origin === "cloud") {
    const info = await _getSandboxInfo(userId);
    if (!info) throw new Error("Sandbox computer not active");
    const list = async (at) => {
      const result = await _sandboxFetch(info, "POST", "/files/list", { path: at });
      return (result.files || result || []).map(f => ({ name: f.name, type: f.type, size: f.size, modified: f.modified || f.mtime }));
    };
    return opts.recursive ? underneath(folderPath, list) : list(folderPath);
  } else if (origin === "bridge") {
    return opts.recursive ? underneath(folderPath, (at) => listMac(userId, at)) : listMac(userId, folderPath);
  }
  return scanCloudStore(userId, origin, folderPath, opts, gKey, msKey);
}

// One folder on the person's Mac, through Bridge. A Mac that cannot be
// reached throws, never lists as an empty folder: that would read as every
// file gone.
async function listMac(userId, folderPath) {
  let files = [], reached = false, failure = null;
  try {
    const result = await _bridgeRequest(userId, "files.list", { path: folderPath }, 15000);
    const rawFiles = result?.items || result?.files || (Array.isArray(result) ? result : []);
    files = rawFiles.map(f => ({ name: f.name, type: f.isDirectory || f.type === "directory" ? "directory" : "file", size: f.size || 0, modified: f.modified || f.modifiedDate || f.mtime }));
    reached = true;
  } catch (e) { failure = e; /* fall through to ls fallback */ }
  // Supplement with ls if files.list returned few results
  if (files.length < 5) {
    try {
      // The folder's name goes as base64, decoded on the Mac, so a $( ) or a
      // quote in a name is never read as part of the command.
      const rel = folderPath.replace(/^~\/?/, "");
      const lsPath = rel ? `"$HOME/$(printf %s ${Buffer.from(rel, "utf8").toString("base64")} | base64 --decode)"` : `"$HOME"`;
      const lsResult = await _bridgeRequest(userId, "shell.run", { command: `ls -1p ${lsPath} 2>/dev/null` }, 10000);
      reached = true;
      const lsOut = (lsResult?.result?.stdout || lsResult?.stdout || "").trim();
      if (lsOut) {
        const existing = new Set(files.map(f => f.name));
        for (const line of lsOut.split("\n").filter(Boolean)) {
          const isDir = line.endsWith("/");
          const name = isDir ? line.slice(0, -1) : line;
          if (name && !name.startsWith(".") && !existing.has(name)) {
            files.push({ name, type: isDir ? "directory" : "file", size: 0, modified: null });
          }
        }
      }
    } catch (e) { failure = failure || e; }
  }
  if (!reached) throw failure || new Error("The Mac could not be reached");
  return files;
}

// Google Drive, OneDrive and Dropbox, listed through their own services.
async function scanCloudStore(userId, origin, folderPath, opts, gKey, msKey) {
  if (origin === "gdrive") {
    // Two modes. The folder browser wants one level (folders included) so the
    // user can navigate. Indexing wants everything underneath the chosen
    // folder: a single-level scan meant "index my Drive" indexed only the
    // files sitting loose in the root and silently ignored every subfolder.
    // Both modes paginate; the old 200-item single page truncated big folders.
    const listPage = async (parentId, pageToken) => {
      const q = encodeURIComponent("'" + parentId + "' in parents and trashed = false");
      const fields = encodeURIComponent("nextPageToken,files(id,name,mimeType,modifiedTime,size)");
      let url = "https://www.googleapis.com/drive/v3/files?q=" + q + "&fields=" + fields + "&pageSize=200";
      if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
      const resp = await fetchWithRefresh(userId, gKey, url);
      if (!resp.ok) throw new Error("Google Drive API error: " + resp.status);
      return resp.json();
    };
    const toEntry = (f) => ({
      name: f.name,
      type: f.mimeType === "application/vnd.google-apps.folder" ? "directory" : "file",
      size: parseInt(f.size) || 0,
      modified: f.modifiedTime,
      id: f.id,
      mimeType: f.mimeType,
    });

    // Every folder underneath, each once: a folder can have more than one parent.
    const out = [], seen = new Set([folderPath || "root"]);
    const queue = [{ id: folderPath || "root" }];
    while (queue.length > 0) {
      const { id } = queue.shift();
      let pageToken = null;
      do {
        const data = await listPage(id, pageToken);
        for (const f of (data.files || [])) {
          const entry = toEntry(f);
          if (entry.type === "directory") {
            out.push(entry); // the browser shows folders; indexing lists them by name
            if (!opts.recursive) continue;
            if (!seen.has(f.id)) { seen.add(f.id); queue.push({ id: f.id }); }
            continue;
          }
          out.push(entry);
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
      if (!opts.recursive) break; // browser: this folder only
    }
    if (opts.recursive) byRecency(out);
    return out;
  } else if (origin === "onedrive") {
    // The same two modes as Google Drive, following Microsoft's pages. The
    // browser navigates by path; indexing walks subfolders by their ids.
    const GRAPH = "https://graph.microsoft.com/v1.0/me/drive";
    const select = "?$select=id,name,size,lastModifiedDateTime,file,folder&$top=200";
    const folderP = folderPath || "/";
    const first = folderP === "/"
      ? GRAPH + "/root/children" + select
      : GRAPH + "/root:" + folderP.split("/").map(encodeURIComponent).join("/") + ":/children" + select;
    const toEntry = (f) => ({
      name: f.name,
      type: f.folder ? "directory" : "file",
      size: f.size || 0,
      modified: f.lastModifiedDateTime,
      id: f.id,
    });

    const out = [], seen = new Set();
    const queue = [{ url: first }];
    while (queue.length > 0) {
      const { url } = queue.shift();
      let next = url;
      do {
        const resp = await fetchWithRefresh(userId, msKey, next);
        if (!resp.ok) throw new Error("OneDrive API error: " + resp.status);
        const data = await resp.json();
        for (const f of (data.value || [])) {
          const entry = toEntry(f);
          if (entry.type === "directory") {
            out.push(entry);
            if (!opts.recursive) continue;
            if (!seen.has(f.id)) { seen.add(f.id); queue.push({ url: GRAPH + "/items/" + encodeURIComponent(f.id) + "/children" + select }); }
            continue;
          }
          out.push(entry);
        }
        next = data["@odata.nextLink"];
      } while (next);
      if (!opts.recursive) break;
    }
    if (opts.recursive) byRecency(out);
    return out;
  } else if (origin === "dropbox") {
    const dropboxPath = folderPath || "";
    const token = await getServiceToken(userId, "dropbox");
    // Every page, and for indexing every folder underneath, as Drive's.
    const call = (route, body) => fetch("https://api.dropboxapi.com/2/files/" + route, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = [];
    let resp = await call("list_folder", { path: dropboxPath, recursive: !!opts.recursive, limit: 2000 });
    for (;;) {
      if (!resp.ok) throw new Error("Dropbox API error: " + resp.status);
      const data = await resp.json();
      for (const f of data.entries || []) {
        if (f[".tag"] === "deleted" || (opts.recursive && f.path_lower === dropboxPath.toLowerCase())) continue;
        out.push({ name: f.name, type: f[".tag"] === "folder" ? "directory" : "file", size: f.size || 0, modified: f.server_modified || null, id: f.id, path: f.path_display });
      }
      if (!data.has_more) break;
      resp = await call("list_folder/continue", { cursor: data.cursor });
    }
    if (opts.recursive) byRecency(out);
    return out;
  }
  throw new Error("Unknown origin: " + origin);
}

// --- File content fetching ---

async function fetchFileContent(userId, origin, filePath, account) {
  const gKey = account || "google";
  const msKey = account || "microsoft";
  if (origin === "cloud") {
    const info = await _getSandboxInfo(userId);
    if (!info) throw new Error("Sandbox computer not active");
    const result = await _sandboxFetch(info, "POST", "/files/download", { path: filePath });
    return Buffer.from(result.content, result.encoding || "base64");
  } else if (origin === "bridge") {
    const result = await _bridgeRequest(userId, "files.read", { path: filePath, encoding: "base64" }, 30000);
    return Buffer.from(result.content, "base64");
  } else if (origin === "gdrive") {
    // filePath is the Drive file ID; fetch metadata to check for Google Docs types
    const metaResp = await fetchWithRefresh(userId, gKey,
      "https://www.googleapis.com/drive/v3/files/" + filePath + "?fields=mimeType,name");
    if (!metaResp.ok) throw new Error("Google Drive metadata error: " + metaResp.status);
    const meta = await metaResp.json();
    const googleDocTypes = [
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.presentation",
    ];
    let resp;
    if (googleDocTypes.includes(meta.mimeType)) {
      // Export as PDF for Google Docs/Sheets/Slides
      resp = await fetchWithRefresh(userId, gKey,
        "https://www.googleapis.com/drive/v3/files/" + filePath + "/export?mimeType=" + encodeURIComponent("application/pdf"));
    } else {
      resp = await fetchWithRefresh(userId, gKey,
        "https://www.googleapis.com/drive/v3/files/" + filePath + "?alt=media");
    }
    if (!resp.ok) throw new Error("Google Drive download error: " + resp.status);
    return Buffer.from(await resp.arrayBuffer());
  } else if (origin === "onedrive") {
    // filePath is the OneDrive item ID
    const resp = await fetchWithRefresh(userId, msKey,
      "https://graph.microsoft.com/v1.0/me/drive/items/" + filePath + "/content");
    if (!resp.ok) throw new Error("OneDrive download error: " + resp.status);
    return Buffer.from(await resp.arrayBuffer());
  } else if (origin === "dropbox") {
    // filePath is the full Dropbox path
    const token = await getServiceToken(userId, "dropbox");
    const resp = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Dropbox-API-Arg": JSON.stringify({ path: filePath }),
      },
    });
    if (!resp.ok) throw new Error("Dropbox download error: " + resp.status);
    return Buffer.from(await resp.arrayBuffer());
  }
  throw new Error("Unknown origin: " + origin);
}

// A recording's or a video's bytes as they arrive, for hearing: it can be
// any size, and is passed on to the bot without being held (hearFile). The
// sandbox computer's files and a Mac's through Bridge come whole.
async function openFileStream(userId, origin, filePath, account) {
  const at = origin === "gdrive" ? ["google", "https://www.googleapis.com/drive/v3/files/" + filePath + "?alt=media"]
    : origin === "onedrive" ? ["microsoft", "https://graph.microsoft.com/v1.0/me/drive/items/" + filePath + "/content"] : null;
  if (at) {
    const resp = await fetchWithRefresh(userId, account || at[0], at[1]);
    if (!resp.ok) throw new Error((origin === "gdrive" ? "Google Drive" : "OneDrive") + " download error: " + resp.status);
    return resp.body;
  }
  if (origin === "dropbox") {
    const token = await getServiceToken(userId, "dropbox");
    const resp = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Dropbox-API-Arg": JSON.stringify({ path: filePath }) },
    });
    if (!resp.ok) throw new Error("Dropbox download error: " + resp.status);
    return resp.body;
  }
  return fetchFileContent(userId, origin, filePath, account);
}

// --- Main processing pipeline ---

async function processDocument(documentId, userId, fileBuffer, fileName, fileType, sourceContext = null) {
  try {
    // Update status to processing
    // With the time it began: the stall sweep takes a read whose row is older
    // than 20 minutes for one cut off, and marked reads under way as failed.
    await supabase.from("rag_documents").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", documentId);

    // 1. Extract text
    console.log(`[RAG] Extracting text from ${fileName} (${fileType})`);
    // Pictures, stretches of sound and video frames, embedded by what they
    // are (EmbeddingGemma 2, in the bot), go in beside the text's chunks.
    const media = [];
    const text = await extractText(fileBuffer, fileType, fileName, userId, media);
    return await fileText(documentId, userId, fileName, text, media, sourceContext);
  } catch (e) {
    console.error(`[RAG] Processing failed for ${fileName}:`, e.message);
    await supabase.from("rag_documents").update({
      status: "error",
      error_message: e.message,
      updated_at: new Date().toISOString(),
    }).eq("id", documentId);
    return { error: e.message };
  }
}

// A file's words (and its pictures, sound and frames), cut into parts,
// embedded and kept, and the file marked ready. Throws when there is nothing
// to keep.
async function fileText(documentId, userId, fileName, text, media, sourceContext = null) {
  text = String(text || "");
  // A file with nothing in it, words or pictures (an empty document), is
  // found by its name, as every file is, and has nothing more to keep. It was
  // counted as a file that couldn't be read.
  if (!text.trim() && !(media && media.length)) {
    await supabase.from("rag_chunks").delete().eq("document_id", documentId);
    const { data: had } = await supabase.from("rag_documents").select("metadata").eq("id", documentId).single();
    await supabase.from("rag_documents").update({ status: "ready", chunk_count: 0, error_message: null, metadata: { ...((had && had.metadata) || {}), empty: true }, updated_at: new Date().toISOString() }).eq("id", documentId);
    console.log(`[RAG] ${fileName}: nothing in it`);
    return { chunks: 0 };
  }

  // 2. Chunk, the whole file: a long one is never cut to its first pages.
  const chunks = text.trim() ? chunkText(text) : [];
  console.log(`[RAG] ${fileName}: ${text.length} chars -> ${chunks.length} chunks`);
  if (chunks.length === 0 && !(media && media.length)) throw new Error("No chunks produced from text");

  // 3. Each part is embedded headed by the file's name and the document's
  // own opening lines, so a part from deep inside ("the fee is £300") is
  // found as part of what it belongs to. A background LLM once wrote a line
  // per part instead, seeing only that part and the name; on invented
  // documents (2026-11-02) the heading put the answering part as high or
  // higher, with nothing sent to an LLM.
  const head = (fileName + "\n" + docOpening(text)).slice(0, 249) + "\n";
  const headed = chunks.map((c) => head + c);

  // 4. Embed the headed parts in batches
  const allEmbeddings = [];
  for (let i = 0; i < headed.length; i += EMBED_BATCH_SIZE) {
    const batch = headed.slice(i, i + EMBED_BATCH_SIZE);
    console.log(`[RAG] Embedding batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1}/${Math.ceil(headed.length / EMBED_BATCH_SIZE)}`);
    const embeddings = await embedBatch(batch);
    // Kept in step with the chunks even when a batch has no vectors.
    allEmbeddings.push(...(embeddings.length === batch.length ? embeddings : batch.map(() => undefined)));
  }

  // Check user's data residency setting
  const { data: _profile } = await supabase.from("profiles").select("settings").eq("id", userId).single();
  const residency = _profile?.settings?.rag_residency || "standard";

  // 5. Insert chunks with embeddings (the part's own text, embedded headed).
  // The heading is kept with each part, so a part saved without a vector is
  // given one headed the same (lib/embed-backfill.js in the bot); never under
  // zero residency, where none of the file's words are kept.
  const rows = chunks.map((content, idx) => ({
    document_id: documentId,
    user_id: userId,
    chunk_index: idx,
    content: residency === "zero" ? "[Zero residency - text not stored]" : content,
    embedding: JSON.stringify(allEmbeddings[idx]),
    metadata: { source_file: fileName, chunk_of: chunks.length, ...(residency === "zero" ? {} : { head: head.trimEnd() }), ...(sourceContext || {}) },
  }));

  rows.push(...(await mediaRows(media, { documentId, userId, fileName, residency, after: chunks.length, sourceContext })));

  // Insert in batches of 50 to avoid payload limits
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase.from("rag_chunks").insert(batch);
    if (error) throw new Error(`Chunk insert failed: ${error.message}`);
  }

  // 5. Update document status. Its details are kept (when it was changed,
  // how a picture was read): written over, every file read before looked
  // changed, so each scan read them all again and never reached the rest.
  const { data: had } = await supabase.from("rag_documents").select("metadata").eq("id", documentId).single();
  await supabase.from("rag_documents").update({
    status: "ready",
    chunk_count: rows.length,
    metadata: { ...((had && had.metadata) || {}), word_count: text.split(/\s+/).length, char_count: text.length },
    updated_at: new Date().toISOString(),
  }).eq("id", documentId);

  console.log(`[RAG] ${fileName}: ready (${chunks.length} chunks)`);
  return { chunks: chunks.length };
}

// --- Recordings and videos ---

// Whether Closedhand is otherwise idle (lib/idle.js in the bot): no chat, no
// sync or indexing, no File Search reading. False when it cannot say.
async function botIdle(userId) {
  try {
    const { BOT_INTERNAL_URL, botToken } = require("./bot-call");
    const res = await fetch(`${BOT_INTERNAL_URL}/internal/idle`, { headers: { "x-closedhand-token": botToken(userId) }, signal: AbortSignal.timeout(10000) });
    return res.ok && (await res.json()).idle === true;
  } catch (_) { return false; }
}

// A recording or a video not heard yet, or due another try: a failed one
// is tried again a few times, less often each time.
const HEAR_TRIES = 5;
const HEAR_AGAIN_MS = 6 * 3600000;
function dueToHear(d, now = Date.now()) {
  if (d.status === "pending") return true;
  const tries = Number(d.metadata?.hear_tries || 0);
  return d.status === "error" && tries < HEAR_TRIES && now - Date.parse(d.updated_at || 0) > HEAR_AGAIN_MS * Math.max(1, tries);
}

// Recordings and videos from every source, heard one at a time, the newest
// first, while Closedhand is otherwise idle and no folder is being read. A
// two-hour video takes about half an hour to hear, and nobody is waiting on
// it: until then it is found by its name, like any file not read yet. Run
// after each folder is read and every few minutes (webapp/server.js).
let _hearing = false;
async function hearWaiting() {
  if (_hearing) return;
  _hearing = true;
  try {
    for (;;) {
      const { data: docs } = await supabase.from("rag_documents")
        .select("id, user_id, source_id, name, file_type, file_path, origin, status, metadata, updated_at")
        .in("status", ["pending", "error"]).in("file_type", [...HEARD_TYPES]);
      const next = (docs || []).filter((d) => dueToHear(d))
        .sort((a, b) => Date.parse(b.metadata?.modified || 0) - Date.parse(a.metadata?.modified || 0))[0];
      if (!next || _readingSources.size || !(await botIdle(next.user_id))) return;
      await hearDocument(next);
    }
  } catch (e) {
    console.error("[RAG] Hearing recordings and videos:", e.message);
  } finally {
    _hearing = false;
  }
}

// One recording or video heard and filed. While it is heard, its row says it
// is still under way (recoverStalledDocuments would otherwise take a long one
// for stuck).
async function hearDocument(doc) {
  const { data: source } = await supabase.from("rag_sources").select("account").eq("id", doc.source_id).single();
  const kept = (what) => ({ error }) => { if (error) console.error(`[RAG] ${doc.name}: could not keep ${what}: ${error.message}`); };
  const stillGoing = () => supabase.from("rag_documents").update({ updated_at: new Date().toISOString() }).eq("id", doc.id).then(kept("that it is still being heard")).catch(() => {});
  const { error: markErr } = await supabase.from("rag_documents").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", doc.id);
  if (markErr) console.error(`[RAG] ${doc.name}: could not keep that it is being heard: ${markErr.message}`);
  const beat = setInterval(stillGoing, 5 * 60000);
  try {
    console.log(`[RAG] Hearing ${doc.name}`);
    const media = [];
    const file = await openFileStream(doc.user_id, doc.origin, doc.file_path, source && source.account);
    const text = await hearFile(file, doc.name, /^(mp4|m4v|mov|webm)$/.test(doc.file_type), doc.user_id, media);
    await fileText(doc.id, doc.user_id, doc.name, text, media, { origin: doc.origin, path: doc.file_path });
  } catch (e) {
    // Nothing said in it is its answer for good; anything else is tried again.
    const tries = /^Nothing is said/.test(e.message) ? HEAR_TRIES : Number(doc.metadata?.hear_tries || 0) + 1;
    console.error(`[RAG] ${doc.name} not heard: ${e.message}`);
    const { error } = await supabase.from("rag_documents").update({ status: "error", error_message: e.message, metadata: { ...(doc.metadata || {}), hear_tries: tries }, updated_at: new Date().toISOString() }).eq("id", doc.id);
    if (error) console.error(`[RAG] ${doc.name}: could not keep that it was not heard: ${error.message}`);
  } finally {
    clearInterval(beat);
  }
}

// --- Source processing pipeline ---

// One reading of a source at a time. Update pressed while one is under way, or
// a start-up resume racing a fresh add, would read the same files twice and
// pay for each twice.
const _readingSources = new Set();
async function processSource(sourceId, ...rest) {
  if (_readingSources.has(sourceId)) { console.log(`[RAG] Source ${sourceId} is already being read`); return; }
  _readingSources.add(sourceId);
  try { await readSource(sourceId, ...rest); } finally { _readingSources.delete(sourceId); hearWaiting().catch(() => {}); }
}

async function readSource(sourceId, userId, origin, folderPath, selectedFiles, account, opts = {}) {
  try {
    // 1. Update source status to indexing
    await supabase.from("rag_sources").update({ status: "indexing", updated_at: new Date().toISOString() }).eq("id", sourceId);

    // 2. Scan folder for files
    // recursive: indexing a folder means everything underneath it
    const files = (await scanFolder(userId, origin, folderPath, { recursive: true, account })).filter((f) => !SYSTEM_FILE.test(f.name || ""));

    // Google Docs mimeTypes that we can export as PDF
    const GOOGLE_DOC_TYPES = [
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.presentation",
    ];

    // 3. Filter to supported file types
    let supported = files.filter(f => {
      if (f.type === "directory" || f.type === "dir") return false;
      // Google Docs/Sheets/Slides can be exported as PDF
      if (origin === "gdrive" && f.mimeType && GOOGLE_DOC_TYPES.includes(f.mimeType)) return true;
      const ext = path.extname(f.name).toLowerCase();
      return !!RAG_FILE_TYPES[ext];
    });

    // 3b. Filter to selected files if specified
    if (selectedFiles && selectedFiles.length > 0) {
      const selIds = new Set(selectedFiles.map(f => f.id));
      const selNames = new Set(selectedFiles.map(f => f.name));
      supported = supported.filter(f => {
        if (origin === "gdrive" && f.id) return selIds.has(f.id);
        return selNames.has(f.name);
      });
    }

    // Where each file is, as the index records it.
    const pathOf = (file) => {
      if (origin === "gdrive" || origin === "onedrive") return file.id; // Drive and OneDrive item ids
      if (origin === "dropbox") return file.path || (folderPath === "" ? "" : folderPath) + "/" + file.name; // Full Dropbox path
      return folderPath.replace(/\/$/, "") + "/" + (file.rel || file.name);
    };
    const typeOf = (file) => (origin === "gdrive" && file.mimeType && GOOGLE_DOC_TYPES.includes(file.mimeType))
      ? "pdf" // Google Docs exported as PDF
      : RAG_FILE_TYPES[path.extname(file.name).toLowerCase()];

    // Documents before pictures, sound and video, newest first within each:
    // reading a page of text takes a moment, a photo or a clip much longer,
    // and a first scan of a Drive full of photos kept every PDF waiting.
    supported.sort((a, b) => (MEDIA_TYPES.has(typeOf(a)) ? 1 : 0) - (MEDIA_TYPES.has(typeOf(b)) ? 1 : 0)
      || new Date(b.modified || 0) - new Date(a.modified || 0));

    // Everything else the source holds, folders included: never read, but
    // found by name like the rest (doc-search's name arm).
    const supportedSet = new Set(supported);
    const listedOnly = selectedFiles && selectedFiles.length > 0 ? [] : files.filter(f => !supportedSet.has(f));

    // 4. Get existing documents for this source
    const readExisting = async () => {
      const { data } = await supabase
        .from("rag_documents")
        .select("id, name, file_path, metadata, status")
        .eq("user_id", userId)
        .eq("source_id", sourceId);
      const map = {};
      for (const doc of data || []) if (doc.file_path) map[doc.file_path] = doc;
      return map;
    };
    let existingMap = await readExisting();

    // 4b. Every file and folder by name, before any is read, so a search
    // finds them from the start. Files to read wait as pending; the rest are
    // listed for good.
    const newRows = [];
    for (const file of supported) {
      if (!existingMap[pathOf(file)]) newRows.push({ user_id: userId, source_id: sourceId, name: file.name, file_type: typeOf(file), size_bytes: file.size || 0,
        file_path: pathOf(file), origin, status: "pending", metadata: { modified: file.modified, ...(file.mimeType ? { mime: file.mimeType } : {}) } });
    }
    // A Google Doc, Sheet or Slides keeps its kind on its row, as it has no
    // extension to be told by; one listed before rows kept it is given it now.
    for (const file of supported) {
      const had = existingMap[pathOf(file)];
      if (!had || !file.mimeType || !file.mimeType.startsWith("application/vnd.google-apps.") || (had.metadata && had.metadata.mime)) continue;
      const metadata = { ...(had.metadata || {}), mime: file.mimeType };
      const { error } = await supabase.from("rag_documents").update({ metadata }).eq("id", had.id);
      if (error) console.error("[RAG] Keeping a Google file's kind:", error.message); else had.metadata = metadata;
    }
    for (const file of listedOnly) {
      if (existingMap[pathOf(file)]) continue;
      const isFolder = file.type === "directory" || file.type === "dir";
      newRows.push({ user_id: userId, source_id: sourceId, name: file.name, file_type: isFolder ? "folder" : (path.extname(file.name).slice(1).toLowerCase() || "file"),
        size_bytes: file.size || 0, file_path: pathOf(file), origin, status: "listed", metadata: { modified: file.modified, ...(file.mimeType ? { mime: file.mimeType } : {}) } });
    }
    for (let i = 0; i < newRows.length; i += 200) {
      const { error } = await supabase.from("rag_documents").insert(newRows.slice(i, i + 200));
      if (error) console.error("[RAG] Listing files by name:", error.message);
    }
    if (newRows.length) existingMap = await readExisting();

    let totalChunks = 0;
    const processedPaths = new Set();

    // 5. Process each supported file
    let processed = 0;
    const retryQueue = [];

    // Live progress. Counts were only written when the whole source finished,
    // so a multi-minute run looked frozen at its previous totals with no way
    // to tell work from a stall. note carries the denominator (how many files
    // the scan found) since the row has no dedicated progress column.
    const publishProgress = async () => {
      await supabase.from("rag_sources").update({
        file_count: processed,
        chunk_count: totalChunks,
        error_message: `${processed} of ${supported.length} files indexed`,
        updated_at: new Date().toISOString(),
      }).eq("id", sourceId).then(() => {}, () => {});
    };
    await publishProgress();

    // Resolve the path of EVERY supported file up front. processedPaths drives
    // the "delete documents whose file disappeared" step below, so a file that
    // is merely skipped (budget, or unchanged) must still register as present,
    // otherwise the cleanup deletes a perfectly good index entry for it.
    const items = supported.map(file => {
      const filePath = pathOf(file);
      processedPaths.add(filePath);
      return { file, filePath };
    });
    for (const file of listedOnly) processedPaths.add(pathOf(file));

    const indexOne = async ({ file, filePath }) => {
      // Skip if unchanged AND successfully processed (has chunks). A picture
      // read before Tesseract kept only lines it was sure of carries the
      // nonsense it read off shapes, so it is read once more.
      const existing = existingMap[filePath];
      let readWell = !MEDIA_TYPES.has(typeOf(file)) || existing?.metadata?.read_by === PICTURE_READER;
      if (!readWell && existing?.status === "ready" && existing.metadata?.read_by === BEFORE_COLOURS) {
        const { data: parts } = await supabase.from("rag_chunks").select("content").eq("document_id", existing.id);
        if (!(parts || []).some((p) => COLOUR_WORD.test(p.content || ""))) {
          const metadata = { ...existing.metadata, read_by: PICTURE_READER };
          const { error } = await supabase.from("rag_documents").update({ metadata }).eq("id", existing.id);
          if (!error) { existing.metadata = metadata; readWell = true; }
        }
      }
      // A routine check leaves an unchanged file that could not be read for
      // Update, rather than fetching it again every time.
      if (opts.scheduled && existing && existing.metadata?.modified === file.modified && existing.status === "error") return;
      if (existing && existing.metadata?.modified === file.modified && existing.status === "ready" && readWell) {
        const { count } = await supabase.from("rag_chunks").select("id", { count: "exact", head: true }).eq("document_id", existing.id);
        if (count > 0 || existing.metadata?.empty) {
          totalChunks += count;
          return;
        }
      }

      // A recording or a video is heard later, while Closedhand is otherwise
      // idle (hearWaiting below), and found by its name until then. One that
      // changed since it was heard waits to be heard again.
      if (HEARD_TYPES.has(typeOf(file))) {
        if (existing && existing.metadata?.modified !== file.modified) {
          const gone = await supabase.from("rag_chunks").delete().eq("document_id", existing.id);
          const waits = await supabase.from("rag_documents").update({ status: "pending", error_message: null, metadata: { modified: file.modified } }).eq("id", existing.id);
          const error = gone.error || waits.error;
          if (error) console.error(`[RAG] ${file.name}: could not mark it to be heard again: ${error.message}`);
        }
        return;
      }

      // An old version's passages go (it is read again); its row stays, so
      // the file is found by name throughout.
      if (existing) await supabase.from("rag_chunks").delete().eq("document_id", existing.id);

      // Fetch file content
      const fileType = typeOf(file);
      let buffer;
      try {
        buffer = await fetchFileContent(userId, origin, filePath, account);
      } catch (e) {
        console.error(`[RAG] Failed to fetch ${filePath}:`, e.message);
        return;
      }

      // Its row, listed by name above: brought up to date to be read.
      const fields = { name: file.name, file_type: fileType, size_bytes: file.size || buffer.length, status: "pending", metadata: { modified: file.modified, ...(file.mimeType ? { mime: file.mimeType } : {}), ...(MEDIA_TYPES.has(fileType) ? { read_by: PICTURE_READER } : {}) } };
      const { data: doc, error: docErr } = existing
        ? await supabase.from("rag_documents").update(fields).eq("id", existing.id).select("id").single()
        : await supabase.from("rag_documents").insert({ user_id: userId, source_id: sourceId, file_path: filePath, origin, ...fields }).select("id").single();
      if (docErr || !doc) {
        console.error(`[RAG] Doc record failed for ${file.name}:`, docErr ? docErr.message : "no row");
        return;
      }

      // Process the document. Isolated: one unreadable or slow file must not
      // abort the whole folder and leave every later file unindexed.
      try {
        const result = await processDocument(doc.id, userId, buffer, file.name, fileType, { origin, path: filePath });
        totalChunks += result.chunks || 0;
      } catch (fileErr) {
        console.error(`[RAG] ${file.name} failed, continuing with the rest:`, fileErr.message);
        await supabase.from("rag_documents")
          .update({ status: "error", error_message: String(fileErr.message).substring(0, 300) })
          .eq("id", doc.id).then(() => {}, () => {});
        // Transient failures (timeout, rate limit, provider blip) get one more
        // go at the end, when whatever was overloaded has had time to recover.
        // Without this a single slow moment permanently removes a file from
        // search with no signal to the user that it is missing.
        if (/timeout|abort|429|50\d|network|fetch failed/i.test(fileErr.message)) {
          retryQueue.push({ file, filePath, fileType, docId: doc.id });
        }
      }
    };

    // Files in parallel. Their pictures are described one at a time by the
    // VLM in the bot, whose model calls queue, so they never come as a burst.
    const FILE_CONCURRENCY = parseInt(process.env.RAG_FILE_CONCURRENCY || "4", 10);
    let fileCursor = 0;
    const fileWorker = async () => {
      while (true) {
        const i = fileCursor++;
        if (i >= items.length) return;
        try {
          await indexOne(items[i]);
        } catch (e) {
          console.error(`[RAG] Unexpected failure on ${items[i].file.name}:`, e.message);
        }
        processed++;
        await publishProgress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(FILE_CONCURRENCY, items.length) }, fileWorker));

    // Second pass over transient failures
    for (const item of retryQueue) {
      try {
        console.log(`[RAG] Retrying ${item.file.name}`);
        const buf = await fetchFileContent(userId, origin, item.filePath, account);
        const result = await processDocument(item.docId, userId, buf, item.file.name, item.fileType, { origin, path: item.filePath });
        totalChunks += result.chunks || 0;
        await publishProgress();
      } catch (e) {
        console.error(`[RAG] Retry failed for ${item.file.name}:`, e.message);
        await supabase.from("rag_documents")
          .update({ status: "error", error_message: `Failed twice: ${String(e.message).substring(0, 250)}` })
          .eq("id", item.docId).then(() => {}, () => {});
      }
    }

    // 6. Remove documents for files no longer in folder, never ones in a
    // folder that could not be listed this time.
    const root = folderPath.replace(/\/$/, "") + "/";
    const unlisted = (files.unlisted || []).map((rel) => root + rel + "/");
    for (const [filePath, doc] of Object.entries(existingMap)) {
      if (unlisted.some((at) => filePath.startsWith(at))) continue;
      if (!processedPaths.has(filePath)) {
        await supabase.from("rag_chunks").delete().eq("document_id", doc.id);
        await supabase.from("rag_documents").delete().eq("id", doc.id);
      }
    }

    // 7. Update source stats
    //
    // file_count is the number of files a search can actually reach, not the
    // number of rows: counting every document made a source with nine failed
    // files read "71 files, 122 chunks, ready" while nine of them were not in
    // the index at all. A file that silently is not indexed looks exactly like
    // one that is, right up until a search comes back empty. Which files
    // can't be read, and which still wait to be heard, are counted when the
    // sources are shown (GET /api/rag/sources): a recording heard or failed
    // after this run would leave a note kept here out of date.
    const { count: fileCount } = await supabase.from("rag_documents")
      .select("id", { count: "exact", head: true }).eq("source_id", sourceId).eq("status", "ready");
    const { count: failedCount } = await supabase.from("rag_documents")
      .select("id", { count: "exact", head: true }).eq("source_id", sourceId).eq("status", "error");

    await supabase.from("rag_sources").update({
      status: "ready",
      file_count: fileCount || 0,
      chunk_count: totalChunks,
      error_message: null,
      last_indexed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", sourceId);

    console.log(`[RAG] Source ${sourceId}: ready (${fileCount} files, ${totalChunks} chunks${failedCount ? `, ${failedCount} failed` : ""})`);
  } catch (e) {
    console.error(`[RAG] processSource failed for ${sourceId}:`, e.message);
    // A routine check that cannot reach the folder (a Mac asleep, the sandbox
    // computer off) leaves it as it was.
    const { error } = await supabase.from("rag_sources").update(opts.scheduled ? { status: "ready", updated_at: new Date().toISOString() } : {
      status: "error",
      error_message: e.message,
      updated_at: new Date().toISOString(),
    }).eq("id", sourceId);
    if (error) console.error(`[RAG] Source ${sourceId} status not saved: ${error.message}`);
  }
}

/**
 * Documents pinned at "processing" (webapp restarted mid-file, or a provider
 * call hung before the timeout existed) are never retried by the source-level
 * resume, so they sit unindexed and invisible forever. Mark them failed so
 * the next source run treats them as changed and re-processes them, and so
 * the user can see which files did not make it in.
 *
 * A recording or video cut off while it was heard (a restart) is not the
 * file's fault, so it waits its turn again instead, rather than hours as a
 * failed try: marked failed, a 6 GB video cut off by a restart waited 18
 * hours. Twice at most, so a file that brings the hearing down is not heard
 * for ever; after that the cut counts as a try. One already marked cut off
 * waits its turn again the same way.
 */
const CUT_OFF = "Reading it was cut off. Update reads it again.";
const HEAR_CUTS = 2;
async function recoverStalledDocuments() {
  const STALL_MS = 20 * 60 * 1000;
  const cutoff = new Date(Date.now() - STALL_MS).toISOString();
  try {
    const { data: docs } = await supabase.from("rag_documents")
      .select("id, name, file_type, metadata").eq("status", "processing").lt("updated_at", cutoff);
    const { data: cut } = await supabase.from("rag_documents")
      .select("id, name, file_type, metadata").eq("status", "error").eq("error_message", CUT_OFF).in("file_type", [...HEARD_TYPES]);
    for (const d of (docs || []).concat(cut || [])) {
      const heard = HEARD_TYPES.has(d.file_type), cuts = Number(d.metadata?.hear_cuts || 0) + 1;
      if (heard && cuts <= HEAR_CUTS) {
        const { error } = await supabase.from("rag_documents")
          .update({ status: "pending", error_message: null, metadata: { ...(d.metadata || {}), hear_cuts: cuts } })
          .eq("id", d.id);
        if (error) console.error(`[RAG] ${d.name}: could not put it back in the queue: ${error.message}`);
        else console.log(`[RAG] ${d.name} was cut off while it was heard, and waits its turn again`);
        continue;
      }
      if ((cut || []).includes(d)) continue;
      const { error } = await supabase.from("rag_documents")
        .update({ status: "error", error_message: CUT_OFF, ...(heard ? { metadata: { ...(d.metadata || {}), hear_cuts: cuts, hear_tries: Number(d.metadata?.hear_tries || 0) + 1 } } : {}) })
        .eq("id", d.id);
      if (error) console.error(`[RAG] ${d.name}: could not mark it cut off: ${error.message}`);
      else console.log(`[RAG] Recovered stalled document: ${d.name}`);
    }
  } catch (e) {
    console.error("[RAG] recoverStalledDocuments failed:", e.message);
  }
}

// Every folder checked for new and changed files, one at a time, as
// connections are synced: only what is new or changed is read.
async function checkSources() {
  const { data, error } = await supabase.from("rag_sources").select("id, user_id, origin, path, selected_files, account").in("status", ["ready", "error"]);
  if (error) { console.error("[RAG] Folders to check could not be read:", error.message); return; }
  for (const src of data || []) {
    await processSource(src.id, src.user_id, src.origin, src.path, src.selected_files || null, src.account || null, { scheduled: true });
  }
}

module.exports = { init, processDocument, processSource, checkSources, scanFolder, fetchFileContent, extractText, chunkText, docOpening, embedBatch, embedSingle, getServiceToken, fetchWithRefresh, recoverStalledDocuments, hearWaiting, hearFile, dueToHear, HEARD_TYPES, HEAR_TRIES, SYSTEM_FILE };
