// The sandbox screen is what a person watching from a phone pays for in
// bytes: every redraw crosses the tunnel. Keep it laptop-sized, and keep
// Chrome's window inside it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const entry = fs.readFileSync(path.join(__dirname, '..', 'sandbox-image', 'entrypoint.sh'), 'utf8');

// The screen itself is taller, so a phone can get a phone-shaped part of it
// (agent /desktop/shape); what is sent unless a phone asks is the part shown.
test('the part of the sandbox screen that is sent is laptop-sized, and Chrome fits inside it', () => {
  const [, sw, sh] = entry.match(/Xvfb :99 -screen 0 (\d+)x(\d+)x24/).map(Number);
  const [, w, h] = entry.match(/x11vnc -display :99 [^\n]* -clip (\d+)x(\d+)\+0\+0/).map(Number);
  assert.ok(w <= sw && h <= sh, 'the part shown is on the screen');
  assert.ok(w * h <= 1280 * 800, `the part shown, ${w}x${h}, is bigger than 1280x800`);
  const windows = [...entry.matchAll(/--window-size=(\d+),(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(windows.length >= 1);
  for (const [ww, wh] of windows) assert.ok(ww <= w && wh <= h, `window ${ww}x${wh} does not fit ${w}x${h}`);
  const status = fs.readFileSync(path.join(__dirname, '..', 'sandbox-image', 'agent', 'server.js'), 'utf8');
  assert.match(status, new RegExp(`resolution: "${w}x${h}"`));
});

// A display killed outright, or one from before a restart, left its lock, and
// Xvfb refused to start while the lock's process number was in use by
// anything: the screen stayed grey and the browser crash-looped for hours.
// The processes each crash left behind piled up under an agent server that
// was process 1 and collected none of them.
test("the screen comes back after its display dies, and crashed browsers are collected", () => {
  const entry = require("fs").readFileSync(require("path").join(__dirname, "..", "sandbox-image/entrypoint.sh"), "utf8");
  assert.match(entry, /\[ "\$\(cat \/proc\/"\$pid"\/comm 2>\/dev\/null\)" != "Xvfb" \]; then\n\s+rm -f \/tmp\/\.X99-lock \/tmp\/\.X11-unix\/X99/, "a lock not held by a running Xvfb is cleared");
  assert.match(entry, /while true; do\n\s+clear_stale_display\n\s+gosu sandbox Xvfb :99/, "before every start");
  assert.match(entry, /exec tini -s -- gosu sandbox env DISPLAY=:99 "\$@"/);
  assert.match(require("fs").readFileSync(require("path").join(__dirname, "..", "sandbox-image/Dockerfile"), "utf8"), /curl ca-certificates gosu tini/);
});

// A part of the screen that stops answering without quitting (a frozen
// Chrome, a display that no longer answers) is ended so its supervisor starts
// it again, and the Computers tab says so meanwhile (screen-watch.js).
test("a part that stops answering twice in a row is restarted, the first of them only, three times in ten minutes at most", async () => {
  const { createWatch } = require("../sandbox-image/agent/screen-watch.js");
  let t = 0;
  const up = { display: true, browser: true, screen: true, stream: true };
  const ended = [];
  const parts = Object.keys(up).map((name) => ({ name, check: async () => up[name] }));
  const w = createWatch({ parts, end: (p) => ended.push(p.name), now: () => t });
  const tick = async (ms = 30000) => { t += ms; return { ...(await w.tick()) }; };
  assert.deepEqual(await tick(0), { screen: "ok", part: null }, "nothing is asked in the first minute");
  t = 60000;
  assert.equal((await tick()).screen, "ok");
  up.browser = false;
  assert.equal((await tick()).screen, "ok", "one slow answer is not a failure");
  assert.deepEqual(await tick(), { screen: "restarting", part: "browser" });
  assert.deepEqual(ended, ["browser"]);
  assert.equal((await tick()).screen, "restarting", "left a minute to come back");
  up.browser = true;
  assert.deepEqual(await tick(60000), { screen: "ok", part: null });
  // A dead display takes Chrome with it: only the display is restarted.
  up.display = false; up.browser = false;
  await tick(); await tick();
  assert.deepEqual(ended, ["browser", "display"]);
  up.display = true; up.browser = true;
  await tick(60000);
  // Restarting that does not help stops after three in ten minutes, and is
  // tried again once the first of them is ten minutes old.
  up.stream = false;
  for (let i = 0; i < 12; i++) await tick();
  assert.deepEqual(ended.filter((n) => n === "stream").length, 3);
  assert.deepEqual(w.state, { screen: "stuck", part: "stream" });
  for (let i = 0; i < 12; i++) await tick();
  assert.ok(ended.filter((n) => n === "stream").length > 3);
});

test("the watchdog runs beside the screen it watches, and the Computers tab shows what it finds", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const server = read("sandbox-image/agent/server.js");
  assert.match(server, /if \(!DESKTOP\) require\("\.\/screen-watch"\)\.startScreenWatch\(CDP_PORT\);/);
  assert.match(server, /res\.json\(\{ status: "running", \.\.\.require\("\.\/screen-watch"\)\.screenState\(\), display: ":99"/, "the sandbox stays running while its browser restarts");
  assert.match(entry, /websockify_supervisor\(\) \{\n\s+while true; do\n\s+gosu sandbox websockify "\$WS_LISTEN" localhost:5900 \|\| true/);
  const watch = read("sandbox-image/agent/screen-watch.js");
  assert.match(watch, /if \(comm !== name \|\| fields\[0\] === "Z"\) continue;/, "finished processes are never taken for the browser");
  assert.match(watch, /part\.proc === "chromium" \? all\.filter\(\(p\) => !p\.args\.includes\("--type="\)\)\.slice\(0, 1\)/, "Chrome's own process, not a tab's");
  const page = read("webapp/views/index.html");
  assert.match(page, /frame\.src = monVncSrc\(data\.token\);\n\s+document\.getElementById\('monDesktopLoading'\)\.style\.display = 'none';\n\s+monWatchScreen\(\);/);
  assert.match(page, /restarting: 'Restarting the browser\\u2026',/);
  assert.match(page, /\} else if \(_monScreenDown && d\.screen === 'ok'\) \{[\s\S]{0,200}frame\.src = monVncSrc\(t\.token\);/, "reconnects once it is back");
});

test("every tool the screen watch runs is installed by the image itself, whichever browser the machine gets", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const watch = read("sandbox-image/agent/screen-watch.js");
  const docker = read("sandbox-image/Dockerfile");
  assert.match(watch, /execFile\("xdpyinfo"/);
  // Google Chrome (amd64, Railway) does not bring x11-utils the way Debian's Chromium does.
  assert.match(docker, /xvfb x11vnc python3-websockify x11-utils \\/);
});
