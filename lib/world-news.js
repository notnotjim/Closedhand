// lib/world-news.js: what is new in the world on the things a person follows,
// for Pulse (lib/pulse.js) to judge alongside everything else in their
// picture, by the same bar. Their main LLM puts what they follow as public
// subjects, from their Pinned Facts, projects and goals, once a week.
// Public news feeds give the stories: they see only the subject ("Rust
// programming language"), never who asks, and cost nothing. Looked at once a
// day, and not at Pulse's lowest level, whose bar no news clears. A story
// offered once is never offered again, told or not.
const crypto = require("crypto");

const DAY = 86400000;
const SUBJECTS_FOR = 7 * DAY;
const LOOK_EVERY = 20 * 3600000;
// Stories from the last three days; older is not news.
const FRESH_FOR = 3 * DAY;
// How many the feeds are asked for, for each subject, and how many subjects:
// what one look can fetch and read, never a limit on what is said.
const PER_SUBJECT = 4;
const MAX_SUBJECTS = 6;
const SEEN_KEPT = 500;

// Google News first, Bing News when Google gives nothing.
const FEEDS = [
  { name: "Google News", url: (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:3d")}&hl=en&gl=US&ceid=US:en` },
  { name: "Bing News", url: (q) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss` },
];

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function text(s) {
  return String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, " ").trim();
}
// A feed's stories: title, link, when, and who published it.
function parse(xml) {
  return [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const tag = (name) => text((item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`)) || [])[1]);
    const source = tag("source") || tag("news:Source");
    let title = tag("title");
    // Google News ends each title with " - <publisher>".
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    return { title, link: tag("link"), date: tag("pubDate"), source };
  }).filter((s) => s.title && /^https:\/\//.test(s.link));
}
// The same story by another link counts as seen too.
const seenKey = (s) => crypto.createHash("sha256").update(s.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).digest("hex").slice(0, 16);

