// lib/people.js: one person, however many names and addresses they go by.
//
// A man saved on the person's phone as "Dad" moved, as WhatsApp is moving
// everyone, to a private id that carries the name he gives himself, "Rowan".
// Closedhand had them as two people: asked to read "my chat with dad", a task
// read a chat that had stopped two weeks earlier and missed the address he had
// just sent; Pulse asked who Rowan was, and the chat asked for the dad's name.
// Nothing tied a person's names and addresses together: chat names, Pinned
// Facts and email addresses each stood alone.
//
// A person here is every handle (a chat app id, a phone number, an email
// address, a Pinned Fact) that the data itself says is one person: a
// platform's own pairing of two ids for one account, a contact that carries
// both, a Pinned Fact that gives someone's address, or a relation only one
// person holds (dad, mum, wife, husband) that the person gave themselves, as
// a name they saved or in a Pinned Fact. A shared first name alone never joins
// two people. Names are kept by kind: the name the person saved them under
// ("saved"), the name a chat goes by ("chat"), the name they give themselves
// ("own"), a Pinned Fact's ("fact").
//
// Chat reads, search, the questions about who someone is and the chat's
// picture of who is who all read people from here.

const ROLE_WORDS = {
  father: ["dad", "daddy", "father", "papa"],
  mother: ["mum", "mummy", "mom", "mommy", "mother", "mam", "mama"],
  wife: ["wife"],
  husband: ["husband", "hubby"],
};
const ROLE_OF = new Map(Object.entries(ROLE_WORDS).flatMap(([role, words]) => words.map((w) => [w, role])));
const NUMBER_ONLY = /^[\d\s+()∙.-]+$/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+|\b00)\d[\d ()-]{7,}\d/g;

const wa = (jid) => (jid ? "wa:" + String(jid).replace(/:\d+(?=@)/, "").toLowerCase() : null);
const mail = (address) => "mail:" + String(address).toLowerCase();
const tel = (number) => { const d = String(number).replace(/^00/, "").replace(/\D/g, ""); return d.length >= 8 ? "tel:+" + d : null; };
// A WhatsApp account by its number is that phone number too.
const telOfWa = (handle) => { const m = /^wa:(\d{7,15})@s\.whatsapp\.net$/.exec(handle); return m ? "tel:+" + m[1] : null; };
const roleOfName = (name) => ROLE_OF.get(String(name || "").toLowerCase().replace(/[^\p{L}]/gu, "")) || null;

// --- Writing: what a source learns, kept in a few batched writes ------------

const _pending = new Map();
const _written = new Set();
let _timer = null;
function note(userId, { links = [], names = [] } = {}) {
  if (!userId) return;
  const p = _pending.get(userId) || { links: new Map(), names: new Map() };
  for (const [a, b, source] of links) {
    if (!a || !b || a === b) continue;
    const [x, y] = [a, b].sort();
    const key = `${userId}|${x}|${y}`;
    if (!_written.has(key)) p.links.set(key, { user_id: userId, a: x, b: y, source });
  }
  for (const [handle, name, kind] of names) {
    const n = String(name || "").trim().slice(0, 120);
    if (!handle || !n || NUMBER_ONLY.test(n)) continue;
    const key = `${userId}|${handle}|${kind}|${n}`;
    if (!_written.has(key)) p.names.set(`${handle}|${kind}`, { user_id: userId, handle, name: n, kind, _key: key });
  }
  if (!p.links.size && !p.names.size) return;
  _pending.set(userId, p);
  if (!_timer) { _timer = setTimeout(flush, 5000); if (_timer.unref) _timer.unref(); }
}
async function flush() {
  _timer = null;
  const { supabase } = require("../user-store");
  for (const [userId, p] of [..._pending]) {
    _pending.delete(userId);
    const links = [...p.links.entries()];
    const names = [...p.names.values()];
    try {
      if (links.length) {
        const { error } = await supabase.from("person_links").upsert(links.map(([, row]) => row), { onConflict: "user_id,a,b", ignoreDuplicates: true });
        if (error) throw error;
        for (const [key] of links) _written.add(key);
      }
      if (names.length) {
        const at = new Date().toISOString();
        const { error } = await supabase.from("person_names").upsert(names.map(({ _key, ...row }) => ({ ...row, updated_at: at })), { onConflict: "user_id,handle,kind" });
        if (error) throw error;
        for (const n of names) _written.add(n._key);
      }
      _rows.delete(userId);
    } catch (e) {
      console.warn(`[people] not kept: ${e.message}`);
    }
  }
}

// --- Reading -----------------------------------------------------------------

