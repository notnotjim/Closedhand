// Recordings and videos, sent in a chat or found by File Search, are heard on
// the computer running Closedhand: what's said with its times, and a video's
// frames. Invented clips and stand-in services only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const SAID = { language: 'en', lines: [{ start: 0, text: 'Welcome back to the long run.' }, { start: 475, text: 'Today we talk about sleep.' }], text: '' };

// lib/video.js with the sandbox and the speech to text stood in.
function withStandIns(sandbox, listen) {
  const sPath = require.resolve('../lib/sandbox'), lPath = require.resolve('../lib/services/listen'), vPath = require.resolve('../lib/video');
  const saved = { s: require.cache[sPath], l: require.cache[lPath] };
  require.cache[sPath] = { id: sPath, filename: sPath, loaded: true, exports: sandbox };
  require.cache[lPath] = { id: lPath, filename: lPath, loaded: true, exports: { ...listen, wavSamples: () => new Float32Array(16000 * 9) } };
  delete require.cache[vPath];
  const video = require('../lib/video');
  return { video, restore() { for (const [p, m] of [[sPath, saved.s], [lPath, saved.l]]) { if (m) require.cache[p] = m; else delete require.cache[p]; } delete require.cache[vPath]; } };
}

test('a video file goes through the sandbox like a link: frames and what is said, then nothing is kept', async () => {
  const calls = [];
  const frame = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  const meta = { title: 'Masai Mara day 2.mp4', duration: 512, frames: [{ time: 30, offset: 0, size: 6 }, { time: 250, offset: 0, size: 6 }, { time: 490, offset: 0, size: 6 }], speech_parts: ['speech-0.pcm'], speech_seconds: 512 };
  const files = { 'meta.json': Buffer.from(JSON.stringify(meta)), 'frames.bin': frame, 'speech-0.pcm': Buffer.alloc(32000) };
  let job;
  const sandbox = {
    ensureSandbox: async () => {},
    // No sandboxExec here: a file's hearing must not count against the
    // model's own 200 runs a day, so calling it would fail this test.
    sandboxRequest: async (userId, method, route, body) => {
      calls.push([route, body]);
      if (route === '/files/write') { job = /in-([0-9a-f]+)\//.exec(body.path)[1]; return { success: true }; }
      if (route === '/exec' && /Popen/.test(body.code)) return { stdout: 'started\n' };
      if (route === '/files/read') return { content: 'CLOSEDHAND_VIDEO ' + JSON.stringify({ ok: true, dir: `.closedhand-video/${job}`, parts: { meta: 'meta.json', frames: 'frames.bin', speech: ['speech-0.pcm'] } }) };
      return { stdout: '' };
    },
    sandboxFileDownload: async (userId, p) => ({ content: files[p.split('/').pop()].toString('base64') }),
  };
  const { video, restore } = withStandIns(sandbox, { transcribe: async () => SAID });
  try {
    const heard = await video.hearMedia({ userId: 'u1', buffer: Buffer.from('not really a video'), name: 'Masai Mara day 2.mp4', video: true, frames: 2 });
    assert.deepEqual(heard.said.lines, SAID.lines);
    assert.equal(heard.duration, 512);
    assert.deepEqual(heard.frames.map((f) => f.time), [30, 490], 'frames spread across the video');
    const write = calls.find(([r]) => r === '/files/write');
    assert.match(write[1].path, /^\.closedhand-video\/in-[0-9a-f]{12}\/file\.mp4$/, 'stored under its own name, never the one sent');
    assert.equal(write[1].encoding, 'base64');
    const started = calls.find(([r, b]) => r === '/exec' && /Popen/.test(b.code))[1].code;
    const script = Buffer.from(/b64decode\("([^"]+)"\)/.exec(started)[1], 'base64').toString();
    const args = JSON.parse(Buffer.from(/b64decode\("([^"]+)"\)/.exec(script)[1], 'base64').toString());
    assert.deepEqual({ path: args.path, title: args.title }, { path: write[1].path, title: 'Masai Mara day 2.mp4' });
    const cleanup = calls.filter(([r, b]) => r === '/exec' && /rmtree/.test(b.code)).pop()[1].code;
    assert.match(cleanup, new RegExp(`\\.closedhand-video/${job}`));
    assert.match(cleanup, new RegExp(`\\.closedhand-video/in-${job}`), 'the copy put on the sandbox goes too');
  } finally { restore(); }
});

// A sandbox that answers each step; its log is what `log(n)` says on the nth read.
function standInSandbox(calls, log) {
  let job, reads = 0;
  return {
    ensureSandbox: async () => {},
    sandboxRequest: async (userId, method, route, body) => {
      calls.push([route, body]);
      if (route === '/files/write') { job = /in-([0-9a-f]+)\//.exec(body.path)[1]; return { success: true }; }
      if (route === '/exec' && /Popen/.test(body.code)) return { stdout: 'started\n' };
      if (route === '/exec' && /print\("joined"\)/.test(body.code)) return { stdout: 'joined\n' };
      if (route === '/files/read') return { content: log(++reads, job) };
      return { stdout: '' };
    },
    sandboxFileDownload: async (userId, p) => ({ content: Buffer.from(p.endsWith('meta.json') ? JSON.stringify({ duration: 7200, frames: [], speech_parts: [] }) : '').toString('base64') }),
  };
}
const finished = (job) => 'CLOSEDHAND_VIDEO ' + JSON.stringify({ ok: true, dir: `.closedhand-video/${job}`, parts: { meta: 'meta.json', speech: [] } });

test('a large file on disk goes over in parts, read from disk one at a time, and is put together there', async () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hear-test-'));
  const file = path.join(dir, 'Ceremony full.mov');
  const MB = 1024 * 1024;
  const bytes = Buffer.alloc(40 * MB);
  for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) % 251;
  fs.writeFileSync(file, bytes);
  const calls = [];
  const { video, restore } = withStandIns(standInSandbox(calls, (n, job) => finished(job)), { transcribe: async () => SAID });
  try {
    await video.hearMedia({ userId: 'u1', file, name: 'Ceremony full.mov', video: true });
    const writes = calls.filter(([r]) => r === '/files/write').map(([, b]) => b);
    assert.deepEqual(writes.map((w) => w.path.replace(/in-[0-9a-f]+/, 'in-JOB')), ['.closedhand-video/in-JOB/file.mov.part00000', '.closedhand-video/in-JOB/file.mov.part00001', '.closedhand-video/in-JOB/file.mov.part00002']);
    assert.deepEqual(writes.map((w) => Buffer.from(w.content, 'base64').length), [16 * MB, 16 * MB, 8 * MB]);
    assert.ok(Buffer.concat(writes.map((w) => Buffer.from(w.content, 'base64'))).equals(bytes), 'the parts are the file');
    const join = calls.find(([r, b]) => r === '/exec' && /print\("joined"\)/.test(b.code))[1].code;
    assert.match(join, /with open\("\.closedhand-video\/in-[0-9a-f]+\/file\.mov", "wb"\) as out:/);
    assert.ok(calls.findIndex(([r, b]) => r === '/exec' && /joined/.test(b.code)) < calls.findIndex(([r, b]) => r === '/exec' && /Popen/.test(b.code)), 'joined before it is heard');
  } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a long recording is waited for while the sandbox is still writing it out, and not once it has gone quiet', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const run = async (log) => {
    const { video, restore } = withStandIns(standInSandbox([], log), { transcribe: async () => SAID });
    const out = video.hearMedia({ userId: 'u1', buffer: Buffer.from('a long talk'), name: 'Talk.m4a', video: true }).then((r) => ({ r }), (e) => ({ e }));
    let settled = null;
    out.then((v) => { settled = v; });
    for (let i = 0; i < 3000 && !settled; i++) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(2000); }
    // On a Mac the Mac's own converter is tried after the sandbox, in real time.
    const done = settled || await out;
    restore();
    return done;
  };
  // Writing out for 70 minutes, a part every few reads, then done.
  const long = await run((n, job) => n > 2100 ? finished(job) : 'CLOSEDHAND_PROGRESS speech\n'.repeat(Math.ceil(n / 3)));
  assert.ok(long && long.r, 'heard, past the half hour that was once the most');
  // Two parts, then nothing more.
  const stuck = await run(() => 'CLOSEDHAND_PROGRESS speech\n'.repeat(2));
  assert.equal(stuck && stuck.e && stuck.e.message, 'hearing stopped partway: nothing new for ten minutes', 'kept as what happened, not said as a sandbox that is off');
  assert.ok(!stuck.e.userFacing, 'and said to the person in the words every failure uses');
});

