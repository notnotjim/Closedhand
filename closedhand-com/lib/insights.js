// A private page for whoever runs closedhand.com, everything needed to run
// Closedhand in one place: what needs them now (lib/needs.js), money in and
// out, the uncensored LLM, people, growth, and everything closedhand.com
// already holds for its own work, totals and each person's row, plus GitHub's
// public counts. closedhand.com collects little (see the privacy page), so all
// of it is shown. Anyone not signed in with an email in OPERATOR_EMAILS that
// Google has verified gets the ordinary not-found page, so the page doesn't
// show that it exists.
const { fairUseMonth } = require('./months');
const { needsOf } = require('./needs');

const REPO = 'notnotjim/Closedhand';
const INSTALL_SCRIPT = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;
const GITHUB_TTL = 15 * 60000;
// The workflows on main whose last run the page shows.
const WORKFLOWS = { checks: 'Checks', mac: 'Build desktop app', images: 'Build self-host images' };

function register(app, { db, sessions, render, env = process.env, request = fetch, includedAi = null, backup = null }) {
  const operators = new Set(String(env.OPERATOR_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const limit = Number.parseInt(env.ADDRESS_LIMIT || '100', 10);
  const misuse = require('./misuse').create({ db, env, includedAi, request });

  async function isOperator(req) {
    const owner = sessions.owner(req);
    if (!owner || !operators.size) return false;
    const row = (await db.query('SELECT email, email_verified FROM owners WHERE id = $1', [owner])).rows[0];
    return !!row && row.email_verified === true && operators.has(String(row.email || '').toLowerCase());
  }
  const guarded = fn => async (req, res, next) => {
    try {
      if (!(await isOperator(req))) return next();
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
      await fn(req, res);
    } catch (e) {
      console.error('[insights]', e.message);
      if (!res.headersSent) res.status(503).json({ error: 'Could not read the numbers. Try again.' });
    }
  };

  // The short install command, curl -fsSL https://closedhand.com/install | sh.
  // Adds one to today's count (nothing about who asked) and sends curl on to
  // the script in the repository. A count that fails never stops an install.
  app.get('/install', async (req, res) => {
    try {
      await db.query(`INSERT INTO install_fetches (day, fetches) VALUES (current_date, 1)
        ON CONFLICT (day) DO UPDATE SET fetches = install_fetches.fetches + 1`);
    } catch (e) { console.error('[install] Could not count a fetch:', e.message); }
    res.set('Cache-Control', 'no-store').redirect(302, INSTALL_SCRIPT);
  });

  // GitHub's public counts, fetched at most every 15 minutes, so the page
  // stays well inside GitHub's limit for requests without a sign-in.
  let github = null, githubAt = 0;
  async function githubCounts() {
    if (Date.now() - githubAt < GITHUB_TTL) return github;
    githubAt = Date.now();
    try {
      const get = async path => {
        const response = await request('https://api.github.com/repos/' + REPO + path, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'closedhand.com' }, signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('GitHub answered ' + response.status);
        return response.json();
      };
      const [repo, releases, runs] = await Promise.all([get(''), get('/releases?per_page=100'), get('/actions/runs?branch=main&per_page=50').catch(() => null)]);
      const mac = releases.filter(r => !r.draft && !r.prerelease).map(r => ({
        version: r.tag_name, at: r.published_at || null,
        downloads: (r.assets || []).filter(a => /\.dmg$/i.test(a.name)).reduce((n, a) => n + (a.download_count || 0), 0),
      }));
      // Each workflow's last finished run on main, and whether another is running now.
      const last = {};
      for (const [key, name] of Object.entries(WORKFLOWS)) {
        const all = ((runs && runs.workflow_runs) || []).filter(r => r.name === name);
        const done = all.find(r => r.status === 'completed');
        last[key] = done ? { conclusion: done.conclusion, at: done.updated_at || done.created_at, sha: String(done.head_sha || '').slice(0, 7), url: done.html_url, running: all.some(r => r.status !== 'completed') } : null;
      }
      github = { stars: repo.stargazers_count || 0, forks: repo.forks_count || 0, macTotal: mac.reduce((n, r) => n + r.downloads, 0), macLatest: mac[0] || null, runs: runs ? last : null };
    } catch (e) {
      console.error('[insights] GitHub counts unavailable:', e.message);
      github = null;
    }
    return github;
  }

  // This month's spend at the provider, apart: Managed Models of everyone
  // else, the maintainer's own Managed Models (their account's key and
  // closedhand.com's own), and the maintainer's own use with keys
  // closedhand.com did not make, which is not Managed Models at all. With what
  // is left of the credit they all draw on. Read at most every five minutes.
  let near = null, nearAt = 0;
  async function fromNear(mine) {
    if (!includedAi || !includedAi.enabled()) return { spentThisMonth: null, spentYou: null, ownUse: null, credit: null, provider: null };
    if (Date.now() - nearAt < 5 * 60000) return near;
    nearAt = Date.now();
    const read = (what, promise) => promise.catch(e => { console.error(`[insights] ${what} unavailable:`, e.message); return null; });
    const [spend, credit] = await Promise.all([read('spend', includedAi.spendSplit(mine)), read('credit', includedAi.credit())]);
    return (near = { spentThisMonth: spend ? spend.others : null, spentYou: spend ? spend.you : null, ownUse: spend ? spend.own : null, credit, provider: includedAi.label });
  }

  // How what Closedhand runs on is doing, read at most every five minutes:
  // closedhand.com's NEAR AI sign-in, crypto payments being followed on the
  // networks invoices offer, the newest backup, and this month's card
  // payments at Polar, the maintainer's own left out. A part that can't be
  // read says so instead of failing the page.
  let health = null, healthAt = 0;
  async function healthOf(mine) {
    if (health && Date.now() - healthAt < 5 * 60000) return health;
    healthAt = Date.now();
    const near = includedAi && includedAi.label === 'NEAR AI' ? await db.query('SELECT expires_at, failed_at FROM near_session WHERE id = 1')
      .then(r => { const row = r.rows[0]; return { signedIn: !!row && !row.failed_at, until: row ? row.expires_at : null, failedAt: row ? row.failed_at : null }; })
      .catch(() => ({ signedIn: false, until: null, failedAt: null })) : null;
    let crypto = null;
    const btcpay = String(env.BTCPAY_URL || '').trim().replace(/\/+$/, ''), btcpayKey = String(env.BTCPAY_API_KEY || '').trim();
    if (btcpay && btcpayKey) {
      const offered = String(env.BTCPAY_PAYMENT_METHODS || 'USDT-ETHEREUM,USDT-POLYGON').split(',').map(s => s.trim()).filter(Boolean);
      try {
        const response = await request(btcpay + '/api/v1/server/info', { headers: { Authorization: 'token ' + btcpayKey }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('BTCPay answered ' + response.status);
        const sync = new Map(((await response.json()).syncStatus || []).map(s => [s.paymentMethodId || s.cryptoCode, s]));
        const NAMES = { 'USDT-ETHEREUM': 'Ethereum', 'USDT-POLYGON': 'Polygon', 'USDT-TRON': 'Tron', 'USDT-BSC': 'BSC', 'BTC-CHAIN': 'Bitcoin' };
        const behind = offered.filter(m => { const s = sync.get(m); return !s || !s.available || (s.chainHeight != null && s.syncHeight != null && s.chainHeight - s.syncHeight > 50); });
        crypto = { networks: offered.map(m => NAMES[m] || m), behind: behind.map(m => NAMES[m] || m) };
      } catch (e) { console.error('[insights] BTCPay unavailable:', e.message); crypto = { error: true }; }
    }
    let saved = null;
    if (backup) {
      try { const list = await backup.list(); saved = { count: list.length, newest: list[0] ? new Date(list[0].at).toISOString() : null }; }
      catch (e) { console.error('[insights] backups unavailable:', e.message); saved = { error: true }; }
    }
    let cards = null;
    if (env.POLAR_ACCESS_TOKEN) {
      try {
        const api = env.POLAR_SERVER === 'sandbox' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh';
        const response = await request(api + '/v1/orders/?sorting=-created_at&limit=100', { headers: { Authorization: 'Bearer ' + env.POLAR_ACCESS_TOKEN, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Polar answered ' + response.status);
        const yours = new Set((await db.query('SELECT polar_customer_id FROM plus_subscriptions WHERE owner_id = ANY($1::uuid[]) AND polar_customer_id IS NOT NULL', [mine])).rows.map(r => r.polar_customer_id));
        const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).getTime();
        const paid = ((await response.json()).items || []).filter(o => o.paid !== false && o.status !== 'pending' && Date.parse(o.created_at) >= start && !yours.has(o.customer_id));
        cards = { payments: paid.filter(o => (o.net_amount || 0) > 0).length, usd: paid.reduce((t, o) => t + Math.max(0, (o.net_amount || 0) - (o.refunded_amount || 0)), 0) / 100 };
      } catch (e) { console.error('[insights] Polar unavailable:', e.message); cards = { error: true }; }
    }
    return (health = { near, crypto, backup: saved, cards });
  }

  async function gather() {
    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0] || {};
    // The maintainer's own accounts (a verified sign-in email in
    // OPERATOR_EMAILS), kept apart so real people's numbers are plain to see:
    // each total is everyone else's, with the maintainer's share beside it.
    const mine = (await db.query('SELECT id FROM owners WHERE email_verified AND lower(email) = ANY($1::text[])', [[...operators]])).rows.map(r => r.id);
    const both = async (sql, col = 'owner_id') => {
      const [others, you] = await Promise.all([
        one(sql.replace('{who}', `NOT (${col} = ANY($1::uuid[]))`), [mine]),
        one(sql.replace('{who}', `${col} = ANY($1::uuid[])`), [mine]),
      ]);
      return { ...others, you };
    };
    // Closedhand Managed Models: free days running and ended, what they
    // allow, and subscriptions by state. The maintainer's own key is none of
    // these: it is counted apart.
    const firstMonths = await both(`SELECT
        count(*) FILTER (WHERE NOT maintainer AND stopped_at IS NULL AND (ends_at IS NULL OR ends_at > now()))::int AS running,
        coalesce(sum(granted_usd) FILTER (WHERE NOT maintainer AND stopped_at IS NULL AND (ends_at IS NULL OR ends_at > now())), 0)::float AS allowance,
        count(*) FILTER (WHERE NOT maintainer AND (stopped_at IS NOT NULL OR ends_at <= now()))::int AS ended,
        count(*) FILTER (WHERE NOT maintainer AND granted_at > now() - interval '7 days')::int AS week,
        count(*) FILTER (WHERE maintainer)::int AS maintainer
      FROM included_ai_keys WHERE {who}`);
    const plusOf = async who => Object.fromEntries((await db.query(`SELECT status, count(*)::int AS n FROM plus_subscriptions WHERE ${who} GROUP BY status`, [mine])).rows.map(r => [r.status, r.n]));
    const [plus, plusYou] = await Promise.all([plusOf('NOT (owner_id = ANY($1::uuid[]))'), plusOf('owner_id = ANY($1::uuid[])')]);
    // Plans paid ahead running now (lib/ahead.js), everyone else's.
    const ahead = (await db.query('SELECT count(*)::int AS n FROM ahead_plans WHERE ended_at IS NULL AND ends_at > now() AND NOT (owner_id = ANY($1::uuid[]))', [mine])).rows[0].n;
    const accounts = await both(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE provider = 'google')::int AS google,
        count(*) FILTER (WHERE provider = 'microsoft')::int AS microsoft,
        count(*) FILTER (WHERE provider = 'anonymous')::int AS anonymous,
        count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
        count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS month
      FROM owners WHERE {who}`, 'id');
    // Online means the computer running it was connected to the relay in
    // that time, from the relay's report each minute.
    const urls = await both(`SELECT
        count(*) FILTER (WHERE activated_at IS NOT NULL)::int AS working,
        count(*) FILTER (WHERE activated_at IS NOT NULL AND last_seen_at > now() - interval '1 day')::int AS day,
        count(*) FILTER (WHERE activated_at IS NOT NULL AND last_seen_at > now() - interval '7 days')::int AS week,
        count(*) FILTER (WHERE activated_at IS NOT NULL AND last_seen_at > now() - interval '30 days')::int AS month,
        count(*) FILTER (WHERE activated_at IS NULL)::int AS setting_up,
        count(*) FILTER (WHERE activated_at IS NOT NULL OR created_at > now() - interval '24 hours')::int AS used
      FROM addresses WHERE {who}`);
    const weeks = (await db.query(`SELECT to_char(w, 'YYYY-MM-DD') AS week,
        (SELECT count(*)::int FROM owners WHERE created_at >= w AND created_at < w + interval '7 days' AND NOT (id = ANY($1::uuid[]))) AS accounts,
        (SELECT count(*)::int FROM owners WHERE created_at >= w AND created_at < w + interval '7 days' AND id = ANY($1::uuid[])) AS you_accounts,
        (SELECT count(*)::int FROM addresses WHERE activated_at >= w AND activated_at < w + interval '7 days' AND NOT (owner_id = ANY($1::uuid[]))) AS claimed,
        (SELECT count(*)::int FROM addresses WHERE activated_at >= w AND activated_at < w + interval '7 days' AND owner_id = ANY($1::uuid[])) AS you_claimed,
        (SELECT coalesce(sum(fetches), 0)::int FROM install_fetches WHERE day >= w::date AND day < (w + interval '7 days')::date) AS installs
      FROM generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') AS w
      ORDER BY w`, [mine])).rows;
    const installs = await one('SELECT coalesce(sum(fetches), 0)::int AS total FROM install_fetches');
    const bugs = await one(`SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
        count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week FROM bug_reports`);
    // Closedhand's own email: addresses on, and this month's mail, the
    // maintainer's counted from their own addresses' use and taken out.
    const email = await one(`SELECT
        (SELECT count(*)::int FROM mail_relay_accounts WHERE enabled AND NOT (owner_id = ANY($1::uuid[]))) AS accounts,
        (SELECT count(*)::int FROM mail_relay_accounts WHERE enabled AND owner_id = ANY($1::uuid[])) AS you_accounts,
        coalesce(g.sent, 0)::int AS all_sent, coalesce(g.received, 0)::int AS all_received,
        (SELECT coalesce(sum(u.sent), 0)::int FROM mail_relay_usage u WHERE u.period = date_trunc('month', now() at time zone 'UTC')::date
          AND u.owner_key IN (SELECT DISTINCT encode(sha256(convert_to(lower(owner_email), 'UTF8')), 'hex') FROM mail_relay_accounts WHERE owner_id = ANY($1::uuid[]))) AS you_sent,
        (SELECT coalesce(sum(u.received), 0)::int FROM mail_relay_usage u WHERE u.period = date_trunc('month', now() at time zone 'UTC')::date
          AND u.owner_key IN (SELECT DISTINCT encode(sha256(convert_to(lower(owner_email), 'UTF8')), 'hex') FROM mail_relay_accounts WHERE owner_id = ANY($1::uuid[]))) AS you_received
      FROM (SELECT 1) AS x LEFT JOIN mail_relay_usage g
        ON g.owner_key = 'global' AND g.period = date_trunc('month', now() at time zone 'UTC')::date`, [mine]);
    // Everyone with a Closedhand account, newest first: their sign-in, the
    // personal URL it holds and when its computer last connected, a name held
    // for them, and Closedhand's own email addresses with this month's use.
    const people = (await db.query(`SELECT o.id, o.email, o.provider, o.email_verified, o.created_at AS signed_up, (o.id = ANY($1::uuid[])) AS you,
        (SELECT json_agg(json_build_object('provider', s.provider, 'email', s.email) ORDER BY s.created_at) FROM owner_sign_ins s WHERE s.owner_id = o.id) AS more_sign_ins,
        CASE WHEN k.maintainer THEN NULL ELSE k.granted_usd::float END AS first_month_usd, k.granted_at AS first_month_from, k.ends_at AS first_month_until, k.stopped_at AS first_month_stopped,
        coalesce(k.maintainer, false) AS maintainer,
        ap.ends_at AS ahead_until,
        p.status AS plus_status, p.started_at AS plus_since, p.current_period_end AS plus_until, p.cancel_at_period_end AS plus_cancels, p.every_months AS plus_every, p.current_period_start AS plus_from, p.extended_for AS plus_extended_for,
        a.hostname, a.state, a.activated_at AS claimed, a.last_seen_at AS last_online,
        (SELECT h.hostname FROM held_names h WHERE h.owner_id = o.id ORDER BY h.created_at DESC LIMIT 1) AS held_name,
        (SELECT count(*)::int FROM retired_names r WHERE r.owner_id = o.id) AS renames,
        m.addresses AS assistant_email, coalesce(u.sent, 0)::int AS email_sent, coalesce(u.received, 0)::int AS email_received
      FROM owners o
      LEFT JOIN addresses a ON a.owner_id = o.id
      LEFT JOIN included_ai_keys k ON k.owner_id = o.id
      LEFT JOIN plus_subscriptions p ON p.owner_id = o.id
      LEFT JOIN ahead_plans ap ON ap.owner_id = o.id AND ap.ended_at IS NULL AND ap.ends_at > now()
      LEFT JOIN LATERAL (SELECT string_agg(address, ', ' ORDER BY created_at) AS addresses, min(owner_email) AS owner_email
        FROM mail_relay_accounts WHERE owner_id = o.id AND enabled) m ON true
      LEFT JOIN mail_relay_usage u ON m.addresses IS NOT NULL
        AND u.owner_key = coalesce(encode(sha256(convert_to(lower(m.owner_email), 'UTF8')), 'hex'), 'owner:' || o.id::text)
        AND u.period = date_trunc('month', now() at time zone 'UTC')::date
      ORDER BY o.created_at DESC LIMIT 2000`, [mine])).rows.map(({ plus_from: from, plus_extended_for: extendedFor, ...p }) => {
        // Carried on this month of fair use, which in a subscription every 6
        // or 12 months is one month of its period.
        const month = fairUseMonth({ current_period_start: from, current_period_end: p.plus_until, every_months: p.plus_every });
        return { ...p, plus_extended: !!month && !!extendedFor && new Date(extendedFor).getTime() === month.from.getTime() };
      });
    const reports = (await db.query(`SELECT created_at, status, left(comment, 400) AS comment, app_version, platform, resolved_at
      FROM bug_reports ORDER BY created_at DESC LIMIT 50`)).rows;
    // Messages sent from the site's "Send us a message", as sent (lib/messages.js),
    // and the maintainer notices closedhand.com sent lately.
    const messages = (await db.query('SELECT created_at, left(message, 2000) AS message, reply_to, page FROM site_messages ORDER BY created_at DESC LIMIT 50')).rows;
    const notices = (await db.query("SELECT created_at, text FROM operator_notices WHERE created_at > now() - interval '14 days' ORDER BY created_at DESC LIMIT 10")).rows;
    // Paid ahead in crypto this month, everyone else's.
    const crypto = await one(`SELECT count(*)::int AS payments, coalesce(sum(amount_cents), 0)::int AS cents FROM ahead_payments
      WHERE paid_at >= date_trunc('month', now() at time zone 'UTC') AND NOT (owner_id = ANY($1::uuid[]))`, [mine]);
    const [near, h, github] = await Promise.all([fromNear(mine), healthOf(mine), githubCounts()]);
    const managed = { ...firstMonths, plus, ahead, you: { ...firstMonths.you, plus: plusYou }, ...near };
    const urlsOut = { ...urls, limit };
    return {
      at: new Date().toISOString(),
      people,
      reports,
      accounts,
      urls: urlsOut,
      weeks,
      installs: { total: installs.total },
      bugs,
      email: { accounts: email.accounts, sent: Math.max(0, email.all_sent - email.you_sent), received: Math.max(0, email.all_received - email.you_received),
        you: { accounts: email.you_accounts, sent: email.you_sent, received: email.you_received } },
      managed,
      github,
      messages,
      notices,
      health: h,
      money: { cards: h.cards, crypto: { payments: crypto.payments, usd: crypto.cents / 100 } },
      needs: needsOf({ managed, near: h.near, bugs, messages: messages.length, backup: h.backup, crypto: h.crypto, cards: h.cards, github, urls: urlsOut }),
    };
  }

  // One person's Managed Models use this month, read from NEAR AI when their
  // row is opened.
  app.get('/api/insights/person/:id', guarded(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Unknown person' });
    res.json({ usage: includedAi && includedAi.enabled() ? await includedAi.usage(req.params.id).catch(() => null) : null });
  }));

  app.get('/insights', guarded(async (req, res) => { res.type('html').send(render('insights.html')); }));
  app.get('/api/insights', guarded(async (req, res) => { res.json(await gather()); }));
  // Possible misuse, apart from the rest: its summary takes an LLM a few seconds.
  app.get('/api/insights/misuse', guarded(async (req, res) => { res.json(await misuse.report()); }));
}

module.exports = { register, INSTALL_SCRIPT };
