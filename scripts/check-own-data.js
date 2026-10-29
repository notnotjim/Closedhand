#!/usr/bin/env node
// Refuse to push details from your own Closedhand: booking references, the
// names of hotels and trips, flight codes, page and task ids, your name and
// email, the addresses that write to you. Tests and examples written while
// fixing a real bug tend to copy the real case; this compares what is about
// to be pushed (the added lines and the commit messages) with what your own
// Closedhand database holds, and lists every match so it can be swapped for an
// invented value of the same shape before the push goes.
//
// Reads the database of the Docker setup on this computer through `docker
// exec` (container from CLOSEDHAND_DB_CONTAINER, default closedhand-db-1).
// With no such database, as in CI, it says so and passes. A Closedhand that
// moved to Railway is read there through the Railway CLI instead: the file
// .own-data-railway at the top of the repo (never committed) holds its
// project, environment and database service ids, and then a database it
// can't reach stops the push rather than letting it through unchecked.
//
//   node scripts/check-own-data.js [range]     default: what @{push} lacks

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CONTAINER = process.env.CLOSEDHAND_DB_CONTAINER || "closedhand-db-1";
const MIN_LENGTH = 5;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const QUERY = `
select 'booking reference', reference from bookings where reference is not null
union all select 'booking', title from bookings
union all select 'booking provider', provider from bookings
union all select 'fact:' || key, value::text from facts where left(key, 1) <> '_'
union all select 'page id', id::text from reports
union all select 'page title', title from reports
union all select 'task id', id::text from agent_tasks
union all select 'task title', title from agent_tasks
union all select 'reminder', name from schedules
union all select 'project', name from projects
union all select 'project about', about from projects
union all select 'profile email', email from profiles
union all select 'profile name', display_name from profiles
union all select 'profile name', settings->>'preferred_name' from profiles
union all select 'mail sender', data->>'from' from data_cache where type = 'email'`;

// "<project> <environment> <service>" of the person's Closedhand database on
// Railway, or null.
function railwayDb(file = path.join(__dirname, "..", ".own-data-railway")) {
  let ids;
  try { ids = fs.readFileSync(file, "utf8").trim().split(/\s+/); } catch { return null; }
  return ids.length === 3 && ids.every((id) => /^[0-9a-f-]{36}$/.test(id)) ? { project: ids[0], environment: ids[1], service: ids[2] } : null;
}

// The query goes across as base64, so no shell on the way can change it.
function psqlOnRailway(db) {
  const sql = Buffer.from(QUERY).toString("base64");
  return execFileSync("railway", ["ssh", "--project", db.project, "--environment", db.environment, "--service", db.service, "--",
    `echo ${sql} | base64 -d | psql -U postgres -d closedhand -At -F "$(printf '\\t')" | cat`],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, timeout: 120000 }).replace(/\r/g, "");
}

function readOwnData(db = railwayDb()) {
  try {
    const out = db ? psqlOnRailway(db) : execFileSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "closedhand", "-At", "-F", "\t", "-c", QUERY],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").filter(Boolean).map((line) => {
      const tab = line.indexOf("\t");
      return { kind: line.slice(0, tab), value: line.slice(tab + 1) };
    });
  } catch {
    return null;
  }
}

// The strings worth looking for: whole values, what each stored fact holds (a
// flight's booking code and number, a profile's name), each email address,
// and each word of the person's name. Short and generic ones are left out:
// times, time zones, single lowercase words, and the airline or status of a
// flight, which say nothing about who took it.
const GENERIC_FIELDS = new Set(["airline", "tz", "timezone", "status", "terminal", "gate", "category", "source", "subject", "utcOffsetMinutes"]);

function leaves(v, key, out) {
  if (typeof v === "string") {
    try { const inner = JSON.parse(v); if (inner && typeof inner === "object") return leaves(inner, key, out); } catch { /* plain text */ }
    if (!GENERIC_FIELDS.has(key)) out.push(v);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) leaves(x, Array.isArray(v) ? key : k, out);
  }
  return out;
}

