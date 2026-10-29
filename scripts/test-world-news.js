// What is new in the world on what a person follows (lib/world-news.js), and
// how Pulse takes it in (lib/pulse.js, lib/pulse-triage.js). Feeds and LLM
// are stand-ins; invented stories only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const world = require("../lib/world-news");

const root = path.join(__dirname, "..");
const NOW = Date.parse("2026-11-10T09:00:00Z");
const ago = (h) => new Date(NOW - h * 3600000).toUTCString();
const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.date}</pubDate>${i.source ? `<source url="https://wire.example.com">${i.source}</source>` : ""}</item>`).join("")}</channel></rss>`;

test("a feed's stories: title, link, when and publisher, with the publisher taken off Google's titles", () => {
  const stories = world.parse(rss([
    { title: "<![CDATA[Ferris &amp; friends ship a faster compiler - Example Wire]]>", link: "https://news.example.com/a", date: ago(2), source: "Example Wire" },
    { title: "Plain http is left out", link: "http://news.example.com/b", date: ago(2) },
    { title: "", link: "https://news.example.com/c", date: ago(2) },
  ]));
  assert.deepEqual(stories, [{ title: "Ferris & friends ship a faster compiler", link: "https://news.example.com/a", date: ago(2), source: "Example Wire" }]);
});

test("the newest unseen stories from the last three days, a few for each subject, the same story only once", async () => {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    if (url.includes("news.google.com") && url.includes("Formula")) return { ok: false, text: async () => "" };
    const many = url.includes("Formula")
      ? [1, 2, 3, 4, 5, 6].map((n) => ({ title: `Race report ${n}`, link: `https://news.example.com/f1/${n}`, date: ago(n) }))
      : [
          { title: "Compiler 2.0 is out - Example Wire", link: "https://news.example.com/r1", date: ago(5), source: "Example Wire" },
          { title: "Compiler 2.0 is out", link: "https://other.example.com/r1-copy", date: ago(4) },
          { title: "An old roundup", link: "https://news.example.com/old", date: ago(24 * 5) },
          { title: "Told last week", link: "https://news.example.com/seen", date: ago(3) },
          { title: "From the future", link: "https://news.example.com/later", date: new Date(NOW + 5 * 3600000).toUTCString() },
          { title: "Undated", link: "https://news.example.com/undated", date: "" },
        ];
    return { ok: true, text: async () => rss(many) };
  };
  const seenBefore = (await world.news([{ subject: "Rust", kind: "follow" }], { now: NOW, get: async () => ({ ok: true, text: async () => rss([{ title: "Told last week", link: "https://x.example.com", date: ago(1) }]) }), pause: async () => {} }))[0].key;
  asked.length = 0;
  const found = await world.news([{ subject: "Rust", kind: "follow" }, { subject: "Formula 1", kind: "follow" }], { seen: new Set([seenBefore]), now: NOW, get, pause: async () => {} });
  assert.ok(found.every((f) => f.kind === "follow"), "each story keeps its subject's kind");
  assert.deepEqual(found.filter((f) => f.subject === "Rust").map((f) => f.title), ["Compiler 2.0 is out"], "the same story once; old, seen, future and undated left out");
  assert.deepEqual(found.filter((f) => f.subject === "Formula 1").map((f) => f.title), ["Race report 1", "Race report 2", "Race report 3", "Race report 4"], "newest first, a few per subject");
  assert.ok(asked.some((u) => u.startsWith("https://www.bing.com/news/search?q=Formula%201&format=rss")), "Bing when Google gives nothing");
  for (const u of asked) assert.match(u, /^https:\/\/(news\.google\.com|www\.bing\.com)\/[^?]*\?q=(Rust|Formula%201)(%20when%3A3d)?&/, "only the subject goes to the feeds");
});