test('a sandbox that fails says so in plain words', async () => {
  const sandbox = { ensureSandbox: async () => { throw new Error('connect ECONNREFUSED'); }, sandboxRequest: async () => ({}) };
  const { video, restore } = withStandIns(sandbox, { transcribe: async () => SAID });
  try {
    if (process.platform === 'darwin') return; // a Mac hears the sound itself instead
    await assert.rejects(video.hearMedia({ userId: 'u1', buffer: Buffer.from('x'), name: 'memo.m4a' }), /hears recordings and videos with its sandbox computer/);
  } finally { restore(); }
});

test('a recording on a Mac is heard by the Mac itself, with no sandbox', { skip: process.platform !== 'darwin' && 'the Mac way needs afconvert' }, async () => {
  const sandbox = { ensureSandbox: async () => { throw new Error('the sandbox is not used here'); } };
  const { video, restore } = withStandIns(sandbox, { transcribe: async (samples) => ({ ...SAID, heardSeconds: samples.length / 16000 }) });
  try {
    // A real AIFF that afconvert reads: a second of quiet.
    const pcm = Buffer.alloc(16000 * 2);
    const aiff = Buffer.concat([Buffer.from('FORM'), Buffer.from([0, 0, 0, 0]), Buffer.from('AIFFCOMM'), Buffer.from([0, 0, 0, 18, 0, 1, 0, 0, 0x3e, 0x80, 0, 16, 0x40, 0x0c, 0xfa, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('SSND'), Buffer.alloc(4), Buffer.alloc(8), pcm]);
    aiff.writeUInt32BE(aiff.length - 8, 4); aiff.writeUInt32BE(pcm.length + 8, 42); // the FORM and SSND sizes
    const heard = await video.hearMedia({ userId: 'u1', buffer: aiff, name: 'quiet.aiff' });
    assert.deepEqual(heard.said.lines, SAID.lines);
  } finally { restore(); }
});

test('the bot hears files for File Search from disk, written as they arrive, one at a time, and says when it is idle', async () => {
  const { Readable } = require('node:stream');
  const routes = {};
  const app = { post: (route, fn) => { routes['POST ' + route] = fn; }, get: (route, fn) => { routes['GET ' + route] = fn; } };
  const heard = [];
  let at = 0, most = 0;
  const idle = { ...require('../lib/idle'), isIdle: () => true };
  require('../lib/hear-route').register(app, {
    verifyToken: (t) => (t === 'good' ? 'u1' : null), idle,
    hear: async (args) => {
      at++; most = Math.max(most, at);
      heard.push({ name: args.name, video: args.video, frames: args.frames, bytes: fs.readFileSync(args.file).length, buffer: args.buffer });
      await new Promise((r) => setTimeout(r, 20));
      at--;
      return { said: SAID, duration: 3600, frames: [] };
    },
  });
  const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const req = (token, chunks, query) => Object.assign(Readable.from(chunks), { get: () => token, query });
  const MB = 1024 * 1024;
  const [a, b] = [res(), res()];
  await Promise.all([
    routes['POST /internal/hear'](req('good', [Buffer.alloc(3 * MB, 1), Buffer.alloc(3 * MB, 2)], { name: 'Long Run Ep 14.mp3' }), a),
    routes['POST /internal/hear'](req('good', [Buffer.from('a short one')], { name: 'Memo.m4a' }), b),
  ]);
  assert.equal(a.body.text, '[0:00] Welcome back to the long run.\n[7:55] Today we talk about sleep.');
  assert.deepEqual(heard.map((h) => [h.name, h.bytes, h.video, h.frames, h.buffer]).sort(), [['Long Run Ep 14.mp3', 6 * MB, false, 0, undefined], ['Memo.m4a', 11, false, 0, undefined]], 'heard from the file on disk, not held');
  assert.equal(most, 1, 'one at a time');
  const left = fs.readdirSync(require('node:os').tmpdir()).filter((f) => f.startsWith('closedhand-file-'));
  assert.deepEqual(left.filter((d) => fs.readdirSync(path.join(require('node:os').tmpdir(), d)).some((f) => /\.(mp3|m4a)$/.test(f))), [], 'its copy is removed');
  const denied = res();
  await routes['POST /internal/hear'](req('forged', [Buffer.from('x')], {}), denied);
  assert.equal(denied.code, 401);
  const asked = res();
  routes['GET /internal/idle']({ get: () => 'good' }, asked);
  assert.deepEqual(asked.body, { idle: true });
  const strangers = res();
  routes['GET /internal/idle']({ get: () => 'forged' }, strangers);
  assert.equal(strangers.code, 401);
});

test('idle is nothing running and nothing for two minutes; long hearings wait their turn', async () => {
  const id = require.resolve('../lib/idle');
  delete require.cache[id];
  const idle = require('../lib/idle');
  const t0 = Date.now();
  assert.equal(idle.isIdle(t0), true, 'at start');
  let release;
  const job = idle.during(() => new Promise((r) => { release = r; }));
  assert.equal(idle.isIdle(t0 + 10 * 60000), false, 'while a job runs');
  release();
  await job;
  const ended = Date.now();
  assert.equal(idle.isIdle(ended + 60000), false, 'a minute after');
  assert.equal(idle.isIdle(ended + idle.QUIET_MS), true, 'two minutes after');
  idle.touch();
  assert.equal(idle.isIdle(Date.now() + 1000), false, 'an LLM call or an embedding just now');
  const ran = [];
  await Promise.all([1, 2, 3].map((n) => idle.oneAtATime(async () => { ran.push('start ' + n); await new Promise((r) => setTimeout(r, 5)); ran.push('end ' + n); if (n === 2) throw new Error('one fails'); }).catch(() => {})));
  assert.deepEqual(ran, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'], 'in turn, and a failure does not stop the next');
  delete require.cache[id];
});

test('chat turns, syncs, indexing, File Search and LLM calls count as Closedhand being busy', () => {
  assert.match(read('lib/user-mutex.js'), /runWithInheritedContext\(\(\) => require\("\.\/idle"\)\.during\(fn\)\)/);
  assert.match(read('lib/services/usi.js'), /return require\("\.\.\/idle"\)\.during\(\(\) => postSyncIndexPass\(userId\)\);/);
  assert.match(read('lib/services/usi.js'), /if \(!hasEmbedConfig\(\) \|\| texts\.length === 0\) return \[\];\n  require\("\.\.\/idle"\)\.touch\(\);/);
  assert.match(read('lib/services/data-sync.js'), /return require\("\.\.\/idle"\)\.during\(\(\) => syncUserDataNow\(userId, mode\)\);/);
  assert.match(read('lib/services/mail-history.js'), /return require\("\.\.\/idle"\)\.during\(\(\) => readAccount\(args\)\);/);
  assert.match(read('lib/services/wa-digest.js'), /return require\("\.\.\/idle"\)\.during\(digestAll\);/);
  assert.match(read('lib/embed-backfill.js'), /await require\("\.\/idle"\)\.during\(\(\) => backfillOnce\(\)\);/);
  assert.match(read('lib/embed-route.js'), /require\("\.\/idle"\)\.touch\(\);/, "File Search's reading and searching");
  assert.match(read('index.js'), /require\("\.\/lib\/model-wire"\)\.onRequest\(require\("\.\/lib\/idle"\)\.touch\);/);
  assert.match(read('lib/model-wire.js'), /if \(_onRequest\) _onRequest\(\);/);
});

test('File Search, the web chat and saved files all hear recordings and videos', () => {
  const rag = read('webapp/rag-processor.js');
  for (const ext of ['mp3', 'm4a', 'wav', 'mp4', 'mov', 'webm']) assert.match(rag, new RegExp(`"${ext}"`), ext);
  assert.match(rag, /if \(read\.kind === "audio" \|\| read\.kind === "video"\) return hearFile\(/);
  assert.match(rag, /fetch\(`\$\{BOT_INTERNAL_URL\}\/internal\/hear\?\$\{query\}`/);
  assert.match(rag, /"x-closedhand-token": botToken\(userId\)/);
  assert.match(read('index.js'), /require\("\.\/lib\/hear-route"\)\.register\(ctx\.expressApp\);/);
  const engine = read('lib/engine.js');
  assert.match(engine, /\} else if \(fileData\.isAudio \|\| fileData\.isVideo\) \{\n\s*\/\/ Heard the way a video link is/);
  assert.match(engine, /frames: fileData\.isVideo && chatSeesImages \? 8 : 0/, 'frames only for a chat model that can see them');
  assert.match(read('lib/attachments.js'), /require\("\.\/video"\)\.hearMedia\(\{ userId, buffer, name: att\.fileName, video: read\.kind === "video" \}\)/);
  const script = read('lib/video-sandbox.py');
  assert.match(script, /def local\(path\):/);
  assert.match(script, /local\(ARGS\["path"\]\) if ARGS\.get\("path"\)/);
  assert.match(read('webapp/server.js'), /const \{ BOT_INTERNAL_URL, botToken \} = require\("\.\/bot-call"\);/);
});

test('every function called on the sandbox module is one it offers', () => {
  // video.js called sandboxRequest, which was never exported: hearing a file
  // failed on every Docker and Railway Closedhand, and was said as a sandbox
  // that is not running.
  const src = read('lib/sandbox.js');
  const offered = new Set(/module\.exports = \{([^}]+)\}/.exec(src)[1].split(',').map((n) => n.trim()).filter(Boolean));
  const walk = (dir) => fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(`${dir}/${e.name}`)) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []);
  const called = [];
  for (const f of [...walk('lib'), 'index.js']) {
    const code = read(f);
    if (!/require\("\.{1,2}\/(?:\.\.\/)*sandbox"\)/.test(code)) continue;
    for (const m of code.matchAll(/const \{([^}]+)\} = require\("\.{1,2}\/(?:\.\.\/)*sandbox"\)/g)) for (const n of m[1].split(',')) called.push([f, n.split(':')[0].trim()]);
    for (const m of code.matchAll(/require\("\.{1,2}\/(?:\.\.\/)*sandbox"\)\.(\w+)/g)) called.push([f, m[1]]);
    if (/const sandbox = require\("\.{1,2}\/(?:\.\.\/)*sandbox"\)/.test(code)) for (const m of code.matchAll(/\bsandbox\.(\w+)\(/g)) called.push([f, m[1]]);
    for (const m of code.matchAll(/\(s\) => s\.(sandbox\w+|ensureSandbox)\(/g)) called.push([f, m[1]]);
  }
  assert.ok(called.some(([f, n]) => f === 'lib/video.js' && n === 'sandboxRequest'), 'the check sees video.js');
  assert.deepEqual(called.filter(([, n]) => n && !offered.has(n)), []);
});

test('a sandbox that answers but fails is not said to be off', async () => {
  const sandbox = { ensureSandbox: async () => {}, sandboxRequest: async () => { throw new Error('request entity too large'); } };
  const { video, restore } = withStandIns(sandbox, { transcribe: async () => SAID });
  try {
    if (process.platform === 'darwin') return; // a Mac hears the sound itself instead
    await assert.rejects(video.hearMedia({ userId: 'u1', buffer: Buffer.from('x'), name: 'memo.m4a' }), (e) => !e.userFacing && e.message === 'request entity too large');
    // What chat, saved files and File Search then say for it.
    for (const f of ['lib/engine.js', 'lib/attachments.js']) assert.match(read(f), /heard\.error\.userFacing \? heard\.error\.message : "Closedhand couldn't hear this file just now\."/, f);
  } finally { restore(); }
});
