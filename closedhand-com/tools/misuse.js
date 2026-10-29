// The insights page's Possible misuse section, in the terminal: the signs
// found now and what the LLM made of them. With --try it sums up one invented
// sign instead, to show the LLM can be reached. For the maintainer; prints no
// email or key.
//
// Run inside the closedhand-com service:
//   railway ssh --service closedhand-com -- node tools/misuse.js [--try]

async function main(args) {
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const includedAi = require('../lib/included-ai').create({ db, env: process.env, request: fetch });
    const misuse = require('../lib/misuse').create({ db, env: process.env, includedAi });
    if (args.includes('--try')) {
      return 'Summary of an invented sign: ' + (await misuse.summary(['example-name has used 60% of its first month ($12.00) in 2 days.']) || 'none written');
    }
    const { signs, summary } = await misuse.report();
    if (!signs.length) return 'Nothing to report.';
    return [summary || '(no summary written)', '', ...signs.map(s => '- ' + s)].join('\n');
  } finally { await db.end(); }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((out) => console.log(out)).catch((e) => { console.error(`misuse: ${e.message}`); process.exit(1); });
}
