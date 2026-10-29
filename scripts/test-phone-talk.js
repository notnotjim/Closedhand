// The web chat's mic: on a computer a tap listens and the next writes what
// was said into the box, to edit before sending. On a phone, talking is a
// conversation instead (scripts/test-conversation.js): the fist on the home
// starts it, the mic carries it on. Runs the real webapp/public/dictation.js
// against a stand-in browser.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function browser(words, extra = {}) {
  const fetched = [];
  let processor = null;
  class AudioContext {
    constructor() { this.sampleRate = 16000; this.state = "running"; this.destination = {}; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { processor = { connect() {}, disconnect() {}, onaudioprocess: null }; return processor; }
    resume() { return Promise.resolve(); }
    close() {}
  }
  const window = {
    AudioContext,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, ...(extra.navigator || {}) },
    localStorage: extra.localStorage,
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, json: async () => (url === "/api/dictation" ? { text: words } : { warming: true }) };
    },
    setTimeout, clearTimeout, Event: class { constructor(type) { this.type = type; } },
  };
  vm.runInNewContext(read("webapp/public/dictation.js"), { window, fetch: window.fetch, Float32Array, ArrayBuffer, DataView, Math, String, Promise, setTimeout, clearTimeout, Event: window.Event });
  const handlers = {};
  const classes = new Set();
  const attrs = {};
  const button = {
    hidden: false, title: "",
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), has: (c) => classes.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k],
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  let focused = 0;
  const input = { value: "", dispatchEvent() {}, focus() { focused++; } };
  const note = { textContent: "", hidden: true };
  // A second of a voice-like tone, or of nothing at all.
  const tone = () => Float32Array.from({ length: 16000 }, (_, i) => 0.2 * Math.sin(i / 8));
  const speak = (silent) => processor.onaudioprocess({ inputBuffer: { getChannelData: () => (silent ? new Float32Array(16000) : tone()) } });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { api: window.ClosedhandDictation, button, input, note, fetched, handlers, classes, attrs, speak, settle, focused: () => focused };
}

test("on a computer the mic writes what was said into the box, to edit before sending", async () => {
  const b = browser("move my 3pm to Thursday");
  assert.equal(b.api.attach(b.button, b.input, b.note, { when: () => true }), true);
  assert.equal(b.note.hidden, true, "no hint line for the mic");
  b.handlers.click();
  await b.settle();
  assert.equal(b.fetched[0], "/api/dictation/warm", "speech to text loads while you talk; no voice is needed");
  assert.ok(b.classes.has("recording"));
  assert.equal(b.attrs["aria-label"], "Stop and write it out");
  b.speak();
  b.handlers.click();
  assert.equal(b.note.textContent, "Writing it out…");
  await b.settle();
  assert.equal(b.input.value, "move my 3pm to Thursday");
  assert.equal(b.focused(), 1);
  assert.equal(b.attrs["aria-label"], "Speak instead of typing");
});

test("on a phone the mic leaves its taps to the conversation", async () => {
  const b = browser("hello");
  b.api.attach(b.button, b.input, b.note, { when: () => false });
  b.handlers.click();
  await b.settle();
  assert.deepEqual(b.fetched, []);
  assert.ok(!b.classes.has("recording"));
});

test("silence from the microphone is not sent to be written out, and says so", async () => {
  const b = browser("you");
  b.api.attach(b.button, b.input, b.note);
  b.handlers.click();
  await b.settle();
  b.speak(true);
  b.handlers.click();
  await b.settle();
  assert.equal(b.note.textContent, "No sound came through from the microphone. Tap the mic and try again.");
  assert.equal(b.input.value, "", "no stray \"you\"");
  assert.ok(!b.fetched.includes("/api/dictation"), "nothing uploaded");
});

