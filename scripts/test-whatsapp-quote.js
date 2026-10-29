// A WhatsApp reply keeps the message it answers, in every chat: "yes of
// course" in another chat said nothing about what was agreed once stored on
// its own, so Closedhand read the reply as covering something else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { quoteOf, replyLine } = require('../lib/whatsapp-quote');
const rules = require('../lib/project-rules');

const reply = (kind, quoted, extra = {}) => ({ [kind]: { text: 'Yes of course', caption: 'Yes of course', contextInfo: { quotedMessage: quoted, ...extra } } });

test('a reply in another chat reads with the message it answers', () => {
  const q = quoteOf(reply('extendedTextMessage', { conversation: 'Can Rowan bring the boxes round on Friday?' }, { participant: '447700900111@s.whatsapp.net' }));
  assert.deepEqual(q, { text: 'Can Rowan bring the boxes round on Friday?', who: null, from: '447700900111@s.whatsapp.net' });
  const line = replyLine(q, 'me');
  assert.equal(line, '[replying to a message from me: "Can Rowan bring the boxes round on Friday?"]');
  assert.equal(rules.splitReply(`${line}\nYes of course`).quoted, 'Can Rowan bring the boxes round on Friday?', 'stored in the shape every reply takes');
  assert.equal(replyLine(q, null), '[replying to an earlier message: "Can Rowan bring the boxes round on Friday?"]');
});

test('a picture or file with a caption carries its reply the same way', () => {
  for (const kind of ['imageMessage', 'videoMessage', 'documentMessage']) {
    assert.equal(quoteOf(reply(kind, { conversation: 'Which floor plan?' }))?.text, 'Which floor plan?', kind);
  }
  assert.equal(quoteOf({ conversation: 'no reply here' }), null);
  assert.equal(quoteOf(reply('extendedTextMessage', { imageMessage: {} })), null, 'a quote with no words to show');
});

test("Closedhand's own message is named as its own, without the stamp", () => {
  const q = quoteOf(reply('extendedTextMessage', { conversation: '✊ *Closedhand:* 📦 Van is booked' }));
  assert.equal(q.who, 'Closedhand');
  assert.equal(q.text, '📦 Van is booked');
  assert.equal(quoteOf(reply('extendedTextMessage', { conversation: 'Van is booked' }, { stanzaId: 'ABC1' }), new Set(['ABC1'])).who, 'Closedhand');
  assert.equal(quoteOf(reply('extendedTextMessage', { conversation: 'a "quote"] inside' })).text, 'a "quote" ] inside', 'cannot close the line early');
});

test('every chat stores its replies with the quote, named as that chat names people', () => {
  const linked = fs.readFileSync(path.join(__dirname, '../lib/platforms/whatsapp-linked.js'), 'utf8');
  const ingest = linked.slice(linked.indexOf('async function ingestMessages'), linked.indexOf('// --- The conversation, in the self-chat'));
  assert.match(ingest, /const quote = quoteOf\(inner, _sentIds\)/);
  assert.match(ingest, /isSelfJid\(by\) \? "me"/, 'the person is "me", as their own messages are');
  assert.match(ingest, /const text = quote \? `\$\{replyLine\(quote, writer\)\}\\n\$\{said\}` : said;/);
  assert.match(linked, /const quoted = media \? null : quoteOf\(unwrap\(msg\.message\), _sentIds\);/, 'the self-chat reads replies the same way');
  assert.ok(!/function extractQuoted/.test(linked), 'one reader of quotes');
});
