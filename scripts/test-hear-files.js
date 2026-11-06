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

// What lib/video.js asked the sandbox to run: the job and the script's ARGS.
function started(code) {
  const script = Buffer.from(/b64decode\("([^"]+)"\)/.exec(code)[1], 'base64').toString();
  return { job: /in-([0-9a-f]+)/.exec(code)[1], args: JSON.parse(Buffer.from(/b64decode\("([^"]+)"\)/.exec(script)[1], 'base64').toString()) };
}
const lentFiles = require('../lib/lent-files');

test('a video file goes through the sandbox like a link: lent there, not copied, frames and what is said, then nothing is kept', async () => {
  const calls = [];
  const frame = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  const meta = { title: 'Masai Mara day 2.mp4', duration: 512, frames: [{ time: 30, offset: 0, size: 6 }, { time: 250, offset: 0, size: 6 }, { time: 490, offset: 0, size: 6 }], speech_parts: ['speech-0.pcm'], speech_seconds: 512 };
  const files = { 'meta.json': Buffer.from(JSON.stringify(meta)), 'frames.bin': frame, 'speech-0.pcm': Buffer.alloc(32000) };
  let job, args, lentWhileHeard = false;
  const sandbox = {
    ensureSandbox: async () => {},
    // No sandboxExec here: a file's hearing must not count against the
    // model's own 200 runs a day, so calling it would fail this test.
    sandboxRequest: async (userId, method, route, body) => {
      calls.push([route, body]);
      if (route === '/exec' && /Popen/.test(body.code)) { ({ job, args } = started(body.code)); return { stdout: 'started\n' }; }
      if (route === '/files/read') {
        lentWhileHeard = !!lentFiles.find(args.file.id, 'u1') && !lentFiles.find(args.file.id, 'u2');
        return { content: 'CLOSEDHAND_VIDEO ' + JSON.stringify({ ok: true, dir: `.closedhand-video/${job}`, parts: { meta: 'meta.json', frames: 'frames.bin', speech: ['speech-0.pcm'] } }) };
      }
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
    assert.equal(calls.filter(([r]) => r === '/files/write').length, 0, 'nothing is copied to the sandbox');
    assert.match(args.file.id, /^[0-9a-f]{32}$/);
    assert.deepEqual({ size: args.file.size, ext: args.file.ext, title: args.title }, { size: 18, ext: 'mp4', title: 'Masai Mara day 2.mp4' });
    assert.ok(lentWhileHeard, "lent to this person's sandbox alone while it is heard");
    assert.equal(lentFiles.find(args.file.id, 'u1'), null, 'and taken back once heard');
    const cleanup = calls.filter(([r, b]) => r === '/exec' && /rmtree/.test(b.code)).pop()[1].code;
    assert.match(cleanup, new RegExp(`\\.closedhand-video/${job}`));
    assert.match(cleanup, new RegExp(`\\.closedhand-video/in-${job}`), 'its log goes too');
  } finally { restore(); }
});

// A sandbox that answers each step; its log is what `log(n)` says on the nth read.
function standInSandbox(calls, log) {
  let job, reads = 0;
  return {
    ensureSandbox: async () => {},
    sandboxRequest: async (userId, method, route, body) => {
      calls.push([route, body]);
      if (route === '/exec' && /Popen/.test(body.code)) { job = started(body.code).job; return { stdout: 'started\n' }; }
      if (route === '/files/read') return { content: log(++reads, job) };
      return { stdout: '' };
    },
    sandboxFileDownload: async (userId, p) => ({ content: Buffer.from(p.endsWith('meta.json') ? JSON.stringify({ duration: 7200, frames: [], speech_parts: [] }) : '').toString('base64') }),
  };
}
const finished = (job) => 'CLOSEDHAND_VIDEO ' + JSON.stringify({ ok: true, dir: `.closedhand-video/${job}`, parts: { meta: 'meta.json', speech: [] } });

// The sandbox reads a lent file as a player does, jumping to the parts it
// needs (an iPhone video keeps its index at the end), over the gateway.
test('a lent file is given a part at a time, as Range asks, and only to the sandbox it is lent to', async (t) => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hear-lent-'));
  const file = path.join(dir, 'Ceremony full.mov');
  const bytes = Buffer.alloc(40000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  fs.writeFileSync(file, bytes);
  const server = require('node:http').createServer((req, res) => {
    const item = lentFiles.find(req.url.split('/').pop(), req.headers['x-user-id']);
    if (!item) { res.writeHead(404); return res.end(); }
    lentFiles.send(item, req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const onDisk = lentFiles.lend('u1', file), inMemory = lentFiles.lend('u1', bytes.subarray(0, 1000));
  t.after(() => { server.close(); lentFiles.takeBack(onDisk.id); lentFiles.takeBack(inMemory.id); fs.rmSync(dir, { recursive: true, force: true }); });
  const get = (id, range, user = 'u1') => fetch(`http://127.0.0.1:${server.address().port}/gateway/file/${id}`, { headers: { 'x-user-id': user, ...(range ? { range } : {}) } });
  const whole = await get(onDisk.id);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(bytes));
  for (const [range, from, to] of [['bytes=100-199', 100, 199], ['bytes=39990-', 39990, 39999], ['bytes=-50', 39950, 39999], ['bytes=39000-99999', 39000, 39999]]) {
    const r = await get(onDisk.id, range);
    assert.equal(r.status, 206, range);
    assert.equal(r.headers.get('content-range'), `bytes ${from}-${to}/40000`, range);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(bytes.subarray(from, to + 1)), range);
  }
  assert.equal((await get(onDisk.id, 'bytes=40000-')).status, 416);
  const part = await get(inMemory.id, 'bytes=10-19');
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10, 20)), 'bytes held in memory too');
  assert.equal((await get(onDisk.id, null, 'u2')).status, 404, "never another person's sandbox");
  lentFiles.takeBack(onDisk.id);
  assert.equal((await get(onDisk.id)).status, 404, 'nor once taken back');
  // The gateway's route, behind the sandbox's own token.
  assert.match(read('lib/gateway.js'), /router\.get\("\/file\/:id", verifySandboxToken, \(req, res\) => \{\n\s*const item = require\("\.\/lent-files"\)\.find\(req\.params\.id, req\.sandboxUserId\);/);
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
  assert.match(read('lib/services/usi.js'), /if \(texts\.length === 0\) return \[\];\n  require\("\.\.\/idle"\)\.touch\(\);/);
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
  assert.match(engine, /frames: fileData\.isVideo \? 8 : 0/, 'frames for every video: a chat model that cannot see gets them described');
  assert.match(read('lib/attachments.js'), /require\("\.\/video"\)\.hearMedia\(\{ userId, buffer, name: att\.fileName, video: read\.kind === "video" \}\)/);
  const script = read('lib/video-sandbox.py');
  assert.match(script, /def local\(file\):/);
  assert.match(script, /local\(ARGS\["file"\]\) if ARGS\.get\("file"\)/);
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

// A job cut off partway left its folders on the sandbox; on a sandbox with
// little room they filled it, and every later video then failed ("no space
// left on device"). Each job now starts by clearing what no running job uses
// and clears its own when it fails. The file itself is lent, never copied, so
// a file bigger than the sandbox's room is heard all the same; only too
// little room for its sound and frames is said.
test('the sandbox is cleared of what earlier jobs left, a failed job clears its own, and a file bigger than the room left is heard all the same', async (t) => {
  const os = require('node:os');
  const calls = [];
  let free = 50 * 1024 ** 3, failStart = false, job, args;
  const sandbox = {
    ensureSandbox: async () => {},
    sandboxRequest: async (userId, method, route, body) => {
      calls.push([route, body]);
      if (route === '/exec' && /disk_usage/.test(body.code)) return { stdout: `free ${free}\n` };
      if (route === '/exec' && /Popen/.test(body.code)) {
        if (failStart) throw new Error('HTTP 400: {"error":"ENOSPC: no space left on device, write"}');
        ({ job, args } = started(body.code));
        return { stdout: 'started\n' };
      }
      if (route === '/files/read') return { content: finished(job) };
      return { stdout: '' };
    },
    sandboxFileDownload: async (userId, p) => ({ content: Buffer.from(p.endsWith('meta.json') ? JSON.stringify({ duration: 7200, frames: [], speech_parts: [] }) : '').toString('base64') }),
  };
  const { video, restore } = withStandIns(sandbox, { transcribe: async () => SAID });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hear-room-'));
  t.after(() => { restore(); fs.rmSync(dir, { recursive: true, force: true }); });

  // A job that fails to start takes its folders with it.
  failStart = true;
  await assert.rejects(video.hearMedia({ userId: 'u1', buffer: Buffer.from('x'), name: 'Harbour walk.mp4', video: true }), /ENOSPC/);
  const failed = /keep = set\(\["([0-9a-f]+)"\]\)/.exec(calls.find(([r, b]) => r === '/exec' && /disk_usage/.test(b.code))[1].code)[1];
  const cleared = calls.filter(([r, b]) => r === '/exec' && /rmtree/.test(b.code) && !/disk_usage/.test(b.code)).pop()[1].code;
  assert.match(cleared, new RegExp(`\\.closedhand-video/in-${failed}"`), 'its folders go');

  // A 6 GB video on a sandbox with 4 GB free is heard, read where it is.
  calls.length = 0; failStart = false; free = 4 * 1024 ** 3;
  const big = path.join(dir, 'Ceremony 4K.mov');
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, 6 * 1024 ** 3); // sparse: nothing is written
  await video.hearMedia({ userId: 'u1', file: big, name: 'Ceremony 4K.mov', video: true });
  assert.equal(args.file.size, 6 * 1024 ** 3);
  assert.equal(calls.filter(([r]) => r === '/files/write').length, 0, 'nothing is copied');
  assert.equal(lentFiles.find(args.file.id, 'u1'), null, 'and it is taken back');

  // Too little room for what the script makes of it is said before it starts.
  calls.length = 0; free = 300 * 1024 ** 2;
  await assert.rejects(video.hearMedia({ userId: 'u1', file: big, name: 'Ceremony 4K.mov', video: true }),
    (e) => e.userFacing && e.message === "There isn't enough room left on Closedhand's sandbox computer to hear this file.");
  assert.equal(calls.filter(([r, b]) => r === '/exec' && /Popen/.test(b.code)).length, 0, 'nothing is started');

  // The sweep itself, run as the sandbox runs it: leftovers go, a running job's folders stay.
  const sweep = calls.find(([r, b]) => r === '/exec' && /disk_usage/.test(b.code))[1].code;
  const running = /keep = set\(\["([0-9a-f]+)"\]\)/.exec(sweep)[1];
  const box = fs.mkdtempSync(path.join(dir, 'box-'));
  for (const d of [`in-${running}`, running, 'in-0123456789ab', '0123456789ab', 'in-ba9876543210']) fs.mkdirSync(path.join(box, '.closedhand-video', d), { recursive: true });
  fs.writeFileSync(path.join(box, '.closedhand-video', 'in-ba9876543210', 'file.mov.part00000'), 'x');
  const ran = require('node:child_process').spawnSync('python3', ['-c', sweep], { cwd: box, encoding: 'utf8' });
  if (ran.error) return t.diagnostic('python3 is not here, so the sweep was not run');
  assert.match(ran.stdout, /^free \d+/);
  assert.deepEqual(fs.readdirSync(path.join(box, '.closedhand-video')).sort(), [running, `in-${running}`].sort());
});
