// Models on the person's own computer through Ollama: offered by what they
// can do, and given room to work. Ollama's model list says nothing about
// abilities and its default window is 4,096 tokens, so Closedhand asks
// Ollama what each model does and shrinks a video's frames to fit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wire = require('../lib/model-wire');
const policy = require('../lib/model-policy');

test("Ollama models are listed with the abilities Ollama reports, so image models show for images", async () => {
  const realFetch = global.fetch; const asked = [];
  global.fetch = async (url, options) => {
    if (url.endsWith('/v1/models')) return { ok: true, json: async () => ({ data: [{ id: 'local-vl:2b' }, { id: 'local-text:7b' }] }) };
    asked.push(JSON.parse(options.body).model);
    return { ok: true, json: async () => ({ capabilities: JSON.parse(options.body).model === 'local-vl:2b' ? ['completion', 'vision', 'tools'] : ['completion'] }) };
  };
  try {
    const conn = policy.connection({ provider: 'ollama', baseUrl: 'http://host.docker.internal:11434/v1' });
    const models = await wire.listModels(conn);
    const cap = (id) => policy.capabilities(conn, id, models.find((m) => m.id === id).metadata);
    assert.deepEqual(asked.sort(), ['local-text:7b', 'local-vl:2b']);
    assert.equal(cap('local-vl:2b').vision, true); assert.equal(cap('local-vl:2b').tools, true);
    assert.equal(cap('local-text:7b').vision, false); assert.equal(cap('local-text:7b').tools, false);
    assert.equal(cap('local-vl:2b').video, false, 'Ollama takes pictures, not whole video');
  } finally { global.fetch = realFetch; }
});

test("a window that is too small is recognised in Ollama's wording, with its size", async () => {
  const realFetch = global.fetch, realWarn = console.warn; console.warn = () => {};
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 400, type: 'exceed_context_size_error', n_ctx: 4096, n_prompt_tokens: 4447,
    message: 'request (4447 tokens) exceeds the available context size (4096 tokens), try increasing it' } }) });
  try {
    await assert.rejects(wire.request({ backend: 'custom', provider: 'ollama', baseUrl: 'http://host.docker.internal:11434/v1', apiKey: '' }, { model: 'local-vl:2b', messages: [{ role: 'user', content: 'hi' }] }),
      (e) => e.code === 'context_length_exceeded' && e.limit === 4096 && e.used === 4447);
  } finally { global.fetch = realFetch; console.warn = realWarn; }
});

test('frames are thinned evenly, keeping the first and last', () => {
  const { spread } = require('../lib/video');
  assert.deepEqual(spread([...Array(14).keys()], 7), [0, 2, 4, 7, 9, 11, 13]);
  assert.deepEqual(spread([...Array(14).keys()], 3), [0, 7, 13]);
  assert.deepEqual(spread([1, 2], 5), [1, 2]);
});

test('a local model gets nearly five minutes and the task stays alive while it works', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/video.js'), 'utf8');
  assert.match(src, /AbortSignal\.timeout\(isLocal\(target\.conn\) \? 290000 : 180000\)/);
  assert.match(src, /const beat = setInterval\(\(\) => progressed\(userId\), 60000\);/);
  assert.match(src, /if \(e\.code !== "context_length_exceeded"/, 'a too-small window is retried with fewer frames');
});

