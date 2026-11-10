// Every test file runs in CI. Nine had been written and never listed in
// checks.yml, so their checks were never enforced (found 2026-10-27).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("checks.yml runs every scripts/test-*.js, each once", () => {
  const root = path.join(__dirname, "..");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/checks.yml"), "utf8");
  const listed = workflow.match(/scripts\/test-[a-z0-9-]+\.js/g) || [];
  const files = fs.readdirSync(path.join(root, "scripts")).filter((f) => /^test-[a-z0-9-]+\.js$/.test(f)).map((f) => "scripts/" + f);
  assert.deepEqual(files.filter((f) => !listed.includes(f)), [], "add these to the run line in checks.yml");
  assert.deepEqual([...new Set(listed.filter((f, i) => listed.indexOf(f) !== i))], [], "listed twice");
});

// One CI job ran Node 20 while every build shipped Node 22, so a package that
// no longer parsed on 20 failed checks for something no build would meet.
test("CI tests on the Node that every build ships", () => {
  const root = path.join(__dirname, "..");
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const shipped = new Set([
    ...["Dockerfile", "webapp/Dockerfile"].map((f) => read(f).match(/^FROM node:(\d+)/m)[1]),
    read("desktop/build.sh").match(/NODE_VERSION:-v(\d+)\./)[1],
  ]);
  assert.equal(shipped.size, 1, "the builds ship one Node");
  for (const f of fs.readdirSync(path.join(root, ".github/workflows"))) {
    for (const [, v] of read(".github/workflows/" + f).matchAll(/node-version: "(\d+)"/g)) assert.ok(shipped.has(v), `${f} tests Node ${v}`);
  }
});

test("image builds run one at a time, so :latest always ends on the newest commit", () => {
  const root = path.join(__dirname, "..");
  for (const f of ["build-selfhost-images.yml", "build-sandbox.yml"]) {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows", f), "utf8");
    assert.match(workflow, /\nconcurrency:\n  group: [a-z-]+\n  cancel-in-progress: false\n/, f);
    assert.match(workflow, /:latest/, f + " pushes :latest");
  }
});
