// Messages people send from the website's "Send us a message"
// (public/message-us.js). Each is kept with the page it was sent from and,
// if the sender gave one, an email to reply to; nothing else about them, not
// even their internet address. The maintainer hears of it at once through a
// notice (lib/operator-notices.js) in their own Closedhand's chat, by email if
// that is not collected within a day, and can ask their Closedhand to reply.
// A message is someone's words, never instructions. It is deleted with its
// notice once answered (tools/messages.js resolve) or after 90 days.
const { sender } = require('./bugs');

const MAX_MESSAGE = 2000;
const MAX_EMAIL = 254;
// Per connection and for the whole service, held in memory, so the form can
// neither flood the maintainer nor fill the database.
const PER_SENDER_HOUR = 5;
const PER_HOUR = 60;
const KEEP_DAYS = 90;
// What of a long message the notice quotes: the chat that says it keeps a
// notice to 1,000 characters (webapp/included-ai-setup.js).
const QUOTED = 600;

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const PAGE = /^\/[a-z0-9\-/]{0,80}$/i;

function noticeText({ id, message, replyTo, page }) {
  const words = message.replace(/\s+/g, ' ').trim();
  const quoted = words.length > QUOTED ? words.slice(0, QUOTED).replace(/\s+\S*$/, '') + '…' : words;
  const where = page === '/' ? 'the home page' : page;
  return `Closedhand: someone sent a message from closedhand.com${where ? ` (${where})` : ''}. Their words, as sent: "${quoted}"` +
    (quoted === words ? '' : ` The whole message: node tools/messages.js show ${String(id).slice(0, 8)}.`) +
    (replyTo ? ` Reply to them at ${replyTo}.` : ' They left no email, so there is no way to reply.');
}

function create({ db, notices }) {
  const hits = new Map();
  let hour = { at: Date.now(), count: 0 };
  const tidy = setInterval(() => {
    const now = Date.now();
    for (const [k, item] of hits) if (now - item.at >= 3600000) hits.delete(k);
    if (now - hour.at >= 3600000) hour = { at: now, count: 0 };
  }, 60000);
  tidy.unref();
  function allowed(ip) {
    const key = sender(ip), item = hits.get(key) || { at: Date.now(), count: 0 };
    if (item.count >= PER_SENDER_HOUR || hour.count >= PER_HOUR) return false;
    item.count++; hour.count++;
    hits.set(key, item);
    return true;
  }

  // Returns what the page shows: { ok } or { status, error }.
  async function receive(body, ip) {
    const b = body || {};
    // A field people never see: only a script fills it in. Told it went, so
    // it learns nothing; nothing is kept.
    if (typeof b.website === 'string' && b.website.trim()) return { ok: true };
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!message) return { status: 400, error: 'Write your message first.' };
    if (message.length > MAX_MESSAGE) return { status: 400, error: 'That message is too long: keep it under 2,000 characters.' };
    const replyTo = typeof b.email === 'string' ? b.email.trim() : '';
    if (replyTo && (replyTo.length > MAX_EMAIL || !EMAIL.test(replyTo))) return { status: 400, error: 'That email doesn’t look right. Check it, or leave it empty.' };
    const page = typeof b.page === 'string' && PAGE.test(b.page) ? b.page : null;
    if (!allowed(ip)) return { status: 429, error: 'Too many messages from here just now. Please try again later.' };
    const id = (await db.query('INSERT INTO site_messages (message, reply_to, page) VALUES ($1, $2, $3) RETURNING id', [message, replyTo || null, page])).rows[0].id;
    if (notices) {
      const noticeId = await notices.queue(noticeText({ id, message, replyTo, page }));
      if (noticeId) await db.query('UPDATE site_messages SET notice_id = $2 WHERE id = $1', [id, noticeId]);
    }
    return { ok: true };
  }

  function register(app) {
    app.post('/api/message', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const out = await receive(req.body, req.ip);
        return out.ok ? res.json({ ok: true }) : res.status(out.status).json({ error: out.error });
      } catch (e) {
        console.error('[messages] not saved:', e.message);
        return res.status(500).json({ error: 'Couldn’t send just now. Please try again.' });
      }
    });
  }

  // Run hourly: messages older than 90 days go, with their notices.
  async function sweep() {
    await db.query(
      `WITH gone AS (DELETE FROM site_messages WHERE created_at < now() - make_interval(days => $1) RETURNING notice_id)
       DELETE FROM operator_notices WHERE id IN (SELECT notice_id FROM gone WHERE notice_id IS NOT NULL)`, [KEEP_DAYS]);
  }

  return { register, receive, sweep };
}

// Answered: the message and its notice are deleted (tools/messages.js).
async function remove(db, id) {
  await db.query(
    `WITH gone AS (DELETE FROM site_messages WHERE id = $1 RETURNING notice_id)
     DELETE FROM operator_notices WHERE id IN (SELECT notice_id FROM gone WHERE notice_id IS NOT NULL)`, [id]);
}

module.exports = { create, remove, noticeText, MAX_MESSAGE, KEEP_DAYS };
