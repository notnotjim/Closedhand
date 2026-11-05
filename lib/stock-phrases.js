// lib/stock-phrases.js: no stock phrases in what Closedhand says.
//
// A reply said a price "held all through the sale, which is the part people
// miss": a phrase that adds nothing but the feel of an insight, and that the
// person's model reaches for whatever it is asked. Such phrases are cut in
// code from every reply, background answer, Pulse message and page, after
// the model, as emdashes are (plain-dashes.js). A sentence that is only the
// phrase goes; one that leads in with it keeps what follows; a clause that
// trails off into it ends without it. Anywhere else it stays, since cutting
// it there would break the sentence. A phrase the person tells Closedhand
// never to use, kept as one of their preferences (save_rule) or a Pinned Fact
// about how they want things done, is cut the same way.

const Q = "['’]";
const STOCK = [
  "the (?:part|bit) (?:most )?people miss", "what (?:most )?people miss",
  `here${Q}?s the (?:thing|kicker)`, "here is the (?:thing|kicker)",
  "let that sink in",
];

const END = "[.!?…]";
const CLOSE = "[\"”’)]";
const AFTER = CLOSE + "?";
const LEAD = "(?:(?:and|but|so)\\s+)?";
const POINTER = `(?:(?:and|but)\\s+)?(?:that|this|which|it)(?:${Q}s|\\s+is|\\s+was)\\s+`;

function cutOne(text, p) {
  return text
    // A sentence that is only the phrase: "Let that sink in." "That's the part people miss."
    .replace(new RegExp(`(^|${END}${AFTER}[ \\t]+)[ \\t]*(?:${POINTER}|${LEAD})${p}[ \\t]*(?:${END}+${AFTER}|(?=\\n|$))[ \\t]*`, "gim"), "$1")
    // A sentence that leads in with it: "Here's the thing: they close at six."
    .replace(new RegExp(`(^|${END}${AFTER}[ \\t]+)[ \\t]*${LEAD}${p}(?:[ \\t]*(?:[:,]|[-–—]|\\.\\.\\.|…)|\\s+(?:is|was)(?:\\s+that|:))[ \\t]*(\\S)`, "gim"),
      (m, before, next) => before + next.toUpperCase())
    // The same after a comma: "It sold, and here's the kicker: twice."
    .replace(new RegExp(`(,\\s+(?:and|but|so)\\s+)${p}[ \\t]*(?:[:,]|[-–—])[ \\t]*`, "gi"), "$1")
    // A clause that trails off into it: "…higher each time, which is the part people miss."
    .replace(new RegExp(`[ \\t]*(?:,|;|[ \\t][-–—])[ \\t]*(?:${POINTER}|(?:and|but)\\s+)?${p}(?=[ \\t]*(?:${END}|${CLOSE}|\\n|$))`, "gim"), "");
}

// A phrase the person said never to use: one of their preferences, or a
// Pinned Fact about how they want things done, that says never (not, don't,
// stop, avoid) to say, use or write something and quotes it, or names the
// phrase or word after saying so.
const NEVER = /\b(?:never|not|don['’]?t|stop|avoid|ban(?:ned)?)\b[^"“‘\n]{0,60}?\b(say|saying|use|using|write|writing|phrase|word|words|expression)\b/gi;
const QUOTED = /["“]([^"”\n]{2,60})["”]|‘([^’\n]{2,60})’|(?<![A-Za-z])'([^'\n]{2,60})'(?![A-Za-z])/g;
const NAMED = /^\s*(?:the\s+)?(?:phrase|word|expression)\s+([^"“‘'.,;:!?\n]{2,60}?)\s*(?:[.,;:!?]|$)/i;
function ownPhrases(store) {
  const texts = (store?.userRules || []).map((r) => (r && typeof r === "object" ? r.rule : r))
    .concat(Object.values(store?.facts || {}).filter((f) => f && typeof f === "object" && f.category === "preference").map((f) => f.value));
  const out = [];
  for (const text of texts) {
    const value = String(text || "");
    for (const never of value.matchAll(NEVER)) {
      const rest = value.slice(never.index + never[0].length);
      const named = !/["“‘']/.test(rest.slice(0, 40)) && NAMED.exec(/^(?:phrase|word|expression)$/i.test(never[1]) ? never[1] + rest : rest);
      if (named) { out.push(named[1].trim()); continue; }
      let at = 0;
      for (const q of rest.matchAll(QUOTED)) {
        const between = rest.slice(at, q.index);
        if (at === 0 ? between.length > 40 : !/^\s*(?:,|\/|or|and|nor|,\s*or|,\s*and)?\s*$/.test(between)) break;
        const phrase = (q[1] || q[2] || q[3]).replace(/^[\s.…]+|[\s.,!?…]+$/g, "");
        if (phrase.length >= 2) out.push(phrase);
        at = q.index + q[0].length;
      }
    }
  }
  return out;
}

const pattern = (phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/['’]/g, Q).replace(/\s+/g, "\\s+");

// The text without them; store holds the person's own (their rules and
// Pinned Facts), the active person's when not given. Code is left as it is.
function noStockPhrases(text, store) {
  if (typeof text !== "string" || !text) return text;
  if (store === undefined) { try { store = require("./context").activeUserStore; } catch (_) { store = null; } }
  const phrases = STOCK.concat(ownPhrases(store).map(pattern));
  let changed = false;
  const out = text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => {
    if (i % 2) return part;
    let t = part;
    for (const p of phrases) t = cutOne(t, p);
    if (t === part) return part;
    changed = true;
    return t.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  }).join("");
  // A reply that was nothing but the phrase stays as it was.
  return changed && out.trim() ? out.trim() : text;
}

module.exports = { noStockPhrases, ownPhrases };