// The check with Ollama and the model stood in for: the model passes every
// other check, and Ollama reports the window it gives it and the model's own most.
async function checkWithOllama({ given, most, role = 'chat' }) {
  const wirePath = require.resolve('../webapp/model-wire');
  const realWire = require(wirePath), realFetch = global.fetch;
  require.cache[wirePath].exports = { ...realWire, listModels: async () => [],
    request: async (conn, params) => {
      const last = params.messages.at(-1).content;
      if (params.tools) return params.messages.length > 1 ? { content: [{ type: 'text', text: 'done' }] } : { content: [{ type: 'tool_use', id: 't', name: 'capability_check', input: { value: 4 } }] };
      if (Array.isArray(last) && last.some((b) => b.type === 'image')) return { content: [{ type: 'text', text: 'Red' }] };
      return { content: [{ type: 'text', text: 'ready' }] };
    } };
  global.fetch = async (url) => ({ json: async () => (url.endsWith('/api/ps')
    ? { models: [{ name: 'local-model', context_length: given }] }
    : { model_info: { 'arch.context_length': most } }) });
  delete require.cache[require.resolve('../webapp/model-config')];
  try {
    const { prepare } = require('../webapp/model-config');
    const ollama = { provider: 'ollama', baseUrl: 'http://host.docker.internal:11434/v1' };
    return await (role === 'chat'
      ? prepare({ primary: ollama, model: 'local-model', visionMode: 'off' }, {})
      : prepare({ primary: { provider: 'deepseek', apiKey: 'k' }, model: 'chat-model', visionMode: 'separate', vision: ollama, visionModel: 'local-model' }, {}));
  } finally { require.cache[wirePath].exports = realWire; global.fetch = realFetch; delete require.cache[require.resolve('../webapp/model-config')]; }
}

test("the check fails an Ollama chat model whose window can't hold Closedhand's instructions, and says how to fix it", async () => {
  await assert.rejects(checkWithOllama({ given: 4096, most: 40960 }), /Ollama gives local-model a window of 4,096 tokens[\s\S]*Set Ollama's context length to at least 32,000/);
  await assert.rejects(checkWithOllama({ given: 8192, most: 8192 }), /local-model can take at most 8,192 tokens[\s\S]*Choose a model in Ollama that takes at least 32,000/);
  const ok = await checkWithOllama({ given: 32768, most: 40960 });
  assert.equal(ok.roles.chat.capabilities.contextWindow, 32768, 'the real window, so long conversations are trimmed to fit');
});

test('an Ollama image model with a small window still passes, with its window recorded for the panel', async () => {
  const cfg = await checkWithOllama({ given: 4096, most: 262144, role: 'vision' });
  assert.equal(cfg.roles.vision.capabilities.contextWindow, 4096);
  assert.match(fs.readFileSync(path.join(__dirname, '../webapp/public/model-settings.js'), 'utf8'), /Ollama gives it " \+ w\.toLocaleString\("en-US"\) \+ " tokens, so only a few frames fit; raise its context length for more"/);
});

// Pictures made on the person's own computer (lib/image-generation.js), with
// stand-ins for the downloads, the database and the program itself.
function loadImageMaking({ platform = 'darwin', arch = 'arm64', memoryGb = 16 } = {}) {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'images-'));
  const conf = {}, said = [], have = new Set();
  const stub = (rel, exports) => { const id = require.resolve(path.join('..', rel)); require.cache[id] = { id, filename: id, loaded: true, exports }; };
  stub('lib/local-models', { MODELS_DIR: dir });
  stub('lib/config', { getConf: async (k) => conf[k], setConf: async (o) => { Object.assign(conf, JSON.parse(JSON.stringify(o))); } });
  stub('lib/model-files', {
    missing: (d, model, set) => set.filter((f) => !have.has(model.repo + '/' + f.path)),
    ensureFiles: async (d, model, set, onProgress) => { for (const f of set) { if (have.has(model.repo + '/' + f.path)) continue; onProgress({ file: f.path, loaded: f.size, total: f.size }); have.add(model.repo + '/' + f.path); } },
  });
  stub('lib/admin', { ensureAdmin: async () => 'u1' });
  stub('user-store', { UserStore: { load: async () => ({}) } });
  stub('lib/db', { supabase: { from: () => ({ select: () => ({ eq: async () => ({ data: [{ platform: 'web', platform_user_id: 'u1' }] }) }) }) } });
  stub('lib/proactive', { deliverUnprompted: async (u, s, links, textFor) => { said.push(await textFor(links[0])); return true; } });
  stub('lib/idle', { during: (fn) => fn() });
  const id = require.resolve('../lib/image-generation');
  delete require.cache[id];
  const im = require('../lib/image-generation');
  const real = { platform: process.platform, arch: process.arch, totalmem: os.totalmem };
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  os.totalmem = () => memoryGb * 2 ** 30;
  const restore = () => {
    Object.defineProperty(process, 'platform', { value: real.platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: real.arch, configurable: true });
    os.totalmem = real.totalmem;
    for (const rel of ['lib/local-models', 'lib/config', 'lib/model-files', 'lib/admin', 'user-store', 'lib/db', 'lib/proactive', 'lib/idle', 'lib/image-generation']) delete require.cache[require.resolve(path.join('..', rel))];
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { im, conf, said, dir, restore };
}

test('image generation is offered on a Mac that can run it, at a size its memory suits, and says what it needs elsewhere', () => {
  const { im, restore } = loadImageMaking();
  try {
    assert.deepEqual(im.eligibility({ platform: 'darwin', arch: 'arm64', memoryGb: 16 }), { eligible: true, needs: null });
    assert.deepEqual(im.eligibility({ platform: 'darwin', arch: 'arm64', memoryGb: 8 }), { eligible: true, needs: null }, 'an 8 GB Mac too');
    assert.deepEqual(im.eligibility({ platform: 'darwin', arch: 'arm64', memoryGb: 4 }), { eligible: false, needs: 'Image generation needs a Mac with Apple silicon and 8 GB of memory or more. This Mac has 4 GB.' });
    assert.deepEqual([im.sizeFor('square', 8), im.sizeFor('landscape', 8), im.sizeFor('square', 16), im.sizeFor('portrait', 32)], [[512, 512], [512, 384], [1024, 1024], [768, 1024]], 'half size under 16 GB');
    assert.equal(im.eligibility({ platform: 'linux', arch: 'x64', memoryGb: 64 }).eligible, false, 'a server with no Apple graphics');
    assert.equal(im.eligibility({ platform: 'darwin', arch: 'x64', memoryGb: 32 }).eligible, false, 'an Intel Mac');
    const all = im.PARTS.flatMap((p) => p.files);
    assert.ok(all.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 0), 'every file pinned and checked');
    assert.equal(Math.round(im.TOTAL_BYTES / 1e9 * 10) / 10, 5.2);
  } finally { restore(); }
});

