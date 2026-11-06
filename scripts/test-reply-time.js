// A reply to a long conversation took more than the 90 seconds a model
// request was allowed, though the engine waited three minutes; the same
// request was then sent again and ran out again, and the person was told
// "Lost connection to my brain". A request gets the time the engine gives it,
// and one that ran out of time is not sent again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test("a model request gets the engine's three minutes, and one that ran out is not sent again", () => {
  const wire = read('lib/model-wire.js'), engine = read('lib/engine.js');
  assert.match(wire, /const signal = options\.signal \|\| AbortSignal\.timeout\(180000\);/);
  assert.match(engine, /rej\(new Error\("LLM API timeout \(3min\)"\)\), 180_000\)/, 'the same three minutes');
  assert.match(engine, /const ranOut = \/timeout\|timed out\/i\.test\(`\$\{llmErrFirst\?\.name \|\| ""\} \$\{llmErrFirst\?\.message \|\| ""\}`\);\n\s*if \(!ranOut\) \{ try \{ response = await require\("\.\/sleep-watch"\)\.retryNetwork\(/);
  for (const e of [{ name: 'TimeoutError', message: 'The operation was aborted due to timeout' }, { message: 'LLM API timeout (3min)' }]) {
    assert.ok(/timeout|timed out/i.test(`${e.name || ''} ${e.message || ''}`), e.message);
  }
  assert.ok(!/timeout|timed out/i.test('TypeError fetch failed'), 'a dropped connection is still tried again');
});
