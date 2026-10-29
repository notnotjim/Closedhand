// Recent Closedhand accounts and what each has of Closedhand Managed Models:
// its first month (allowance, when it began and ends, spend so far) and
// Closedhand+, with this month's OpenRouter spend across every key. For the
// maintainer. Reads only; never prints an email or a key.
//
// Run inside the closedhand-com service:
//   railway ssh --service closedhand-com -- node tools/accounts.js [days]

const day = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '-');
const usd = (n) => '$' + Number(n || 0).toFixed(2);

async function recent(db, includedAi, days = 7) {
  const { rows } = await db.query(
    `SELECT o.id, o.created_at, o.provider,
            (SELECT count(*)::int FROM owner_sign_ins s WHERE s.owner_id = o.id) AS more_sign_ins,
            a.hostname, a.state,
            k.granted_usd, k.granted_at, k.ends_at, k.stopped_at,
            p.status AS plus_status, p.current_period_end
       FROM owners o
       LEFT JOIN addresses a ON a.owner_id = o.id
       LEFT JOIN included_ai_keys k ON k.owner_id = o.id
       LEFT JOIN plus_subscriptions p ON p.owner_id = o.id
      WHERE o.created_at > now() - make_interval(days => $1)
      ORDER BY o.created_at DESC`, [days]);
  const lines = [`Accounts made in the last ${days} day(s): ${rows.length}`];
  for (const r of rows) {
    const used = r.granted_usd != null ? await includedAi.usage(r.id).catch(() => null) : null;
    const first = r.granted_usd == null ? 'no first month'
      : `first month ${usd(r.granted_usd)} from ${day(r.granted_at)} to ${day(r.ends_at)}${r.stopped_at ? `, stopped ${day(r.stopped_at)}` : ''}`
        + (used ? `, used ${usd(used.used)} of ${usd(used.limit)}` : '');
    const plus = r.plus_status ? `Closedhand+ ${r.plus_status} until ${day(r.current_period_end)}` : 'no Closedhand+';
    lines.push(`  ${day(r.created_at)}  ${r.provider}${r.more_sign_ins ? ` +${r.more_sign_ins} sign-in(s)` : ''}  `
      + `${r.hostname ? r.hostname.replace('.closedhand.ai', '') + ` (${r.state})` : 'no personal URL'}  ${first}  ${plus}`);
  }
  const live = (await db.query('SELECT count(*)::int n, coalesce(sum(granted_usd), 0) total FROM included_ai_keys WHERE stopped_at IS NULL')).rows[0];
  lines.push(`Keys running now: ${live.n}, allowances totalling ${usd(live.total)}`);
  const spent = await includedAi.spentThisMonth().catch(() => null);
  lines.push(`OpenRouter spend this month across every key: ${spent == null ? 'could not be read' : usd(spent)}`);
  return lines.join('\n');
}

async function main([days]) {
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const includedAi = require('../lib/included-ai').create({ db, env: process.env, request: fetch });
    const n = Number.parseInt(days || '7', 10);
    return await recent(db, includedAi, Number.isFinite(n) && n > 0 && n <= 365 ? n : 7);
  } finally { await db.end(); }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((out) => console.log(out)).catch((e) => { console.error(`accounts: ${e.message}`); process.exit(1); });
}

module.exports = { recent };
