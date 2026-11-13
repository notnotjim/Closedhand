// The glance before pressing send (lib/claims-check.js) flags what a message
// gets wrong, and never puts to the person what they already said yes to:
// asked to confirm a second email to a helpdesk, they were warned about two
// points the first email they sent had already made, in a voice that read
// like Closedhand's own notes ("Known facts say..."). Invented people,
// flights and numbers only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const llm = { answer: null, prompts: [] };
stub('../lib/llm', { getInternalClient: () => ({ model: 'test-model', client: { messages: { create: async (req) => { llm.prompts.push(req.messages[0].content); return { content: [{ type: 'text', text: JSON.stringify(llm.answer) }] }; } } } }) });
stub('../lib/projects', { live: async () => [] });
// The cache: a thread the person wrote on, and a helpdesk's reply on a new thread.
const rows = [
  { data: { id: 's1', threadId: 't-receipt', labels: ['SENT'], to: 'help@kestrelair.test', date: 'Wed, 12 Nov 2026 20:07:00 +0000', body: 'Hello, I bought Wi-Fi on KP209 on 9 November 2026, ref ABC123, £29.99. It never worked. The connection was down for the whole flight. The cabin crew told me to email you for a full refund. Paid by card ending 4821.' } },
  { data: { id: 'r1', threadId: 't-receipt', labels: ['INBOX'], from: 'Desk <desk@kestrelair-support.test>', body: '[ticket 55]' } },
  { data: { id: 'r2', threadId: 't-ticket', labels: ['INBOX'], from: 'Desk <desk@kestrelair-support.test>', body: 'Please send the receipt.' } },
  { data: { id: 'd1', threadId: 't-ticket', labels: ['DRAFT'], is_draft: true, draft_id: 'r-9', body: 'draft' } },
];
function query() {
  const f = [];
  const q = {
    select: () => q, limit: () => q,
    eq: (k, v) => { f.push((d) => (k === 'data->>threadId' ? d.threadId === v : k === 'data->>draft_id' ? d.draft_id === v : k === 'data->>id' || k === 'external_id' ? d.id === v : true)); return q; },
    ilike: (k, v) => { const want = v.replace(/%/g, '').toLowerCase(); f.push((d) => String(k === 'data->>from' ? d.from : d.to || '').toLowerCase().includes(want)); return q; },
    gte: () => q,
    then: (res) => Promise.resolve({ data: rows.filter((r) => f.every((ok) => ok(r.data))) }).then(res),
  };
  return q;
}
stub('../lib/db', { supabase: { from: query } });
const check = require('../lib/claims-check');

const recent = [
  { role: 'user', content: 'The Wi-Fi worked on my phone, only the laptop never connected. The crew said to email them.' },
  { role: 'assistant', content: 'Draft saved.' },
];
const reply = 'Hello, a screenshot of the receipt is attached. The service didn\'t work for the whole flight, and the cabin crew told me to ask for a full refund. Paid by card ending 4812.';
const run = (warnings) => { llm.answer = { warnings }; return check.checkOutbound({ userId: 'u1', kind: 'send an email', to: 'Desk <desk@kestrelair-support.test>', subject: 'Re: ticket 55', body: reply, recent, input: { draft_id: 'r-9' } }); };

test('a point the person already sent or wrote is never put to them again; a mistake still is', async () => {
  const { warnings } = await run([
    // Repeats the first email near word for word: dropped by code.
    { claim: 'the cabin crew told me to ask for a full refund', because: 'You said the crew told you to email them.', same_as: '' },
    // Said there in other words, and the LLM quotes where: dropped.
    { claim: "The service didn't work for the whole flight", because: 'You said the Wi-Fi worked on your phone.', same_as: 'The connection was down for the whole flight.' },
    // A wrong number, even with a quote of the right one: kept.
    { claim: 'Paid by card ending 4812', because: 'The card you gave them ends 4821.', same_as: 'Paid by card ending 4821.' },
    // A quote that is not in anything they sent: kept.
    { claim: 'a screenshot of the receipt is attached', because: 'Nothing is attached to the draft yet.', same_as: 'I attached the receipt last time.' },
  ]);
  assert.deepEqual(warnings.map((w) => w.claim), ['Paid by card ending 4812', 'a screenshot of the receipt is attached']);

  // What they sent is found from the draft's thread, and from the threads the
  // helpdesk wrote on: it answered on a new thread from another address.
  const prompt = llm.prompts.at(-1);
  assert.match(prompt, /ALREADY SENT BY THE USER ON THIS THREAD OR TO THIS ADDRESS/);
  assert.match(prompt, /The connection was down for the whole flight/);
  assert.doesNotMatch(prompt.slice(prompt.indexOf('ALREADY SENT')), /"draft"/, 'an unsent draft is not something they said yes to');
  // Spoken to the person, never as Closedhand's own notes.
  assert.match(prompt, /"because" is one short sentence to the user, as you would say it to them/);
  assert.match(prompt, /never naming known facts, the picture or the conversation/);
  assert.match(check.renderWarnings(warnings), /^\nCheck before you say yes:\n- The message says "Paid by card ending 4812"\. The card you gave them ends 4821\.\n/);
});

test('their own words in the chat count as said, and numbers must match exactly', () => {
  assert.equal(check.repeats('the Wi-Fi worked on my phone', [recent[0].content]), true);
  assert.equal(check.repeats('flight KP209 on 9 November 2026', [rows[0].data.body]), true);
  assert.equal(check.repeats('flight KP209 on 19 November 2026', [rows[0].data.body]), false, 'a different day is never a repeat');
  assert.equal(check.repeats('£29.90 on card', [rows[0].data.body]), false);
  assert.equal(check.repeats('we land at 14:05 on Saturday', [rows[0].data.body]), false);
});

test('no answer in time means no warning, and the card never waits long for it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'claims-check.js'), 'utf8');
  assert.match(src, /const TIMEOUT_MS = 12000;/);
  assert.match(src, /const \[open, sentBefore\] = await Promise\.all\(/, 'what was sent is looked up alongside the projects');
  for (const f of ['lib/engine.js', 'lib/agents.js']) assert.match(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /claimsCheck\.checkOutbound\(\{[^}]*input: (block|pendingSend)\.input/, `${f} says which thread the send goes to`);
});
