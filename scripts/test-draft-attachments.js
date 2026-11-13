// A file the person wants on a draft goes into that draft, in every mailbox,
// and the draft is what is sent: asked to attach a photo to a draft they had
// edited and send it, Closedhand once wrote a separate reply with the photo
// and left their draft behind in Drafts. A reply on a thread that holds an
// unsent draft is now turned back before anyone is asked, unless a separate
// reply with the draft kept is what they want. Invented names and files only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const handlers = read('lib/tools/handlers.js');
const fnSrc = (name) => { const a = handlers.indexOf(`async function ${name}(`); return handlers.slice(a, handlers.indexOf('\n}\n', a) + 2); };
const block = (name) => handlers.slice(handlers.indexOf(`case "${name}": {`), handlers.indexOf('\n    case "', handlers.indexOf(`case "${name}": {`) + 10));
const { addAttachmentParts, collectBoundaries, splitHeaders, headerValue } = require('../lib/gmail-draft');

const photo = { fileName: 'envelope.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('a photo of an envelope addressed to Kestrel Point '.repeat(4)) };

// The parts of a message, at every depth: { type, filename, text }.
function parts(raw) {
  const out = [];
  const walk = (block) => {
    const p = splitHeaders(block);
    if (!p) return;
    const type = headerValue(p.headers, 'Content-Type') || 'text/plain';
    const b = (type.match(/boundary\s*=\s*"?([^";]+)"?/i) || [])[1];
    if (/^multipart\//i.test(type) && b) {
      for (const seg of p.body.split(`--${b.trim()}`).slice(1)) if (!seg.startsWith('--')) walk(seg.replace(/^\r?\n/, ''));
      return;
    }
    const encoded = /base64/i.test(headerValue(p.headers, 'Content-Transfer-Encoding') || '');
    const text = encoded ? Buffer.from(p.body.replace(/\s+/g, ''), 'base64').toString('utf8') : p.body.trim();
    out.push({ type: type.split(';')[0].trim(), filename: ((headerValue(p.headers, 'Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || null, text });
  };
  walk(raw);
  return out;
}

test('a file goes into the draft beside everything already there, whatever shape the message has', () => {
  const plain = 'From: rowan@harbour.test\r\nTo: help@kestrelair.test\r\nSubject: Re: Wi-Fi refund\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n'
    + Buffer.from('Hello, the Wi-Fi never worked on KP209.').toString('base64') + '\r\n';
  const wrapped = parts(addAttachmentParts(plain, [photo]));
  assert.deepEqual(wrapped.map((p) => [p.type, p.filename]), [['text/plain', null], ['image/jpeg', 'envelope.jpg']]);
  assert.equal(wrapped[0].text, 'Hello, the Wi-Fi never worked on KP209.', 'the wording is untouched');
  assert.equal(wrapped[1].text, photo.buffer.toString('utf8'), 'the file arrives whole');
  const headers = splitHeaders(addAttachmentParts(plain, [photo])).headers;
  assert.match(headers, /^Subject: Re: Wi-Fi refund$/m, 'the message keeps its own headers');
  assert.equal((headers.match(/^Content-Type:/gim) || []).length, 1, 'and has one content type, the new one');

  // Text and HTML, with a picture placed in the HTML: all of it stays.
  const alt = 'Subject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="R"\r\n\r\n--R\r\nContent-Type: multipart/alternative; boundary="A"\r\n\r\n--A\r\nContent-Type: text/plain\r\n\r\nHi\r\n--A\r\nContent-Type: text/html\r\n\r\n<p>Hi <img src="cid:pic1"></p>\r\n--A--\r\n--R\r\nContent-Type: image/png\r\nContent-ID: <pic1>\r\nContent-Transfer-Encoding: base64\r\n\r\nUE5H\r\n--R--\r\n';
  const kept = parts(addAttachmentParts(alt, [photo]));
  assert.deepEqual(kept.map((p) => p.type), ['text/plain', 'text/html', 'image/png', 'image/jpeg']);

  // Already holding a file: the new one is added beside it, in the same list.
  const mixed = 'Subject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="M"\r\n\r\n--M\r\nContent-Type: text/plain\r\n\r\nBody\r\n--M\r\nContent-Type: application/pdf; name="note.pdf"\r\nContent-Disposition: attachment; filename="note.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nUERG\r\n--M--\r\n';
  const out = addAttachmentParts(mixed, [photo]);
  assert.deepEqual(parts(out).map((p) => p.filename), [null, 'note.pdf', 'envelope.jpg']);
  assert.deepEqual(collectBoundaries(out), ['M'], 'no new layer for a message that already lists files');
  assert.equal(addAttachmentParts(plain, []), plain, 'nothing to add, nothing changed');
});

test('each mailbox adds files to the draft itself, and a file alone is a change', async () => {
  // Gmail: the draft as it stands is fetched, the file added, and it is saved over.
  let put = null;
  const dApi = async (method, url, body) => {
    if (method === 'PUT') { put = body; return { id: 'r-draft-7', message: { id: 'msg-8' } }; }
    throw new Error('unexpected ' + method + ' ' + url);
  };
  const raw = Buffer.from('From: rowan@harbour.test\r\nTo: help@kestrelair.test\r\nSubject: Re: refund\r\nContent-Type: text/plain\r\n\r\nWording the person edited\r\n').toString('base64url');
  const gmail = new Function('isGoogleConnected', 'draftAccountFor', 'googleReqFor', 'require', 'liveGmailDraft', 'draftSeenVersions', 'draftLastSeen', 'changedDraft', 'gmailPlainText', 'gmailFrom', 'resolveOutgoingAttachments',
    'return async (toolInput) => { switch ("gmail_draft_update") {\n' + block('gmail_draft_update') + '\n} };')(
    () => true, async () => null, () => dApi, (m) => require(m === '../gmail-draft' ? '../lib/gmail-draft' : m),
    async () => ({ draftId: 'r-draft-7', draft: { message: { id: 'msg-7', threadId: 't-1', raw } } }), async () => null, new Map(), null, null, null,
    async (ids) => ({ attachments: (ids || []).filter((id) => id === 'att-1').map(() => photo), missing: (ids || []).filter((id) => id !== 'att-1') }));
  const done = await gmail({ draft_id: 'r-draft-7', attachment_ids: ['att-1'] });
  assert.equal(done.success, true, JSON.stringify(done));
  assert.deepEqual(done.attached, ['envelope.jpg']);
  const saved = parts(Buffer.from(put.message.raw, 'base64url').toString('utf8'));
  assert.deepEqual(saved.map((p) => p.filename), [null, 'envelope.jpg']);
  assert.equal(saved[0].text, 'Wording the person edited', "the person's wording is kept");
  assert.equal(put.message.threadId, 't-1', 'it stays on its thread');
  assert.match((await gmail({ draft_id: 'r-draft-7', attachment_ids: ['att-9'] })).error, /Could not find attachment.*Nothing was changed/);

  // Outlook: the file is added to the draft's own attachments, nothing else patched.
  const calls = [];
  const msApi = async (method, url, body) => { calls.push([method, url.replace('https://graph.microsoft.com/v1.0/', ''), body && body.name]); return method === 'GET' ? { id: 'AAMk-2', isDraft: true, changeKey: 'ck-5' } : {}; };
  const outlook = new Function('ctx', 'require', 'isMicrosoftConnected', 'draftAccountFor', 'microsoftReqFor', 'liveOutlookMessage', 'draftSeenVersions', 'draftLastSeen', 'changedDraft', 'outlookWording', 'outlookRecipients', 'outlookFrom', 'addOutlookAttachments', 'resolveOutgoingAttachments',
    'return async (toolInput) => { switch ("outlook_draft_update") {\n' + block('outlook_draft_update') + '\n} };')(
    {}, (m) => require(m === '../gmail-draft' ? '../lib/gmail-draft' : m), () => true, async () => null, () => msApi, (api, id) => api('GET', 'me/messages/' + id), async () => null, new Map(), null, null, null, null,
    new Function('OUTLOOK_ONE_REQUEST', fnSrc('addOutlookAttachments') + '\nreturn addOutlookAttachments;')(3 * 1024 * 1024),
    async () => ({ attachments: [photo], missing: [] }));
  const o = await outlook({ draft_id: 'AAMk-2', attachment_ids: ['att-1'] });
  assert.equal(o.success, true, JSON.stringify(o));
  assert.deepEqual(calls.filter((c) => c[0] !== 'GET'), [['POST', 'me/messages/AAMk-2/attachments', 'envelope.jpg']], 'only the file is added');

  // Other mail: the draft is rebuilt with its wording and the file beside its own.
  const imap = read('lib/services/imap-mail.js');
  assert.match(imap, /text: rewording \? body : p\.text,/, 'a file alone keeps the wording');
  assert.match(imap, /\.\.\.attachments\.map\(\(a\) => \(\{ filename: a\.fileName, content: a\.buffer, contentType: a\.mimeType \}\)\),/);
  assert.match(block('update_mail_draft'), /attachments: adding/);
});

test('a reply on a thread that holds an unsent draft goes back to be made in that draft, before anyone is asked', async () => {
  let rows = [];
  const supabase = { from: () => { const f = []; const q = { select: () => q, eq: (k, v) => { f.push([k, v]); return q; }, limit: async () => ({ data: rows.filter((r) => f.every(([k, v]) => k === 'user_id' || k === 'type' || (k === 'data->>threadId' ? r.data.threadId === v : k === 'data->>is_draft' ? String(r.data.is_draft) === v : k === 'external_id' ? r.external_id === v : k === 'data->>id' ? r.data.id === v : true))) }) }; return q; } };
  let liveDraft = true;
  const guard = new Function('require', 'liveGmailDraft', 'googleReqFor', 'liveOutlookMessage', 'microsoftReqFor', 'DRAFT_TOOLS_FOR',
    fnSrc('draftLeftBehind') + '\nreturn draftLeftBehind;')(
    () => ({ supabase }), async () => { if (!liveDraft) throw new Error('404 Not Found'); return { draftId: 'r-draft-7' }; }, () => null,
    async () => ({ isDraft: liveDraft }), () => null,
    { gmail_reply: ['gmail_draft_update', 'gmail_send_draft'], outlook_reply: ['outlook_draft_update', 'outlook_send_draft'], reply_to_mail: ['update_mail_draft', 'send_mail_draft'] });

  rows = [{ external_id: 'm-1', data: { id: 'm-1', threadId: 't-1' } }, { external_id: 'm-2', data: { id: 'm-2', threadId: 't-1', is_draft: true, draft_id: 'r-draft-7', account: 'rowan@harbour.test' } }];
  const back = await guard('u1', 'gmail_reply', { message_id: 'm-1', thread_id: 't-1', body: 'x', attachment_ids: ['att-1'] });
  assert.match(back, /already holds their unsent draft \(draft_id r-draft-7, account rowan@harbour\.test\)/);
  assert.match(back, /gmail_draft_update \(attachment_ids adds files[^)]*\) and send it with gmail_send_draft/);
  assert.match(await guard('u1', 'outlook_reply', { message_id: 'm-1', body: 'x' }), /outlook_draft_update[\s\S]*outlook_send_draft/, 'Outlook finds the thread from the message');
  assert.match(await guard('u1', 'reply_to_mail', { message_id: 'm-1', body: 'x' }), /update_mail_draft[\s\S]*send_mail_draft/, 'and so does other mail');
  assert.equal(await guard('u1', 'gmail_reply', { message_id: 'm-1', thread_id: 't-1', body: 'x', leave_draft: true }), null, 'a separate reply asked for goes ahead');
  assert.equal(await guard('u1', 'gmail_send', { to: 'a@b.test', body: 'x' }), null, 'a new email has no thread');
  liveDraft = false;
  assert.equal(await guard('u1', 'gmail_reply', { message_id: 'm-1', thread_id: 't-1', body: 'x' }), null, 'a draft the mailbox no longer has holds nothing back');
  assert.equal(await guard('u1', 'outlook_reply', { message_id: 'm-1', body: 'x' }), null, 'nor one Outlook says was sent');
  liveDraft = true;
  rows = rows.slice(0, 1);
  assert.equal(await guard('u1', 'gmail_reply', { message_id: 'm-1', thread_id: 't-1', body: 'x' }), null, 'no draft, nothing to say');

  // Turned back in chat before the card, in a background task before the
  // send is held, and by the reply tools themselves.
  assert.match(read('lib/engine.js'), /if \(needsConfirmation\) \{\n\s*const behind = await require\("\.\/tools\/handlers"\)\.draftLeftBehind\(userId, block\.name, block\.input\);[\s\S]{0,300}is_error: true, content: behind \}\);\n\s*continue;/);
  const agents = read('lib/agents.js');
  assert.ok(agents.indexOf('draftLeftBehind(userId, block.name, block.input)') < agents.indexOf('if (!pendingSend) { pendingSend = block; continue; }'), 'checked before a task holds the send');
  for (const name of ['gmail_reply', 'outlook_reply', 'reply_to_mail'])
    assert.match(block(name), new RegExp(`draftLeftBehind\\(ctx\\.activeUserId, "${name}", toolInput\\)`), name);
});

test('every mailbox offers the same: files on a draft edit, and leave_draft on a reply', () => {
  const defs = require('../lib/tools/definitions').INTERNAL_TOOLS;
  const props = (name) => defs.find((t) => t.name === name).input_schema;
  for (const name of ['gmail_draft_update', 'outlook_draft_update', 'update_mail_draft']) {
    assert.ok(props(name).properties.attachment_ids, name);
    assert.deepEqual(props(name).required, ['draft_id'], `${name}: a file alone is a change`);
  }
  for (const name of ['gmail_reply', 'outlook_reply', 'reply_to_mail']) assert.equal(props(name).properties.leave_draft.type, 'boolean', name);
});
