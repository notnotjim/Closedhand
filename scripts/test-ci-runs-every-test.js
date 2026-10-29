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

test("image builds run one at a time, so :latest always ends on the newest commit", () => {
  const root = path.join(__dirname, "..");
  for (const f of ["build-selfhost-images.yml", "build-sandbox.yml"]) {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows", f), "utf8");
    assert.match(workflow, /\nconcurrency:\n  group: [a-z-]+\n  cancel-in-progress: false\n/, f);
    assert.match(workflow, /:latest/, f + " pushes :latest");
  }
});
