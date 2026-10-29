// The dashboard of a Closedhand that has moved to another computer
// (move.js). It starts nothing else, no sync, tunnel or schedule: every page
// says where Closedhand went. Once the new one runs, this computer is
// cleared of everything Closedhand kept here (move-clear.js).
const express = require("express");
const fs = require("fs");
const path = require("path");
const assets = require("./assets");

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(state) {
  let url = null;
  try { url = new URL(state.url || state.to).href.replace(/\/$/, ""); } catch (_) { /* no address recorded */ }
  let where = "on another computer";
  try { if (new URL(state.to).hostname.endsWith(".railway.app")) where = "on Railway"; } catch (_) {}
  const html = assets.stamp(fs.readFileSync(path.join(__dirname, "views", "moved.html"), "utf8"))
    .replace("__WHERE__", where)
    .replace("__URL__", escape(url || "#"))
    .replace("__URL_TEXT__", escape(url ? url.replace(/^https?:\/\//, "") : "its new address"))
    // On Railway the old one is a project that costs money while it stays.
    .replace("__LEFT__", require("./move-clear").leftWords(state, !!process.env.RAILWAY_ENVIRONMENT_ID));
  return assets.withAppearance(html);
}

// Clearing this computer, once the new Closedhand answers: the database, the
// storage folder, the sandbox computer and, where it has a folder of its own,
// the bot's.
function clearDeps(state) {
  const marker = require("./move-marker");
  const { BOT_INTERNAL_URL, botToken } = require("./bot-call");
  const sandboxUrl = process.env.SANDBOX_URL || (process.env.CLOSEDHAND_DESKTOP ? "" : "http://sandbox:8080");
  return {
    pool: require("./db-driver-pg").createPgClient({ connectionString: process.env.DATABASE_URL, applicationName: "closedhand-moved" })._pool,
    storageDir: process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : null,
    markerName: marker.NAME,
    marker,
    clearSandbox: sandboxUrl ? async (code) => {
      const r = await fetch(new URL("/exec", sandboxUrl.includes("://") ? sandboxUrl : "http://" + sandboxUrl), {
        method: "POST", headers: { "X-Sandbox-Token": process.env.SANDBOX_TOKEN || "", "Content-Type": "application/json" },
        body: JSON.stringify({ language: "bash", code, timeout_ms: 60000 }), signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) throw new Error(`the sandbox computer answered ${r.status}`);
    } : null,
    clearBot: async () => {
      const r = await fetch(`${BOT_INTERNAL_URL}/internal/move-clear`, {
        method: "POST", headers: { "x-closedhand-token": botToken(require("./admin").getAdminUserId()) }, signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`the bot answered ${r.status}`);
    },
    onCleared: () => { state.cleared = true; },
  };
}

function serve() {
  const state = require("./move-marker").read();
  if (process.env.DATABASE_URL) require("./move-clear").whenMoved(state, clearDeps(state));
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (req, res) => res.json({ status: "ok", service: "closedhand-webapp", move: "moved" }));
  // Settings polls this while handing over; after the restart it lands here.
  // A move to Railway names its Railway address; one to a computer of the
  // person's own keeps the personal URL, so Settings words each as it was.
  app.get("/api/move/status", (req, res) => {
    let railway = false;
    try { railway = new URL(state.to).hostname.endsWith(".railway.app"); } catch (_) {}
    res.set("Cache-Control", "no-store").json({ step: "done", url: state.url || state.to || null, ...(railway ? {} : { home: true }), ...(process.env.RAILWAY_ENVIRONMENT_ID ? { railway: true } : {}) });
  });
  app.use(express.static(path.join(__dirname, "public"), { setHeaders: assets.cacheHeaders }));
  app.use((req, res) => res.set("Cache-Control", "no-store").type("html").send(page(state)));
  const port = process.env.PORT || 3000;
  app.listen(port, process.env.LISTEN_HOST || undefined, () => console.log(`[move] moved to ${state.to}: the dashboard shows only that (port ${port})`));
}

module.exports = { serve, page };
