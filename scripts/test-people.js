// One person, however many names and addresses they go by (lib/people.js).
// A dad saved on the phone as "Dad" moved, as WhatsApp is moving everyone, to
// a private id carrying the name he gives himself; Closedhand had him as two
// people, read a chat of his that had stopped two weeks earlier, and asked
// who he was. Invented people and ids throughout.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const people = require("../lib/people");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
function load(file, stubs) {
  const full = require.resolve(path.join("..", file));
  delete require.cache[full];
  const real = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.call(this, request, parent, isMain);
  };
  try { return require(full); } finally { Module._load = real; }
}

const PN = "447700900123@s.whatsapp.net", LID = "88001122334455@lid";
const MUM_PN = "447700900456@s.whatsapp.net", MUM_LID = "88009988776655@lid";
const world = () => people.build({
  userName: "Sam Fixture",
  links: [{ a: people.wa(LID), b: people.wa(PN) }, { a: people.wa(MUM_LID), b: people.wa(MUM_PN) }],
  names: [
    { handle: people.wa(PN), name: "Dad", kind: "saved" },
    { handle: people.wa(LID), name: "Rowan", kind: "own" },
    { handle: people.wa(MUM_PN), name: "Mum ❤️", kind: "saved" },
    { handle: people.wa(MUM_LID), name: "Wren", kind: "own" },
    { handle: people.wa("447700900789@s.whatsapp.net"), name: "Theo", kind: "own" },
    { handle: people.wa("88005544332211@lid"), name: "Theo", kind: "own" },
    { handle: people.wa("120363000000000000@g.us"), name: "House Hunt", kind: "chat" },
  ],
  facts: {
    "family-dad-rowan": { value: "Sam's father is called Rowan and lives in Alnwick; he writes from rowan.pike@example.org.", category: "person", subject: "Rowan" },
    "family-wife-ana": { value: "Sam's wife is Ana. Ana's father has died; his birthday recurs in the calendar.", category: "person", subject: "Ana" },
    "profile-name": { value: "Sam Fixture", category: "profile", subject: "Sam Fixture" },
  },
});

test("a person's ids, names, relation and address are one person; a shared first name never joins two", () => {
  const p = world();
  const [dad] = p.find("dad");
  assert.ok(dad, "dad is someone");
  assert.deepEqual(dad.chats.sort(), [LID, PN].sort(), "the chat saved as Dad and the one WhatsApp moved to his private id");
  assert.deepEqual(dad.emails, ["rowan.pike@example.org"], "and the address his Pinned Fact gives");
  assert.deepEqual(dad.facts, ["family-dad-rowan"]);
  assert.equal(p.describe(dad), "Rowan, your dad");
  assert.equal(p.find("Rowan")[0], dad);
  assert.equal(p.find("rowan.pike@example.org")[0], dad);
  assert.equal(p.ofChat(LID), dad);
  assert.equal(p.find("Theo").length, 2, "two Theos stay two people");
  const [ana] = p.find("wife");
  assert.equal(ana.name, "Ana");
  assert.equal(p.find("father").length, 1, "\"Ana's father\" is not Sam's father");
  assert.equal(p.find("house hunt").length, 0, "a group is a chat, never a person");
  assert.equal(p.find("Sam Fixture").length, 0, "nor is the person themselves");
});

test("placed: by a Pinned Fact, or by the relation they were saved under when their name is known too", () => {
  const p = world();
  assert.equal(p.placedName("Rowan"), true);
  assert.equal(p.placedName("Wren"), true, "saved as Mum, calls herself Wren");
  assert.equal(p.placedName("mum"), true);
  assert.equal(p.placedName("Theo"), false);
  assert.equal(p.placedName("Bea"), false);
  assert.equal(p.contactLine(), 'WHO IS WHO IN THEIR CONTACTS (as they saved them): Wren is their mum (saved as "Mum ❤️").', "only what no Pinned Fact already says");
  const only = people.build({ names: [{ handle: people.wa(PN), name: "Dad", kind: "saved" }] });
  assert.equal(only.placedName("dad"), false, "a relation with no name for them is not placed: the name is worth asking");
  assert.equal(only.describe(only.find("dad")[0]), "your dad", "and a relation is never used as their name");
  const bracket = people.build({ userName: "Sam", facts: { "family-mum-wren": { value: "Sam's mother is Wren.", category: "person", subject: "Wren (Sam's mother)" } } });
  assert.equal(bracket.describe(bracket.find("mum")[0]), "Wren, your mum", "a fact's subject is a name, not its note");
});

