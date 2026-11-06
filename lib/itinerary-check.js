// lib/itinerary-check.js: plans that cannot all be true, said once. After a
// scan brings in a booking or a flight, the rule check (lib/itinerary.js)
// finds what contradicts what; the person's own LLM sees each new clash with
// everything coming up and decides whether it is one they would want to sort
// out, and if so writes the one question Closedhand asks in their chat. Their
// answer settles it (settle below, the plans_settle tool), so where Closedhand
// takes them to be (lib/time-context.js) and Upcoming agree afterwards.
//
// What has been found and asked is kept in the person's facts under
// RECORD_KEY, per clash and per item: each item is asked about once, a new
// item clashing with the same flight is a new question, and the webapp shows
// a line on each card involved until it is settled (webapp/itinerary.js lines).
const ctx = require("./context");
const itinerary = require("./itinerary");

const RECORD_KEY = "_itinerary-clashes";

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

// Where the person gets their messages, as every unprompted one goes.
async function tell(userId, store, text) {
  const { supabase } = require("./db");
  const { data: links } = await supabase.from("chat_links").select("platform, platform_user_id").eq("user_id", userId);
  return require("./proactive").deliverUnprompted(userId, store, links || [], async () => text);
}

// After a scan: new clashes judged, asked about once, and kept.
// deps (tests): bookings, judge, tell, now.
async function review(userId, deps = {}) {
  const facts = ctx.store?.facts;
  if (!facts) return { found: 0, asked: 0 };
  const now = deps.now || Date.now();
  const bookings = deps.bookings || await require("./bookings").listUpcoming(userId);
  const flights = itinerary.flightsFrom(facts);
  const found = itinerary.clashes({ flights, bookings, now });
  const record = readRecord(facts);
  let asked = 0, changed = false;
  for (const clash of found) {
    const rec = record.clashes[clash.id] || (record.clashes[clash.id] = { kind: clash.kind, number: clash.flight?.number || null, items: {} });
    // Only what has not been put to them yet: a new item clashing with the
    // same flight is asked about on its own, and one judged real but not yet
    // asked about is judged again.
    const fresh = clash.items.filter((it) => !rec.items[it.id] || ["open", "real"].includes(rec.items[it.id].state));
    if (!fresh.length) continue;
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
      const told = await (deps.tell || tell)(userId, ctx.activeUserStore, verdict.message).catch((e) => { console.log(`[itinerary] could not ask: ${e.message}`); return false; });
      if (told) { state = "asked"; asked++; rec.asked = new Date(now).toISOString(); rec.message = verdict.message; }
    }
    for (const it of fresh) rec.items[it.id].state = real.has(it.id) ? state : "quiet";
  }
  if (changed) { writeRecord(facts, record); require("./storage").saveStore(); }
  return { found: found.length, asked };
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
// the dashboard's x takes them off (a booking removed, a flight no longer
// tracked); everything else in the clash stands as it is. Either way it is
// settled: no more questions or card lines about it.
async function settle(userId, { clash, drop = [] } = {}) {
  const facts = ctx.store?.facts;
  if (!facts) return { error: "No plans are loaded." };
  const record = readRecord(facts);
  const rec = record.clashes[String(clash || "")];
  if (!rec) return { error: "No clash with that id. The time block lists the open ones." };
  const ids = Array.isArray(drop) ? drop.map(String) : [];
  const dropped = [];
  for (const id of ids) {
    if (id.startsWith("flight-")) {
      const raw = facts[id];
      const f = raw && (typeof raw.value === "string" ? JSON.parse(raw.value) : typeof raw === "string" ? JSON.parse(raw) : raw);
      if (!f) continue;
      const marked = JSON.stringify({ ...f, supersededBy: "removed", supersededAt: new Date().toISOString() });
      if (raw && raw.value !== undefined) raw.value = marked; else facts[id] = marked;
      dropped.push(f.flightNumber || id);
    } else if (await require("./bookings").removeBooking(userId, id)) {
      dropped.push(rec.items?.[id]?.title || id);
    }
  }
  for (const it of Object.values(rec.items || {})) it.state = "settled";
  rec.settled = new Date().toISOString();
  if (dropped.length) rec.dropped = dropped;
  writeRecord(facts, record);
  require("./storage").saveStore();
  return { success: true, dropped, kept: Object.values(rec.items || {}).map((it) => it.title).filter((t) => !dropped.includes(t)) };
}

module.exports = { review, settle, openClashes, readRecord, RECORD_KEY };
