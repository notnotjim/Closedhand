// Talking with Closedhand on a phone (webapp/public/conversation.js): one tap
// starts a conversation and one ends it; a turn ends when the person stops
// talking; the reply is spoken as it is written (speech-playback.js talk);
// talking over it stops it. Runs the real scripts against a stand-in
// browser and microphone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const RATE = 16000, CHUNK = 1600; // 100 ms a chunk

function browser({ words = "what's on tomorrow" } = {}) {
  const fetched = [], said = [], interrupted = [], ended = [];
  let processor = null, stopped = 0, released = 0, session = null;
  const listeners = {};
  class AudioContext {
    constructor() { this.sampleRate = RATE; this.state = "running"; this.destination = {}; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { processor = { connect() {}, disconnect() {}, onaudioprocess: null }; return processor; }
    resume() { return Promise.resolve(); }
    close() {}
  }
  const navigator = {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++; } }] }) },
    wakeLock: { request: async () => ({ release() { released++; } }) },
    get audioSession() { return { set type(t) { session = t; } }; },
  };
  const document = { hidden: false, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const window = {
    AudioContext, navigator, document,
    fetch: async (url, opts) => {
      fetched.push(url);
      return { ok: true, json: async () => (url === "/api/dictation" ? { text: words, bytes: opts.body.byteLength } : {}) };
    },
    setTimeout, clearTimeout,
  };
  const context = { window, Float32Array, ArrayBuffer, DataView, Math, String, Promise, setTimeout, clearTimeout };
  vm.runInNewContext(read("webapp/public/dictation.js"), context);
  vm.runInNewContext(read("webapp/public/conversation.js"), context);
  const conversation = window.ClosedhandConversation.create({
    words: (w) => said.push(w), interrupt: () => interrupted.push(1), prime: () => {}, onEnd: () => ended.push(1),
  });
  const handlers = {}, classes = new Set(), attrs = {};
  const button = {
    title: "", classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k],
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  const note = { textContent: "", hidden: true };
  const states = [];
  conversation.bind(button, note, {
    labels: { idle: "Talk to Closedhand", on: "End the conversation" },
    hints: { idle: "Tap to talk", listening: "Listening", thinking: "Thinking", speaking: "Speaking, talk to interrupt", quiet: "Tap to end" },
    onState: (s) => states.push(s),
  });
  // ms of a voice, of the room's quiet, or of near silence.
  const sound = (ms, kind) => {
    for (let t = 0; t < ms && processor.onaudioprocess; t += 100) {
      const chunk = Float32Array.from({ length: CHUNK }, (_, i) => (kind === "voice" ? 0.2 * Math.sin(i / 8) : kind === "room" ? 0.002 * Math.sin(i / 3) : 0));
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { conversation, button, note, handlers, classes, attrs, fetched, said, interrupted, ended, states, sound, settle, stopped: () => stopped, released: () => released, session: () => session, hide: () => { document.hidden = true; listeners.visibilitychange(); } };
}

test("one tap starts it: listening, the voice and speech to text loading, the screen kept on", async () => {
  const b = browser();
  assert.equal(b.note.textContent, "Tap to talk");
  b.handlers.click();
  await b.settle();
  assert.equal(b.fetched[0], "/api/dictation/warm?voice=1");
  assert.equal(b.conversation.state(), "listening");
  assert.ok(b.classes.has("recording"));
  assert.equal(b.note.textContent, "Listening");
  assert.equal(b.attrs["aria-label"], "End the conversation");
  assert.equal(b.session(), "play-and-record", "the microphone stays open while it speaks");
  b.handlers.click();
  assert.equal(b.conversation.state(), "off");
  assert.equal(b.stopped(), 1, "the microphone is let go");
  assert.equal(b.released(), 1, "and the screen may sleep again");
  assert.equal(b.note.textContent, "Tap to talk");
});

test("a turn ends when the person stops talking, and is written out and sent", async () => {
  const b = browser({ words: "move my 3pm to Thursday" });
  b.handlers.click();
  await b.settle();
  b.sound(500, "room");
  b.sound(900, "voice");
  b.sound(500, "room");
  assert.deepEqual(b.fetched.filter((u) => u === "/api/dictation"), [], "a short pause is not the end of a turn");
  b.sound(400, "room");
  assert.equal(b.conversation.state(), "thinking");
  assert.equal(b.note.textContent, "Thinking");
  await b.settle();
  assert.deepEqual(b.said, ["move my 3pm to Thursday"]);
  assert.equal(b.fetched.filter((u) => u === "/api/dictation").length, 1);
});

test("a cough or a knock is not a turn", async () => {
  const b = browser();
  b.handlers.click();
  await b.settle();
  b.sound(500, "room");
  b.sound(200, "voice");
  b.sound(1500, "room");
  await b.settle();
  assert.deepEqual(b.said, []);
  assert.equal(b.conversation.state(), "listening");
});

test("the reply is heard, then it listens again; talking over it stops it and starts the next turn", async () => {
  const b = browser({ words: "no, the other one" });
  b.handlers.click();
  await b.settle();
  b.sound(500, "room"); b.sound(800, "voice"); b.sound(1000, "room");
  await b.settle();
  b.conversation.replyStarted();
  assert.equal(b.conversation.state(), "speaking");
  assert.equal(b.note.textContent, "Speaking, talk to interrupt");
  b.sound(100, "voice");
  assert.deepEqual(b.interrupted, [], "a moment of sound over the reply is not talking over it");
  b.sound(200, "room");
  b.conversation.replyDone();
  assert.equal(b.conversation.state(), "listening", "said in full: listening again");
  b.conversation.replyStarted();
  b.sound(400, "voice");
  assert.deepEqual(b.interrupted, [1], "talked over: the reply stops");
  assert.equal(b.conversation.state(), "listening");
  b.sound(600, "voice"); b.sound(1000, "room");
  await b.settle();
  assert.deepEqual(b.said, ["no, the other one", "no, the other one"], "and what was said over it is the next turn");
});

test("quiet for a while says how to end; quiet for half a minute, or the page hidden, ends it", async () => {
  const b = browser();
  b.handlers.click();
  await b.settle();
  b.sound(4200, "room");
  assert.equal(b.note.textContent, "Tap to end");
  b.sound(26000, "room");
  assert.equal(b.conversation.state(), "off");
  assert.deepEqual(b.ended, [1]);
  const c = browser();
  c.handlers.click();
  await c.settle();
  c.hide();
  assert.equal(c.conversation.state(), "off");
});

test("on a computer the mic writes into the box; on a phone it is the conversation", () => {
  const page = read("webapp/views/index.html");
  assert.match(page, /<script src="\/conversation\.js\?v=\d+"><\/script>/);
  assert.match(page, /ClosedhandDictation\.attach\(document\.getElementById\('micBtn'\), input, document\.getElementById\('dictationNote'\),\n\s+\{ when: function \(\) \{ return !window\.talkFirst\(\); \} \}\);/);
  assert.match(page, /window\._conversation\.bind\(document\.getElementById\('talkBtn'\), document\.getElementById\('talkHint'\), \{/);
  assert.match(page, /window\._conversation\.bind\(document\.getElementById\('micBtn'\), document\.getElementById\('dictationNote'\), \{[\s\S]{0,200}when: function \(\) \{ return window\.talkFirst\(\); \}/, "carried on once the chat view opens");
  assert.match(page, /var talkHints = \{ listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking, talk to interrupt', quiet: 'Tap to end' \};/);
  assert.match(read("webapp/public/dictation.js"), /if \(!take && opts\.when && !opts\.when\(\)\) return;/);
  assert.doesNotMatch(page, /_replyAloud/, "the one-reply read-aloud is gone: a conversation speaks every reply");
});

// --- speech-playback.js talk: a reply spoken as it is written ---
function voice() {
  const sent = [];
  let started = 0, done = 0, now = 0;
  class AudioContext {
    constructor() { this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({ duration: 1 }); }
    createBufferSource() { const s = { connect() {}, disconnect() {}, start() {}, stop() { s.onended && s.onended(); }, onended: null }; voice.sources.push(s); return s; }
  }
  voice.sources = [];
  const window = { AudioContext, addEventListener() {} };
  const context = { window, navigator: {}, document: { createElement: () => ({}) }, Set, Promise, Uint8Array, atob: (s) => Buffer.from(s, "base64").toString("binary"), setTimeout, clearTimeout };
  vm.runInNewContext(read("webapp/public/speech-playback.js"), context);
  const speech = window.ClosedHandSpeech;
  speech.prime(true);
  const t = speech.talk((p) => { sent.push(p); return true; }, { onStart: () => started++, onDone: () => done++ });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const reply = (id) => speech.receive({ type: "speech_chunk", id, audio: Buffer.from("x").toString("base64") });
  const finish = (id) => speech.receive({ type: "speech_end", id });
  return { t, sent, reply, finish, settle, started: () => started, done: () => done, played: () => voice.sources };
}

test("each sentence goes to the voice as soon as it is written, one at a time, and the reply ends when all of it is said", async () => {
  const v = voice();
  v.t.add("Your 3pm with Ravi");
  assert.deepEqual(v.sent, [], "half a sentence waits");
  v.t.add(" is on Thursday. It's at");
  assert.deepEqual(v.sent.map((p) => p.text), ["Your 3pm with Ravi is on Thursday."]);
  v.t.add(" Hearth.\n[[next]]\nWant me to");
  assert.equal(v.sent.length, 1, "the next waits until the voice has made this one");
  v.reply(v.sent[0].id);
  await v.settle();
  assert.equal(v.started(), 1, "heard from the first sentence");
  v.finish(v.sent[0].id);
  assert.deepEqual(v.sent.map((p) => p.text), ["Your 3pm with Ravi is on Thursday.", "It's at Hearth."], "a follow-on break is never read out");
  v.t.add(" tell him?");
  v.t.end();
  v.reply(v.sent[1].id); v.finish(v.sent[1].id);
  await v.settle();
  assert.deepEqual(v.sent.map((p) => p.text).at(-1), "Want me to tell him?");
  v.reply(v.sent[2].id); v.finish(v.sent[2].id);
  await v.settle();
  assert.equal(v.done(), 0, "not done while it is still playing");
  v.played().forEach((s) => s.onended && s.onended());
  await v.settle();
  assert.equal(v.done(), 1);
});

test("the first words are said at their first comma, so it starts speaking sooner", async () => {
  const v = voice();
  v.t.add("Tomorrow afternoon looks clear, apart from");
  assert.deepEqual(v.sent.map((p) => p.text), ["Tomorrow afternoon looks clear,"]);
  v.t.add(" the dentist at four, which moved. Anything else?");
  v.reply(v.sent[0].id); v.finish(v.sent[0].id);
  assert.equal(v.sent.at(-1).text, "apart from the dentist at four, which moved.", "after the first, whole sentences");
});

test("talked over, the rest is not said and the voice stops making it", async () => {
  const v = voice();
  v.t.add("First. Second. Third.");
  v.t.stop();
  assert.deepEqual(JSON.parse(JSON.stringify(v.sent.at(-1))), { type: "speech_cancel", id: v.sent[0].id });
  v.t.add("Fourth.");
  assert.equal(v.sent.filter((p) => p.type === "speech").length, 1);
});

test("a spoken turn is marked, and its reply is written to be heard", () => {
  const ws = read("lib/web-chat-ws.js");
  assert.match(ws, /await handleChatMessage\(userId, text, ws, fileData, project, msg\.spoken === true\);/);
  assert.match(ws, /const opts = \{\n\s+project,\n\s+spoken,/);
  const engine = read("lib/engine.js");
  assert.match(engine, /"\\n\\n" \+ \(opts\.spoken \? SPOKEN_TURN : ANSWER_SIZE_TURN\)/, "a spoken reply's length note in place of the written one");
  assert.match(engine, /effort: deepThink \? "strong" : \(isQuick \|\| isLight \|\| opts\.spoken\) \? "fast" : "default",/, "answered without the long think first");
  assert.match(read("webapp/views/index.html"), /if \(window\.talkFirst\(\) && !document\.body\.classList\.contains\('chat-active'\)\) fetch\('\/api\/dictation\/warm\?voice=1'/, "speech to text and the voice load as a phone's home opens");
  assert.match(engine, /Answer the way you would say it: the answer first, in a few short sentences, with no lists, headings, tables, links or emoji\./);
  const page = read("webapp/views/index.html");
  assert.match(page, /if \(spoken === true\) \{\n\s+payload\.spoken = true;/);
  assert.match(page, /if \(_awaitingSpoken\) speakReply\(msg\);/);
  assert.match(page, /if \(msg\.type === 'status' && !_saidStep && !_spokenReply && msg\.content\)/, "a step it takes first is said once");
});