async function feed(subject, get) {
  for (const f of FEEDS) {
    try {
      const response = await get(f.url(subject), { headers: { "User-Agent": "Mozilla/5.0 (compatible; ClosedHand/1.0; +https://closedhand.com)", Accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(10000), redirect: "follow" });
      if (!response.ok) continue;
      const stories = parse(await response.text());
      if (stories.length) return stories;
    } catch (_) { /* the next feed */ }
  }
  return [];
}

// The newest unseen stories from the last three days, for each subject
// ({ subject, kind }).
async function news(topics, { seen = new Set(), now = Date.now(), get = fetch, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const found = [], taken = new Set(seen);
  for (const [i, { subject, kind }] of topics.entries()) {
    if (i) await pause(1000);
    const fresh = (await feed(subject, get))
      .map((s) => ({ ...s, at: Date.parse(s.date) }))
      .filter((s) => Number.isFinite(s.at) && now - s.at <= FRESH_FOR && s.at <= now + 3600000)
      .sort((a, b) => b.at - a.at);
    for (const s of fresh) {
      if (found.filter((f) => f.subject === subject).length >= PER_SUBJECT) break;
      const key = seenKey(s);
      if (taken.has(key)) continue;
      taken.add(key);
      found.push({ subject, kind, title: s.title, link: s.link, source: s.source, date: new Date(s.at).toISOString(), key });
    }
  }
  return found;
}

// What they follow, as subjects anyone could search the news for, from their
// Pinned Facts, projects and goals and what they wrote themselves in the last
// month (messages, mail, posts in any connected app); worked out again each
// week. Only the subject leaves their computer, with nothing that says who
// is asking. Following a subject and doing something are told apart: a
// person in the middle of a treatment, a purchase, a move or a plan wants
// news that changes it or helps get it done (a breakthrough, a new rule, a
// disruption, a better option), not about the field, its businesses or tips,
// while a team, a band or the field they work in is followed for its own sake.
const ASK = `From what a person's assistant knows about them, list up to ${MAX_SUBJECTS} public subjects with news of their own that they would want news about. For each candidate ask: would they read about it for its own sake (a team, a band, a hobby, the field they work in, a technology or brand they are into)? Then it is "follow". If not, but they are in the middle of it or planning it (a treatment, a big purchase, a move, an event they are entering) and news would matter only where it changes it or helps them get it done (a breakthrough, a new rule, a disruption, a better option)? Then it is "doing", named as the news would name it: the treatment, never the appointment, booking, order or prescription. If neither, leave it out. Something they are having done is never "follow". Each subject once, in one kind. Each specific enough to have news of its own; never a whole area like "technology" or "music". Only subjects the information below shows; never invent one. A subject they come back to in what they write counts; one mentioned once in passing does not. Say what it is when the name alone could mean something else, by adding a word such as "band", "football club" or "programming language". Public figures only, never a person they know. One per line as "follow: subject" or "doing: subject", 2 to 5 words each, most important first. If nothing qualifies, answer NONE.`;
async function subjects({ facts = "", projects = [], goals = [], writing = [] }, ask) {
  const known = [facts && "PINNED FACTS:\n" + facts, projects.length && "PROJECTS:\n" + projects.join("\n"), goals.length && "GOALS:\n" + goals.join("\n"),
    writing.length && "WHAT THEY WROTE in the last month (their own messages, mail and posts):\n" + writing.join("\n")].filter(Boolean).join("\n\n");
  if (!known.trim()) return [];
  const raw = String((await ask(ASK, known)) || "");
  if (/^\s*NONE\s*$/i.test(raw)) return [];
  const topics = [], named = new Set();
  for (const line of raw.split("\n")) {
    const m = line.replace(/^[\s\-*\d.)]+/, "").match(/^(follow|doing)\s*:\s*(.+)$/i);
    const subject = m && m[2].replace(/["`]/g, "").trim();
    if (!subject || subject.length < 2 || subject.length > 60 || /[@:/\\]|https?/i.test(subject) || named.has(subject.toLowerCase())) continue;
    named.add(subject.toLowerCase());
    topics.push({ subject, kind: m[1].toLowerCase() });
  }
  return topics.slice(0, MAX_SUBJECTS);
}

// For Pulse's look: today's unseen stories, or none when it is not yet a day
// since the last, the level is low, or nothing is known that they follow.
// offered() records them as seen once Pulse has judged them.
async function forPulse(store, { level, projects = [], ask, save, writing = async () => [], now = Date.now(), get = fetch } = {}) {
  const settings = store?.profile?.settings || {};
  if (!level || level === "off" || level === "low") return [];
  if (settings.world_looked_at && now - Date.parse(settings.world_looked_at) < LOOK_EVERY) return [];
  let list = settings.world_topics?.list;
  if (!Array.isArray(list) || !settings.world_topics?.at || now - Date.parse(settings.world_topics.at) >= SUBJECTS_FOR) {
    const facts = require("./facts-prose").factsProse(store.facts || {});
    const goals = (store.goals || []).filter((g) => g.status === "active").map((g) => g.title);
    const projectLines = projects.filter((p) => p.status === "active").map((p) => `${p.name}: ${p.summary || p.about || ""}`.slice(0, 200));
    list = await subjects({ facts, projects: projectLines, goals, writing: await writing().catch(() => []) }, ask);
    await save({ world_topics: { at: new Date(now).toISOString(), list } });
  }
  if (!list.length) { await save({ world_looked_at: new Date(now).toISOString() }); return []; }
  return news(list, { seen: new Set(settings.world_seen || []), now, get });
}
async function offered(store, stories, save, now = Date.now()) {
  const seen = [...(store?.profile?.settings?.world_seen || []), ...stories.map((s) => s.key)];
  await save({ world_seen: [...new Set(seen)].slice(-SEEN_KEPT), world_looked_at: new Date(now).toISOString() });
}

module.exports = { forPulse, offered, news, subjects, parse, FEEDS };
