// lib/itinerary-check.js: plans that cannot all be true, said once. After a
// scan brings in a booking or a flight, the rule check (lib/itinerary.js)
// finds what contradicts what; the person's own LLM sees each new clash with
// everything coming up and decides whether it is one they would want to sort
// out, and if so writes the one question Closedhand asks in their chat. Their
// answer settles it (settle below, the plans_settle tool), so where Closedhand
// takes them to be (lib/time-context.js) and Upcoming agree afterwards.
//
// What has been found and asked is kept in the person's facts under
// RECORD_KEY, per clash and per item: a new item clashing with the same
// flight is a new question, and the webapp shows a line on each card involved
// until it is settled (webapp/itinerary.js lines). Unanswered, a question is
// asked again a day later, then the day before each plan in it comes, after
// first looking again for proof that a plan is off (lib/plans-off.js); one
// asked once and left read as if Closedhand had forgotten.
const ctx = require("./context");
const itinerary = require("./itinerary");

const RECORD_KEY = "_itinerary-clashes";
const HOUR = 3600000;
// Asked again once a day has passed without an answer, and again in the day
// and a half before each plan the question is about.
const AGAIN_AFTER_MS = 24 * HOUR;
const BEFORE_MS = 36 * HOUR;
const MIN_GAP_MS = 12 * HOUR;
const PLATFORM_NAMES = { whatsapp: "WhatsApp", whatsapp_linked: "WhatsApp", telegram: "Telegram", slack: "Slack", discord: "Discord", line: "LINE", web: "the web chat" };

function readRecord(facts) {
  try {
    let v = facts && facts[RECORD_KEY];
    if (v && v.value !== undefined) v = v.value;
    const r = typeof v === "string" ? JSON.parse(v) : v;
    return r && typeof r === "object" && r.clashes ? r : { clashes: {} };
  } catch { return { clashes: {} }; }
}
function writeRecord(facts, record) {
  const now = new Date().toISOString();
  const existing = facts[RECORD_KEY];
  if (existing && typeof existing === "object" && existing.value !== undefined) { existing.value = JSON.stringify(record); existing.lastAccessed = now; }
  else facts[RECORD_KEY] = { value: JSON.stringify(record), created: now, lastAccessed: now, accessCount: 0 };
}

