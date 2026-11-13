// The web chat's box: a file dragged anywhere over the chat lights it as
// "Connect anything" is lit (one shared piece, interface.css), where a dashed
// rectangle used to go round the box and the whole thread; dropped, it flares
// once. And the thread meets the box through a short eased fade that softens
// under a growing blur, where a long straight fade laid a milky band over
// pictures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const page = fs.readFileSync(path.join(__dirname, '..', 'webapp/views/index.html'), 'utf8');

test('a file dragged over the chat lights its box with the shared lights, and dropping flares it once', () => {
  for (const id of ['<div class="input-box-wrap" id="heroInputWrap">', '<div class="docked-input" id="dockedInput">\n    <div class="input-box-wrap">']) {
    assert.ok(page.includes(id + '\n      <span class="edge-glow" aria-hidden="true"></span><span class="edge-run" aria-hidden="true"></span>'), id);
  }
  assert.match(page, /body\.file-over \.input-box-wrap > :is\(\.edge-run, \.edge-glow\) \{ opacity: 1; --edge-lit: 1; \}/);
  assert.match(page, /\.input-box-wrap\.landed > \.edge-glow \{ opacity: 1; animation: box-landed/);
  assert.doesNotMatch(page, /\.chat-messages\.drag-over|\.docked-input\.drag-over|border: 2px dashed/, 'no rectangles');
  // Only files light it, and moving between the places that take one keeps it lit.
  assert.match(page, /if \(!hasFiles\(e\)\) return;\n\s+if \(counter\+\+ === 0\) fileOver\(true\);/);
  assert.match(page, /document\.body\.classList\.toggle\('file-over', filesOver > 0\);/);
  assert.match(page, /if \(e\.dataTransfer\.files\.length > 0\) \{ landed\(\); handleFiles\(e\.dataTransfer\.files\); \}/);
});

test('the thread meets the box through a short eased fade under a growing blur, with no cream band', () => {
  assert.match(page, /mask-image: linear-gradient\(to bottom, #000 0, #000 calc\(100% - 3rem\), rgba\(0,0,0,\.93\)/);
  assert.match(page, /body\.chat-active \.docked-input::before \{\n\s+content: ''; position: absolute;[^}]*backdrop-filter: blur\(0\.625rem\);/);
  assert.doesNotMatch(page, /background: linear-gradient\(transparent, rgba\(var\(--raised-rgb\),0\.95\)\);/, 'the cream band on phones is gone too');
});