test("on an iPhone that would ask again, the tip to allow the microphone is given once", async () => {
  const store = {};
  const localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } };
  const navigator = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1", permissions: { query: async () => ({ state: "prompt" }) } };
  for (const round of [1, 2]) {
    const b = browser("what's on tomorrow", { navigator, localStorage });
    b.api.attach(b.button, b.input, b.note);
    b.handlers.click();
    await b.settle();
    b.speak();
    b.handlers.click();
    await b.settle();
    if (round === 1) assert.match(b.note.textContent, /page menu beside the address, then the three dots, and under Website Settings set Microphone to Allow/);
    else assert.equal(b.note.hidden, true, "said once on this device");
  }
  assert.match(read("webapp/public/conversation.js"), /if \(heard && root\.ClosedhandDictation && root\.ClosedhandDictation\.allowTip\) root\.ClosedhandDictation\.allowTip\(/, "a conversation gives it too, once one has worked");
});

test("too short a recording says which button to tap", async () => {
  const b = browser("");
  b.api.attach(b.button, b.input, b.note);
  b.handlers.click();
  await b.settle();
  b.handlers.click();
  assert.equal(b.note.textContent, "That was too short to hear. Tap the mic, speak, then tap it again.");
});

test("the page: the ring and the chat apps on phones only, the ring following the voice, no keyboard while talking", () => {
  const page = read("webapp/views/index.html");
  assert.match(page, /<button type="button" class="talk-btn" id="talkBtn" aria-label="Talk to Closedhand"><video class="talk-smoke" id="talkSmoke" muted loop playsinline preload="none" [^>]*data-mov="\/orb\/smoke\.mov" data-webm="\/orb\/smoke\.webm" data-poster="\/orb\/smoke-poster\.png"><\/video><span class="talk-core" aria-hidden="true"><\/span><span class="talk-fist" aria-hidden="true"><\/span><\/button>/);
  // No filter on the ring or the fist: Safari draws a filtered video or image
  // at a lower resolution. Each theme has its own film; the fist takes the ink.
  assert.doesNotMatch(page, /\.talk-smoke \{ filter|\.talk-btn img|\.talk-fist[^}]*filter/);
  assert.match(page, /\.talk-fist \{[^}]*background: var\(--fg\); -webkit-mask: url\(\/fist\.png\) center \/ contain no-repeat; mask: url\(\/fist\.png\)/);
  assert.match(page, /var of = function \(src\) \{ return light \? src\.replace\('\/smoke', '\/smoke-light'\) : src; \};/);
  assert.match(page, /document\.documentElement\.addEventListener\('themechange', function \(\) \{ film\(\); sync\(\); \}\);/, "and the film changes with the theme");
  assert.match(page, /\.talk, \.continue-on \{ display: none; \}\n  @media \(max-width: 600px\) \{\n    body:not\(\.no-talk\) \.talk \{ display: flex;/);
  assert.match(page, /var phone = window\.matchMedia\('\(max-width: 600px\)'\);/);
  assert.match(page, /hints: Object\.assign\(\{ idle: 'Tap to talk' \}, talkHints\),/);
  assert.match(page, /btn\.style\.setProperty\('--level', level === 0 \? 0 : shown\.toFixed\(3\)\);/, "the ring follows the voice");
  assert.match(page, /transform: scale\(calc\(1 \+ var\(--level, 0\) \* 0\.12\)\);/, "the ring swells with the voice");
  assert.match(page, /\.talk-btn\.recording \.talk-core \{ animation: none; opacity: calc\(0\.75 \+ var\(--level, 0\) \* 0\.6\);/, "and the light inside rises with it");
  assert.match(page, /\.talk-btn\.speaking \.talk-core \{ animation-duration: 1\.2s;/, "and quickens while Closedhand speaks");
  assert.match(page, /\.toolbar-btn\.speaking \{ color: var\(--accent-live\);/, "the mic too, once the chat is open");
  assert.match(page, /@media \(prefers-reduced-motion: reduce\) \{ \.talk-btn, \.talk-fist, \.talk-core, #heroInputWrap::after \{ animation: none !important; \}/);
  assert.match(page, /if \(!window\._conversation \|\| window\._conversation\.state\(\) === 'off'\) input\.focus\(\);/, "no keyboard over a reply being spoken");
  assert.match(page, /: window\.talkFirst && window\.talkFirst\(\) \? \(document\.body\.classList\.contains\('chat-active'\) \? 'Type a message' : 'Message Closedhand'\)/);
  const play = read("webapp/public/speech-playback.js");
  assert.match(play, /window\.ClosedHandSpeech = \{ addControl: addControl, receive: receive, stop: stop, prime: prime, talk: talk \};/);
  // An iPhone on silent mutes page audio unless it says it is playback; in a
  // conversation the session is play-and-record, so the mic stays open.
  assert.match(play, /navigator\.audioSession\.type = "playback"/);
  assert.ok(play.indexOf("asPlayback();\n        context = context || new AudioContext();") > 0, "Read aloud asks for it in the tap");
  assert.match(play, /if \(!recording\) asPlayback\(\);/);
});

test("the phone's home: the ring's film fetched on phones only, the box at the thumb, conversations as chips, desks unchanged", () => {
  const page = read("webapp/views/index.html");
  // The same film as closedhand.com's phone page, byte for byte.
  for (const f of ["smoke.webm", "smoke.mov", "smoke-poster.png", "smoke-light.webm", "smoke-light.mov", "smoke-light-poster.png"]) {
    assert.ok(fs.readFileSync(path.join(ROOT, "webapp/public/orb", f)).equals(fs.readFileSync(path.join(ROOT, "closedhand-com/public/orb", f))), f);
  }
  assert.match(read("closedhand-com/views/home.html"), /var of = function \(src\) \{ return light \? src\.replace\('\/smoke', '\/smoke-light'\) : src; \};/, "closedhand.com plays each theme's own film too");
  assert.match(page, /if \(!smoke \|\| !window\.talkFirst\(\)\) return;/, "a desk never downloads it");
  assert.match(page, /if \(still \|\| document\.hidden \|\| document\.body\.classList\.contains\('chat-active'\) \|\| !window\.talkFirst\(\)\) \{ smoke\.pause\(\); return; \}/);
  assert.match(page, /smokeRate\(state\);/);
  // Top to bottom: greeting, weather, ring, then chips, box and chat apps at the foot, filling the screen.
  for (const [sel, n] of [["#chatGreeting", 1], ["> .hero-footer", 2], ["#talkArea", 3], [".hero-space-bottom", 4], ["#heroInputWrap", 6], ["#heroProjects", 7], ["#continueOn", 8]]) {
    assert.ok(page.includes(sel + " { order: " + n + ";"), sel);
  }
  assert.match(page, /min-height: calc\(100svh - var\(--hero-top, 8.625rem\)\) !important;/);
  assert.match(page, /document\.documentElement\.style\.setProperty\('--hero-top', Math\.round\(hero\.getBoundingClientRect\(\)\.top \+ window\.scrollY\) \+ 'px'\);/);
  // The box: + on the left, the arrow once there is something to send, one sweep of light on focus.
  assert.match(page, /body:not\(\.chat-active\) #heroInputBox \.send-btn:disabled \{ width: 0;/);
  assert.match(page, /body:not\(\.chat-active\) #heroInputWrap:focus-within::after \{ animation: composeSweep 1\.15s/);
  assert.match(page, /#heroSection:has\(#heroInputWrap:focus-within\) \.talk-btn/, "the ring steps back while typing");
  // Pick up a project: one row under the box at every width, All projects when there are more.
  assert.match(page, /\+ \(projects\.length > shown\.length \? '<button type="button" class="hero-project" data-all="1">All projects<\/button>' : ''\);/);
  assert.match(page, /if \(!row \|\| !projects\.length\) return;/, "only when there is a project to pick up");
  assert.doesNotMatch(page, /resumePill|hero-recent-float|heroRecentChips/);
  // In a conversation on a phone: the box edge to edge at the bottom, and the chat apps beside it.
  assert.match(page, /@media \(max-width: 600px\) \{\n    body\.chat-active \.docked-input\.active \{ bottom: 0;/);
  assert.match(page, /var under = window\.talkFirst\(\) && !document\.body\.classList\.contains\('chat-active'\);/);
});
