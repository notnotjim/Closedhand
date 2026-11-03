// lib/embed-route.js: POST /internal/embed, how File Search in the dashboard
// (webapp/rag-processor.js) uses the local embedding model, which runs here in
// the bot. { texts, query } in, { vectors } out, each the 1536-wide vector the
// index keeps. A query is someone waiting and goes ahead of background work.
// A picture's own bytes (application/octet-stream, any size: a scanner's TIFF
// is tens of MB) is embedded by what it shows, into the same space, with
// EmbeddingGemma 2, and comes back as { vectors: [one] }.
const MAX_TEXTS = 64;

function register(app, deps = {}) {
  const verifyToken = deps.verifyToken || require("./web-chat-ws").verifyToken;
  const usi = deps.usi || require("./services/usi");
  const express = require("express");
  const body = deps.body || [express.json({ limit: "2mb" }), express.raw({ type: "application/octet-stream", limit: "512mb" })];
  app.post("/internal/embed", body, async (req, res) => {
    if (!verifyToken(req.get("x-closedhand-token"))) return res.status(401).json({ error: "Not allowed" });
    // File Search reading a folder, or searching it: busy (lib/idle.js).
    require("./idle").touch();
    if (Buffer.isBuffer(req.body)) {
      const lm = deps.localModels || require("./local-models");
      if (lm.embedderSpec().runner !== "eg2") return res.status(409).json({ error: "Pictures are embedded by EmbeddingGemma 2 only" });
      if (!req.body.length) return res.status(400).json({ error: "No picture came through." });
      try {
        return res.json({ vectors: [await lm.localEmbedMedia("image", req.body)] });
      } catch (e) {
        console.log(`[embed] picture not embedded: ${e.message}`);
        return res.status(503).json({ error: "The picture model is not ready yet" });
      }
    }
    const texts = Array.isArray(req.body?.texts) ? req.body.texts.slice(0, MAX_TEXTS).map((t) => String(t || "")) : [];
    if (!texts.length) return res.status(400).json({ error: "Nothing to embed" });
    // A file's chunks wait their turn with the rest of the indexing.
    const vectors = await usi.embedBatch(texts, { quick: !!req.body.query }).catch(() => []);
    if (vectors.length !== texts.length) return res.status(503).json({ error: "The embedding model is not ready yet" });
    res.json({ vectors });
  });
}

module.exports = { register, MAX_TEXTS };