test("subjects are specific and few, each marked as followed or being done; nothing known asks nothing", async () => {
  let asked = 0;
  const ask = async (system, content) => {
    asked++;
    assert.match(system, /Only subjects the information below shows; never invent one\./);
    assert.match(system, /Public figures only, never a person they know\./);
    assert.match(content, /PINNED FACTS:\nLoves trail running/);
    assert.match(content, /WHAT THEY WROTE in the last month \(their own messages, mail and posts\):\nSaw the new compiler release, it is fast/);
    assert.match(system, /Then it is "doing", named as the news would name it: the treatment, never the appointment, booking, order or prescription\. If neither, leave it out\. Something they are having done is never "follow"\. Each subject once, in one kind\./);
    return "1. follow: Rust programming language\n- doing: Kitchen renovation\nfollow: \"Kyoto\"\nfollow: mail@example.com\nfollow: https://example.com\nfollow: Rust programming language\nfollow: A\nTrail running\nfollow: Formula 1\nfollow: Sourdough\nfollow: Jazz\nfollow: Chess\nfollow: Go";
  };
  assert.deepEqual(await world.subjects({ facts: "Loves trail running.", writing: ["Saw the new compiler release, it is fast"] }, ask), [
    { subject: "Rust programming language", kind: "follow" }, { subject: "Kitchen renovation", kind: "doing" }, { subject: "Kyoto", kind: "follow" },
    { subject: "Formula 1", kind: "follow" }, { subject: "Sourdough", kind: "follow" }, { subject: "Jazz", kind: "follow" }], "unmarked lines are left out");
  assert.deepEqual(await world.subjects({ facts: "x" }, async () => "NONE"), []);
  assert.deepEqual(await world.subjects({}, async () => { throw new Error("never asked"); }), []);
  assert.equal(asked, 1);
});

test("once a day, never at the lowest level, subjects worked out weekly, and each story offered once", async () => {
  const saved = [];
  const save = async (set) => { saved.push(set); Object.assign(store.profile.settings, set); };
  const store = { facts: { trail: { value: "Loves trail running" } }, goals: [], profile: { settings: {} } };
  const get = async () => ({ ok: true, text: async () => rss([{ title: "A new trail opens", link: "https://news.example.com/trail", date: ago(1) }]) });
  let asks = 0;
  const ask = async () => { asks++; return "follow: Trail running"; };
  assert.deepEqual(await world.forPulse(store, { level: "low", ask, save, now: NOW, get }), [], "no news clears the lowest bar");
  assert.equal(asks, 0);
  const first = await world.forPulse(store, { level: "medium", ask, save, now: NOW, get });
  assert.deepEqual(first.map((s) => s.title), ["A new trail opens"]);
  assert.deepEqual(store.profile.settings.world_topics.list, [{ subject: "Trail running", kind: "follow" }]);
  await world.offered(store, first, save, NOW);
  assert.deepEqual(await world.forPulse(store, { level: "medium", ask, save, now: NOW + 3600000, get }), [], "not again within the day");
  assert.deepEqual(await world.forPulse(store, { level: "high", ask, save, now: NOW + 21 * 3600000, get }), [], "the story told or not is never offered again");
  assert.equal(asks, 1, "subjects kept for the week");
  await world.forPulse(store, { level: "high", ask, save, now: NOW + 8 * 86400000, get });
  assert.equal(asks, 2, "worked out again after a week");
  store.profile.settings.world_seen = Array.from({ length: 600 }, (_, i) => "k" + i);
  await world.offered(store, [{ key: "new" }], save, NOW);
  assert.equal(store.profile.settings.world_seen.length, 500);
  assert.equal(store.profile.settings.world_seen.at(-1), "new");
});

test("Pulse judges the day's news with everything else, by the same bar, and gives the link", () => {
  const pulse = fs.readFileSync(path.join(root, "lib/pulse.js"), "utf8");
  const triage = fs.readFileSync(path.join(root, "lib/pulse-triage.js"), "utf8");
  assert.match(pulse, /const world = await worldNews\.forPulse\(store, \{ level, projects, ask: askSubjects, save: saveSettings, writing \}\)/);
  assert.match(pulse, /\(r\.type === "message" && r\.sender === "me"\) \|\| \(r\.type === "email" && Array\.isArray\(r\.labels\) && r\.labels\.includes\("SENT"\)\)/, "only what they wrote themselves");
  assert.match(pulse, /realEmails\.length === 0 && otherItems\.length === 0 && !world\.length && !enteringSoon && !lookDue/, "the day's news wakes the look");
  assert.match(pulse, /if \(world\.length\) await worldNews\.offered\(store, world, saveSettings\)/, "judged once, after a look that worked");
  assert.match(pulse, /A news story goes with its link, exactly as the item gives it/);
  assert.match(triage, /NEW IN THE WORLD \(public news from the last three days on subjects they follow; not addressed to them\)/);
  assert.match(triage, /General coverage, opinion and what they would see anyway never do\./);
  assert.match(triage, /on something they are doing or planning rather than following \(a treatment, a purchase, a move, an event\), only news that changes it or helps them get it done, such as a breakthrough, a new rule, a disruption or a better option, never coverage of the field, its businesses or tips/);
  assert.match(pulse, /\$\{w\.kind === "doing" \? "something they are doing" : "something they follow"\}/, "each story says which kind it is");
  assert.match(fs.readFileSync(path.join(root, "lib/pulse-tools.js"), "utf8"), /if \(name === "web_fetch"\) return false;/, "Pulse still never opens a link itself");
});
