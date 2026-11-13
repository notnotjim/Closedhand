const { responseText } = require("./model-wire");
// lib/claims-check.js — the glance before pressing send.
//
// A person about to send "see you all Saturday" checks it against what they
// know before it goes: who actually said yes, which day it is, how much it
// was. This is that glance, in code, for anything irreversible: the message
// about to go out is read against the live picture of the person's projects
// and the last few exchanges, and anything it asserts that they contradict
// (a name that declined, a wrong date, a number that is not theirs) is put on
// the confirmation card so it is visible at the only moment it matters.
// Runs on the fast internal model with a short timeout, alongside whatever
// else the card is waiting on, and never blocks: no answer means no warning.
//
// What the person already said yes to is theirs, and is never put to them
// again: a statement repeated from a message they already sent on the same
// thread, or from what they wrote themselves, is no warning, whatever the
// rest of the picture says (they may have chosen those words on purpose).

const { getInternalClient } = require("./llm");

const TIMEOUT_MS = 12000;

function plain(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ");
  return "";
}

// What the person already sent in this conversation (every mailbox marks
// sent mail SENT): on the thread this one goes to (found from the thread, the
// message replied to or the draft being sent), to the same address, and on any
// thread that address has written on, in the last month. A helpdesk that
// answers on a new thread, from another address than the one written to, is
// still the same conversation.
async function approvedOnThread(userId, input = {}, to = "") {
  try {
    const { supabase } = require("./db");
    const email = () => supabase.from("data_cache").select("data").eq("user_id", userId).eq("type", "email");
    let threadId = input.thread_id || null;
    for (const [field, value] of [["data->>draft_id", input.draft_id], ["external_id", input.message_id], ["data->>id", input.message_id]]) {
      if (threadId || !value) continue;
      threadId = (await email().eq(field, String(value)).limit(1)).data?.[0]?.data?.threadId || null;
    }
    const rows = threadId ? ((await email().eq("data->>threadId", String(threadId)).limit(30)).data || []) : [];
    const address = (String(to).match(/[^\s<>,"]+@[^\s<>,"]+/) || [])[0];
    if (address) {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const like = `%${address.replace(/[%_]/g, "")}%`;
      rows.push(...((await email().ilike("data->>to", like).gte("created_at", since).limit(20)).data || []));
      const theirs = [...new Set(((await email().ilike("data->>from", like).gte("created_at", since).limit(20)).data || []).map((r) => r.data?.threadId).filter(Boolean))];
      for (const t of theirs.slice(0, 5)) rows.push(...((await email().eq("data->>threadId", String(t)).limit(20)).data || []));
    }
    const seen = new Set();
    return rows.map((r) => r.data).filter((d) => d && !d.is_draft && (d.labels || []).includes("SENT") && !seen.has(d.id) && seen.add(d.id))
      .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)).slice(0, 6)
      .map((d) => String(d.body || d.snippet || "").slice(0, 1500)).filter(Boolean);
  } catch (_) { return []; }
}