// A moment in its own place's time, as the person reads it there.
function local(ms, tz) {
  try { return new Date(ms).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
  catch { return new Date(ms).toISOString(); }
}
// Everything coming up, as the LLM is shown it: flights and bookings, in time
// order, each in its own place's time.
function picture(flights, bookings, now) {
  const lines = [];
  for (const f of flights) if (f.arr.at > now - 86400000) lines.push({ at: f.dep.at, text: `Flight ${f.number}: ${f.dep.airport || "?"} ${local(f.dep.at, f.dep.tz)} -> ${f.arr.airport || "?"} ${local(f.arr.at, f.arr.tz)} (${f.arr.tz})` });
  for (const raw of bookings) {
    const b = itinerary.readBooking(raw);
    if (!b || (b.end || b.start) < now) continue;
    lines.push({ at: b.start, text: `${b.kind}: ${b.title}${raw.location ? `, ${raw.location}` : ""}, ${local(b.start, b.tz)}${b.end ? ` to ${local(b.end, b.tz)}` : ""} (${b.tz})` });
  }
  return lines.sort((a, b) => a.at - b.at).map((l) => "- " + l.text).join("\n");
}
// The items numbered, so the person's LLM can say which of them really clash.
function describe(clash, only) {
  const listed = clash.items.filter((it) => !only || only.has(it.id));
  const items = listed.map((it, n) => `[${n + 1}] ${it.what === "flight" ? "flight " : ""}${it.title} (${new Date(it.at).toISOString()})`).join("; ");
  if (clash.kind === "stays") return { listed, text: `Two stays far apart on the same nights: ${items}.` };
  const f = clash.flight;
  return { listed, text: `Flight ${f.number} from ${f.from || "?"} lands at ${f.to || "?"} (${f.toTz}) at ${local(f.arrives, f.toTz)}, while these are booked far from there after it: ${items}.` };
}

// The person's LLM decides, from what each thing is, which of them really
// clash, and whether that is worth one question, and writes it. The rule
// check only finds things booked in two far places at once; that alone is
// not a clash. Returns { clashing: [item ids], ask, message, place, from },
// or null when it could not say.
async function judge(userId, clash, shown, only) {
  const { getInternalClient } = require("./llm");
  const { responseText } = require("./model-wire");
  const { client, model } = getInternalClient(userId);
  const { listed, text: found } = describe(clash, only);
  const reply = await client.messages.create({
    model, max_tokens: 700,
    messages: [{ role: "user", content: `You look after one person's plans. Everything they have coming up, each in its own place's local time:
${shown}

A simple check noticed things booked in places far apart around the same time:
${found}

Far apart alone does not make a clash. Decide from what each one actually is. Something is a real clash only when, understanding what it is, the person genuinely cannot do all of it as booked: they would have to be there in person, it is theirs (not for someone else), it is still going ahead, and they cannot get between the places in time. It is not a clash when, for example, it can be done from anywhere (an online call, a delivery, a subscription or a reminder), it is plainly for someone else or for a group they are not travelling with, it is already cancelled or only tentative, or it ends before the flight leaves. When in doubt, it is not a clash.

If any are real, write the one message Closedhand sends them about it, in Closedhand's own voice ("I"): short and plain, naming the new or odd one out and what it clashes with (dates and places as they would say them), asking what is happening (for example whether they are cutting a trip short), and offering to take what no longer stands off their plans. No greeting, no emoji.

Reply with ONLY this JSON: {"clashing": [the numbers of the ones that really clash, or empty], "ask": true or false, "message": "the message, or empty", "place": "the city the clashing flight takes them to, e.g. Lisbon, or empty", "from": "the city of the plans it takes them away from, or empty"}` }],
  });
  const text = String(responseText(reply) || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const plain = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const clashing = (Array.isArray(j.clashing) ? j.clashing : []).map((n) => listed[Number(n) - 1]).filter(Boolean).map((it) => it.id);
    return { clashing, ask: j.ask === true && clashing.length > 0 && !!String(j.message || "").trim(), message: String(j.message || "").trim(), place: plain(j.place), from: plain(j.from) };
  } catch { return null; }
}

// Asked again, when they have not answered: one short line in Closedhand's
// voice about what is still open, written by the person's LLM.
async function nudge(userId, rec, open, shown) {
  const { getInternalClient } = require("./llm");
  const { responseText } = require("./model-wire");
  const { client, model } = getInternalClient(userId);
  const items = open.map((it) => `- ${it.what === "flight" ? "flight " : ""}${it.title}, ${new Date(it.at).toISOString()}`).join("\n");
  const reply = await client.messages.create({
    model, max_tokens: 300,
    messages: [{ role: "user", content: `You look after one person's plans. Everything they have coming up, each in its own place's local time:
${shown}

Earlier you asked them this and they have not answered:
${rec.message || "Whether some of their plans still stand."}

Still coming up and not settled:
${items}

Write one short message asking again, in Closedhand's own voice ("I"): plain, one or two sentences, naming each of these by its day, the soonest first, so one answer can cover all of them, and offering to take off what no longer stands. No greeting, no emoji, no apology. Reply with ONLY the message.` }],
  });
  return String(responseText(reply) || "").trim().replace(/^"|"$/g, "");
}

// Where the person gets their messages, as every unprompted one goes.
// Returns the chat apps it went to (empty when it could not go).
async function tell(userId, store, text) {
  const { supabase } = require("./db");
  const proactive = require("./proactive");
  const { data: links } = await supabase.from("chat_links").select("platform, platform_user_id").eq("user_id", userId);
  const targets = await proactive.getProactiveTargets(userId, store, links || []);
  if (!(await proactive.deliverUnprompted(userId, store, links || [], async () => text))) return [];
  return [...new Set(targets.map((t) => PLATFORM_NAMES[t.platform] || t.platform))];
}
// The record of each time the question went: [{ at, in: [app names] }].
function asksOf(rec) {
  if (Array.isArray(rec.asks)) return rec.asks;
  return rec.asked ? [{ at: rec.asked, in: [] }] : [];
}

// After a scan: plans now known to be off taken off, new clashes judged and
// asked about, unanswered ones asked again, and all of it kept.
// deps (tests): bookings, plansOff, judge, nudge, tell, now.
async function review(userId, deps = {}) {
  const facts = ctx.store?.facts;
  if (!facts) return { found: 0, asked: 0 };
  const now = deps.now || Date.now();
  // Proof first: a plan its booking's own email or chat says is off comes
  // off before anything is asked about it.
  try { await (deps.plansOff || require("./plans-off").review)(userId, { now }); }
  catch (e) { console.log(`[itinerary] could not look for plans that are off: ${e.message}`); }
  const bookings = (deps.bookings || await require("./bookings").listUpcoming(userId)).filter((b) => b.status !== "cancelled");
  const flights = itinerary.flightsFrom(facts);
  const found = itinerary.clashes({ flights, bookings, now });
  const record = readRecord(facts);
  let asked = 0, changed = false;
  // What a question was about and is no longer in its clash (taken off,
  // moved, over) is no longer open.
  const still = new Map(found.map((c) => [c.id, new Set(c.items.map((it) => it.id))]));
  for (const [id, rec] of Object.entries(record.clashes)) {
    for (const [itemId, it] of Object.entries(rec.items || {})) {
      if (["asked", "real", "open"].includes(it.state) && !still.get(id)?.has(itemId)) { it.state = "gone"; changed = true; }
    }
  }
  for (const clash of found) {
    const rec = record.clashes[clash.id] || (record.clashes[clash.id] = { kind: clash.kind, number: clash.flight?.number || null, items: {} });
    // Only what has not been put to them yet: a new item clashing with the
    // same flight is asked about on its own, and one judged real but not yet
    // asked about is judged again.
    const fresh = clash.items.filter((it) => !rec.items[it.id] || ["open", "real"].includes(rec.items[it.id].state));
    if (!fresh.length) {
      if (await askAgain(userId, clash, rec, { now, flights, bookings, deps })) { asked++; changed = true; }
      continue;
    }
    changed = true;
    for (const it of fresh) rec.items[it.id] = { title: it.title, what: it.what, at: new Date(it.at).toISOString(), state: "open" };
    let verdict = null;
    try { verdict = await (deps.judge || judge)(userId, clash, picture(flights, bookings, now), new Set(fresh.map((it) => it.id))); }
    catch (e) { console.log(`[itinerary] could not judge a clash: ${e.message}`); }
    if (!verdict) continue; // judged again after the next scan, and nothing shows meanwhile
    if (verdict.place) rec.place = verdict.place;
    if (verdict.from) rec.from = verdict.from;
    // Only what their LLM judged a real clash is shown or asked about; the
    // rest of what the check noticed stays quiet.
    const real = new Set(verdict.clashing || []);
    let state = "real";
    if (verdict.ask) {
      const told = await (deps.tell || tell)(userId, ctx.activeUserStore, verdict.message).catch((e) => { console.log(`[itinerary] could not ask: ${e.message}`); return []; });
      if (told && told.length) { state = "asked"; asked++; rec.asks = [...asksOf(rec), { at: new Date(now).toISOString(), in: told }]; rec.asked = rec.asked || rec.asks[0].at; rec.message = verdict.message; }
    }
    for (const it of fresh) rec.items[it.id].state = real.has(it.id) ? state : "quiet";
  }
  if (changed) { writeRecord(facts, record); require("./storage").saveStore(); }
  return { found: found.length, asked };
}

// A question with no answer yet, asked again: once a day has passed, then in
// the day and a half before each plan it is about, never twice within half a
// day. Returns true when it went.
async function askAgain(userId, clash, rec, { now, flights, bookings, deps }) {
  const open = clash.items.filter((it) => rec.items[it.id]?.state === "asked" && it.at > now);
  const asks = asksOf(rec);
  if (!open.length || !asks.length) return false;
  const last = Date.parse(asks[asks.length - 1].at) || 0;
  if (now - last < MIN_GAP_MS) return false;
  const soonest = open[0];
  const before = (rec.before || []).includes(soonest.id);
  const due = (asks.length === 1 && now - last >= AGAIN_AFTER_MS) || (!before && soonest.at - now <= BEFORE_MS);
  if (!due) return false;
  let message = "";
  try { message = await (deps.nudge || nudge)(userId, rec, open, picture(flights, bookings, now)); }
  catch (e) { console.log(`[itinerary] could not write the question again: ${e.message}`); return false; }
  if (!message) return false;
  const told = await (deps.tell || tell)(userId, ctx.activeUserStore, message).catch((e) => { console.log(`[itinerary] could not ask again: ${e.message}`); return []; });
  if (!told || !told.length) return false;
  rec.asks = [...asks, { at: new Date(now).toISOString(), in: told }];
  if (soonest.at - now <= BEFORE_MS) rec.before = [...new Set([...(rec.before || []), soonest.id])];
  return true;
}

// Open clashes, for the chat's time block: what Closedhand asked about and
// has not heard back on, with the ids that settle it.
function openClashes(facts) {
  const out = [];
  for (const [id, rec] of Object.entries(readRecord(facts).clashes)) {
    const open = Object.entries(rec.items || {}).filter(([, it]) => it.state === "asked" || it.state === "real");
    if (!open.length) continue;
    out.push({ id, number: rec.number, place: rec.place || null, from: rec.from || null, asked: rec.asked || null, items: open.map(([itemId, it]) => ({ id: itemId, title: it.title, what: it.what, at: it.at })) });
  }
  return out;
}

// The person has said what stands. Items in `drop` come off their plans as
// the dashboard's x takes them off, to Cancelled plans, saying they said so
// and where (a booking cancelled, a flight no longer tracked); items in
// `keep` stand. What they said nothing about stays open and is asked about
// again: "No, it's cancelled" about one plan of three is no answer about the
// other two. Neither given: everything stands as it is. What is settled gets
// no more questions or card lines.
async function settle(userId, { clash, drop = [], keep = [] } = {}) {
  const facts = ctx.store?.facts;
  if (!facts) return { error: "No plans are loaded." };
  const record = readRecord(facts);
  const rec = record.clashes[String(clash || "")];
  if (!rec) return { error: "No clash with that id. The time block lists the open ones." };
  const ids = Array.isArray(drop) ? drop.map(String) : [];
  const dropped = [];
  const said = { by: "you", ...(PLATFORM_NAMES[ctx.activePlatform] ? { in: PLATFORM_NAMES[ctx.activePlatform] } : {}) };
  for (const id of ids) {
    if (id.startsWith("flight-")) {
      const raw = facts[id];
      const f = raw && (typeof raw.value === "string" ? JSON.parse(raw.value) : typeof raw === "string" ? JSON.parse(raw) : raw);
      if (!f) continue;
      const at = new Date().toISOString();
      const reminders = await require("./bookings").endRemindersFor(userId, f.departure?.dateTime);
      const marked = JSON.stringify({ ...f, supersededBy: "removed", supersededAt: at, cancelled: { ...said, at, ...(reminders.length ? { reminders } : {}) } });
      if (raw && raw.value !== undefined) raw.value = marked; else facts[id] = marked;
      dropped.push(f.flightNumber || id);
    } else if (await require("./bookings").cancelBooking(userId, id, said)) {
      dropped.push(rec.items?.[id]?.title || id);
    }
  }
  const stands = Array.isArray(keep) ? keep.map(String) : [];
  const answered = ids.length || stands.length ? new Set([...ids, ...stands]) : null;
  for (const [id, it] of Object.entries(rec.items || {})) if (!answered || answered.has(id)) it.state = "settled";
  const open = Object.values(rec.items || {}).filter((it) => it.state === "asked" || it.state === "real").map((it) => it.title);
  if (!open.length) rec.settled = new Date().toISOString();
  if (dropped.length) rec.dropped = [...(rec.dropped || []), ...dropped];
  writeRecord(facts, record);
  require("./storage").saveStore();
  const kept = Object.entries(rec.items || {}).filter(([id, it]) => it.state === "settled" && (!answered || stands.includes(id))).map(([, it]) => it.title).filter((t) => !dropped.includes(t));
  return { success: true, dropped, kept, ...(open.length ? { still_open: open } : {}) };
}

module.exports = { review, settle, openClashes, readRecord, RECORD_KEY };
