// closedhand.com's own check on the uncensored LLM it provides, every 15
// minutes: one tiny request, sent the way every Closedhand sends one
// (near-private.js: the enclave proven, the request sealed to it, the reply's
// signature checked), with closedhand.com's own key. A check that fails is
// tried again two minutes on; failing twice, the maintainer is told once, with
// the check that failed, so a change at NEAR AI is fixed before people find
// their chats failing, and told once more when it works again. People's own
// Closedhands send nothing for it. The failing state is a row in
// operator_alerts, so a restart neither repeats the notice nor loses the
// "works again" one.
const near = require('./near-private');

const EVERY = 15 * 60000;
const AGAIN = 2 * 60000;

function create({ db, notices, includedAi, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  // The check that failed, or null when the reply came back proven.
  async function once() {
    try {
      const llm = await includedAi.forOperator();
      const res = await near.complete({ provider: 'near', backend: 'custom', baseUrl: llm.base, apiKey: llm.key },
        { model: llm.model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 16 });
      if (!res.ok) { await res.json().catch(() => null); return `NEAR AI answered HTTP ${res.status}`; }
      await res.json();
      return null;
    } catch (e) {
      return e.reason || e.message;
    }
  }

  // Returns 'ok', 'failing', or null when there is nothing to check (no
  // provider set, or one that runs outside sealed hardware).
  async function check() {
    if (!includedAi?.enabled() || includedAi.label !== 'NEAR AI') return null;
    let failed = await once();
    if (failed) { await wait(AGAIN); failed = await once(); }
    if (failed) {
      console.warn('[private llm] failing:', failed);
      const fresh = await db.query("INSERT INTO operator_alerts (kind, period, level) VALUES ('private-llm', 'failing', 0) ON CONFLICT DO NOTHING RETURNING level");
      if (fresh.rowCount) await notices.queue(`Closedhand: the uncensored LLM failed closedhand.com's privacy check twice, two minutes apart, so people's chats on it are probably failing too. The check that failed: ${failed}.`);
      return 'failing';
    }
    const back = await db.query("DELETE FROM operator_alerts WHERE kind = 'private-llm' AND period = 'failing' RETURNING level");
    if (back.rowCount) await notices.queue("Closedhand: the uncensored LLM passes closedhand.com's privacy check again, so people's chats on it work.");
    return 'ok';
  }

  function start() {
    const run = () => check().catch(e => console.error('[private llm] check:', e.message));
    setTimeout(run, 90000).unref();
    setInterval(run, EVERY).unref();
  }

  return { check, start };
}

module.exports = { create };
