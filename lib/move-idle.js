// The bot of a Closedhand that is moving to another computer, or has moved
// (lib/move-marker.js). It starts nothing: no chat apps, schedules or sync.
// It answers its health check, saying so, and the dashboard's call to start
// again once the move is over or has failed (webapp/move.js).
const express = require("express");

// POST /internal/restart, for the dashboard: the process ends and Docker,
// the Mac app or the host starts it again, reading the marker afresh. A
// non-zero exit, because a host may restart a service only when it fails.
// The dashboard sends its marker along, and it is written here too: on
// Docker and the Mac app the two share the folder, so it is the same file;
// on Railway each has a volume of its own, and the bot reads only its own.
function registerRestart(app, stop = async () => {}) {
  const { verifyToken } = require("./ws-ticket");
  app.post("/internal/restart", express.json(), async (req, res) => {
    if (!verifyToken(req.get("x-closedhand-token"))) return res.status(401).json({ error: "Not allowed" });
    const sent = req.body && Object.prototype.hasOwnProperty.call(req.body, "marker") ? req.body.marker : undefined;
    try {
      const marker = require("./move-marker");
      if (sent === null) marker.clear();
      else if (sent && ["moving", "moved"].includes(sent.state)) marker.write(sent);
    } catch (e) { console.error("[move] the marker the dashboard sent:", e.message); }
    res.json({ restarting: true });
    console.log("[move] restarting at the dashboard's request");
    setTimeout(async () => {
      try { await stop(); } catch (_) {}
      // Files that came with a move go in first, so the bot that starts
      // next finds its WhatsApp session in place (move-files.js).
      try { await require("./move-files").restore(); } catch (e) { console.error("[move] files that came with the move:", e.message); }
      process.exit(1);
    }, 200);
  });
  // Moved, and the new Closedhand runs: the bot's own folder is cleared, all
  // but the marker (the dashboard clears the rest, webapp/move-clear.js). On
  // Docker and the Mac app the folder is shared and already empty.
  app.post("/internal/move-clear", (req, res) => {
    if (!verifyToken(req.get("x-closedhand-token"))) return res.status(401).json({ error: "Not allowed" });
    const marker = require("./move-marker");
    if ((marker.read() || {}).state !== "moved") return res.status(409).json({ error: "Not moved" });
    const fs = require("fs"), path = require("path");
    const dir = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : null;
    let gone = 0;
    try {
      for (const name of dir ? fs.readdirSync(dir) : []) {
        if (name === marker.NAME) continue;
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        gone++;
      }
    } catch (e) { console.error("[move] clearing the bot's folder:", e.message); return res.status(500).json({ error: "The bot's folder could not be cleared." }); }
    console.log(`[move] cleared the bot's folder (${gone} items)`);
    res.json({ cleared: gone });
  });
  // Moving away from a host where the bot keeps its folder to itself
  // (Railway): its own files, such as the WhatsApp session, go into the
  // database for the move to take along (move-files.js stash).
  app.post("/internal/move-files/stash", async (req, res) => {
    if (!verifyToken(req.get("x-closedhand-token"))) return res.status(401).json({ error: "Not allowed" });
    try { res.json({ files: await require("./move-files").stash() }); }
    catch (e) { console.error("[move] the bot's files:", e.message); res.status(500).json({ error: "The bot's files could not be gathered." }); }
  });
}

function start() {
  const state = require("./move-marker").read();
  const app = express();
  app.use(express.json());
  app.get("/health", (req, res) => res.json({ status: "ok", platform: "closedhand-bot", move: state && state.state }));
  registerRestart(app);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[move] ${state.state === "moved" ? "moved to another computer" : "moving to another computer"}: the bot starts nothing (port ${port})`));
}

module.exports = { start, registerRestart };
