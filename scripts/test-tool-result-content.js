// A picture a tool opens reaches the LLM as the picture in chat, background
// tasks, routines and Pulse alike (lib/tool-result-content.js): background
// work once got only its stored description, so a task looking for a receipt
// among the person's screenshots read "a phone screen that says Thank you for
// your purchase" and decided there was no receipt to attach. What is saved of
// a run keeps a note that a picture was shown, never its bytes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const { toolResultContent, storable } = require('../lib/tool-result-content');

const picture = { _contentType: 'image', base64: 'iVBORw0KGgo=', mediaType: 'image/png', description: 'A phone screen that says Thank you for your purchase', question: 'Is this the Kestrel Air Wi-Fi receipt?' };

test('a picture goes to the LLM as the picture, with its description and what to look for', () => {
  const content = toolResultContent(picture);
  assert.deepEqual(content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
  assert.deepEqual(content.slice(1).map((c) => c.text), ['Image: A phone screen that says Thank you for your purchase', 'Look for: Is this the Kestrel Air Wi-Fi receipt?']);
  assert.match(JSON.stringify(toolResultContent({ ...picture, sign_in_needed: true, sign_in_site: 'kestrelair.test' })), /sign_in_needed/, 'a sign-in it needs is still said');
  assert.equal(toolResultContent({ _contentType: 'text', fileName: 'note.txt', textContent: 'Gate 14' }), 'File: note.txt\n\nGate 14');
  assert.equal(toolResultContent({ results: [] }), null, 'anything else is formatted by the caller');
});

test('what is saved of a run, and what its check reads, keeps a note in place of the picture', () => {
  const messages = [
    { role: 'user', content: 'find the receipt' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: toolResultContent(picture) }, { type: 'image', source: { type: 'base64', data: 'xyz' } }] },
  ];
  const saved = JSON.stringify(storable(messages));
  assert.doesNotMatch(saved, /iVBORw0KGgo=|xyz/);
  assert.match(saved, /a picture was shown here/);
  assert.match(saved, /Image: A phone screen that says Thank you for your purchase/, 'its description is kept');
  assert.equal(messages[1].content[0].content[0].type, 'image', 'the run itself still has the picture');
  assert.match(read('lib/agents-store.js'), /if \(updates\.messages\) updates\.messages = require\("\.\/tool-result-content"\)\.storable\(updates\.messages\);/);
  assert.match(read('lib/automations-store.js'), /if \(updates\.messages\) updates\.messages = require\("\.\/tool-result-content"\)\.storable\(updates\.messages\);/);
  assert.match(read('lib/task-evidence.js'), /require\("\.\/tool-result-content"\)\.storable\(messages \|\| \[\]\)/);
});

test('chat, background tasks, routines and Pulse all give a tool answer the same way, and none reduces a picture to words', () => {
  for (const f of ['lib/engine.js', 'lib/agents.js', 'lib/automations.js', 'lib/pulse.js']) {
    const src = read(f);
    assert.match(src, /require\("\.\/tool-result-content"\)\.toolResultContent\(result\)/, f);
    assert.doesNotMatch(src, /Binary content handled/, `${f} hands over the picture, not its description`);
  }
  // Their LLM client routes a picture to a vision model for a chat model that
  // cannot read one, so handing it over is safe whatever the person chose.
  assert.match(read('lib/llm.js'), /routeImages: role === "chat" && \(!vision \|\| pick\.capabilities\?\.vision !== true\)/);
  for (const f of ['lib/agents.js', 'lib/pulse.js']) assert.match(read(f), /getUserLLMClient\(/, `${f} uses the chat's LLM client`);
});