function distinctive(rows) {
  const found = new Map();
  const add = (kind, value) => {
    const v = String(value || "").trim();
    if (v.length < MIN_LENGTH || /^0{8}-/.test(v) || /^[\d\s.:+TZ-]+$/.test(v) || /^[a-z]+$/.test(v) || /^[A-Z][a-z]+\/[A-Za-z_]+$/.test(v)) return;
    if (!found.has(v.toLowerCase())) found.set(v.toLowerCase(), { kind, value: v });
  };
  for (const { kind, value } of rows) {
    const fact = kind.startsWith("fact:") ? kind.slice(5) : null;
    let parts = [value];
    if (fact) {
      let stored = value;
      try { stored = JSON.parse(value); } catch { /* a bare value */ }
      parts = leaves(stored && typeof stored === "object" && "value" in stored ? stored.value : stored, null, []);
    }
    const label = fact ? (fact.startsWith("flight-") ? "flight" : fact) : kind;
    for (const part of parts) {
      const emails = String(part).match(EMAIL) || [];
      for (const e of emails) add(kind === "mail sender" ? "mail sender" : "email", e);
      if (kind === "mail sender") continue;
      add(label, part);
      if (kind === "profile name" || fact === "profile-name") for (const word of String(part).split(/\s+/)) add("name", word);
    }
  }
  return [...found.values()];
}

// Every match of a value in the outgoing lines: [{ where, kind, value }].
function findMatches(values, lines) {
  const hits = [];
  for (const line of lines) {
    const text = line.text.toLowerCase();
    for (const v of values) {
      const at = text.indexOf(v.value.toLowerCase());
      if (at === -1) continue;
      // A name or word must stand alone, not sit inside a longer word.
      const before = text[at - 1], after = text[at + v.value.length];
      if (/[\p{L}\d]/u.test(before || "") || /[\p{L}\d]/u.test(after || "")) continue;
      hits.push({ where: line.where, kind: v.kind, value: v.value });
    }
  }
  return hits;
}

// Each outgoing commit on its own, its added lines and its message: a detail
// one commit adds and a later one removes is still in the history.
function outgoing(range) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const lines = [];
  for (const hash of git("rev-list", "--no-merges", range).split("\n").filter(Boolean)) {
    const short = hash.slice(0, 7);
    git("log", "-1", "--format=%B", hash).split("\n").forEach((text) => lines.push({ where: `${short} message`, text }));
    let file = null, lineNo = 0;
    for (const raw of git("show", "--unified=0", "--no-color", "--format=", hash).split("\n")) {
      if (raw.startsWith("+++ ")) { file = raw.slice(4).replace(/^b\//, ""); continue; }
      const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) { lineNo = Number(hunk[1]); continue; }
      if (raw.startsWith("+")) lines.push({ where: `${short} ${file}:${lineNo++}`, text: raw.slice(1) });
    }
  }
  return lines;
}

function main() {
  let range = process.argv[2];
  if (!range) {
    try { execFileSync("git", ["rev-parse", "--verify", "-q", "@{push}"], { stdio: "ignore" }); range = "@{push}..HEAD"; }
    catch { range = "origin/main..HEAD"; }
  }
  const db = railwayDb();
  const rows = readOwnData(db);
  if (!rows && db) { console.error("Your Closedhand's database on Railway couldn't be read (railway ssh), so nothing was checked. Sign in with `railway login` and push again."); process.exitCode = 1; return; }
  if (!rows) { console.log(`OK: no local Closedhand database (${CONTAINER}) to compare against, skipped.`); return; }
  const hits = findMatches(distinctive(rows), outgoing(range));
  if (!hits.length) { console.log("OK: nothing from your own Closedhand in what is being pushed."); return; }
  console.error("Details from your own Closedhand are about to be pushed. Swap each for an invented value of the same shape:");
  for (const h of hits) console.error(`  ${h.where}: ${h.kind} "${h.value}"`);
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { distinctive, findMatches, railwayDb, readOwnData };
