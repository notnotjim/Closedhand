// webapp/projects.js: the dashboard's Projects tab and each project's page.
//
// The bot keeps projects up to date from chat (lib/projects.js); here the
// person starts one, renames it, changes its emoji, gives it context (files,
// notes, links, and emails, events or messages from their connected apps),
// archives, merges or deletes it. Both sides hold to webapp/project-rules.js
// and meet in the projects table. A project's page is read-only and has no
// script: where it stands, what is open and decided, who said what, and its
// context. It lives under /page/, which reaches the computer through the
// tunnel like every other page.

const rules = require("./project-rules");
const page = require("./report-page");

const COLUMNS = "id, name, emoji, about, instructions, summary, state, context, status, expected_end, last_touched, created_at, archived_at";
// Instructions, one a line, as written.
const lines = (x) => String(x || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).join("\n").slice(0, 4000);
const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; form-action 'self'; frame-ancestors 'self'";
// What a search of the person's synced items looks in, across kinds.
const SEARCHED = ["data->>subject", "data->>summary", "data->>title", "data->>from", "data->>chat_name", "data->>text"];

function register(app, { db, userId: who, withAppearance }) {
  const multer = require("multer");
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 10 } });
  const owner = (req, res) => {
    const id = who(req);
    if (!id) res.status(401).json({ error: "Not logged in" });
    return id;
  };
  const mine = async (userId) => {
    const { data, error } = await db.from("projects").select(COLUMNS).eq("user_id", userId).in("status", ["active", "archived"]).order("last_touched", { ascending: false }).limit(200);
    if (error) throw new Error("Could not load your projects.");
    return data || [];
  };
  const fail = (res, e, status = 500) => res.status(status).json({ error: e.message || String(e) });
  const name = (x) => String(x || "").trim().slice(0, 80);
  // Items from connected apps are taken from the stored record, never from
  // what the form sent.
  const syncedItems = async (userId, refs) => {
    const out = [];
    for (const r of (Array.isArray(refs) ? refs : []).slice(0, 20)) {
      const { data } = await db.from("data_cache").select("source, type, external_id, data, received_at")
        .eq("user_id", userId).eq("source", String((r && r.source) || "")).eq("external_id", String((r && r.ref) || "")).limit(1);
      const item = data && data[0] && rules.synced(data[0]);
      if (item) out.push(item);
    }
    return out;
  };

  // The project's goal, with this week's count for a habit.
  const goalOf = async (userId, projectId) => {
    const { data } = await db.from("goals").select("id, title, shape, why, if_then, target_date, done_when, habit, plan, stage, status, check_in, achieved_at")
      .eq("user_id", userId).eq("project_id", projectId).in("status", ["active", "paused", "achieved"]).limit(1);
    const g = data && data[0];
    if (!g) return null;
    const goalsTime = require("./goals-time");
    const { data: prof } = await db.from("profiles").select("timezone").eq("id", userId).maybeSingle();
    const since = goalsTime.weekStart((prof && prof.timezone) || goalsTime.DEFAULT_TZ).toISOString();
    const { data: ticks } = g.habit ? await db.from("goal_events").select("id").eq("goal_id", g.id).eq("kind", "habit_done").gte("at", since) : { data: [] };
    return { ...g, this_week: (ticks || []).length, check_in_text: g.check_in ? goalsTime.describeCheckIn(g.check_in) : null };
  };

  // The web chat's conversations: Chat, the person's one general
  // conversation, and each project's own, newest first. A project's
  // conversation is a thread of its own that is never the open one
  // (lib/projects.js), so the web chat picks it by the project.
  const generalThread = async (userId) => {
    const { data } = await db.from("conversation_threads").select("id, messages, updated_at").eq("user_id", userId).eq("is_active", true).is("project_id", null).order("updated_at", { ascending: false }).limit(1);
    return (data && data[0]) || null;
  };
  app.get("/api/conversations", async (req, res) => {
    const userId = owner(req, res); if (!userId) return;
    try {
      const general = await generalThread(userId);
      const projects = (await mine(userId)).filter((p) => p.status === "active");
      const { data: threads } = projects.length ? await db.from("conversation_threads").select("project_id, messages, updated_at").eq("user_id", userId).in("project_id", projects.map((p) => p.id)) : { data: [] };
      const list = projects.map((p) => {
        const t = (threads || []).find((x) => x.project_id === p.id);
        return { id: p.id, emoji: p.emoji, name: p.name, updated_at: (t && t.updated_at) || p.last_touched, message_count: t && Array.isArray(t.messages) ? t.messages.length : 0 };
      }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      res.json({ chat: { updated_at: general ? general.updated_at : null, message_count: general && Array.isArray(general.messages) ? general.messages.length : 0 }, projects: list });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/conversation", async (req, res) => {
    const userId = owner(req, res); if (!userId) return;
    try {
      const projectId = String(req.query.project || "");
      if (!projectId) { const t = await generalThread(userId); return res.json({ messages: (t && t.messages) || [] }); }
      const p = (await mine(userId)).find((x) => x.id === projectId);
      if (!p) return fail(res, new Error("That project is not here any more."), 404);
      const { data } = await db.from("conversation_threads").select("messages").eq("user_id", userId).eq("project_id", p.id).limit(1);
      res.json({ project: { id: p.id, emoji: p.emoji, name: p.name }, messages: (data && data[0] && data[0].messages) || [] });
    } catch (e) { fail(res, e); }
  });

  // Search Chat: its messages by their words, newest first, from the
  // conversation now and from the archive every condensed turn is kept in
  // word for word (lib/conversation.js), so an old one can be found and
  // replied to (lib/reply-context.js brings its exchange back). Project
  // conversations are their own and are left out.
  const REPLY_PREFIX = /^\s*\[replying to[^"\]]*"[\s\S]*?"\]\s*/i;
  const said = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && b.type === "text" ? b.text : "")).join(" ") : "").replace(REPLY_PREFIX, "").trim();
  const around = (text, q) => {
    const at = text.toLowerCase().indexOf(q);
    if (at < 0 || text.length <= 160) return text.slice(0, 160);
    const from = Math.max(0, at - 60);
    return (from ? "…" : "") + text.slice(from, from + 160) + (from + 160 < text.length ? "…" : "");
  };
  app.get("/api/conversation/search", async (req, res) => {
    const userId = owner(req, res); if (!userId) return;
    try {
      const q = String(req.query.q || "").trim().slice(0, 80);
      if (q.length < 2) return res.json({ results: [] });
      const needle = q.toLowerCase();
      const t = await generalThread(userId);
      const live = ((t && t.messages) || []).map((m) => ({ who: m.role === "assistant" ? "closedhand" : "me", text: said(m.content), at: m.ts || null }))
        .filter((m) => m.text && m.text.toLowerCase().includes(needle)).reverse();
      const { data: projectThreads } = await db.from("conversation_threads").select("id").eq("user_id", userId).not("project_id", "is", null);
      const skip = new Set((projectThreads || []).map((x) => String(x.id)));
      const { data: kept } = await db.from("data_cache").select("external_id, data").eq("user_id", userId).eq("source", "conversation")
        .ilike("data->>text", `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`).order("received_at", { ascending: false }).limit(60);
      const seen = new Set(live.map((m) => m.text));
      const archived = (kept || []).filter((r) => !skip.has(String(r.data?.chat)))
        .map((r) => ({ who: r.data?.sender === "Closedhand" ? "closedhand" : "me", text: said(r.data?.text), at: r.data?.date || null, n: Number(String(r.external_id).match(/-(\d+)$/)?.[1]) || 0 }))
        .filter((m) => m.text && !seen.has(m.text)).sort((a, b) => b.n - a.n);
      const results = [...live, ...archived].slice(0, 30).map((m) => ({ who: m.who, text: m.text.slice(0, 1200), snippet: around(m.text, needle), at: m.at }));
      res.json({ results });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/projects", async (req, res) => {
    const userId = owner(req, res); if (!userId) return;
    try { res.json({ projects: await mine(userId) }); } catch (e) { fail(res, e); }
  });

  // Emails, events and messages from the person's connected apps, by words
  // in their subject, title, sender or text, newest first.
  app.get("/api/projects/find", async (req, res) => {
    const userId = owner(req, res); if (!userId) return;
    try {
      const q = String(req.query.q || "").trim().slice(0, 80);
      if (q.length < 2) return res.json({ items: [] });
      const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      const found = new Map();
      for (const field of SEARCHED) {
        const { data, error } = await db.from("data_cache").select("source, type, external_id, data, received_at")
          .eq("user_id", userId).ilike(field, like).order("received_at", { ascending: false }).limit(8);
        if (error) continue;
        for (const row of data || []) {
          const item = rules.synced(row);
          if (item && !found.has(item.id)) found.set(item.id, item);
        }
      }
      const items = [...found.values()].sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 20);
      res.json({ items });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/projects", async (req, res) => {
    const userId = owner(req, res); if (!userId) return;
    try {
      const b = req.body || {};
      const title = name(b.name), emoji = rules.onlyMark(b.emoji);
      if (!title) return fail(res, new Error("Give it a name."), 400);
      if (!emoji) return fail(res, new Error("Choose one emoji for it."), 400);
      const clash = rules.takenBy(await mine(userId), emoji);
      if (clash) return fail(res, new Error(`${emoji} already marks ${clash.name}. Choose another.`), 409);
      const context = rules.withContext(rules.typed(b.context), await syncedItems(userId, b.items));
      const { data, error } = await db.from("projects").insert({
        user_id: userId, name: title, emoji, about: String(b.about || "").trim().slice(0, 600), instructions: lines(b.instructions), context, status: "active",
      }).select(COLUMNS).single();
      if (error) throw new Error("Could not start the project.");
      res.json({ project: data });
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/projects/:id", async (req, res) => {
    const userId = owner(req, res); if (!userId) return;
    try {
      const rows = await mine(userId);
      const p = rows.find((r) => r.id === req.params.id);
      if (!p) return fail(res, new Error("That project is not here any more."), 404);
      const b = req.body || {}, set = {};
      if (b.name !== undefined) { set.name = name(b.name); if (!set.name) return fail(res, new Error("Give it a name."), 400); }
      if (b.emoji !== undefined) {
        set.emoji = rules.onlyMark(b.emoji);
        if (!set.emoji) return fail(res, new Error("Choose one emoji for it."), 400);
      }
      if (b.about !== undefined) set.about = String(b.about || "").trim().slice(0, 600);
      if (b.instructions !== undefined) set.instructions = lines(b.instructions);
      if (b.add_context || b.add_items) set.context = rules.withContext(p.context, [...rules.typed(b.add_context), ...await syncedItems(userId, b.add_items)]);
      if (b.remove_context) set.context = (set.context || p.context || []).filter((c) => c.id !== b.remove_context);
      if (b.archived === true) Object.assign(set, { status: "archived", archived_at: new Date().toISOString() });
      if (b.archived === false) Object.assign(set, { status: "active", archived_at: null, expected_end: null });
      const emoji = set.emoji || p.emoji;
      const clash = (set.status || p.status) === "active" && rules.takenBy(rows, emoji, p.id);
      if (clash) return fail(res, new Error(`${emoji} already marks ${clash.name}. Choose another.`), 409);
      // Only a real change counts as an update: saving the form as it was
      // leaves "Updated" where it was.
      const same = (k) => JSON.stringify(set[k] ?? null) === JSON.stringify(p[k] ?? null);
      if (Object.keys(set).every(same)) return res.json({ project: p });
      set.last_touched = new Date().toISOString();
      const { data, error } = await db.from("projects").update(set).eq("user_id", userId).eq("id", p.id).select(COLUMNS).single();
      if (error) throw new Error("Could not save the project.");
      res.json({ project: data });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/projects/:id/merge", async (req, res) => {
    const userId = owner(req, res); if (!userId) return;
    try {
      const rows = await mine(userId);
      const into = rows.find((r) => r.id === req.params.id), from = rows.find((r) => r.id === (req.body || {}).from);
      if (!into || !from || into.id === from.id) return fail(res, new Error("Choose another project to merge into this one."), 400);
      const { data, error } = await db.from("projects").update({ ...rules.merged(into, from), last_touched: new Date().toISOString() }).eq("user_id", userId).eq("id", into.id).select(COLUMNS).single();
      if (error) throw new Error("Could not merge them.");
      await rules.mergeConversations(db, userId, into.id, from.id);
      const gone = await db.from("projects").delete().eq("user_id", userId).eq("id", from.id);
      if (gone.error) throw new Error("Merged, but the other project is still there. Delete it.");
      res.json({ project: data });
    } catch (e) { fail(res, e); }
  });

  // Its record goes; files stay where every file sent to Closedhand is kept,
  // in Context Brain, and emails and events stay in their apps.
  app.delete("/api/projects/:id", async (req, res) => {
    const userId = owner(req, res); if (!userId) return;
    const { error } = await rules.deleteProject(db, userId, req.params.id);
    if (error) return fail(res, new Error("Could not delete it."));
    res.json({ success: true });
  });

  // Files added on the dashboard are kept as files sent to Closedhand are:
  // checked by what they hold, stored, and listed under Context Brain.
  app.post("/api/projects/:id/files", upload.array("files", 10), async (req, res) => {
    const userId = owner(req, res); if (!userId) return;
    try {
      const p = (await mine(userId)).find((r) => r.id === req.params.id);
      if (!p) return fail(res, new Error("That project is not here any more."), 404);
      const { checkFile } = require("./upload-types");
      const added = [], refused = [];
      for (const f of req.files || []) {
        const fileName = String(f.originalname || "file").slice(0, 160);
        const found = checkFile(f.buffer, fileName);
        if (!found.ok) { refused.push(fileName); continue; }
        const id = `att_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const storagePath = `${userId}/${id}`;
        const up = await db.storage.from("attachments").upload(storagePath, f.buffer, { contentType: found.type, upsert: true });
        if (up.error) throw new Error("Could not store the file.");
        const { error } = await db.from("attachments").upsert({
          user_id: userId, attachment_id: id, file_name: fileName, description: `${fileName}, added to the project ${p.name}`,
          media_type: found.type, storage_path: storagePath, size_bytes: f.buffer.length, direction: "in",
        }, { onConflict: "user_id,attachment_id" });
        if (error) throw new Error("Could not store the file.");
        added.push(rules.file(id, fileName));
      }
      const { data, error } = await db.from("projects").update({ context: rules.withContext(p.context, added), last_touched: new Date().toISOString() })
        .eq("user_id", userId).eq("id", p.id).select(COLUMNS).single();
      if (error) throw new Error("Could not add the files.");
      res.json({ project: data, refused });
    } catch (e) { fail(res, e); }
  });

  app.get("/page/project/:id", async (req, res) => {
    const userId = owner(req, res); if (!userId) return;
    try {
      const { data } = await db.from("projects").select(COLUMNS).eq("user_id", userId).eq("id", req.params.id).limit(1);
      res.set("Content-Security-Policy", PAGE_CSP);
      const p = data && data[0];
      if (!p || !["active", "archived"].includes(p.status)) return res.status(404).send(withAppearance(missingHtml()));
      const { data: threads } = await db.from("conversation_threads").select("messages").eq("user_id", userId).eq("project_id", p.id).limit(1);
      const { data: routines } = await db.from("automations").select("name, status, trigger_type, trigger_human_schedule, trigger_event_source, trigger_event_condition, trigger_when, trigger_offset_minutes")
        .eq("user_id", userId).eq("project_id", p.id).order("created_at", { ascending: true });
      res.send(withAppearance(projectHtml(p, Date.now(), (threads && threads[0] && threads[0].messages) || [], await goalOf(userId, p.id), routines || [])));
    } catch (e) {
      console.error("Project page error:", e.message);
      res.status(500).send("Could not show this project.");
    }
  });
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const esc = page.esc;
const DAY = 86400000;
const longDate = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long" });

function ago(iso, now) {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return days === 1 ? "yesterday" : `${days} days ago`;
  return `on ${longDate(iso)}`;
}

// The end date, as time left.
function untilText(iso, now) {
  const days = Math.ceil((new Date(iso).getTime() - now) / DAY);
  if (days < 0) return `Ended ${longDate(iso)}`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days} days to go`;
}

// A person's answer, coloured by what it means for the project.
function stance(position) {
  const p = String(position || "").toLowerCase();
  if (/^(yes|confirmed|in|going|agreed|done)\b/.test(p)) return "yes";
  if (/^(no|declined|out|can't|cannot|not)\b/.test(p)) return "no";
  if (/^(maybe|unsure|tentative|waiting|pending|unknown)\b/.test(p)) return "maybe";
  return "role";
}
const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join("").toUpperCase();
const tint = (n) => [...String(n || "")].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 4, 0);

const ICON = {
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  note: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
  email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  event: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
  message: '<path d="M5 18l-1 3 4-2h9a3 3 0 0 0 3-3V8a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v7"/>',
  item: '<circle cx="12" cy="12" r="4"/>',
};
const icon = (kind) => `<svg viewBox="0 0 24 24" width="1.125rem" height="1.125rem" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[kind] || ICON.item}</svg>`;
const KIND_WORD = { file: "File", note: "Note", link: "Link", email: "Email", event: "Event", message: "Message", page: "Page" };

function host(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }

function contextRow(c) {
  const kind = ICON[c.kind] ? c.kind : "item";
  const word = KIND_WORD[c.kind] || "Item";
  if (c.kind === "note") {
    return `<details class="ctx note" data-ctx-id="${esc(c.id)}"><summary><span class="ctx-icon">${icon("note")}</span><span class="ctx-main"><span class="ctx-title">${esc(c.title)}</span><span class="ctx-meta">${word}</span></span></summary><div class="note-text">${esc(c.text).replace(/\n/g, "<br>")}</div></details>`;
  }
  const ext = c.kind === "file" ? (/\.([a-z0-9]{1,5})$/i.exec(c.title) || [])[1] : null;
  const meta = c.kind === "file" ? (ext ? ext.toUpperCase() : word)
    : c.kind === "link" ? host(c.url)
    : [word, c.from, c.at ? longDate(c.at) : ""].filter(Boolean).join(" · ");
  const href = c.kind === "file" ? `/api/files/${encodeURIComponent(c.id)}/download` : c.kind === "link" ? c.url : c.web || null;
  const inner = `<span class="ctx-icon">${icon(kind)}</span><span class="ctx-main"><span class="ctx-title">${esc(c.title || c.url || word)}</span><span class="ctx-meta">${esc(meta)}</span></span>`;
  return href ? `<a class="ctx" data-ctx-id="${esc(c.id)}" href="${esc(href)}"${c.kind === "file" ? "" : ' target="_blank" rel="noopener"'}>${inner}</a>` : `<div class="ctx" data-ctx-id="${esc(c.id)}">${inner}</div>`;
}

// The latest of the project's own conversation, from whichever chat it was
// in: what was said, without tool steps or the bracketed notes chat apps add.
function said(m) {
  const raw = typeof m.content === "string" ? m.content
    : Array.isArray(m.content) ? m.content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ") : "";
  let t = rules.splitReply(raw).rest.replace(/^\s*\[User uploaded[^\]]*\]\s*/, "").replace(/\[\[next\]\]/g, "\n").trim();
  if (t.length > 700) t = t.slice(0, 699).replace(/\s+\S*$/, "") + "…";
  return t;
}
function conversationHtml(messages) {
  const shown = (messages || []).filter((m) => m && (m.role === "user" || m.role === "assistant")).map((m) => ({ who: m.role, text: said(m), ts: m.ts })).filter((m) => m.text).slice(-12);
  if (!shown.length) return "";
  const time = (ts) => (ts && !isNaN(new Date(ts).getTime()) ? `<span class="when">${esc(new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" }))}</span>` : "");
  return `<section class="talk"><h2>Conversation</h2><ol>${shown.map((m) => `<li class="${m.who === "user" ? "you" : "ch"}"><span class="who-said">${m.who === "user" ? "You" : "Closedhand"}${time(m.ts)}</span><span class="bubble">${page.inline(m.text).replace(/\n+/g, "<br>")}</span></li>`).join("")}</ol></section>`;
}

// The goal, as the dashboard's goal card shows it: the finish line or the
// habit and how this week is going, their reason, the if-then plan, the
// steps and the check-ins.
function goalHtml(g) {
  if (!g) return "";
  const date = (v) => new Date(String(v).slice(0, 10) + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const rows = [];
  if (g.done_when) rows.push(["Done when", `${esc(g.done_when)}${g.target_date ? `, by ${esc(date(g.target_date))}` : ""}`]);
  else if (g.target_date) rows.push(["By", esc(date(g.target_date))]);
  if (g.habit) {
    const per = g.habit.per_week || 7, n = Math.min(g.this_week || 0, per);
    const what = [g.habit.cue, g.habit.action].filter(Boolean).join(", ");
    rows.push(["Habit", `${what ? esc(what.charAt(0).toUpperCase() + what.slice(1)) + ". " : ""}<span class="meter" role="img" aria-label="${n} of ${per} this week">${Array.from({ length: per }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</span> ${n} of ${per} this week`]);
  }
  if (g.why) rows.push(["Why", esc(g.why)]);
  if (g.if_then) rows.push(["If-then", esc(g.if_then)]);
  if (g.stage) rows.push(["Now", esc(g.stage)]);
  if (g.check_in_text && g.status === "active") rows.push(["Check-ins", esc(g.check_in_text.charAt(0).toUpperCase() + g.check_in_text.slice(1))]);
  const plan = (g.plan || []).filter((s) => s && s.text);
  const done = plan.filter((s) => s.status !== "todo").length;
  const steps = plan.length ? `<div class="goal-steps"><span class="steps-count">${done} of ${plan.length} steps</span><span class="goal-bar"><span style="width:${Math.round((done / plan.length) * 100)}%"></span></span><ul class="checks">${plan.map((s) => `<li class="${s.status === "done" ? "is-done" : ""}"><span class="box" aria-hidden="true">${s.status === "done" ? '<svg viewBox="0 0 16 16" width="0.75rem" height="0.75rem"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ""}</span>${page.inline(s.text)}</li>`).join("")}</ul></div>` : "";
  const tag = g.status === "achieved" ? `<span class="goal-tag win">Achieved${g.achieved_at ? " " + esc(new Date(g.achieved_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })) : ""}</span>` : g.status === "paused" ? '<span class="goal-tag">Paused</span>' : "";
  return `<section class="goal"><h2>Goal</h2><div class="goal-card"><p class="goal-title">${esc(g.title)}${tag}</p>${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}${steps}</div></section>`;
}

// A routine as the dashboard names it: its name in words and when it runs.
const routineName = (n) => { const t = String(n || "").replace(/[-_]+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
function routineWhen(r) {
  const off = r.status === "paused" ? " (paused)" : "";
  if (r.trigger_type === "scheduled") return (r.trigger_human_schedule || "On a schedule") + off;
  if (r.trigger_type === "event") {
    const kinds = require("./watch-kinds");
    return (r.trigger_when && r.trigger_when !== "arrives" ? "Runs " : "On ") + kinds.describe(r.trigger_event_source, r.trigger_when, r.trigger_offset_minutes) + off;
  }
  return "When you ask" + off;
}

const section = (label, count, body) => `<section><h2>${label}${count ? `<span class="count">${count}</span>` : ""}</h2>${body}</section>`;

function projectHtml(p, now = Date.now(), messages = [], goal = null, routines = []) {
  const s = p.state || {};
  const open = (s.open || []).filter(Boolean), decided = (s.decisions || []).filter(Boolean);
  const people = (s.people || []).filter((x) => x && x.name), facts = (s.facts || []).filter(Boolean);
  const context = Array.isArray(p.context) ? p.context : [];
  const archived = p.status === "archived";
  const status = archived && p.archived_at ? `Archived ${longDate(p.archived_at)}` : `Updated ${ago(p.last_touched, now)}`;
  const until = p.expected_end && !archived ? `<span class="until">${esc(untilText(p.expected_end, now))}</span>` : "";

  const main = [], side = [];
  if (open.length) main.push(section("Still open", open.length, `<ul class="checks">${open.map((t) => `<li><span class="box" aria-hidden="true"></span>${page.inline(t)}</li>`).join("")}</ul>`));
  if (decided.length) main.push(section("Decided", decided.length, `<ul class="checks done">${decided.map((t) => `<li><span class="box" aria-hidden="true"><svg viewBox="0 0 16 16" width="0.75rem" height="0.75rem"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>${page.inline(t)}</li>`).join("")}</ul>`));
  // A project's context ends with the tile to add to it (project-page.js),
  // the same choices as its form on the dashboard.
  const adding = archived ? "" : `<div class="ctx-add" data-add-context="${esc(p.id)}"><button type="button" class="add-tile">+ Add files, notes or links</button></div>`;
  // What the person adds for Closedhand to work from leads the side column,
  // with its tile, where it is seen first (as a project's knowledge is).
  const files = context.length || adding ? section("Files and notes", context.length, `<div class="ctx-list">${context.map(contextRow).join("")}</div>${adding}`) : null;
  if (people.length) {
    side.push(section("People", people.length, `<ul class="people">${people.map((x) => `<li><span class="avatar t${tint(x.name)}" aria-hidden="true">${esc(initials(x.name))}</span><span class="who"><span class="name">${esc(x.name)}${x.position && !/^unknown$/i.test(String(x.position).trim()) ? ` <span class="stance ${stance(x.position)}">${esc(x.position)}</span>` : ""}</span>${x.said ? `<span class="said">${page.inline(x.said)}</span>` : ""}</span></li>`).join("")}</ul>`));
  }
  if (facts.length) side.push(section("Worth knowing", 0, `<ul class="facts">${facts.map((t) => `<li>${page.inline(t)}</li>`).join("")}</ul>`));
  if (routines.length) side.push(section("Routines", routines.length, `<ul class="routines">${routines.map((r) => `<li><span class="r-name">${esc(routineName(r.name))}</span><span class="r-when">${esc(routineWhen(r))}</span></li>`).join("")}</ul>`));
  const rules = String(p.instructions || "").split(/\n+/).filter(Boolean);
  if (rules.length) side.unshift(section("Instructions", 0, `<ul class="rules">${rules.map((t) => `<li>${page.inline(t)}</li>`).join("")}</ul>`));
  const empty = !open.length && !decided.length && !context.length && !side.length && !p.summary && !p.about && !goal && !(messages || []).length;
  if (files) side.unshift(files);

  // Back to the Projects tab at this project, and its form for what the page
  // does not change (name, emoji, about, instructions).
  const at = `/dashboard#projects/${encodeURIComponent(p.id)}`;
  return shell(`${p.emoji} ${p.name}`, `<header class="bar"><a class="back" href="${at}"><span aria-hidden="true">&larr;</span> All projects</a><a class="manage" href="${at}/edit">Edit</a></header>
<div class="hero">
  <div class="mark" aria-hidden="true">${esc(p.emoji)}</div>
  <div class="titles">
    <h1><span class="stroke">${esc(p.name)}</span></h1>
    <p class="status"><span class="dot${archived ? " off" : ""}" aria-hidden="true"></span>${esc(status)}${until}</p>
  </div>
</div>
${archived ? `<p class="banner">This project is archived. Start a message with ${esc(p.emoji)} in any chat to bring it back.</p>` : ""}
${p.about ? `<p class="lead">${page.inline(p.about)}</p>` : ""}
${p.summary ? `<div class="stands"><span class="label">Where it stands</span><p>${page.inline(p.summary)}</p></div>` : ""}
${goalHtml(goal)}
${empty ? `<p class="empty">Nothing here yet. Start a message with ${esc(p.emoji)} in any chat to begin its conversation.</p>` : ""}
${main.length && side.length ? `<div class="grid"><div class="col">${main.join("")}</div><aside class="col">${side.join("")}</aside></div>` : main.length || side.length ? `<div class="grid one"><div class="col">${[...main, ...side].join("")}</div></div>` : ""}
${conversationHtml(messages)}
<footer>Start a message with <span class="em">${esc(p.emoji)}</span> in any chat to carry on with ${esc(p.name)}. Closedhand’s replies start with <span class="em">${esc(p.emoji)}</span> while you’re talking about it.</footer>
${adding ? `<script src="/project-context.js" defer></script><script src="/project-page.js" defer></script>` : ""}`);
}

function shell(title, inner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400..700&display=swap">
<style>
/* The app's one root size (interface.css): 90% on computers. */
html { font-size: 100%; }
@media screen and (hover: hover) and (pointer: fine) { html { font-size: 90%; } }
:root { --bg: #EFE6D6; --raised: #F7F1E7; --fg: #1A1817; --fg-rgb: 26,24,23; --muted: #5E574F; --accent: #C4513B; --accent-rgb: 196,81,59; --ok: #4E7F3A; --ok-rgb: 78,127,58; --warn: #8A6416; --warn-rgb: 138,100,22; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme-pick="light"]) { --bg: #100E0D; --raised: #1A1817; --fg: #EFE6D6; --fg-rgb: 239,230,214; --muted: #B6AFA4; --accent: #D8624B; --accent-rgb: 216,98,75; --ok: #8DBD79; --ok-rgb: 141,189,121; --warn: #D0A652; --warn-rgb: 208,166,82; color-scheme: dark; } }
:root[data-theme-pick="dark"] { --bg: #100E0D; --raised: #1A1817; --fg: #EFE6D6; --fg-rgb: 239,230,214; --muted: #B6AFA4; --accent: #D8624B; --accent-rgb: 216,98,75; --ok: #8DBD79; --ok-rgb: 141,189,121; --warn: #D0A652; --warn-rgb: 208,166,82; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 1rem/1.6 "DM Sans", system-ui, -apple-system, sans-serif; padding: max(1.125rem, env(safe-area-inset-top)) 1rem 3.5rem; -webkit-font-smoothing: antialiased; }
main { max-width: 55rem; margin: 0 auto; }
a { color: inherit; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding-bottom: 1rem; border-bottom: 1px solid rgba(var(--fg-rgb),0.12); }
.brand { display: flex; align-items: center; gap: 0.5rem; color: var(--muted); font-size: 0.8125rem; text-decoration: none; }
.brand img { width: 1.125rem; height: 1.125rem; filter: brightness(0.11); }
@media (prefers-color-scheme: dark) { :root:not([data-theme-pick="light"]) .brand img { filter: none; } }
:root[data-theme-pick="dark"] .brand img { filter: none; }
.manage, .back { font-size: 0.8125rem; color: var(--muted); text-decoration: none; }
.back:hover, .back:focus-visible { color: var(--accent); }
.manage:hover, .manage:focus-visible { color: var(--accent); }
.hero { display: flex; align-items: center; gap: 1.375rem; margin: 2.5rem 0 1.625rem; animation: rise .5s cubic-bezier(.2,.7,.2,1) both; }
.mark { flex: none; width: 5.5rem; height: 5.5rem; border-radius: 1.5rem; display: grid; place-items: center; font-size: 3rem; line-height: 1; background: var(--raised); border: 1px solid rgba(var(--fg-rgb),0.1); box-shadow: 0 0.875rem 2rem -1.125rem rgba(var(--accent-rgb),0.55); }
.titles { min-width: 0; }
h1 { font-size: clamp(1.7rem, 4.6vw, 2.5rem); font-weight: 700; line-height: 1.15; letter-spacing: -0.015em; margin: 0 0 0.75rem; text-wrap: balance; }
.stroke { position: relative; }
.stroke::after { content: ""; position: absolute; left: -0.25rem; right: -0.375rem; bottom: -0.4375rem; height: 0.625rem; background: var(--accent); -webkit-mask: url(/brush-underline.svg) center / 100% 100% no-repeat; mask: url(/brush-underline.svg) center / 100% 100% no-repeat; animation: draw .7s .25s cubic-bezier(.2,.7,.2,1) both; }
.status { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.625rem; margin: 0; color: var(--muted); font-size: 0.875rem; }
.dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 0.25rem rgba(var(--ok-rgb),0.16); }
.dot.off { background: var(--muted); box-shadow: none; }
.until { font-weight: 600; color: var(--accent); background: rgba(var(--accent-rgb),0.1); border-radius: 62.4375rem; padding: 2px 0.625rem; font-size: 0.8125rem; }
.banner { margin: 0 0 1.375rem; padding: 0.75rem 1rem; border-radius: 0.75rem; background: rgba(var(--fg-rgb),0.05); color: var(--muted); font-size: 0.875rem; }
.lead { font-size: 1.2rem; line-height: 1.55; margin: 0 0 1.5rem; max-width: 62ch; color: rgba(var(--fg-rgb),0.82); }
.stands { margin: 0 0 2rem; padding: 1rem 1.25rem; border-left: 0.1875rem solid var(--accent); background: var(--raised); border-radius: 0 0.75rem 0.75rem 0; }
.stands p { margin: 0; font-size: 1.05rem; }
.rules li { position: relative; padding: 0.5625rem 0.75rem 0.5625rem 2.125rem; margin: 0 0 0.375rem; border-radius: 0.625rem; background: var(--raised); border: 1px solid rgba(var(--fg-rgb),0.08); font-size: 0.9375rem; }
.rules li::before { content: ""; position: absolute; left: 0.8125rem; top: 0.9375rem; width: 0.5625rem; height: 0.5625rem; border-right: 2px solid var(--accent); border-bottom: 2px solid var(--accent); transform: rotate(-45deg); }
.label, h2 { display: block; font-size: 0.75rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0 0 0.625rem; }
.count { margin-left: 0.5rem; color: var(--accent); }
.grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 2.25rem; margin-top: 0.5rem; }
.grid.one { grid-template-columns: minmax(0, 1fr); }
section { margin: 0 0 1.875rem; animation: rise .5s .1s cubic-bezier(.2,.7,.2,1) both; }
ul { list-style: none; margin: 0; padding: 0; }
.checks li { display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.625rem 0; border-bottom: 1px solid rgba(var(--fg-rgb),0.08); }
.checks li:last-child { border-bottom: 0; }
.box { flex: none; width: 1.125rem; height: 1.125rem; margin-top: 0.1875rem; border-radius: 50%; border: 1.6px solid rgba(var(--fg-rgb),0.35); display: grid; place-items: center; }
.done .box { background: var(--ok); border-color: var(--ok); color: var(--bg); }
.done li { color: var(--muted); }
.ctx-list { display: grid; gap: 0.5rem; }
.ctx-add { margin-top: 0.5rem; display: grid; gap: 0.625rem; }
.add-tile { width: 100%; padding: 0.8125rem 0.875rem; border-radius: 0.75rem; border: 1px dashed rgba(var(--fg-rgb),0.24); background: transparent; color: var(--muted); font: inherit; font-size: 0.9375rem; text-align: left; cursor: pointer; }
.add-tile:hover, .add-tile:focus-visible { color: var(--fg); border-color: rgba(var(--fg-rgb),0.4); outline: none; }
.context-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.goal-small { display: inline-flex; align-items: center; padding: 0.4375rem 0.75rem; border-radius: 0.5rem; border: 1px solid rgba(var(--fg-rgb),0.2); background: var(--raised); color: var(--fg); font: inherit; font-size: 0.8125rem; cursor: pointer; }
.goal-small:hover { border-color: rgba(var(--fg-rgb),0.36); }
.goal-small:disabled { opacity: .55; cursor: default; }
.goal-quiet { background: transparent; border-color: transparent; color: var(--muted); }
.context-box { display: grid; gap: 0.5rem; padding: 0.75rem; border: 1px solid rgba(var(--fg-rgb),0.14); border-radius: 0.75rem; background: var(--raised); }
.context-box input, .context-box textarea { font: inherit; font-size: 0.875rem; padding: 0.5625rem 0.6875rem; border-radius: 0.5rem; border: 1px solid rgba(var(--fg-rgb),0.18); background: var(--bg); color: var(--fg); }
.goal-new-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.context-results { display: grid; gap: 0.375rem; max-height: 18.75rem; overflow-y: auto; }
.context-row { display: flex; align-items: center; gap: 0.625rem; padding: 0.5rem 0.625rem; border-radius: 0.5rem; background: rgba(var(--fg-rgb),0.04); font-size: 0.875rem; }
.context-kind { flex: none; min-width: 3.5rem; font-size: 0.7188rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); }
.context-title { flex: 1; min-width: 0; display: grid; overflow: hidden; }
.context-title > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-meta { color: var(--muted); font-size: 0.7812rem; }
.project-hint { margin: 0; color: var(--muted); font-size: 0.7812rem; }
.project-hint.error { color: var(--accent); }
.ctx { display: flex; align-items: center; gap: 0.75rem; padding: 0.6875rem 0.875rem; border-radius: 0.75rem; background: var(--raised); border: 1px solid rgba(var(--fg-rgb),0.08); text-decoration: none; transition: border-color .15s, transform .15s; }
a.ctx:hover, a.ctx:focus-visible { border-color: rgba(var(--accent-rgb),0.5); transform: translateY(-1px); }
.note { display: block; padding: 0; }
.note summary { display: flex; align-items: center; gap: 0.75rem; padding: 0.6875rem 0.875rem; cursor: pointer; list-style: none; }
.note summary::-webkit-details-marker { display: none; }
.note[open] summary .ctx-meta::after { content: " · hide"; }
.note:not([open]) summary .ctx-meta::after { content: " · show"; }
.note-text { padding: 0 1rem 0.875rem 3.75rem; font-size: 0.9375rem; }
.ctx-icon { flex: none; width: 2.125rem; height: 2.125rem; border-radius: 0.625rem; display: grid; place-items: center; color: var(--accent); background: rgba(var(--accent-rgb),0.1); }
.ctx-main { min-width: 0; display: grid; }
.ctx-title { font-weight: 500; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.ctx-meta { font-size: 0.7812rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.people li { display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.5rem 0; }
.avatar { flex: none; width: 2.25rem; height: 2.25rem; border-radius: 50%; display: grid; place-items: center; font-size: 0.8125rem; font-weight: 600; }
.t0 { background: rgba(var(--accent-rgb),0.16); color: var(--accent); }
.t1 { background: rgba(var(--ok-rgb),0.18); color: var(--ok); }
.t2 { background: rgba(var(--warn-rgb),0.18); color: var(--warn); }
.t3 { background: rgba(var(--fg-rgb),0.1); color: var(--fg); }
.who { display: grid; min-width: 0; }
.name { font-weight: 600; }
.stance { font-size: 0.75rem; font-weight: 600; border-radius: 62.4375rem; padding: 1px 0.5rem; margin-left: 0.25rem; background: rgba(var(--fg-rgb),0.08); color: var(--muted); }
.stance.yes { background: rgba(var(--ok-rgb),0.16); color: var(--ok); }
.stance.no { background: rgba(var(--accent-rgb),0.14); color: var(--accent); }
.stance.maybe { background: rgba(var(--warn-rgb),0.16); color: var(--warn); }
.said { font-size: 0.875rem; color: var(--muted); }
.routines li { display: grid; padding: 0.5rem 0; border-bottom: 1px solid rgba(var(--fg-rgb),0.08); }
.routines li:last-child { border-bottom: 0; }
.r-name { font-weight: 500; }
.r-when { font-size: 0.8438rem; color: var(--muted); }
.facts li { position: relative; padding: 0.375rem 0 0.375rem 1rem; font-size: 0.9375rem; }
.facts li::before { content: ""; position: absolute; left: 0; top: 0.9375rem; width: 0.375rem; height: 0.375rem; border-radius: 50%; background: var(--accent); opacity: .7; }
.goal { margin: 0 0 2rem; }
.goal-card { padding: 1.125rem 1.25rem; border-radius: 0.875rem; background: var(--raised); border: 1px solid rgba(var(--fg-rgb),0.08); }
.goal-title { margin: 0 0 0.625rem; font-size: 1.1rem; font-weight: 600; }
.goal-tag { margin-left: 0.625rem; font-size: 0.75rem; font-weight: 600; border-radius: 62.4375rem; padding: 2px 0.5625rem; background: rgba(var(--fg-rgb),0.08); color: var(--muted); vertical-align: middle; }
.goal-tag.win { background: rgba(var(--ok-rgb),0.16); color: var(--ok); }
.goal dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.375rem 1rem; margin: 0; font-size: 0.9375rem; }
.goal dt { color: var(--muted); font-size: 0.8125rem; padding-top: 2px; }
.goal dd { margin: 0; }
.meter { display: inline-flex; gap: 0.25rem; vertical-align: middle; margin: 0 0.25rem; }
.meter i { width: 0.625rem; height: 0.625rem; border-radius: 50%; border: 1.5px solid rgba(var(--fg-rgb),0.3); }
.meter i.on { background: var(--ok); border-color: var(--ok); }
.goal-steps { margin-top: 0.875rem; padding-top: 0.75rem; border-top: 1px solid rgba(var(--fg-rgb),0.08); }
.steps-count { font-size: 0.8125rem; color: var(--muted); }
.goal-bar { display: block; height: 0.375rem; margin: 0.375rem 0 0.25rem; border-radius: 62.4375rem; background: rgba(var(--fg-rgb),0.1); overflow: hidden; }
.goal-bar span { display: block; height: 100%; background: var(--accent); border-radius: 62.4375rem; }
.goal .checks li.is-done { color: var(--muted); }
.goal .checks li.is-done .box { background: var(--ok); border-color: var(--ok); color: var(--bg); }
.talk ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
.talk li { display: grid; gap: 0.25rem; max-width: 78%; }
.talk li.you { justify-self: end; text-align: right; }
.who-said { font-size: 0.75rem; color: var(--muted); }
.who-said .when { margin-left: 0.5rem; opacity: .8; }
.bubble { display: inline-block; text-align: left; padding: 0.625rem 0.875rem; border-radius: 1rem; font-size: 0.9375rem; line-height: 1.5; background: var(--raised); border: 1px solid rgba(var(--fg-rgb),0.08); }
.you .bubble { background: rgba(var(--accent-rgb),0.12); border-color: rgba(var(--accent-rgb),0.2); border-bottom-right-radius: 0.375rem; }
.ch .bubble { border-bottom-left-radius: 0.375rem; }
.empty { padding: 1.375rem; border-radius: 0.875rem; border: 1px dashed rgba(var(--fg-rgb),0.2); color: var(--muted); text-align: center; }
footer { margin-top: 2.25rem; padding-top: 1.125rem; border-top: 1px solid rgba(var(--fg-rgb),0.12); color: var(--muted); font-size: 0.875rem; }
footer .em { font-size: 1.125rem; }
@keyframes rise { from { opacity: 0; transform: translateY(0.375rem); } to { opacity: 1; transform: none; } }
@keyframes draw { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@media (prefers-reduced-motion: reduce) { .hero, section, .stroke::after { animation: none; } }
@media (max-width: 720px) {
  .grid { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .hero { gap: 1rem; margin-top: 1.75rem; }
  .mark { width: 4.25rem; height: 4.25rem; border-radius: 1.25rem; font-size: 2.25rem; }
  .lead { font-size: 1.08rem; }
  .talk li { max-width: 92%; }
}
</style></head>
<body><main>
${inner}
</main></body></html>`;
}

function missingHtml() {
  return shell("Project not found", `<header class="bar"><a class="brand" href="/"><img src="/fist.png" alt="">Closedhand</a></header>
<div class="hero"><div class="titles"><h1>This project isn’t here</h1></div></div>
<p class="lead">It may have been deleted or merged into another, or the link may be for a different Closedhand.</p>
<p><a href="/dashboard#projects">Your projects</a> &middot; <a href="/">Back to Closedhand</a></p>`);
}

module.exports = { register, projectHtml };
