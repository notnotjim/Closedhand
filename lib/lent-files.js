// Files the bot lends its sandbox computer while a job there needs them, read
// over the gateway (lib/gateway.js GET /gateway/file/<id>) a part at a time,
// as a video player reads a file. A recording or video to hear is read where
// it is and never copied to the sandbox whole: a copy needed the sandbox's
// disk to hold all of it, so a 6 GB video never fitted a 5 GB one. Each file
// is lent to one person's sandbox, under an id nobody can guess, only until
// it is taken back.
const crypto = require("crypto");
const fs = require("fs");

const lent = new Map();

// `input` is the file's bytes or a file on disk. Returns { id, size }.
function lend(userId, input) {
  const id = crypto.randomBytes(16).toString("hex");
  const size = Buffer.isBuffer(input) ? input.length : fs.statSync(input).size;
  lent.set(id, { userId, input, size });
  return { id, size };
}

// The lent file under `id`, if it is lent to this person's sandbox.
function find(id, userId) {
  const item = lent.get(String(id));
  return item && item.userId === userId ? item : null;
}

function takeBack(id) { lent.delete(id); }

// The bytes a Range header asks for, as { start, end } (end included): the
// whole file without one, null when none of it can be given.
function part(range, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range || "").trim());
  if (!m || (!m[1] && !m[2])) return { start: 0, end: size - 1, whole: true };
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start > end || start >= size ? null : { start, end, whole: false };
}

// Sends what a request asks for of a lent file.
function send(item, req, res) {
  const want = part(req.headers.range, item.size);
  if (!want) return res.status(416).set("Content-Range", `bytes */${item.size}`).end();
  if (!want.whole) res.status(206).set("Content-Range", `bytes ${want.start}-${want.end}/${item.size}`);
  res.set({ "Accept-Ranges": "bytes", "Content-Type": "application/octet-stream", "Content-Length": String(want.end - want.start + 1) });
  if (Buffer.isBuffer(item.input)) return res.end(item.input.subarray(want.start, want.end + 1));
  if (want.end < want.start) return res.end();
  const stream = fs.createReadStream(item.input, { start: want.start, end: want.end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

module.exports = { lend, find, takeBack, part, send };