const _rows = new Map();
const FRESH_MS = 60 * 1000;
function factValue(raw) {
  if (raw && typeof raw === "object") return raw.value !== undefined ? raw : { value: raw };
  const s = String(raw ?? "");
  if (s.startsWith("{")) { try { const o = JSON.parse(s); if (o && o.value !== undefined) return o; } catch { /* plain text */ } }
  return { value: s };
}
async function rowsFor(userId) {
  const hit = _rows.get(userId);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit;
  const { supabase } = require("../user-store");
  const [lk, nm, fx, pr] = await Promise.all([
    supabase.from("person_links").select("a, b").eq("user_id", userId).limit(50000),
    supabase.from("person_names").select("handle, name, kind").eq("user_id", userId).limit(50000),
    supabase.from("facts").select("key, value, subject, category").eq("user_id", userId),
    supabase.from("profiles").select("display_name, settings").eq("id", userId).single(),
  ]);
  const facts = {};
  for (const r of fx.data || []) facts[r.key] = { ...factValue(r.value), subject: r.subject ?? factValue(r.value).subject, category: r.category ?? factValue(r.value).category };
  const row = { at: Date.now(), links: lk.data || [], names: nm.data || [], facts,
    userName: pr.data?.settings?.preferred_name || pr.data?.display_name || "" };
  _rows.set(userId, row);
  return row;
}

// The people in what is known: every group of joined handles with a name.
function build({ links = [], names = [], facts = {}, userName = "" }) {
  const up = new Map();
  const root = (x) => {
    if (!up.has(x)) up.set(x, x);
    let r = x;
    while (up.get(r) !== r) r = up.get(r);
    for (let y = x; up.get(y) !== r;) { const n = up.get(y); up.set(y, r); y = n; }
    return r;
  };
  const join = (a, b) => { const ra = root(a), rb = root(b); if (ra !== rb) up.set(ra, rb); };
  const namesOf = new Map();
  const roleHandles = new Map();
  const addName = (handle, name, kind) => {
    root(handle);
    if (!namesOf.has(handle)) namesOf.set(handle, []);
    namesOf.get(handle).push({ name, kind });
    const role = kind === "saved" || kind === "chat" ? roleOfName(name) : null;
    if (role) { if (!roleHandles.has(role)) roleHandles.set(role, []); roleHandles.get(role).push({ handle, word: name }); }
  };
  for (const l of links) join(l.a, l.b);
  // A group is a chat, never a person.
  for (const n of names) if (!/@g\.us$/.test(n.handle)) addName(n.handle, n.name, n.kind);
  for (const h of [...up.keys()]) { const t = telOfWa(h); if (t) join(h, t); }

  // Pinned Facts about someone: their name, the relation the person gave, and
  // any address they hold. "<their name>'s father" or "your/my father" is
  // the person's own relation; "Ana's father" is not.
  const first = String(userName || "").trim().split(/\s+/)[0] || "";
  const mine = new RegExp(`(?:\\b(?:your|my)|${first ? `\\b${first.replace(/[^\p{L}]/gu, "")}['’]s` : "\\bthe user['’]s"})\\s+(\\p{L}+)`, "giu");
  const factKeys = new Map();
  for (const [key, raw] of Object.entries(facts || {})) {
    if (String(key).startsWith("_")) continue;
    const f = factValue(raw);
    const category = String(f.category || "");
    const subject = String(f.subject || "").trim();
    if (category !== "person" && !/^family[-_]/i.test(key)) continue;
    if (!subject || (first && subject.toLowerCase() === String(userName).toLowerCase())) continue;
    const h = "fact:" + key;
    factKeys.set(h, key);
    addName(h, subject, "fact");
    const text = String(f.value || "");
    const roles = new Set();
    for (const w of String(key).toLowerCase().split(/[-_\s]+/)) if (ROLE_OF.has(w)) roles.add(ROLE_OF.get(w));
    for (const m of text.matchAll(mine)) if (ROLE_OF.has(m[1].toLowerCase())) roles.add(ROLE_OF.get(m[1].toLowerCase()));
    for (const role of roles) { if (!roleHandles.has(role)) roleHandles.set(role, []); roleHandles.get(role).push({ handle: h, word: null }); }
    for (const m of text.match(EMAIL) || []) join(h, mail(m));
    for (const m of text.match(PHONE) || []) { const t = tel(m); if (t) join(h, t); }
  }
  // A relation only one person holds, given by the person themselves.
  const roleOfRoot = new Map();
  for (const [role, hs] of roleHandles) {
    for (let i = 1; i < hs.length; i++) join(hs[0].handle, hs[i].handle);
    const said = (hs.find((x) => x.word) || {}).word;
    roleOfRoot.set(root(hs[0].handle), { role, word: said ? said.toLowerCase().replace(/[^\p{L}]/gu, "") : ROLE_WORDS[role][0] });
  }

  const groups = new Map();
  for (const h of up.keys()) { const r = root(h); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(h); }
  const persons = [];
  for (const [r, handles] of groups) {
    const all = handles.flatMap((h) => (namesOf.get(h) || []).map((n) => ({ ...n, handle: h })));
    const role = [...roleOfRoot].find(([rr]) => root(rr) === r)?.[1] || null;
    if (!all.length && !role) continue;
    // A name as a name: "Wren (Sam's mother)" is Wren.
    const pick = (kind) => { const n = all.find((x) => x.kind === kind && !roleOfName(x.name) && !NUMBER_ONLY.test(x.name)); return n ? n.name.replace(/\s*\([^)]*\)/g, "").trim() || n.name : undefined; };
    // Their name, never a relation ("Dad" says who they are, not what they are called).
    const name = pick("fact") || pick("own") || pick("saved") || pick("chat") || null;
    persons.push({
      handles, names: all, name, role: role ? role.role : null, roleWord: role ? String(role.word).toLowerCase() : null,
      facts: handles.filter((h) => factKeys.has(h)).map((h) => factKeys.get(h)),
      chats: handles.filter((h) => /^wa:.+@(s\.whatsapp\.net|lid)$/.test(h)).map((h) => h.slice(3)),
      emails: handles.filter((h) => h.startsWith("mail:")).map((h) => h.slice(5)),
    });
  }
  return snapshot(persons);
}

