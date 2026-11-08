const { test } = require('node:test');
const assert = require('node:assert/strict');
const { factsProse } = require('../lib/facts-prose');
test('facts read as grouped sentences with the key as a handle, never as JSON', () => {
  const out = factsProse({
    'person-mei': { value: "Mei is Sam's girlfriend; she is a nurse", category: 'person', subject: 'Mei', source: 'chat' },
    'profile-name': { value: 'Sam', category: 'profile', subject: 'Sam', source: 'setup scan' },
    'profile-company': { value: 'Acme Goods (Shopify store operator)', category: 'profile', subject: 'Sam' },
    'boss-email': 'ann@acme.example',
    '_onboarded': { value: '2026-09-09' },
    'flight-XY646-2026-09-16': { value: '{"airline":"ExampleAir"}' },
    'pulse_last': { value: 'x' },
  });
  assert.doesNotMatch(out, /[{}"]/, 'no JSON punctuation');
  assert.doesNotMatch(out, /_onboarded|flight-|pulse/, 'internal rows stay out');
  const about = out.indexOf('About the user:'), people = out.indexOf('People in their life:'), other = out.indexOf('Other:');
  assert.ok(about > 0 && people > about && other > people, 'groups in a fixed order');
  assert.match(out, /- Name: Sam\. \(read from mail by the setup scan\) \[profile-name\]/);
  assert.match(out, /- Company: Acme Goods \(Shopify store operator\)\. \[profile-company\]/, 'profile facts are labelled by what they are');
  assert.match(out, /- Mei is Sam's girlfriend; she is a nurse\. \[person-mei\]/, 'a value that starts with its subject is not prefixed');
  assert.match(out, /- ann@acme\.example\. \[boss-email\]/, 'a plain string fact still shows');
  assert.equal(factsProse({ _x: 'y' }), '', 'nothing to say gives an empty string');
});

const read = (f) => require("node:fs").readFileSync(require("node:path").join(__dirname, "..", f), "utf8");

// Pinned Facts follow what the person says to everyone, not only to
// Closedhand (lib/facts-follow.js): told a clinic their partner was
// expecting, Closedhand, which reads that chat, still had only what was said
// to it. Invented people and words only.
function followHarness(facts) {
  const ctx = require("../lib/context");
  ctx.store = { facts, profile: { settings: { preferred_name: "Robin" } } };
  const sPath = require.resolve("../lib/storage");
  require.cache[sPath] = { id: sPath, filename: sPath, loaded: true, exports: { saveStore() {} } };
  const mPath = require.resolve("../lib/facts-follow");
  delete require.cache[mPath];
  return { mod: require("../lib/facts-follow"), restore() { delete require.cache[sPath]; delete require.cache[mPath]; ctx.store = null; } };
}
const NOW = Date.parse("2026-12-01T09:00:00Z");
const words = [
  { n: 1, at: NOW - 3600000, where: "WhatsApp to Clinica Sorriso", text: "Sorry to move it at short notice, my wife Ana is pregnant and has had complications, so I need to stay home." },
  { n: 2, at: NOW - 1800000, where: "WhatsApp to Dana Fixture", text: "See you at 7!" },
];

test("what the person wrote to anyone becomes a Pinned Fact only on their own words, written through pin_fact", async () => {
  const facts = { "family-partner": { value: "Robin's wife is Ana Fixture.", category: "person", subject: "Ana Fixture", source: "chat" } };
  const { mod, restore } = followHarness(facts);
  try {
    let shown = null;
    const pinned = [];
    const judge = async (u, w, prose, name) => { shown = { w, prose, name }; return [
      { key: "[family-partner]", category: "person", subject: "Ana Fixture", adds: "She is expecting their first child.", replaces: "", n: 1, quote: "my wife Ana is pregnant" },
      { key: "work-employer", category: "business", subject: "Example Freight", adds: "Robin works for Example Freight.", replaces: "", n: 2, quote: "I work at Example Freight" },
      { key: "_pulse_last", category: "topic", subject: "x", adds: "Something long enough here.", replaces: "", n: 1, quote: "my wife Ana is pregnant" },
    ]; };
    const r = await mod.review("u1", { now: NOW, words: async () => words, judge, pin: async (f) => { pinned.push(f); } });
    assert.equal(shown.name, "Robin");
    assert.match(shown.prose, /\[family-partner\]/, "the facts it may rewrite, by key");
    assert.deepEqual(pinned.map((f) => f.key), ["family-partner"], "on the person's own words only, once a note however many readings found it; a key of Closedhand's own is never written");
    assert.deepEqual(mod.readRecord({ "_facts-follow": JSON.stringify({ looked: "2026-11-30T00:00:00Z", since: "2026-11-30T00:00:00Z" }) }), { v: 2 }, "a look by older rules is read again");
    assert.equal(pinned[0].from, "your WhatsApp to Clinica Sorriso, Tue 1 Dec");
    assert.equal(pinned[0].value, "Robin's wife is Ana Fixture. She is expecting their first child.", "added to what the note said, nothing lost");
    assert.equal(r.read, 2);
    assert.equal(mod.readRecord(facts).since, new Date(NOW - 1800000).toISOString(), "the next look reads only what came after");
    // A second note about the same person goes into the one there is.
    const again = await mod.review("u1", { now: NOW + 7200000, words: async () => [{ ...words[0], n: 1, at: NOW + 3600000 }], judge: async () => [{ key: "family-baby", category: "person", subject: "Ana Fixture (Ana), Robin's wife", adds: "Ana Fixture is expecting a baby.", replaces: "", n: 1, quote: "my wife Ana is pregnant" }], pin: async (f) => { pinned.push(f); } });
    assert.deepEqual([again.pinned[0].key, again.pinned[0].subject], ["family-partner", "Ana Fixture"], "one note per subject, under its own name");
    const sum = await mod.review("u1", { now: NOW + 9000000, words: async () => [{ ...words[0], n: 1, at: NOW + 8000000 }], judge: async () => [{ key: "family-partner", category: "person", subject: "Ana Fixture", adds: "Ana Fixture is expecting a baby, due in 2027.", replaces: "", n: 1, quote: "my wife Ana is pregnant" }], pin: async (f) => { pinned.push(f); } });
    assert.deepEqual(sum.pinned, [], "a year nobody wrote is not a fact");
    const dated = await mod.review("u1", { now: NOW + 11000000, words: async () => [{ ...words[0], n: 1, at: NOW + 10000000 }], judge: async () => [{ key: "family-partner", category: "person", subject: "Ana Fixture", adds: "She was expecting their first child as of December 2026.", replaces: "", n: 1, quote: "my wife Ana is pregnant" }], pin: async (f) => { pinned.push(f); } });
    assert.equal(dated.pinned.length, 1, "the year they wrote it in is theirs");
    facts["family-partner"].value = "Robin's wife is Ana Fixture. She lives in Lisbon. She was expecting their first child as of December 2026.";
    const same = await mod.review("u1", { now: NOW + 13000000, words: async () => [{ ...words[0], n: 1, at: NOW + 12000000 }], judge: async () => [{ key: "family-partner", category: "person", subject: "Ana Fixture", adds: "She was expecting their first child as of December 2026.", replaces: "", n: 1, quote: "my wife Ana is pregnant" }], pin: async (f) => { pinned.push(f); } });
    assert.deepEqual(same.pinned, [], "a note with nothing new is left as it was");
    const moved = await mod.review("u1", { now: NOW + 15000000, words: async () => [{ ...words[0], n: 1, at: NOW + 14000000 }], judge: async () => [{ key: "family-partner", category: "person", subject: "Ana Fixture", adds: "She lives in Porto.", replaces: "She lives in Lisbon.", n: 1, quote: "my wife Ana is pregnant" }], pin: async (f) => { pinned.push(f); } });
    assert.equal(moved.pinned[0].value, "Robin's wife is Ana Fixture. She lives in Porto. She was expecting their first child as of December 2026.", "only the sentence their words make untrue is replaced");
  } finally { restore(); }
});

test("facts follow at most once an hour, skip the person's chats with Closedhand, and are kept through pin_fact", async () => {
  const facts = {};
  const { mod, restore } = followHarness(facts);
  try {
    let read = 0;
    const deps = { words: async () => { read++; return []; } };
    await mod.review("u1", deps);
    await mod.review("u1", deps);
    assert.equal(read, 1, "once an hour");
  } finally { restore(); }
  const src = read("lib/facts-follow.js");
  assert.match(src, /if \(!d\.text \|\| closedhand\.has\(String\(d\.chat\)\)\) continue;/, "their chat with Closedhand is not 'what they wrote to others'");
  assert.match(src, /\.eq\("data->>sender", "me"\)/, "their side of each chat");
  assert.match(src, /require\("\.\/tools\/handlers"\)\.handleInternalTool\("pin_fact", \{ key: held\.key, value: held\.value, category: held\.category, subject: held\.subject, _userId: userId \}\);/, "one note per subject, as pin_fact keeps it");
  assert.match(src, /if \(isNew\) kept\.source = "own words"; kept\.from = held\.from;/, "and says where it came from");
});
