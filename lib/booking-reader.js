// lib/booking-reader.js: what the bookings reader (lib/bookings.js) is shown
// of each email, chat day or page, and how many go in one read. Pure, no
// database.

// How much of an item the reader is shown. An agency's confirmation opens
// with offers, an app to download and tracking links, and its times and
// flight numbers came 9,000 to 13,000 characters in: shown the first 3,000,
// the reader saw a route and an order number and no time.
const READ_CHARS = 15000;
// A link reads as its site alone, so an email of tracking links shrinks to
// its words. A link that may be the way to check in stays whole, as the
// reader is asked for it.
const CHECK_IN = /check[\s._-]?in|boarding/i;
function forReader(text) {
  return String(text || "").replace(/https?:\/\/[^\s)<>"\]]+/g, (url, at, all) => {
    if (CHECK_IN.test(url) || CHECK_IN.test(all.slice(Math.max(0, at - 60), at))) return url;
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  }).slice(0, READ_CHARS);
}

// Ten at most in one read: forty came back as a list longer than the reply
// allows, cut off mid-way.
const EMAILS_PER_READ = 10;
// As many items as the reading LLM's window holds beside its instructions and
// its reply, ten at most, and an item longer than all of that is cut to it:
// a local LLM with a small window reads one at a time.
function readerBatches(items) {
  const window = require("./token-tracker").roleWindow("background");
  const room = Math.max(2000, Math.floor((window - 4000 - 2000) * 0.6) * 4);
  const batches = [];
  for (let at = 0; at < items.length;) {
    let size = 0, n = 0;
    while (at + n < items.length && n < EMAILS_PER_READ) {
      const len = String(items[at + n].subject || "").length + Math.min(room, String(items[at + n].body || "").length) + 200;
      if (n && size + len > room) break;
      size += len; n++;
    }
    batches.push({ at, items: items.slice(at, at + n).map((e, i) => ({ ...e, emailIndex: i, body: String(e.body || "").slice(0, room) })) });
    at += n;
  }
  return batches;
}

module.exports = { READ_CHARS, EMAILS_PER_READ, forReader, readerBatches };
