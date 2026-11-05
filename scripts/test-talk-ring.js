// The ring drawn round the fist while talking (webapp/public/talk-ring.js):
// it comes out of the film's ring and draws in to listen, bends with the
// voice, gathers in with a light running round while thinking, holds still
// for reduced motion, and stops drawing once it has faded or is off screen.
// Then the page: said to the ring on a phone's home, the ring thinks until
// the answer begins and only then does the conversation open. Runs the real
// script against a stand-in canvas.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function stage({ still = false } = {}) {
  let frames = [], timers = 0, now = 0, shown = true, loud = 0;
  const strokes = [];
  let path = [];
  const ctx = {
    globalCompositeOperation: "", lineJoin: "", lineCap: "", strokeStyle: "", lineWidth: 1,
    clearRect() {}, beginPath() { path = []; }, moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); },
    stroke() { strokes.push({ style: ctx.strokeStyle, width: ctx.lineWidth, points: path.slice() }); },
  };
  const canvas = { className: "", width: 0, height: 0, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getContext: () => ctx };
  const kids = [];
  const host = {
    clientWidth: 200, isConnected: true, firstChild: null,
    getClientRects: () => (shown ? [{}] : []),
    insertBefore(el, before) { kids.splice(before ? kids.indexOf(before) : 0, 0, el); },
  };
  const core = { name: "core" };
  kids.push(core);
  const root = { getAttribute: () => "dark", addEventListener() {} };
  const doc = { createElement: () => canvas, documentElement: root, hidden: false };
  const win = {
    devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: (n) => ({ "--accent-soft-rgb": "232,164,147", "--accent-warm-rgb": "227,179,148" }[n] || "") }),
    matchMedia: () => ({ matches: still }),
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setTimeout: () => ++timers, clearTimeout() {},
  };
  doc.defaultView = win;
  host.ownerDocument = doc;
  const context = { window: win, Math, Float32Array, Uint8Array };
  vm.runInNewContext(read("webapp/public/talk-ring.js"), context);
  const analyser = { frequencyBinCount: 128, getByteFrequencyData: (d) => { for (let i = 0; i < d.length; i++) d[i] = i < 24 ? loud : 0; } };
  const ring = win.ClosedhandTalkRing.mount(host, { before: core, sound: (state) => (state === "listening" || state === "speaking" ? analyser : null) });
  // Runs the frames the ring asks for, 1/60 s apart, as a phone would.
  const run = (ms) => {
    for (let t = 0; t < ms; t += 16) {
      const due = frames; frames = [];
      if (!due.length) break;
      now += 16;
      strokes.length = 0;
      due.forEach((fn) => fn(now));
    }
  };
  // The thin strokes of the ring (not its soft wide pass, not the running light), as radii from the centre.
  const rings = () => strokes.filter((s) => s.width < 2 && s.points.length > 100).map((s) => s.points.map(([x, y]) => Math.hypot(x - 100, y - 100)));
  const lights = () => strokes.filter((s) => s.style.startsWith("rgba(227,179,148"));
  return { ring, canvas, kids, core, run, rings, lights, waiting: () => frames.length, timers: () => timers, voice: (v) => { loud = v; }, hide: () => { shown = false; } };
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const spread = (a) => Math.max(...a) - Math.min(...a);

test("off, nothing is drawn and nothing runs; the canvas sits under the light and the fist", () => {
  const s = stage();
  assert.equal(s.kids[0], s.canvas);
  assert.equal(s.kids[1], s.core, "before the light inside, so the fist stays on top");
  assert.equal(s.canvas.attrs["aria-hidden"], "true");
  assert.equal(s.waiting(), 0);
});

test("listening, the ring comes out of the film's ring, draws in, and bends with the voice", () => {
  const s = stage();
  s.ring.set("listening");
  s.run(16);
  const first = mean(s.rings()[0]);
  s.run(700);
  const settled = s.rings().map(mean);
  assert.ok(first > 90, "starts wide, where the film's ring is: " + first);
  assert.ok(Math.abs(mean(settled) - 80) < 4, "draws in to listen: " + mean(settled));
  const quiet = Math.max(...s.rings().map(spread));
  s.voice(230);
  s.run(400);
  const loud = Math.max(...s.rings().map(spread));
  assert.ok(loud > quiet * 2, `a voice bends it: ${quiet.toFixed(1)} -> ${loud.toFixed(1)}`);
  assert.ok(mean(s.rings().map(mean)) > mean(settled), "and swells it");
  assert.equal(s.lights().length, 0, "no running light while listening");
});

test("thinking, it gathers in and a light runs round; off again, it fades and stops", () => {
  const s = stage();
  s.ring.set("listening"); s.run(600);
  const listening = mean(s.rings().map(mean));
  s.ring.set("thinking"); s.run(600);
  assert.ok(mean(s.rings().map(mean)) < listening - 10, "gathered in");
  assert.ok(s.lights().length > 0, "a light runs round it");
  s.ring.set("off"); s.run(3000);
  assert.equal(s.waiting(), 0, "faded, it stops asking for frames");
});

test("without motion: no drift, no running light, the voice only swells it", () => {
  const s = stage({ still: true });
  s.ring.set("listening"); s.voice(230); s.run(600);
  assert.ok(Math.max(...s.rings().map(spread)) < 0.01, "each strand a circle");
  s.ring.set("thinking"); s.run(600);
  assert.equal(s.lights().length, 0);
});

test("off screen, it draws nothing and only looks again now and then", () => {
  const s = stage();
  s.ring.set("listening"); s.run(100);
  s.hide();
  s.run(100);
  assert.equal(s.waiting(), 0, "no frames while hidden");
  assert.ok(s.timers() > 0, "a look again later");
});

test("the page: said to the ring, it thinks until the answer begins, then the conversation opens", () => {
  const page = read("webapp/views/index.html");
  assert.match(page, /if \(spoken === true && !hasMessages && window\.talkFirst && window\.talkFirst\(\)\) holdForAnswer\(\); else enterChatMode\(\);/);
  assert.match(page, /function holdForAnswer\(\) \{ clearTimeout\(_holding\); _holding = setTimeout\(talkHandover, 12000\); \}/, "never longer than twelve seconds");
  assert.match(page, /if \(_holding && \/\^\(status\|stream_start\|stream_token\|message\|file\|error\)\$\/\.test\(msg\.type\)\) talkHandover\(\);/, "the first of the answer opens it");
  assert.match(page, /if \(window\._talkRing\) window\._talkRing\.set\('settle'\);\n\s+enterChatMode\(\);/, "the ring settles back into its smoke as it opens");
  assert.match(page, /onEnd: function \(\) \{[^\n]*talkHandover\(\); \}/, "ending the conversation while it thinks opens it too");
  assert.match(page, /function enterChatMode\(\) \{\n\s+if \(_holding\) \{ clearTimeout\(_holding\); _holding = null; \}/, "and anything else that opens it ends the wait");
});
