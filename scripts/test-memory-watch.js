// Memory reaching a new high is logged once per step up, with what was running
// then, by kind and size only; work past its time limit is still listed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const doing = require("../lib/doing");

test("a new high names what was running, and the same level is not logged twice", () => {
  const lines = [];
  let tick = null, rss = 1 * 1024 ** 3;
  const box = {
    module: { exports: {} }, require: (n) => (n === "./doing" ? doing : require(n)),
    console: { log: (l) => lines.push(l) },
    process: { memoryUsage: () => ({ rss, heapUsed: 0.6 * 1024 ** 3 }) },
    setInterval: (fn) => { tick = fn; return { unref() {} }; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/memory-watch.js"), "utf8"), box);
  box.module.exports.start();
  const end = doing.start("Gmail extra");
  tick();
  assert.equal(lines.length, 0, "under the floor");
  rss = 4.6 * 1024 ** 3; tick();
  assert.match(lines[0], /^\[memory\] new high 4\.6 GB \(JavaScript 0\.6 GB\) while: Gmail extra \(\d+s\)$/);
  rss = 4.7 * 1024 ** 3; tick();
  assert.equal(lines.length, 1, "a small rise is not a new line");
  end(); rss = 6.8 * 1024 ** 3; tick();
  assert.match(lines[1], /new high 6\.8 GB .* while: nothing in particular$/);
});

test("timed sync steps, local model calls and file reads are listed while they run", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  assert.match(read("lib/services/data-sync.js"), /const end = require\("\.\.\/doing"\)\.start\(label\);\n\s*Promise\.resolve\(promise\)\.then\(end, end\);/);
  assert.match(read("lib/local-models.js"), /const busy = require\("\.\/doing"\)\.start\(`local model \$\{job\.op\}/);
  assert.match(read("lib/item-files.js"), /const busy = require\("\.\/doing"\)\.start\(`reading a \$\{f\.kind \|\| "file"\}/);
  assert.match(read("index.js"), /require\("\.\/lib\/memory-watch"\)\.start\(\);/);
});
