// Closedhand asks, once, about someone in the person's life it cannot place,
// rather than guessing who they are; a fact told in the same step as a change
// that waits for their yes is pinned at once; and a Pinned Fact's subject is
// a name alone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const a = require("../lib/ask-who");

const facts = {
  "family-partner": { value: "Sam's partner is Mina. Mina's father has died.", subject: "Mina" },
  "family-sister": { value: "Rosa is Sam's sister. Her birthday is 11 September.", subject: "Rosa" },
  _pulse_last: { value: "Kai asked whether you'll be back before the 20th." },
};
const store = (asked = []) => ({ facts, profile: { settings: { asked_who: asked } } });

test("only names no Pinned Fact covers, and family words, are candidates", () => {
  assert.deepEqual(a.candidates("Is Bea's birthday in my diary recurring annually?", facts), ["Bea"]);
  assert.deepEqual(a.candidates("Is Al coming?", facts), ["Al"], "a short name too");
  assert.deepEqual(a.candidates("Dad's bday is 3 Mar", facts), ["dad"], "not the month, nor Dad twice");
  assert.deepEqual(a.candidates("Can you remind me to call Minako tomorrow", facts), [], "a fact's short form covers the name");
  assert.deepEqual(a.candidates("Did Dr Okafor confirm the time?", facts), [], "a name after a title is a professional's");
  assert.deepEqual(a.candidates("Kai says they're coming on the 20th", facts), ["Kai"], "Closedhand's own notes do not make someone known");
  assert.equal(a.worthChecking("Have I got anything coming up?"), false, "no name, no family word: no question asked of the LLM");
});

test("one narrow question to their LLM picks who to ask about, once, in Pulse's words", async () => {
  const seen = [];
  const said = (answer) => async (content) => { seen.push(content); return answer; };
  assert.deepEqual(await a.whoToAsk({ store: store(), message: "Is Bea's birthday in my diary recurring annually?", ask: said('{"ask": "Bea"}') }),
    { who: "Bea", kind: "name", question: "Who's Bea to you, and where do they live? Tell me once and I'll remember." });
  assert.match(seen[0], /Words from the message: \["Bea"\]/);
  assert.match(seen[0], /Not a place, business, brand, professional, public figure or someone in the news, and not someone who has died\./);
  assert.deepEqual(await a.whoToAsk({ store: store(), message: "Dad's bday is 3 Mar", ask: said('{"ask": "dad"}') }),
    { who: "dad", kind: "relation", question: "What's your dad's name, and where do they live? Tell me once and I'll remember." });
  assert.equal(await a.whoToAsk({ store: store(["bea"]), message: "Is Bea's birthday in my diary recurring annually?", ask: said('{"ask": "Bea"}') }), null, "asked once, by chat or by Pulse");
  assert.equal(await a.whoToAsk({ store: store(), message: "Is Bea's birthday in my diary recurring annually?", ask: said('{"ask": "Bob"}') }), null, "only a word the message holds");
  assert.equal(await a.whoToAsk({ store: store(), message: "Is Bea's birthday in my diary recurring annually?", ask: said("no idea") }), null);
  assert.equal(a.questionFor("Mina's dad", "relation"), "What's Mina's dad's name, and where do they live? Tell me once and I'll remember.");
});