test("a search for a person brings their other names and addresses, and a name many share brings none", () => {
  const p = world();
  assert.deepEqual(p.expand(["dad"]).sort(), ["rowan", "rowan.pike@example.org"].sort());
  assert.deepEqual(p.expand(["Rowan", "venue"]).sort(), ["dad", "rowan.pike@example.org"].sort());
  assert.deepEqual(p.expand(["Alnwick"]), []);
  const crowd = people.build({ names: ["1", "2", "3", "4"].map((n) => ({ handle: people.wa(`4477009000${n}@s.whatsapp.net`), name: "Sam " + n, kind: "own" })) });
  assert.deepEqual(crowd.expand(["sam"]), [], "four people called Sam: no guessing which");
  assert.match(read("lib/services/usi.js"), /asked\.concat\(await require\("\.\.\/people"\)\.load\(userId\)\.then\(\(p\) => p\.expand\(asked\)\)/, "recall and mail search");
  assert.match(read("lib/services/data-sync.js"), /asked\.concat\(await peopleOf\.load\(userId\)\.then\(\(p\) => p\.expand\(asked\)\)/, "and the cache search");
});

test("Pulse and the chat do not ask who someone is whom a fact or their saved relation places, nor again under another name", async () => {
  const facts = require("../lib/pulse-facts");
  const row = (chat, chat_name) => ({ type: "message", data: { chat, chat_name } });
  const p = world();
  assert.equal(facts.unknownPerson([row(LID, "Rowan")], {}, []), "Rowan", "without people, a name no fact holds");
  assert.equal(facts.unknownPerson([row(LID, "Rowan")], {}, [], p), null, "with them, the chat WhatsApp moved from the number saved as Dad");
  assert.equal(facts.unknownPerson([row(MUM_LID, "Wren")], {}, [], p), null);
  const theo = people.build({ links: [{ a: people.wa(LID), b: people.wa(PN) }], names: [{ handle: people.wa(PN), name: "Teddy", kind: "saved" }, { handle: people.wa(LID), name: "Theo", kind: "own" }] });
  assert.equal(facts.unknownPerson([row(LID, "Theo")], {}, ["teddy"], theo), null, "asked about once, under any of their names");
  assert.equal(facts.unknownPerson([row(LID, "Theo")], {}, [], theo), "Theo");
  assert.match(read("lib/pulse.js"), /store\.facts, \[\.\.\.\(settings\.asked_who \|\| \[\]\), \.\.\.require\("\.\/ask-who"\)\.ownNames\(store\)\], people\)/);
  assert.match(read("lib/pulse.js"), /factsProse\(store\.facts, \{ handles: false \}\), people\.contactLine\(\)/, "Pulse is told who is who as their contacts say");
  assert.match(read("lib/ask-who.js"), /!people\.placedName\(w\) && !askedAbout\(w\)/);
  assert.match(read("lib/engine.js"), /require\("\.\/people"\)\.load\(userId, \{ facts: ctx\.store\?\.facts \}\)\.then\(\(p\) => p\.contactLine\(\)\)/, "and so is the chat");
});

test("reading a chat by a person reads every chat they are in on their own, in order", async () => {
  const rows = [
    { user_id: "u1", type: "message", source: "whatsapp", external_id: "wa-1", received_at: new Date(Date.now() - 20 * 86400000).toISOString(), data: { chat: PN, chat_name: "Dad", sender: "Rowan", text: "Booked the van for Saturday" } },
    { user_id: "u1", type: "message", source: "whatsapp", external_id: "wa-2", received_at: new Date(Date.now() - 2 * 86400000).toISOString(), data: { chat: LID, chat_name: "Rowan", sender: "Rowan", text: "office@harbour-homes.example" } },
    { user_id: "u1", type: "message", source: "whatsapp", external_id: "wa-3", received_at: new Date(Date.now() - 86400000).toISOString(), data: { chat: MUM_LID, chat_name: "Wren", sender: "Wren", text: "Lunch Sunday?" } },
  ];
  const get = (r, k) => (k.startsWith("data->>") ? r.data[k.slice(7)] : r[k]);
  const db = { from: () => {
    const f = [], q = { limit: 1e9, desc: false };
    const c = {
      select: () => c, eq: (k, v) => (f.push((r) => get(r, k) === v), c), in: (k, vs) => (f.push((r) => vs.includes(get(r, k))), c),
      ilike: (k, pat) => { const re = new RegExp("^" + pat.replace(/%/g, ".*") + "$", "i"); f.push((r) => re.test(String(get(r, k) || ""))); return c; },
      gte: (k, v) => (f.push((r) => get(r, k) >= v), c), order: (k, o) => ((q.desc = !o.ascending), c), limit: (n) => ((q.limit = n), c),
      then: (res) => { const out = rows.filter((r) => f.every((t) => t(r))).sort((a, b) => (q.desc ? -1 : 1) * a.received_at.localeCompare(b.received_at)); return res({ data: out.slice(0, q.limit), error: null }); },
    };
    return c;
  } };
  const sync = load("lib/services/data-sync.js", { "../../user-store": { supabase: db }, "../people": { load: async () => world() } });
  const dad = await sync.queryChat("u1", { chat: "dad", query: "*", days: 30 });
  assert.equal(dad.chat, "Rowan, your dad");
  assert.deepEqual(dad.results.map((r) => r.text), ["Booked the van for Saturday", "office@harbour-homes.example"], "both of his chats, oldest first, nobody else's");
  const byName = await sync.queryChat("u1", { chat: "Rowan", query: "*", days: 30 });
  assert.equal(byName.results.length, 2, "by the name he gives himself too");
  const byOldName = await sync.queryChat("u1", { chat: "wa-1", query: "*", days: 30 });
  assert.equal(byOldName.results.length, 2, "and by a message in either chat");
});

test("WhatsApp says who is who: its pairing of ids, saved names and the names people give themselves; nothing for groups", () => {
  const wa = read("lib/platforms/whatsapp-linked.js");
  assert.match(wa, /sock\.ev\.on\("lid-mapping\.update", \(m\) => \{ if \(m && m\.lid && m\.pn\) notePeople\(\{ id: m\.lid, phoneNumber: m\.pn \}\); \}\);/);
  assert.match(wa, /named\.push\(\.\.\.learnContact\(_chatNames, c, bareJid\)\); notePeople\(c\);/);
  assert.match(wa, /const alt = jid\.endsWith\("@g\.us"\) \? msg\.key\.participantAlt : msg\.key\.remoteJidAlt;/, "each message's other id");
  assert.match(wa, /pairStoredIds\(sock\)/, "and the chats already stored, paired when it links");
  assert.match(wa, /\.filter\(\(j\) => !j\.endsWith\("@g\.us"\) && !isSelfJid\(j\)\)/);
  const server = read("webapp/server.js");
  assert.match(server, /"person_links", "person_names",/, "deleting the account deletes them");
  assert.match(server, /from\("person_links"\)\.delete\(\)\.eq\("user_id", userId\)\.eq\("source", "whatsapp"\)/, "disconnecting WhatsApp deletes what it said");
  assert.match(read("migrations/089_people.sql"), /PRIMARY KEY \(user_id, handle, kind\)/);
});
