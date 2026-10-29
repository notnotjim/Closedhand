// lib/whatsapp-files.js: files sent in any WhatsApp chat, opened when a
// question needs them.
//
// A linked device sees every chat, and a file in one (an estimate, a ticket,
// a photo of a receipt) is often what a question is about. Recall keeps a line
// for it ("[file: Estimate.pdf]"), and the few fields WhatsApp needs to fetch
// it again are kept apart, in Closedhand's own file store: with them anyone
// could download and read the file, so they never sit in the rows that search
// and the LLM read. Opening it asks WhatsApp for the file, and the person's
// phone sends it again when WhatsApp no longer has it; once the phone has
// deleted it too, it is gone.

const KINDS = { documentMessage: "document", imageMessage: "image", videoMessage: "video", audioMessage: "audio" };

function extFromMime(mime) {
  const m = String(mime || "").split(";")[0].trim();
  const map = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
    "application/pdf": "pdf",
  };
  return map[m] || (m.split("/")[1] || "bin");
}

// The file an (unwrapped) message carries, or null.
function fileOf(inner) {
  for (const [field, kind] of Object.entries(KINDS)) {
    const f = inner && inner[field];
    if (!f) continue;
    const mime = String(f.mimetype || "").split(";")[0].trim();
    const given = String(f.fileName || "").trim();
    const name = (given || `${kind === "audio" && f.ptt ? "voice note" : kind}.${extFromMime(mime)}`).slice(0, 200);
    return { field, kind, name, mime, size: Number(f.fileLength || 0) || null };
  }
  return null;
}

// Where a message's reference is kept, under the person's own folder.
const refName = (messageId) => `whatsapp-files/${String(messageId).replace(/[^A-Za-z0-9_-]/g, "")}.json`;

// What WhatsApp needs to fetch the file again: the message's key and its
// media fields, without the preview picture.
function encodeRef(key, field, media) {
  const { proto } = require("@whiskeysockets/baileys");
  const kept = { ...media };
  delete kept.jpegThumbnail;
  delete kept.contextInfo;
  const bytes = proto.Message.encode({ [field]: kept }).finish();
  const { remoteJid, fromMe, id, participant } = key || {};
  return JSON.stringify({ key: { remoteJid, fromMe, id, participant }, message: Buffer.from(bytes).toString("base64") });
}

function decodeRef(json) {
  const { proto } = require("@whiskeysockets/baileys");
  const { key, message } = JSON.parse(json);
  return { key, message: proto.Message.decode(Buffer.from(message, "base64")) };
}

// Kept when the message arrives, for each file it carries.
async function keep(userId, msg, inner, file) {
  const { uploadFile } = require("../user-store");
  await uploadFile(userId, refName(`wa-${msg.key.id}`), Buffer.from(encodeRef(msg.key, file.field, inner[file.field])), "application/json");
}

// The file of a message recall has (its id is wa-…), as bytes with its name.
async function open(userId, messageId, download) {
  const { downloadFile } = require("../user-store");
  const raw = await downloadFile(`${userId}/${refName(messageId)}`);
  if (!raw) throw new Error("That message has no file Closedhand can open. Only files sent since this was added can be opened; ask the person to forward it to their own chat");
  const msg = decodeRef(raw.toString("utf8"));
  const file = fileOf(msg.message);
  let buffer;
  try { buffer = await download(msg); }
  catch (e) { throw new Error(`WhatsApp could not send the file again (${String(e.message).slice(0, 80)}). It may be gone from the person's phone`); }
  return { buffer, name: file ? file.name : "file", mime: file ? file.mime : "application/octet-stream", kind: file ? file.kind : null };
}

module.exports = { fileOf, extFromMime, refName, encodeRef, decodeRef, keep, open };
