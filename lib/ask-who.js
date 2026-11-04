// lib/ask-who.js: the chat asks, once, about someone in the person's life it
// cannot place, rather than guessing who they are. A name with no word on who
// they are to the person ("Bea"), or a relation with no name ("Dad"): either
// way the next mistake is a guess (an event about their partner's dad taken
// for their own dad's). Pulse asks about the people its messages are about
// (lib/pulse.js); this is the chat's side, and both keep one list of who has
// been asked about (settings.asked_who), so nobody is asked about twice.
// Rules sift first (a name or a family word in the message that no Pinned
// Fact covers), then one narrow question to their own LLM, beside the turn. The question
// goes as a follow-on message after the answer, and the answer is pinned like
// anything else said in chat.

const FAMILY = /\b(dad|daddy|mum|mummy|mom|mother|father|sister|brother|wife|husband|partner|son|daughter|aunt|auntie|uncle|cousin|grandma|grandpa|granny|grandad|grandmother|grandfather|nan|nana|niece|nephew|in-laws?|boyfriend|girlfriend|fianc[eé]e?)\b/i;

// A family word, or a capitalised word that does not start a sentence (and is
// not "I"): the only messages worth the question.
function worthChecking(message) {
  const t = String(message || "").trim();
  if (FAMILY.test(t)) return true;
  const words = t.split(/\s+/);
  return words.some((w, i) => i > 0 && !/[.!?:]$/.test(words[i - 1]) && /^\p{Lu}\p{Ll}+/u.test(w) && !/^I('|’|$)/.test(w));
}

// The question, in the same words Pulse asks with.
function questionFor(who, kind) {
  if (kind === "relation") {
    const rel = String(who).trim().replace(/’/g, "'").replace(/^(my|your)\s+/i, "");
    const whose = /'s\s/.test(rel) ? rel : `your ${rel.toLowerCase()}`;
    return `What's ${whose}'s name, and where do they live? Tell me once and I'll remember.`;
  }
  return `Who's ${who} to you, and where do they live? Tell me once and I'll remember.`;
}

const asked = (store) => new Set(((store && store.profile && store.profile.settings && store.profile.settings.asked_who) || []).map((x) => String(x).toLowerCase()));

// The assistant's own names, Closedhand and whatever the person calls it,
// word by word: never someone in their life. A reply in a chat app arrives as
// "[replying to Closedhand's message: ...]", and "Closedhand" was asked about
// as a person. Pulse leaves them out the same way.
function ownNames(store) {
  const given = String((store && store.profile && store.profile.settings && store.profile.settings.bot_name) || "");
  return [...new Set(["closedhand", ...(given.trim() ? [given.trim().toLowerCase()] : []), ...(given.toLowerCase().match(/\p{L}[\p{L}'’-]*/gu) || [])])];
}

// Words a capital letter starts that are never someone: the first word of a
// request, days and months, titles.
const NOT_NAMES = new Set("i i'm i've i'll i'd is are am was were do does did can could will would should shall may might have has had put add set get send book make move find check show tell remind call ask let also and but or so if when what where who why how which please thanks thank ok okay yes no hi hey hello the a an my your our this that these those it its there here then just not monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december today tomorrow tonight jan feb mar apr jun jul aug sep sept oct nov dec mon tue tues wed thu thur thurs fri sat sun dr mr mrs ms miss prof sir".split(" "));

// What the message could be about: names it gives that no Pinned Fact
// covers, and relations it names ("Dad"). A name after "Dr" or "Prof" is a
// professional's.
function candidates(message, facts) {
  const t = String(message || "").replace(/\b(Dr|Doctor|Prof|Professor)\.?\s+\p{Lu}[\p{L}'’-]*(\s+\p{Lu}[\p{L}'’-]*)?/gu, " ");
  const names = (t.match(/\p{Lu}[\p{L}'’-]*/gu) || []).map((w) => w.replace(/['’]s$/i, "").replace(/['’-]+$/, ""))
    .filter((w) => w.length > 1 && !NOT_NAMES.has(w.toLowerCase()) && !FAMILY.test(w) && !require("./pulse-facts").knownName(w, facts));
  const relations = (t.match(new RegExp(FAMILY.source, "gi")) || []).map((w) => w.toLowerCase());
  return [...new Set([...names, ...relations])].slice(0, 6);
}

// The one person to ask about, { who, kind, question }, or null. Code finds
// the words; the LLM only says which, if any, is someone in their life the
// facts do not place: asked openly "is there anyone?", it missed a dad named
// only as "Dad" half the time.
async function whoToAsk({ userId, store, message, ask }) {
  // Only what they wrote: a message they reply to comes in front of it, quoted.
  message = require("./project-rules").splitReply(message).rest;
  if (!worthChecking(message)) return null;
  const facts = (store && store.facts) || {};
  const before = new Set([...asked(store), ...ownNames(store)]);
  // One person under any of their names (lib/people.js): someone a Pinned Fact
  // or a relation they were saved under already places, or who was asked
  // about under another of their names, is not asked about again.
  const people = await require("./people").load(userId, { facts });
  const askedAbout = (w) => people.find(w).some((p) => p.names.some((n) => before.has(n.name.toLowerCase())));
  const words = candidates(message, facts).filter((w) => !before.has(w.toLowerCase()) && !people.placedName(w) && !askedAbout(w));
  if (!words.length) return null;
  const known = Object.entries(facts).filter(([k]) => !k.startsWith("_"))
    .map(([, f]) => (f && f.value !== undefined ? f.value : f)).filter(Boolean).join("\n").slice(0, 4000);
  const given = String(store?.profile?.settings?.bot_name || "").trim();
  const content = `Someone wrote this to their personal assistant, Closedhand${given && given.toLowerCase() !== "closedhand" ? `, which they call ${given}` : ""}:
"""${String(message).slice(0, 1500)}"""

What the assistant knows about the people in their life (Pinned Facts):
${known || "(nothing yet)"}

Words from the message: ${JSON.stringify(words)}

Which one of these words, if any, is a person in their own life (family, a friend, their partner's family) whom neither the facts nor the message itself place? For a name, placing them is saying who they are to them; for a relation (dad, sister), it is giving the name of that relative of theirs (not of their partner's). A first name on its own, for someone who says, sends or does something, is someone in their life unless the message or the facts show otherwise. Not a place, business, brand, professional, public figure or someone in the news, and not someone who has died. Return ONLY JSON: {"ask": "the word" or null}`;
  let raw;
  if (ask) raw = await ask(content);
  else {
    // Their own LLM, as Pulse asks it: the light summaries model said no to
    // every name, the main one answers as a person would.
    const { client, model } = require("./llm").getUserLLMClient(userId, store);
    const res = await require("./task-model").modelCall(client, { model, max_tokens: 2000, messages: [{ role: "user", content }] }, { purpose: "ask_who", timeoutMs: 60000 });
    raw = require("./model-wire").responseText(res);
  }
  let t;
  try { t = JSON.parse(String(raw || "").match(/\{[\s\S]*\}/)?.[0] || "null"); } catch { return null; }
  const who = t && typeof t.ask === "string" ? t.ask.trim().slice(0, 60) : "";
  if (!who || !words.some((w) => w.toLowerCase() === who.toLowerCase())) return null;
  const kind = FAMILY.test(who) ? "relation" : "name";
  return { who, kind, question: questionFor(who, kind) };
}

// After the turn: still unplaced (a name a fact pinned during the turn now
// covers is not asked about), then asked, and noted so it is asked once.
async function addQuestion({ userId, store, check, reply }) {
  const found = await check;
  if (!found) return reply;
  if (found.kind === "name" && require("./pulse-facts").knownName(found.who, store && store.facts)) return reply;
  await require("./profile-settings").updateSettings(userId, (s) => { s.asked_who = [...(s.asked_who || []), found.who.toLowerCase()].slice(-500); }, { store }).catch(() => {});
  return `${String(reply).trim()}\n[[next]]\n${found.question}`;
}

module.exports = { worthChecking, candidates, questionFor, ownNames, whoToAsk, addQuestion };
