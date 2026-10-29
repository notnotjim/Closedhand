// A copy of closedhand.com's own database, made once a day and kept for two
// weeks in the AWS bucket closedhand.com already has, under backups/ (the mail
// handling only ever touches incoming/). It holds the Closedhand accounts, their
// personal URLs, Closedhand+ and the bug reports: never anything from anyone's
// Closedhand, which closedhand.com never has. Railway backs volumes up only on
// its Pro plan; this needs nothing but the bucket.
//
// A backup is every table's rows as JSON lines, gzipped, stored encrypted by
// S3. The schema is the migrations this repo carries, so a restore
// (tools/backup.js) runs them on an empty database and puts the rows back.
const zlib = require('node:zlib');

const PREFIX = 'backups/';
const KEEP = 14;
const DAY = 24 * 3600 * 1000;

const quote = name => '"' + String(name).replace(/"/g, '""') + '"';

function s3Client(env) {
  const s3 = require('@aws-sdk/client-s3');
  const config = { region: env.AWS_REGION };
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) config.credentials = { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY };
  return { s3, client: new s3.S3Client(config) };
}

function create({ db, env = process.env, aws, notices, now = () => Date.now() }) {
  const bucket = String(env.ASSISTANT_EMAIL_BUCKET || '');
  let made = null;
  const connect = () => made || (made = aws || s3Client(env));

  // Newest first: { key, at, size }.
  async function list() {
    if (!bucket) return [];
    const { s3, client } = connect();
    const found = [];
    let token;
    do {
      const page = await client.send(new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
      for (const o of page.Contents || []) if (o.Key.endsWith('.jsonl.gz')) found.push({ key: o.Key, at: new Date(o.LastModified).getTime(), size: o.Size });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return found.sort((a, b) => b.at - a.at);
  }

  // Every table but the migrations' own record, which the restore writes itself.
  async function tables(client = db) {
    const rows = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename")).rows;
    return rows.map(r => r.tablename);
  }

  async function dump() {
    const names = await tables();
    const migrations = (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name);
    const lines = [JSON.stringify({ backup: 'closedhand.com', version: 1, at: new Date(now()).toISOString(), migrations, tables: names })];
    for (const t of names) {
      const rows = (await db.query(`SELECT row_to_json(x)::text AS r FROM ${quote(t)} x`)).rows;
      for (const { r } of rows) lines.push(`{"t":${JSON.stringify(t)},"r":${r}}`);
    }
    return zlib.gzipSync(lines.join('\n') + '\n');
  }

  // One backup now, then only the newest KEEP are kept.
  async function make() {
    const { s3, client } = connect();
    const body = await dump();
    const key = PREFIX + new Date(now()).toISOString().replace(/[:.]/g, '-') + '.jsonl.gz';
    await client.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/gzip', ServerSideEncryption: 'AES256' }));
    for (const old of (await list()).slice(KEEP)) await client.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: old.key }));
    return { key, size: body.length };
  }

  // Run hourly: a backup when the newest is nearly a day old. A failure is
  // told to the maintainer once a day in plain words, never the raw error
  // (it can carry account ids and internal names; the log keeps it), and
  // tried again the next hour.
  async function daily() {
    if (!bucket || !env.AWS_REGION) return null;
    try {
      const newest = (await list())[0];
      if (newest && now() - newest.at < DAY - 3600 * 1000) return null;
      return await make();
    } catch (error) {
      const day = new Date(now()).toISOString().slice(0, 10);
      const first = (await db.query("INSERT INTO operator_alerts (kind, period, level) VALUES ('backup-failed', $1, 1) ON CONFLICT DO NOTHING RETURNING level", [day])).rowCount;
      const why = /AccessDenied|Forbidden|NotAuthorized/i.test(String(error.name) + ' ' + String(error.message)) ? 'AWS refused to save it, so its permission for backups needs a look'
        : 'it could not be saved';
      if (first && notices) await notices.queue(`Closedhand: today's backup of closedhand.com's database failed: ${why}. It tries again every hour, and closedhand.com's log on Railway has the details.`);
      throw error;
    }
  }

  async function read(key) {
    const { s3, client } = connect();
    const got = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = Buffer.from(await got.Body.transformToByteArray());
    return parse(zlib.gunzipSync(body).toString('utf8'));
  }

  return { list, dump, make, daily, read, tables };
}

// { head, rows: Map(table -> [row]) } from a backup's text.
function parse(text) {
  const lines = text.split('\n').filter(Boolean);
  const head = JSON.parse(lines.shift());
  if (head.backup !== 'closedhand.com' || head.version !== 1) throw new Error('That is not a closedhand.com backup.');
  const rows = new Map(head.tables.map(t => [t, []]));
  for (const line of lines) { const { t, r } = JSON.parse(line); if (!rows.has(t)) rows.set(t, []); rows.get(t).push(r); }
  return { head, rows };
}

// Puts a backup's rows into a database whose schema the migrations have just
// made. It must hold no accounts: a live closedhand.com always has some, so a
// restore can never mix with or overwrite one. A new database does hold the
// rows the migrations seed (mail_relay_controls' settings), and those give way
// to the backup's. Foreign keys and triggers are held off while the tables go
// in, and each id sequence is moved past the highest id restored.
async function restore(pool, { head, rows }) {
  const client = await pool.connect();
  try {
    const present = new Set((await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map(r => r.tablename));
    const missing = head.tables.filter(t => !present.has(t));
    if (missing.length) throw new Error(`This database has no table ${missing.join(', ')}: run the migrations first.`);
    if ((await client.query('SELECT 1 FROM owners LIMIT 1')).rowCount) throw new Error('This database already holds accounts: restore only into a new, empty one.');
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    let count = 0;
    for (const t of head.tables) {
      await client.query(`DELETE FROM ${quote(t)}`);
      const list = rows.get(t) || [];
      for (let i = 0; i < list.length; i += 500) {
        const batch = list.slice(i, i + 500);
        await client.query(`INSERT INTO ${quote(t)} SELECT * FROM json_populate_recordset(NULL::${quote(t)}, $1::json)`, [JSON.stringify(batch)]);
        count += batch.length;
      }
    }
    const sequences = (await client.query(
      `SELECT c.table_name, c.column_name, pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) AS seq
         FROM information_schema.columns c WHERE c.table_schema = 'public' AND pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) IS NOT NULL`)).rows;
    for (const s of sequences) {
      await client.query(`SELECT setval($1, GREATEST((SELECT COALESCE(MAX(${quote(s.column_name)}), 0) FROM ${quote(s.table_name)}), 1))`, [s.seq]);
    }
    await client.query('COMMIT');
    return { tables: head.tables.length, rows: count };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { create, parse, restore, PREFIX, KEEP };