test("the question follows the answer as its own message, unless a fact pinned meanwhile names them", async () => {
  const src = read("lib/ask-who.js");
  assert.match(src, /s\.asked_who = \[\.\.\.\(s\.asked_who \|\| \[\]\), found\.who\.toLowerCase\(\)\]\.slice\(-500\)/, "the same list Pulse keeps");
  assert.match(src, /return `\$\{String\(reply\)\.trim\(\)\}\\n\[\[next\]\]\\n\$\{found\.question\}`;/);
  const named = { ...facts, "friend-bea": { value: "Bea is Sam's oldest friend, in Porto.", subject: "Bea" } };
  assert.equal(await a.addQuestion({ store: { facts: named }, check: Promise.resolve({ who: "Bea", kind: "name", question: "?" }), reply: "Yes." }), "Yes.");
  const engine = read("lib/engine.js");
  assert.match(engine, /if \(!askWhoCheck\) askWhoCheck = require\("\.\/ask-who"\)\.whoToAsk\(\{ userId, store: ctx\.activeUserStore, message: userMessage \}\)\.catch\(\(\) => null\);\n\s*const recalled = fetchRelevantContext/, "beside the turn's recall");
  assert.ok(engine.indexOf('require("./ask-who").addQuestion(') < engine.indexOf('finalText = require("./follow-on").withBreaks(finalText);'), "before the reply is split");
  assert.ok(engine.indexOf('require("./ask-who").addQuestion(') > engine.indexOf("Run ended at a confirmation gate"), "never on a reply that waits for a yes");
});

test("a fact pinned in the same step as a change that waits for a yes is pinned at once", () => {
  const engine = read("lib/engine.js");
  const at = engine.indexOf('console.log("Calling internal tool: pin_fact (before asking to confirm)");');
  assert.ok(at > 0 && at < engine.indexOf("ctx.pendingConfirmations[userId] = {"), "before the change is held for the yes");
  assert.match(engine, /if \(otherBlock\.type !== "tool_use" \|\| otherBlock\.name !== "pin_fact" \|\| otherBlock\.id === block\.id/);
});

test("a fact's subject is a name alone, however it was given", () => {
  const { subjectName } = require("../lib/own-name");
  assert.equal(subjectName("Jo (Sam's mother)"), "Jo");
  assert.equal(subjectName("Rosa"), "Rosa");
  assert.equal(subjectName(null), null);
  assert.equal(read("lib/own-name.js"), read("webapp/own-name.js"), "the same rule in both services");
  assert.match(read("lib/tools/handlers.js"), /const subject = subjectName\(toolInput\.subject \|\| \(existing && existing\.subject\)\) \|\| null;/);
  assert.match(read("webapp/server.js"), /subject = require\("\.\/own-name"\)\.subjectName\(subject\);/);
  assert.match(read("webapp/views/dashboard.html"), /return String\(n\.subject \|\| ''\)\.replace\(\/\\s\*\\\(\[\^\)\]\*\\\)\\s\*\$\/, ''\)\.trim\(\) \|\| key\.replace/, "and shown so on the dashboard, older facts too");
});

test("the assistant is never someone to ask about, by its name or the one they gave it, and a quoted message is not theirs", async () => {
  const asked = [];
  const ask = async (content) => { asked.push(content); return '{"ask": "Closedhand"}'; };
  const reply = `[replying to Closedhand's message: "Right, and that matters: Rowan agreed in principle."]\nDid I offer him fixed instalments? But not tied to sales?`;
  assert.equal(await a.whoToAsk({ store: store(), message: reply, ask }), null, "the quote's label and words are not what they wrote");
  assert.equal(asked.length, 0, "and no question goes to their LLM");
  assert.equal(await a.whoToAsk({ store: store(), message: "Thanks Closedhand, that helps", ask }), null, "nor its name in their own words");
  const named = { facts, profile: { settings: { asked_who: [], bot_name: "Juno Max" } } };
  assert.equal(await a.whoToAsk({ store: named, message: "Can Juno check this", ask }), null, "nor the name they gave it");
  assert.deepEqual(a.ownNames(named), ["closedhand", "juno max", "juno", "max"]);
  await a.whoToAsk({ store: named, message: "Is Bea coming?", ask: async (content) => { asked.push(content); return '{"ask": "Bea"}'; } });
  assert.match(asked.at(-1), /their personal assistant, Closedhand, which they call Juno Max:/, "the check is told who the assistant is");
  assert.match(read("lib/pulse.js"), /facts\.unknownPerson\([^\n]*require\("\.\/ask-who"\)\.ownNames\(store\)/, "Pulse leaves its names out too");
});
