// A background task drafting a viewing request made up an estate agent's
// name and built an address from it. Mail goes only to an address that came
// from somewhere: what the run has read, or the person's own data. Invented
// people and addresses only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const guard = require('../lib/recipient-guard');

test('mail goes only to an address found in what was read or in the person data', async () => {
  const nowhere = async () => false;
  const run = [
    { role: 'user', content: 'Book me a viewing at Fernhill Lettings, the listing is on their site.' },
    { role: 'user', content: [{ type: 'tool_result', content: 'Fernhill Lettings. Contact us: lettings@fernhill.example, 0161 000 0000.' }] },
  ];
  assert.equal(await guard.check('u1', 'gmail_create_draft', { to: 'lettings@fernhill.example', subject: 'Viewing' }, run, nowhere), null, 'read off the page');
  const made = await guard.check('u1', 'gmail_create_draft', { to: 'priya.nolan@fernhill.example', subject: 'Viewing' }, run, nowhere);
  assert.match(made, /^Not done\. priya\.nolan@fernhill\.example appears nowhere in what you have read or in the person's mail, chats or files, so it may be made up\. Write only to an address you found, and say where you found it; if there is none, ask the person for it\.$/);
  assert.equal(await guard.check('u1', 'send_mail', { to: 'Priya.Nolan@Fernhill.example' }, run, async (u, a) => a === 'priya.nolan@fernhill.example'), null, 'found in their own mail, whatever the case');
  assert.match(await guard.check('u1', 'gcal_create_event', { title: 'Viewing', attendees: 'lettings@fernhill.example, sam.k@fernhill.example' }, run, nowhere), /sam\.k@fernhill\.example appears nowhere/, 'invitations too');
  assert.equal(await guard.check('u1', 'web_search', { query: 'priya.nolan@fernhill.example' }, run, nowhere), null, 'only what writes to someone');
  assert.equal(await guard.check('u1', 'reply_to_mail', { message_id: 'm1', body: 'Thanks' }, run, nowhere), null, 'a reply to the sender names no one new');
});

test('the person data is looked up field by field, and a lookup that fails never stops their mail', async () => {
  const dbPath = require.resolve('../lib/db');
  const saved = require.cache[dbPath];
  const asked = [];
  const query = (table) => {
    const q = { field: null, eq() { return q; }, select() { return q; }, limit() { return q; },
      ilike(field, like) { q.field = field; asked.push([table, field, like]); return q; },
      then(resolve) { return Promise.resolve({ data: table === 'facts' ? [{ id: 'f1' }] : [], error: null }).then(resolve); } };
    return q;
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabase: { from: query } } };
  try {
    assert.equal(await guard.inPersonsData('u1', 'sam_k@fern%hill.example'), true, 'a Pinned Fact holds it');
    assert.deepEqual(asked.map(([t, f]) => `${t}:${f}`), ['data_cache:data->>from', 'data_cache:data->>to', 'data_cache:data->>cc', 'data_cache:data->>body', 'data_cache:data->>text', 'data_cache:data->>snippet', 'facts:value', 'rag_chunks:content']);
    assert.equal(asked[0][2], '%sam\\_k@fern\\%hill.example%', 'its wildcards escaped');
    require.cache[dbPath].exports = { supabase: { from: () => { throw new Error('down'); } } };
    assert.equal(await guard.inPersonsData('u1', 'a@b.example'), true);
  } finally { if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath]; }
});

test('every path that runs a tool checks recipients: chat, tasks, team agents, routines and scheduled jobs', () => {
  assert.match(read('lib/engine.js'), /const madeUp = await require\("\.\/recipient-guard"\)\.check\(userId, block\.name, block\.input, \[\{ content: userMessage \}\]\.concat\(messages\)\);/);
  const agents = read('lib/agents.js');
  assert.match(agents, /async function actGate\(userId, userStore, block, messages = \[\]\) \{\n[^\n]*\n[^\n]*\n[^\n]*\n\s*const madeUp = await require\("\.\/recipient-guard"\)\.check\(userId, block\.name, block\.input, messages\);/);
  assert.match(agents, /await actGate\(userId, userStore, b, \[\{ content: systemPrompt \}\]\.concat\(messages\)\)/);
  assert.equal((agents.match(/require\("\.\/recipient-guard"\)\.check\(/g) || []).length, 2);
  for (const f of ['lib/automations.js', 'lib/scheduling.js']) assert.match(read(f), /const madeUp = await require\("\.\/recipient-guard"\)\.check\(userId, block\.name, block\.input, messages\);/, f);
});
