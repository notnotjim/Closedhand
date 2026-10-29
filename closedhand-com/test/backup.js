// closedhand.com's daily database backup (lib/backup.js) and its restore
// (tools/backup.js), against a real Postgres, in databases of their own so the
// test can run beside the others. AWS is an in-memory bucket. Invented people
// only.
// Run: DATABASE_URL=postgres://... node --test closedhand-com/test/backup.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../lib/db');
const backup = require('../lib/backup');

const SOURCE = 'closedhand_backup_test', TARGET = 'closedhand_backup_restore_test';
let admin, db, target;
const url = (name) => { const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + name; return u.toString(); };
before(async () => {
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const n of [SOURCE, TARGET]) { await admin.query(`DROP DATABASE IF EXISTS ${n}`); await admin.query(`CREATE DATABASE ${n}`); }
  db = new Pool({ connectionString: url(SOURCE) });
  target = new Pool({ connectionString: url(TARGET) });
  await migrate(db);
});
after(async () => {
  await db?.end(); await target?.end();
  for (const n of [SOURCE, TARGET]) await admin?.query(`DROP DATABASE IF EXISTS ${n}`);
  await admin?.end();
});

// An S3 bucket in memory, answering the four commands the backup sends.
function bucket({ failPut = false } = {}) {
  const objects = new Map();
  const command = (name) => class { constructor(input) { this.name = name; this.input = input; } };
  const s3 = { ListObjectsV2Command: command('list'), PutObjectCommand: command('put'), DeleteObjectCommand: command('delete'), GetObjectCommand: command('get') };
  let clock = Date.now();
  const client = {
    async send(cmd) {
      const { Key, Prefix } = cmd.input;
      if (cmd.name === 'put') {
        if (failPut) throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
        assert.equal(cmd.input.ServerSideEncryption, 'AES256', 'stored encrypted');
        objects.set(Key, { body: cmd.input.Body, at: clock });
        return {};
      }
      if (cmd.name === 'delete') { objects.delete(Key); return {}; }
      if (cmd.name === 'get') { const o = objects.get(Key); return { Body: { transformToByteArray: async () => new Uint8Array(o.body) } }; }
      return { Contents: [...objects].filter(([k]) => k.startsWith(Prefix)).map(([k, o]) => ({ Key: k, LastModified: new Date(o.at), Size: o.body.length })), IsTruncated: false };
    },
  };
  return { aws: { s3, client }, objects, tick: (ms) => { clock = ms; } };
}

const env = { ASSISTANT_EMAIL_BUCKET: 'mail-bucket', AWS_REGION: 'eu-west-1' };

async function people() {
  const owner = (await db.query("INSERT INTO owners (provider, subject, email, email_verified) VALUES ('google', 'sub-rowan', 'rowan@example.com', true) RETURNING id")).rows[0].id;
  await db.query("INSERT INTO starter_grants (person_hash, granted_usd) VALUES ($1, 20), ($2, 20)", [crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('hex')]);
  await db.query("INSERT INTO operator_notices (text) VALUES ('Closedhand: an invented notice')");
  return owner;
}

test('a backup holds every table and restores into an empty database exactly, sequences moved on', async () => {
  const owner = await people();
  const b = bucket();
  const made = await backup.create({ db, env, aws: b.aws }).make();
  assert.match(made.key, /^backups\/.+\.jsonl\.gz$/);

  const data = await backup.create({ db: target, env, aws: b.aws }).read(made.key);
  assert.ok(data.head.tables.includes('owners') && !data.head.tables.includes('schema_migrations'));
  await migrate(target);
  const done = await backup.restore(target, data);
  for (const t of ['owners', 'starter_grants', 'operator_notices']) {
    const [a, c] = await Promise.all([db, target].map(async (p) => (await p.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n));
    assert.equal(c, a, `${t} came back whole`);
  }
  assert.equal((await target.query('SELECT email FROM owners WHERE id = $1', [owner])).rows[0].email, 'rowan@example.com');
  assert.ok(done.rows >= 4);
  const highest = (await target.query('SELECT max(id) AS m FROM starter_grants')).rows[0].m;
  const next = (await target.query("INSERT INTO starter_grants (person_hash, granted_usd) VALUES ('fresh', 20) RETURNING id")).rows[0].id;
  assert.ok(Number(next) > Number(highest), 'a new row never collides with a restored one');
  await assert.rejects(backup.restore(target, data), /already holds accounts/, 'never into a database that has accounts');
  const controls = async (p) => JSON.stringify((await p.query('SELECT * FROM mail_relay_controls')).rows);
  assert.equal(await controls(target), await controls(db), 'the settings a new database seeds give way to the backed-up ones');
});

test('once a day, the newest fourteen kept, and nothing without a bucket', async () => {
  const b = bucket();
  let now = Date.parse('2026-11-01T03:00:00Z');
  const daily = backup.create({ db, env, aws: b.aws, now: () => now });
  for (let day = 0; day < 16; day++) {
    b.tick(now);
    assert.ok(await daily.daily(), `day ${day}: made`);
    now += 3600 * 1000;
    b.tick(now);
    assert.equal(await daily.daily(), null, `day ${day}: not twice the same day`);
    now += 23 * 3600 * 1000;
  }
  assert.equal(b.objects.size, backup.KEEP);
  assert.equal(await backup.create({ db, env: {}, aws: b.aws }).daily(), null);
});

test('a failed backup is told to the maintainer once a day, and tried again', async () => {
  await db.query('TRUNCATE operator_alerts, operator_notices');
  const b = bucket({ failPut: true });
  const told = [];
  const notices = { queue: async (text) => told.push(text) };
  const daily = backup.create({ db, env, aws: b.aws, notices, now: () => Date.parse('2026-11-20T04:00:00Z') });
  await assert.rejects(daily.daily(), /Access Denied/);
  await assert.rejects(daily.daily(), /Access Denied/, 'tried again the next hour');
  assert.equal(told.length, 1);
  assert.match(told[0], /backup of closedhand\.com's database failed \(AccessDenied/);
});
