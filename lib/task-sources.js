// Where a finished task found the specifics in its answer, kept with its
// message in the conversation (conversation.js aboutRecent), never shown.
//
// A task drafted an email to an estate agent's sales negotiator, an address it
// read on the agency's team page. Asked "where did you get that name?", the
// chat could not see what the task had read, searched mail and chats, found
// the name nowhere, and told the person it had been invented. Now an address,
// link or phone number the answer gives keeps the lines it was read from.
//
// Only what came from outside: what the person gave the task, and their own
// accounts, need no source. At most three, so a long answer does not carry a
// pile of them; most answers carry none.

const MAX_SOURCES = 3;
const AROUND = 220;

const SPECIFIC = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  /https?:\/\/[^\s<>"')\]]+/g,
  /\+?\d[\d ()-]{8,}\d/g,
];

function textOf(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p && p.type === "text" ? p.text : "")).join("\n");
  return c ? JSON.stringify(c) : "";
}
const flat = (s) => String(s || "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();

// What the task read, in order: each tool result with the call that made it.
function reads(messages) {
  const calls = new Map(), out = [];
  for (const m of messages || []) {
    for (const part of Array.isArray(m?.content) ? m.content : []) {
      if (part?.type === "tool_use") calls.set(part.id, part);
      if (part?.type === "tool_result") out.push({ call: calls.get(part.tool_use_id) || {}, text: textOf(part.content) });
    }
  }
  return out;
}

// The record holding it, when the read was a search: its id and source, so
// the chat can open it whole.
function recordOf(text, found) {
  try {
    const items = JSON.parse(text).results || [];
    const hit = items.find((r) => JSON.stringify(r).includes(found));
    return hit && hit.id ? { id: String(hit.id), source: String(hit.source || hit._source || "") } : null;
  } catch { return null; }
}

function sourcesFor(answer, messages, given = "") {
  const read = reads(messages);
  if (!read.length) return [];
  // The person's own accounts appear on every mail result.
  const own = new Set();
  for (const r of read) for (const m of r.text.matchAll(/"account":\s*"([^"]+)"/g)) own.add(m[1].toLowerCase());
  const specifics = [];
  for (const re of SPECIFIC) for (const m of String(answer || "").matchAll(re)) {
    const s = m[0].replace(/[.,;:]+$/, "");
    if (!specifics.includes(s) && !own.has(s.toLowerCase()) && !String(given).includes(s)) specifics.push(s);
  }
  const out = [];
  for (const s of specifics) {
    if (out.length >= MAX_SOURCES) break;
    const r = read.find((x) => x.text.includes(s) && x.call.name && !/(_send|_draft|_reply|create_|update_)/.test(x.call.name));
    if (!r) continue;
    const at = r.text.indexOf(s);
    const lines = flat(r.text.slice(Math.max(0, at - AROUND), at + s.length + AROUND));
    if (out.some((o) => o.text.includes(lines.slice(0, 80)))) continue;
    const where = r.call.input?.url || r.call.input?.id || (r.call.input?.query ? `a search for "${r.call.input.query}"` : r.call.name);
    out.push({ ...(recordOf(r.text, s) || {}), text: `Read from ${where}: …${lines}…` });
  }
  return out;
}

module.exports = { sourcesFor, MAX_SOURCES };