function snapshot(persons) {
  const byHandle = new Map(), byName = new Map(), byWord = new Map();
  const add = (map, k, i) => { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(i); };
  persons.forEach((p, i) => {
    for (const h of p.handles) byHandle.set(h, i);
    for (const n of p.names) {
      const full = n.name.toLowerCase().trim();
      if (NUMBER_ONLY.test(full)) continue;
      add(byName, full, i);
      for (const w of full.match(/\p{L}[\p{L}'’-]{2,}/gu) || []) add(byWord, w, i);
    }
    if (p.role) for (const w of ROLE_WORDS[p.role]) { add(byName, w, i); add(byWord, w, i); }
  });
  const at = (set) => [...(set || [])].map((i) => persons[i]);
  const api = {
    persons,
    ofHandle: (handle) => (byHandle.has(handle) ? persons[byHandle.get(handle)] : null),
    ofChat: (jid) => api.ofHandle(wa(jid)),
    // Who a name, relation or address names: a whole name first ("Rowan
    // Pike", "dad"), then the words of one, then an address.
    find(text) {
      const t = String(text || "").toLowerCase().trim();
      if (!t) return [];
      const exact = byName.get(t.replace(/^(my|your)\s+/, ""));
      if (exact) return at(exact);
      const hits = new Set();
      for (const m of t.match(EMAIL) || []) if (byHandle.has(mail(m))) hits.add(byHandle.get(mail(m)));
      for (const w of t.match(/\p{L}[\p{L}'’-]{2,}/gu) || []) for (const i of byWord.get(w.replace(/['’]s$/, "")) || []) hits.add(i);
      return at(hits);
    },
    // Placed: a Pinned Fact says who they are, or the person gave the
    // relation themselves and their name is known.
    placed: (p) => !!p && (p.facts.length > 0 || (!!p.role && !!p.name)),
    placedName: (word) => api.find(word).some(api.placed),
    describe(p) {
      if (!p) return "";
      const rel = p.role ? `your ${p.roleWord || ROLE_WORDS[p.role][0]}` : "";
      return p.name && rel ? `${p.name}, ${rel}` : p.name || rel;
    },
    // A search's words, with the other names and addresses of the people
    // they name, so "dad" finds what Rowan sent and his email.
    expand(words, max = 12) {
      const have = new Set((words || []).map((w) => String(w).toLowerCase()));
      const people = api.find((words || []).join(" "));
      if (!people.length || people.length > 3) return [];
      const extra = [];
      for (const p of people) {
        for (const n of p.names) for (const w of n.name.toLowerCase().match(/\p{L}[\p{L}'’-]{2,}/gu) || []) if (!have.has(w)) { have.add(w); extra.push(w); }
        for (const e of p.emails) if (!have.has(e)) { have.add(e); extra.push(e); }
      }
      return extra.slice(0, max);
    },
    // Who is who where only their contacts say it: the relations the person
    // saved that no Pinned Fact covers, for the chat's picture of their life.
    contactLine() {
      const told = persons.filter((p) => p.role && p.name && !p.facts.length).slice(0, 8);
      if (!told.length) return "";
      return "WHO IS WHO IN THEIR CONTACTS (as they saved them): " + told.map((p) => {
        const saved = p.names.find((n) => (n.kind === "saved" || n.kind === "chat") && roleOfName(n.name));
        return `${p.name} is their ${p.roleWord}${saved ? ` (saved as "${saved.name}")` : ""}`;
      }).join("; ") + ".";
    },
  };
  return api;
}

async function load(userId, { facts = null } = {}) {
  if (!userId) return snapshot([]);
  try {
    const rows = await rowsFor(userId);
    return build({ ...rows, facts: facts || rows.facts });
  } catch (e) {
    console.warn(`[people] could not load: ${e.message}`);
    return snapshot([]);
  }
}

module.exports = { load, note, flush, build, wa, mail, tel, roleOfName, ROLE_WORDS };