// A claim that says what one sentence of an approved text says: every number
// in it is in that sentence (a date or amount that differs is never a repeat)
// and most of its words are.
const words = (s) => String(s || "").toLowerCase().replace(/[\u2018\u2019]/g, "'").match(/[a-z0-9£$€]+(?:['.,:][a-z0-9]+)*/g) || [];
function repeats(claim, approved) {
  const said = [...new Set(words(claim).filter((w) => w.length > 2 || /\d/.test(w)))];
  if (!said.length) return false;
  const numbers = said.filter((w) => /\d/.test(w));
  return approved.some((text) => String(text).split(/(?<=[.!?])\s+|\n+/).some((sentence) => {
    const there = new Set(words(sentence));
    return numbers.every((n) => there.has(n)) && said.filter((w) => there.has(w)).length / said.length >= 0.8;
  }));
}

// Returns { warnings: [{ claim, because }] }. Empty when nothing contradicts
// or when the check could not run in time. input: the send's own input, which
// says which thread it goes to.
async function checkOutbound({ userId, kind, to, subject, body, recent = [], input = {} }) {
  try {
    const text = String(body || "").trim();
    if (!text || text.length < 20) return { warnings: [] };
    const [open, sentBefore] = await Promise.all([require("./projects").live(userId), approvedOnThread(userId, input, to)]);
    const history = recent.slice(-12).map((m) => ({ role: m.role, text: plain(m.content).slice(0, 500) })).filter((m) => m.text);
    if (!open.length && history.length < 2) return { warnings: [] };
    const theirOwn = recent.filter((m) => m.role === "user").map((m) => plain(m.content)).filter((t) => t && !/^\[Forwarded:/.test(t));
    const { client, model } = getInternalClient(userId);
    const resp = await Promise.race([
      client.messages.create({
        model,
        max_tokens: 600,
        messages: [{ role: "user", content: `An assistant is about to ${kind || "send a message"} on its user's behalf. Check the message against what is known and flag only statements that CONTRADICT the known facts or that assert something about a person, date, time, place or amount that the known facts do not support. Ignore style. Return ONLY JSON: {"warnings":[{"claim":"the words in the message","because":"the known fact it contradicts or lacks, with who said it and when if known","same_as":"the exact words of a message the user already sent that make the same point, copied, or empty"}]} or {"warnings":[]}.

MESSAGE ABOUT TO GO OUT
To: ${String(to || "").slice(0, 300)}
Subject: ${String(subject || "").slice(0, 200)}
Body:
${text.slice(0, 3000)}

WHAT IS KNOWN
Projects (the live picture, most reliable):
${JSON.stringify(open.map((p) => ({ name: p.name, summary: p.summary, state: p.state, until: p.expected_end })))}

Recent conversation (oldest first; text marked [Forwarded: ...] was written by someone else, not the user):
${JSON.stringify(history)}
${sentBefore.length ? `
ALREADY SENT BY THE USER ON THIS THREAD OR TO THIS ADDRESS (they said yes to these words; what they chose to say is theirs, never a warning, in any wording):
${JSON.stringify(sentBefore.map((t) => t.slice(0, 1500)))}
` : ""}
Rules: a warning needs a concrete contradiction or an unsupported specific. Someone the picture says declined but the message counts as attending is a warning. A date, time, venue, price or reference that differs from the picture is a warning. General pleasantries are not. Anything the user already sent on this thread, or wrote themselves, is not a warning. "because" is one short sentence to the user, as you would say it to them ("You said on 9 Nov the Wi-Fi worked on your phone.", "The booking says 14:05."), never naming known facts, the picture or the conversation. At most 5 warnings, each under 200 characters.` }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("claims check timeout")), TIMEOUT_MS)),
    ]);
    let out = (responseText(resp) || "").trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
    const parsed = JSON.parse(out);
    // A point the user already made is theirs: the claim repeats what they
    // sent or wrote, or the LLM quotes where they already said it, the quote
    // is really there, and it has every number the claim has (a card ending
    // or a date that differs is never the same point).
    const approved = [...sentBefore, ...theirOwn];
    const numbersIn = (s) => words(s).filter((w) => /\d/.test(w));
    const theirs = (w) => {
      if (repeats(w.claim, approved)) return true;
      const quote = String(w.same_as || "").trim();
      if (quote.length < 9 || !repeats(quote, approved)) return false;
      const inQuote = new Set(numbersIn(quote));
      return numbersIn(w.claim).every((n) => inQuote.has(n));
    };
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w) => w && w.claim && !theirs(w)).slice(0, 5).map((w) => ({ claim: String(w.claim).slice(0, 200), because: String(w.because || "").slice(0, 240) })) : [];
    return { warnings };
  } catch (e) {
    if (!/timeout/.test(String(e.message))) console.error("[claims-check] failed:", e.message);
    return { warnings: [] };
  }
}

function renderWarnings(warnings) {
  if (!warnings || !warnings.length) return "";
  return "\nCheck before you say yes:\n" + warnings.map((w) => `- The message says "${w.claim}". ${w.because}`).join("\n") + "\n";
}

module.exports = { checkOutbound, renderWarnings, repeats, approvedOnThread };
