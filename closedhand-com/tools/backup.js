// tools/backup.js: closedhand.com's daily database backups (lib/backup.js).
//
// Run inside the closedhand-com service, where DATABASE_URL and the AWS
// settings are set:
//   railway ssh --service closedhand-com -- node tools/backup.js list
//   railway ssh --service closedhand-com -- node tools/backup.js now
//   railway ssh --service closedhand-com -- node tools/backup.js restore <key>
//
// restore puts a backup into the database DATABASE_URL names, and only when
// that database is empty: after losing the old one, point closedhand-com at a
// new Postgres, then run it. It makes the schema with the migrations and puts
// every row back; a database that already holds rows is refused.
const { create, restore } = require('../lib/backup');

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

async function main([cmd, key]) {
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const backup = create({ db });
  try {
    if (cmd === 'list' || !cmd) {
      const all = await backup.list();
      if (!all.length) return 'No backups yet.';
      return `BACKUPS (${all.length}, newest first):\n` + all.map((b) => `  ${b.key}  ${new Date(b.at).toISOString().slice(0, 16).replace('T', ' ')}  ${mb(b.size)}`).join('\n');
    }
    if (cmd === 'now') {
      const made = await backup.make();
      return `Backed up to ${made.key} (${mb(made.size)}).`;
    }
    if (cmd === 'restore') {
      if (!key) throw new Error('Say which backup: node tools/backup.js list shows them.');
      const data = await backup.read(key);
      await require('../lib/db').migrate(db);
      const done = await restore(db, data);
      return `Restored ${done.rows} rows into ${done.tables} tables from ${key}, made ${data.head.at}.`;
    }
    throw new Error('Usage: node tools/backup.js list | now | restore <key>');
  } finally { await db.end(); }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((out) => console.log(out)).catch((e) => { console.error(`backup: ${e.message}`); process.exit(1); });
}

module.exports = { main };
