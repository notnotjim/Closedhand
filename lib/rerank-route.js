// lib/rerank-route.js: POST /internal/rerank, how File Search in the dashboard
// ranks with the local cross-encoder, which runs here in the bot, as embedding
// does (embed-route.js). { query, texts } in, { scores } out, one per text,
// in the order sent. The dashboard sends at most the 20 it ranks.
const MAX_TEXTS = 20;

function register(app, deps = {}) {
  const verifyToken = deps.verifyToken || require("./web-chat-ws").verifyToken;
  const body = deps.body || require("express").json({ limit: "2mb" });
  app.post("/internal/rerank", body, async (req, res) => {
    if (!verifyToken(req.get("x-closedhand-token"))) return res.status(401).json({ error: "Not allowed" });
    const query = String(req.body?.query || "").slice(0, 2000);
    const texts = Array.isArray(req.body?.texts) ? req.body.texts.slice(0, MAX_TEXTS).map((t) => String(t || "").slice(0, 512)) : [];
    if (!query || !texts.length) return res.status(400).json({ error: "Nothing to rank" });
    try {
      const lm = deps.localModels || require("./local-models");
      res.json({ scores: await lm.localRerankScores(query, texts) });
    } catch (e) {
      console.log(`[rerank] not ranked: ${e.message}`);
      res.status(503).json({ error: "The ranking model is not ready yet" });
    }
  });
}

module.exports = { register, MAX_TEXTS };
