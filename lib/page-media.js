// page-media.js: what a page can hold besides its words: pictures, film,
// sound and interactive pieces made on the sandbox computer. Vendored:
// lib/page-media.js and webapp/page-media.js stay byte-identical. A page
// names each on a line of its own, ![caption](name); the file is kept in the
// person's own storage beside the page and shows on the page as itself.

const KINDS = {
  png: "picture", jpg: "picture", jpeg: "picture", gif: "picture", webp: "picture", svg: "picture",
  mp4: "film", webm: "film", mp3: "sound", m4a: "sound", ogg: "sound", wav: "sound", html: "interactive",
};
const TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav", html: "text/html",
};
const LINE = /^\s*!\[([^\]\n]*)\]\(([\w.-]+)\)\s*$/;
const MAX_BYTES = 20 * 1024 * 1024;

const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(String(name || "")) || [])[1]?.toLowerCase() || "";
const kindOf = (name) => KINDS[extOf(name)] || null;
const typeOf = (name) => TYPES[extOf(name)] || "application/octet-stream";

// A file's name as the page knows it: its own name, made safe for a link,
// or null when a page cannot hold that kind of file.
function partName(filename) {
  const base = String(filename || "").split(/[\\/]/).pop().replace(/\s+/g, "-").replace(/[^\w.-]/g, "").replace(/^\.+/, "").slice(-80);
  return base && kindOf(base) ? base.replace(/\.[^.]+$/, (e) => e.toLowerCase()) : null;
}

// The pieces a page's words name, in order.
function namedParts(md) {
  const out = [];
  for (const line of String(md || "").split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m && kindOf(m[2]) && !out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

const partKey = (userId, pageId, name) => `${userId}/pages/${pageId}/${name}`;

module.exports = { KINDS, TYPES, LINE, MAX_BYTES, extOf, kindOf, typeOf, partName, namedParts, partKey };
