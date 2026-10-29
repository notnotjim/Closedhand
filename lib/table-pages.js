// lib/table-pages.js: a table Closedhand keeps (the dataset tools) is a page,
// like everything else it makes. Its page holds the table as it is now: the
// page's row in reports is rewritten whenever the table changes, so the
// person has one page that is always current and downloads as Excel, never a
// new page per change. It never archives (lib/page-expiry.js), and it goes
// when the table is deleted.

const cell = (v) => String(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v)
  .replace(/\s*\n\s*/g, " ").replace(/\|/g, "/");

function tableMarkdown(ds, rows) {
  const cols = (ds.columns || []).map((c) => c.name);
  const lines = ds.description ? [ds.description, ""] : [];
  if (!cols.length) return lines.concat("No columns yet.").join("\n");
  lines.push(`| ${cols.map(cell).join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`);
  for (const r of rows) lines.push(`| ${cols.map((c) => cell((r.data || {})[c])).join(" | ")} |`);
  if (!rows.length) lines.push("", "No rows yet.");
  return lines.join("\n");
}

// The table's page, made or brought up to date. Returns the page's id.
async function syncTablePage(db, userId, datasetId) {
  const { data: ds } = await db.from("datasets").select("id, name, columns, description").eq("id", datasetId).eq("user_id", userId).single();
  if (!ds) return null;
  const { data: rows } = await db.from("dataset_rows").select("data, row_index, created_at").eq("dataset_id", datasetId)
    .order("created_at", { ascending: true }).order("row_index", { ascending: true }).limit(5000);
  const content = tableMarkdown(ds, rows || []);
  const { data: existing } = await db.from("reports").select("id").eq("user_id", userId).eq("dataset_id", datasetId).limit(1);
  if (existing && existing[0]) {
    const { error } = await db.from("reports").update({ title: ds.name, content, updated_at: new Date().toISOString() }).eq("id", existing[0].id).eq("user_id", userId);
    if (error) throw error;
    return existing[0].id;
  }
  const { data: made, error } = await db.from("reports")
    .insert({ user_id: userId, dataset_id: datasetId, title: ds.name, content, reason: "A table Closedhand keeps up to date" })
    .select("id").single();
  if (error) throw error;
  return made.id;
}

// What a dataset tool adds to its result: the page, to share when the table
// is new or the person asks where it is.
async function pageOf(db, userId, datasetId, platform) {
  try {
    const id = await syncTablePage(db, userId, datasetId);
    const url = id ? await require("./dashboard-links").reportUrl(platform, id).catch(() => null) : null;
    return url ? { page: url } : {};
  } catch (e) {
    console.error("[tables] page not updated:", e.message);
    return {};
  }
}

module.exports = { tableMarkdown, syncTablePage, pageOf };
