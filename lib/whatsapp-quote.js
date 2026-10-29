// The message a WhatsApp reply answers. A reply carries the message it quotes
// along with its own text, and without it "yes of course" says nothing about
// what was agreed: in the self-chat, where "cancel this" on yesterday's
// message needs its referent, and in every other chat, read later. A picture,
// video or file with a caption carries it the same way a text does.

// Closedhand's own messages open with the fist and its name (stamp).
const STAMP = /^✊ \*[^*\n]{1,60}:\* /;

// { text, who, from } for a reply, or null. content is the message's own
// content, unwrapped. The quote is Closedhand's words without the stamp, so
// the emoji a project message starts with still files the reply in that
// project; who is "Closedhand" by the stamp, which holds after a restart, or
// by the quoted id among sentIds. from is the id of whoever wrote the quoted
// message, when WhatsApp gives it.
function quoteOf(content, sentIds) {
  const ci = Object.values(content || {}).map((v) => (v && typeof v === "object" ? v.contextInfo : null)).find((c) => c && c.quotedMessage);
  if (!ci) return null;
  const q = ci.quotedMessage;
  const text = q.conversation
    || q.extendedTextMessage?.text
    || q.imageMessage?.caption
    || q.videoMessage?.caption
    || q.documentMessage?.caption
    || "";
  if (!text) return null;
  const stamped = STAMP.exec(text);
  const who = stamped || (ci.stanzaId && sentIds && sentIds.has(ci.stanzaId)) ? "Closedhand" : null;
  const words = (stamped ? text.slice(stamped[0].length) : text).substring(0, 300).replace(/"\]/g, "\" ]");
  return { text: words, who, from: ci.participant || null };
}

// A stored message's reply, in front of its text in the shape every chat
// app's replies take (project-rules.js reads it). writer is the name the
// chat's messages carry for whoever wrote the quoted one ("me" for the
// person), or null when WhatsApp doesn't say.
function replyLine(quote, writer) {
  return `[replying to ${writer ? "a message from " + writer : "an earlier message"}: "${quote.text}"]`;
}

module.exports = { quoteOf, replyLine };
