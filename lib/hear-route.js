// lib/hear-route.js: POST /internal/hear, how File Search in the dashboard
// (webapp/rag-processor.js) gets recordings and videos written out: the
// speech to text lives here, in the bot. The file is the body, its name is
// ?name=, and a video asks for ?video=1 and up to ?frames=N frames; ?vectors=1
// asks for the sound and frames embedded too (EmbeddingGemma 2 only).
// Answers { text, duration, frames: [{ time, jpeg, vector }], sound: [{ start,
// end, vector }], note }, where text is what's said, one line per stretch,
// each starting with its time ("[7:55]").
//
// The file is written to disk as it arrives, whatever its size, and heard
// from there; one hearing at a time across Closedhand (lib/idle.js), the file
// step's included. GET /internal/idle says whether Closedhand is otherwise
// idle, which File Search waits for before sending a recording or a video.
//
// POST /internal/describe-image is the same for a picture, which File Search
// always has described here: the picture is the body, and the answer is
// { text }, what it shows, by the VLM (lib/local-models.js).

// Its own errors are written for people; anything else is logged, not shown.
const SAYABLE = /sandbox|too long|couldn't open|can't/i;

function register(app, deps = {}) {
  const verifyToken = deps.verifyToken || require("./web-chat-ws").verifyToken;
  const hear = deps.hear || ((args) => require("./video").hearMedia(args));
  const idle = deps.idle || require("./idle");
  const describe = deps.describe || ((bytes) => require("./local-models").localDescribeImage(bytes));
  const fs = require("fs");
  const { pipeline } = require("stream/promises");
  const { tempPath, removeTemp } = require("./download-file");
  app.get("/internal/idle", (req, res) => {
    if (!verifyToken(req.get("x-closedhand-token"))) return res.status(401).json({ error: "Not allowed" });
    res.json({ idle: idle.isIdle() });
  });
  app.post("/internal/describe-image", async (req, res) => {
    if (!verifyToken(req.get("x-closedhand-token"))) return res.status(401).json({ error: "Not allowed" });
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (!bytes.length) return res.status(400).json({ error: "No picture came through." });
      res.json({ text: await describe(bytes) });
    } catch (e) {
      console.error(`[see] not read: ${e.message}`);
      res.status(503).json({ error: "Closedhand couldn't see this picture just now." });
    }
  });
  app.post("/internal/hear", async (req, res) => {
    const userId = verifyToken(req.get("x-closedhand-token"));
    if (!userId) return res.status(401).json({ error: "Not allowed" });
    const name = String(req.query.name || "file").slice(0, 200);
    const file = tempPath(name);
    try {
      await pipeline(req, fs.createWriteStream(file));
      if (!fs.statSync(file).size) return res.status(400).json({ error: "No file came through." });
      const heard = await idle.oneAtATime(() => hear({
        userId, file, name,
        video: req.query.video === "1", frames: Math.max(0, Math.min(24, Number(req.query.frames) || 0)), vectors: req.query.vectors === "1",
      }));
      res.json({
        text: saidText(heard.said),
        duration: heard.duration || null,
        frames: (heard.frames || []).map((f) => ({ time: f.time, jpeg: Buffer.from(f.jpeg).toString("base64"), vector: f.vector || null })),
        sound: heard.sound || [],
        note: heard.note || null,
      });
    } catch (e) {
      console.error(`[hear] not written out: ${e.message}`);
      res.status(503).json({ error: e.userFacing || SAYABLE.test(e.message) ? e.message : "Closedhand couldn't hear this file just now." });
    } finally {
      removeTemp(file);
    }
  });
}

// What's said, whole, each line with its time.
function saidText(said) {
  const { clock } = require("./video");
  return (said?.lines || []).map((l) => (l.start == null ? "" : `[${clock(l.start)}] `) + l.text).join("\n");
}

module.exports = { register, saidText };
