// lib/chat-tables.js: a table in a chat app.
//
// No chat app shows a table: WhatsApp, Telegram, Slack, Discord and LINE show
// a Markdown table's pipes and dashes as typed, so an answer's figures came
// out as a grid of symbols. The person's model is asked not to send one there
// (response-presentation.js) and sometimes does anyway. So in a chat app each
// table goes as one line per row, its first cell the label
// ("Plan B: Buy £280k, Rent £15k/mo"), and a chat answer that had one is
// also kept as a page with the table laid out as a table, linked under the
// answer, which stays whole in the chat. The web chat shows tables as they are.

// A table as a page reads one (report-page.js).
const ROW = /^\s*\|.*\|\s*$/;
const RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*```/;
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const bare = (c) => String(c || "").replace(/\*\*|__/g, "").trim().replace(/^([*_])(.+)\1$/, "$2").trim();
const EMPTY = /^(|-|–|—|n\/a)$/i;

const CHAT_APPS = new Set(["telegram", "whatsapp", "whatsapp_linked", "slack", "discord", "line"]);
// A label is bold in the reply's own Markdown, which WhatsApp's sender turns
// into its own (chat-format.js); Telegram and LINE show it as typed, so plain.
const PLAIN = new Set(["telegram", "line"]);

// The tables in a text, outside code: where each starts and ends, its header and rows.
function tablesIn(text) {
  const lines = String(text == null ? "" : text).split("\n");
  const found = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced || !ROW.test(lines[i]) || !RULE.test(lines[i + 1] || "")) continue;
    const start = i, header = cells(lines[i]), rows = [];
    for (i += 2; i < lines.length && ROW.test(lines[i]); i++) rows.push(cells(lines[i]));
    found.push({ start, end: i, header, rows });
    i--;
  }
  return { lines, found };
}

const hasTable = (text) => tablesIn(text).found.length > 0;

// "Label: Column value, Column value"; with one column beside the label, just its value.
function rowLine(header, row, platform) {
  const b = PLAIN.has(platform) ? "" : "**";
  const label = bare(row[0]);
  const pairs = [];
  for (let j = 1; j < header.length; j++) {
    const value = String(row[j] || "").trim();
    if (EMPTY.test(value)) continue;
    const name = bare(header[j]);
    pairs.push(header.length === 2 || !name ? value : `${name} ${value}`);
  }
  if (header.length < 2) return `- ${label}`;
  const said = pairs.join(pairs.some((p) => p.includes(",")) ? "; " : ", ");
  if (!label) return said;
  return said ? `${b}${label}${b}: ${said}` : `${b}${label}${b}`;
}

function flatten(text, platform) {
  if (!CHAT_APPS.has(platform) || typeof text !== "string") return text;
  const { lines, found } = tablesIn(text);
  if (!found.length) return text;
  const out = [];
  let at = 0;
  for (const t of found) {
    out.push(...lines.slice(at, t.start), ...t.rows.map((r) => rowLine(t.header, r, platform)));
    at = t.end;
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}

const REASON = "A chat answer with a table, laid out as one";
const short = (t, n) => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t);

// The answer as a page. A run's page belongs to its run, as save_report's
// does, so its delivery links it (task-delivery.js). Returns the page's id.
async function keepAsPage(userId, text, { title = "", run = null, db = null } = {}) {
  db = db || require("../user-store").supabase;
  const content = require("./plain-dashes").noEmDashes(require("./follow-on").joined(text).trim());
  const named = short(String(title || "").replace(/\s+/g, " ").trim(), 110) || "Table";
  const { data, error } = await db.from("reports").insert({ user_id: userId, title: named, content, reason: REASON,
    ...(run ? { [run.table === "automation_runs" ? "automation_run_id" : "task_id"]: run.id } : {}) }).select("id").single();
  if (error || !data) throw new Error(error?.message || "no record came back");
  return data.id;
}

// A chat turn's page is named after the question until the person's model
// gives it a short title, after the answer has gone.
async function retitle(userId, id, asked, store, db = null) {
  db = db || require("../user-store").supabase;
  const { client, model } = require("./llm").getInternalClient(userId, store);
  const resp = await Promise.race([
    client.messages.create({ model, max_tokens: 30, messages: [{ role: "user", content: `Give a page answering this question a short title (3-7 words, no quotes):\n${String(asked).slice(0, 400)}` }] }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
  ]);
  const title = String(require("./model-wire").responseText(resp) || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/[*_#`]/g, "").trim().replace(/^["'“‘]+|["'”’.\s]+$/g, "");
  if (title && title.length <= 80) await db.from("reports").update({ title }).eq("id", id).eq("user_id", userId);
}

// A chat turn's answer, as a chat app is sent it: the page first, unless the
// turn made one already, then the tables as lines.
async function forChatApp({ userId, platform, text, asked = "", madePage = false }) {
  if (!CHAT_APPS.has(platform) || !hasTable(text)) return text;
  let out = text;
  if (userId && !madePage && !require("./page-link").hasLink(text)) {
    try {
      const id = await keepAsPage(userId, text, { title: asked });
      const ctx = require("./context"), store = ctx.activeUserStore;
      if (asked) setImmediate(() => ctx.runWithInheritedContext(() => retitle(userId, id, asked, store))
        .catch((e) => console.warn(`[tables] page keeps the question as its title: ${e.message}`)));
      const url = await require("./dashboard-links").reportUrl(platform, id);
      if (url) out = `${out.trim()}\n\nOpen the page: ${url}`;
    } catch (e) {
      console.warn(`[tables] no page for the table: ${e.message}`);
    }
  }
  return flatten(out, platform);
}

module.exports = { hasTable, flatten, keepAsPage, forChatApp, CHAT_APPS };