test('turned on, it downloads in the background with how far it has got, then says once in chat that it is ready', async () => {
  const { im, conf, said, dir, restore } = loadImageMaking();
  try {
    const bin = path.join(dir, 'image-generation', im.PARTS[0].repo, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'sd-cli'), '');
    await im.boot();
    assert.equal(conf.LOCAL_MODELS_STATUS.images.state, 'off');
    assert.equal(conf.LOCAL_MODELS_STATUS.images.total_gb, 5.2);
    await im.turnOn();
    const status = conf.LOCAL_MODELS_STATUS.images;
    assert.deepEqual([status.state, status.pct, status.wanted], ['ready', 100, true]);
    assert.equal(im.ready(), true);
    assert.deepEqual(said, ["Image generation is ready. I generate images right here on this computer, with nothing sent anywhere: describe one and I'll make it."]);
  } finally { restore(); }
});

test('an image is generated by the program on this computer from the pinned model files, one at a time', async () => {
  const { im, dir, restore } = loadImageMaking();
  try {
    const bin = path.join(dir, 'image-generation', im.PARTS[0].repo, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const log = path.join(dir, 'args.txt');
    fs.writeFileSync(path.join(bin, 'sd-cli'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then printf 'PNGDATA' > "$2"; fi; shift; done\n`, { mode: 0o755 });
    await im.turnOn();
    const png = await im.generate('A red kettle on a windowsill', { width: 1000, height: 700, seed: 7 });
    assert.equal(png.toString(), 'PNGDATA');
    const args = fs.readFileSync(log, 'utf8').trim().split('\n');
    const after = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(after('-p'), 'A red kettle on a windowsill');
    assert.deepEqual([after('-W'), after('-H'), after('--steps'), after('--cfg-scale'), after('-s')], ['1008', '704', '4', '1.0', '7'], 'sizes in steps of 16, four steps as the distilled model takes');
    assert.match(after('--diffusion-model'), /FLUX\.2-klein-4B-GGUF\/flux-2-klein-4b-Q4_0\.gguf$/);
    assert.match(after('--llm'), /Qwen3-4B-Q4_K_M\.gguf$/);
    assert.match(after('--vae'), /vae\/diffusion_pytorch_model\.safetensors$/);
    assert.ok(args.includes('--mmap'), 'the model mapped, not copied into memory');
  } finally { restore(); }
});

test('the switch refuses a computer that cannot generate images, saying why', async () => {
  const { im, restore } = loadImageMaking({ platform: 'linux', arch: 'x64', memoryGb: 64 });
  try {
    let handler;
    im.register({ post: (route, fn) => { handler = fn; } }, { verifyToken: () => true });
    let code = 200, body;
    await handler({ get: () => 't', body: { on: true } }, { status: (c) => { code = c; return { json: (b) => { body = b; } }; }, json: (b) => { body = b; } });
    assert.equal(code, 409);
    assert.match(body.error, /^Image generation needs a Mac with Apple silicon/);
  } finally { restore(); }
});

test('the tool is offered only once the model is ready, sends the picture to the chat, and Settings shows each state', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('lib/engine.js'), /if \(g === "images" && !require\("\.\/image-generation"\)\.ready\(\)\) return false;/);
  const def = require('../lib/tools/definitions').INTERNAL_TOOLS.find((t) => t.name === 'generate_image');
  assert.deepEqual(def.groups, ['images']);
  assert.ok(!def.core, 'listed, not carried in full on every message');
  assert.match(read('lib/tools/handlers.js'), /const png = await require\("\.\.\/image-generation"\)\.generate\(toolInput\.prompt, \{ shape: toolInput\.shape \}\);\n\s*await sendDocument\(chatId, png, "image\.png", "image\/png"\);/);
  const dash = read('webapp/views/dashboard.html');
  assert.match(dash, /<h2>Image generation<\/h2>/);
  assert.match(dash, /if \(!im\.eligible\) \{\n\s*body\.innerHTML = '<p>' \+ escHtml\(im\.needs \|\| ''\) \+ '<\/p><div class="images-ways"><button type="button" class="conn-btn conn-btn-manage" disabled>Turn on<\/button><\/div>';/, 'greyed out, saying what it needs');
  assert.match(dash, /Turn off and remove the download\? You can turn it on again later\./, 'asks before removing');
  assert.match(read('webapp/server.js'), /app\.post\("\/api\/images", async \(req, res\) => \{/);
  assert.match(read('lib/model-files.js'), /fetchImpl\(f\.url \|\| `https:\/\/huggingface\.co\//, 'a program from its own address');
});

// The vision language model (VLM): Closedhand always sees a picture, whether or not an
// image model is chosen, by Florence-2 on the computer running it.
// usi.js loads the database client, which these tests don't use (and CI's
// check job doesn't install). Set up in each test: the image generation
// tests above clear these from the cache when they finish.
const stubOnce = (rel, exports) => { const id = require.resolve(path.join('..', rel)); if (!require.cache[id]) require.cache[id] = { id, filename: id, loaded: true, exports }; };
const noDatabase = () => { stubOnce('user-store', { supabase: {}, UserStore: { load: async () => ({}) } }); stubOnce('lib/db', { supabase: {} }); };
const withVlm = async (describe, fn) => {
  const lm = require('../lib/local-models'), fr = require('../lib/file-reader');
  const [realSee, realOcr] = [lm.localDescribeImage, fr.ocrImage];
  lm.localDescribeImage = describe; fr.ocrImage = async () => 'TOTAL 12.50';
  try { return await fn(); } finally { lm.localDescribeImage = realSee; fr.ocrImage = realOcr; }
};
const asPerson = (fn) => {
  const context = require('../lib/context');
  return context.runWithInheritedContext(() => { context.activeUserStore = { profile: { settings: { model_config: { roles: { vision: null }, connections: {} } } } }; return fn(); });
};

test('with no image model chosen, a picture is described by the VLM with its words, and indexing waits behind people', async () => {
  noDatabase();
  const usi = require('../lib/services/usi');
  const asked = [];
  const pic = [{ mediaType: 'image/jpeg', base64: Buffer.from('a picture').toString('base64') }];
  await withVlm(async (bytes, { urgent }) => { asked.push([String(bytes), urgent]); return 'A receipt on a wooden table.'; }, () => asPerson(async () => {
    assert.equal(await usi.describeImages(pic, { detailed: true }), 'A receipt on a wooden table.\nWords in it: TOTAL 12.50', 'a chat photo: what it shows and its words');
    assert.equal(await usi.describeImages(pic, { detailed: true, background: true, wordsRead: true }), 'A receipt on a wooden table.', 'indexing has read its words already');
    assert.equal(await usi.describeImages([pic[0], pic[0]]), '1. A receipt on a wooden table.\n\n2. A receipt on a wooden table.', 'several are numbered, and a brief label leaves the words out');
  }));
  assert.deepEqual(asked.slice(0, 2), [['a picture', true], ['a picture', false]]);
});

test('a chat model that cannot see gets what the VLM sees where no image model is chosen, never "off"', async () => {
  noDatabase();
  const { substituteImages } = require('../lib/model-images');
  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('a screenshot').toString('base64') } };
  const out = await withVlm(async () => 'A browser window showing a sign-in page.', () =>
    substituteImages([{ role: 'user', content: [block, { type: 'text', text: 'what is this?' }] }], null, 'u-reader-test'));
  assert.equal(out[0].content[0].text, '[Description from the vision language model on this computer]\nA browser window showing a sign-in page.\nWords in it: TOTAL 12.50');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../lib/model-images.js'), 'utf8'), /understanding is off/i);
});

test('the bot describes a picture for File Search by the VLM, for the web app only', async () => {
  const { Readable } = require('node:stream');
  const routes = {};
  require('../lib/hear-route').register({ post: (r, fn) => { routes[r] = fn; }, get: () => {} }, {
    verifyToken: (t) => (t === 'good' ? 'u1' : null), describe: async (bytes) => `seen ${bytes.length} bytes`,
  });
  const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const req = (token, chunks) => Object.assign(Readable.from(chunks), { get: () => token });
  const ok = res(); await routes['/internal/describe-image'](req('good', [Buffer.from('abc'), Buffer.from('de')]), ok);
  assert.deepEqual(ok.body, { text: 'seen 5 bytes' });
  const denied = res(); await routes['/internal/describe-image'](req('forged', [Buffer.from('x')]), denied);
  assert.equal(denied.code, 401);
});

test('the VLM is pinned and checked, fetched in the background at start, and shows in the Getting to know you line', () => {
  const { FLORENCE_2 } = require('../lib/local-models');
  assert.match(FLORENCE_2.revision, /^[0-9a-f]{40}$/);
  for (const f of FLORENCE_2.files) { assert.ok(f.size > 0, f.path); assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path); }
  assert.ok(FLORENCE_2.files.some((f) => f.path === 'onnx/decoder_model_merged_q4.onnx'));
  const src = fs.readFileSync(path.join(__dirname, '../lib/local-models.js'), 'utf8');
  assert.match(src, /ensureVlm\(\)\.catch/, 'fetched at start, not on first need');
  assert.match(src, /fetchInBackground\("media", spec/, "the embedder's picture and sound parts follow its text part");
  const dash = fs.readFileSync(path.join(__dirname, '../webapp/views/dashboard.html'), 'utf8');
  assert.match(dash, /\['media', 'vlm'\]\.forEach/);
});
