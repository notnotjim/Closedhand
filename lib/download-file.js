// lib/download-file.js: a file's bytes written to disk as they arrive.
//
// A file from Drive, OneDrive or an Outlook message can be any size: a long
// video, a scanned book. Held whole in memory, and turned into text on the
// way, one of 600 MB stopped the bot. Written to a file of its own as it
// comes, any size the disk holds is read, a piece at a time where it can be
// (lib/item-files.js, lib/video.js).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Readable, Transform } = require("stream");

// A download that sends nothing for this long has stalled. There is no limit
// on the whole: a large file on a slow line takes as long as it takes.
const STALL_MS = 2 * 60000;

// A new, empty place for one file, named like the original so readers that
// go by extension still know what it is.
function tempPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "closedhand-file-"));
  const ext = (path.extname(String(name || "")).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || [""])[0];
  return path.join(dir, "file" + ext);
}

// Removes a file made by tempPath, and its folder. Anything else is left.
function removeTemp(file) {
  if (!file) return;
  const dir = path.dirname(file);
  if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith("closedhand-file-")) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

// GETs `url` into `dest`. `label` starts an error, as the providers' own
// helpers do ("Google API 404: ..."). Resolves { size, type }.
async function downloadTo(url, headers, dest, label) {
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), STALL_MS);
  const alive = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), STALL_MS); };
  try {
    const res = await fetch(url, { headers, signal: stall.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${label} ${res.status}: ${text.substring(0, 200)}`);
    }
    let size = 0;
    const count = new Transform({ transform(chunk, _, done) { size += chunk.length; alive(); done(null, chunk); } });
    await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(dest));
    return { size, type: res.headers.get("content-type") || "" };
  } catch (e) {
    fs.rmSync(dest, { force: true });
    if (stall.signal.aborted) throw new Error(`${label}: the download stopped arriving`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { tempPath, removeTemp, downloadTo, STALL_MS };
