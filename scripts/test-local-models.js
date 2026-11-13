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
      // The DeepSeek primary model reads no pictures, so they go to the image model.
      if (Array.isArray(last) && last.some((b) => b.type === 'image')) return { content: [{ type: 'text', text: params.model === 'chat-model' ? 'I cannot see images.' : 'Red' }] };
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
    const needs = 'Image generation needs a Mac with Apple silicon and 8 GB of memory or more, or an NVIDIA graphics card with 8 GB or more.';
    assert.deepEqual(im.eligibility({ platform: 'darwin', arch: 'arm64', memoryGb: 4 }), { eligible: false, needs: needs + ' This Mac has 4 GB.' });
    // Docker with an NVIDIA card handed in (docker-compose.gpu.yml) and the program built into the image.
    assert.deepEqual(im.eligibility({ platform: 'linux', arch: 'x64', gpu: { name: 'RTX 4000', vramGb: 16 }, builtIn: true }), { eligible: true, needs: null });
    assert.deepEqual(im.eligibility({ platform: 'linux', arch: 'x64', gpu: { name: 'GTX 1060', vramGb: 6 }, builtIn: true }), { eligible: false, needs: needs + " This computer's GTX 1060 has 6 GB." });
    assert.deepEqual(im.eligibility({ platform: 'linux', arch: 'x64', gpu: null, builtIn: true }), { eligible: false, needs }, 'no card handed in');
    assert.equal(im.eligibility({ platform: 'linux', arch: 'arm64', gpu: { name: 'RTX 4000', vramGb: 16 }, builtIn: false }).eligible, false, 'no program in this image');
    assert.deepEqual([im.sizeFor('square', 10, 12), im.sizeFor('square', 16, 12)], [[512, 512], [1024, 1024]], 'a card under 12 GB takes half size');
    assert.deepEqual([im.sizeFor('square', 8), im.sizeFor('landscape', 8), im.sizeFor('square', 16), im.sizeFor('portrait', 32)], [[512, 512], [512, 384], [1024, 1024], [768, 1024]], 'half size under 16 GB');
    assert.equal(im.eligibility({ platform: 'linux', arch: 'x64', memoryGb: 64, gpu: null }).eligible, false, 'a server with no graphics card');
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

test('the tool is always offered and says why it cannot run here, sends the picture to the chat when it can, and Settings shows each state', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  // Offered whatever the computer: asked for a picture without it, Closedhand
  // made one through a free website, with the description and its watermark.
  assert.doesNotMatch(read('lib/engine.js'), /g === "images"/);
  const im = require('../lib/image-generation');
  assert.match(im.unavailable({ eligible: false, needs: 'Image generation needs a Mac with Apple silicon.' }), /^Image generation needs a Mac with Apple silicon\.$/);
  assert.match(im.unavailable({ eligible: true, state: 'off' }), /turned on in Settings, under Image generation/);
  assert.match(im.unavailable({ eligible: true, state: 'downloading', pct: 42 }), /still downloading .*\(42%\)/);
  assert.equal(im.unavailable({ state: 'ready' }), null);
  // A service the person connected themselves makes it first, as a job of its
  // own; otherwise the reason, and no other way.
  assert.doesNotMatch(read('lib/tools/handlers.js'), /IMAGE_SERVICE/, 'a connected image service is a job of its own (test-connection-jobs.js)');
  assert.match(read('lib/tools/handlers.js'), /return \{ error: `\$\{e\.message\} Tell the person this in one sentence\$\{e\.offer \? " and add nothing to it" : ""\}, and make the picture no other way\.`, \.\.\.\(e\.offer \? \{ _imageOffer: true, \.\.\.\(e\.provider \? \{ _imageProvider: e\.provider\.provider \} : \{\}\), \.\.\.\(e\.editing \? \{ _imageEdit: true \} : \{\}\) \} : \{\}\) \};/);
  const def = require('../lib/tools/definitions').INTERNAL_TOOLS.find((t) => t.name === 'generate_image');
  assert.deepEqual(def.groups, ['images']);
  assert.ok(!def.core, 'listed, not carried in full on every message');
  assert.match(read('lib/tools/handlers.js'), /const pic = await require\("\.\.\/image-generation"\)\.picture\(toolInput\.prompt, \{ shape: toolInput\.shape, settings, useProvider: toolInput\.use_provider === true, edit \}\);/);
  assert.match(read('lib/tools/handlers.js'), /await sendDocument\(chatId, pic\.bytes, pic\.name, pic\.mime, \{ attachmentId: pictureId \}\);/);
  const dash = read('webapp/views/dashboard.html');
  assert.match(dash, /<h2>Image generation<\/h2>/);
  assert.match(dash, /if \(!im\.eligible\) \{\n\s*body\.innerHTML = '<p>' \+ escHtml\(im\.needs \|\| ''\) \+ '<\/p><div class="images-ways"><button type="button" class="conn-btn conn-btn-manage" disabled>Turn on<\/button><\/div>';/, 'greyed out, saying what it needs');
  assert.match(dash, /Turn off and remove the download\? You can turn it on again later\./, 'asks before removing');
  assert.match(read('webapp/server.js'), /app\.post\("\/api\/images", async \(req, res\) => \{/);
  assert.match(read('lib/model-files.js'), /fetchImpl\(f\.url \|\| `https:\/\/huggingface\.co\//, 'a program from its own address');
});

test('Docker hands an NVIDIA card to Closedhand only where install.sh finds one, with the GPU image that has the program built for CUDA', () => {
  const gpu = fs.readFileSync(path.join(__dirname, '../docker-compose.gpu.yml'), 'utf8');
  assert.match(gpu, /^    gpus: all$/m, 'gpus, which sits beside docker-compose.yml\'s mem_reservation where a deploy reservation can\'t');
  assert.doesNotMatch(gpu, /deploy:/);
  assert.match(gpu, /image: ghcr\.io\/notnotjim\/closedhand-bot-gpu:latest/, 'only computers with a card download it');
  assert.match(gpu, /NVIDIA_DRIVER_CAPABILITIES: compute,utility/, 'CUDA, which every NVIDIA driver runs');
  const install = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
  assert.match(install, /\{ docker info 2>\/dev\/null \| grep -qi nvidia \|\| command -v nvidia-ctk >\/dev\/null 2>&1; \}/, 'the toolkit, registered with Docker or not');
  assert.match(install, /COMPOSE_FILE=docker-compose\.yml:docker-compose\.gpu\.yml/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8'), /stable-diffusion/, 'the regular image carries none of it');
  const docker = fs.readFileSync(path.join(__dirname, '../Dockerfile.gpu'), 'utf8');
  assert.match(docker, /FROM nvidia\/cuda:12\.6\.3-devel-ubuntu22\.04 AS build/, 'a C library older than the bot image\'s');
  assert.match(docker, /-DSD_CUDA=ON -DGGML_CUDA_NCCL=OFF -DGGML_NATIVE=OFF/, 'for any x86-64 processor, without the multi-card library');
  assert.match(docker, /patchelf --set-rpath '\$ORIGIN'/, 'its CUDA libraries found beside it');
  assert.match(docker, /FROM \$\{BOT_IMAGE\}\nCOPY --from=build \/opt\/stable-diffusion \/opt\/stable-diffusion/);
  const ci = fs.readFileSync(path.join(__dirname, '../.github/workflows/build-selfhost-images.yml'), 'utf8');
  assert.match(ci, /BOT_IMAGE=ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/closedhand-bot:\$\{\{ github\.sha \}\}/, 'built on the same commit\'s bot');
  assert.equal(require('../lib/image-generation').BUILT_IN, '/opt/stable-diffusion/sd-cli');
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

test('an image model is told what a picture came with or is looked at for, and looks again for a new question', async () => {
  noDatabase();
  const wirePath = require.resolve('../lib/model-wire'), imagesPath = require.resolve('../lib/model-images');
  const real = require.cache[wirePath], sent = [];
  require.cache[wirePath] = { id: wirePath, filename: wirePath, loaded: true, exports: {
    request: async (conn, params) => { sent.push(params); return { content: [{ type: 'text', text: 'Two mugs on a shelf; the left one says HOME.' }], usage: {} }; },
    responseText: (r) => r.content[0].text } };
  delete require.cache[imagesPath];
  try {
    const { substituteImages } = require('../lib/model-images');
    const vision = { baseUrl: 'https://img.example.test/v1', apiKey: 'test-key', model: 'seer-1' };
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('a shelf').toString('base64') } };
    const asked = [{ role: 'user', content: [{ type: 'text', text: '[Closedhand context for this message, not written by the user]\nTime: 10:00' }, block, { type: 'text', text: 'what does the left mug say?' }] }];
    const out = await substituteImages(asked, vision, 'u-ask');
    assert.equal(out[0].content[1].text, '[Description from the selected image model, looking at what was asked]\nTwo mugs on a shelf; the left one says HOME.');
    assert.match(JSON.stringify(sent[0].messages[0].content), /what does the left mug say\?/, 'the question goes with the picture');
    assert.doesNotMatch(JSON.stringify(sent[0].messages), /Closedhand context|Time: 10:00/, 'Closedhand\'s own context does not');
    await substituteImages(asked, vision, 'u-ask');
    assert.equal(sent.length, 1, 'the same question is answered from what was seen');
    await substituteImages([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [block, { type: 'text', text: 'Image: a kitchen shelf' }, { type: 'text', text: 'Look for: how many mugs' }] }] }], vision, 'u-ask');
    assert.equal(sent.length, 2, 'a new question looks again');
    assert.match(JSON.stringify(sent[1].messages[0].content), /Look for: how many mugs/);
  } finally {
    if (real) require.cache[wirePath] = real; else delete require.cache[wirePath];
    delete require.cache[imagesPath];
  }
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('lib/tools/handlers.js'), /description: data\.description, \.\.\.\(toolInput\.question \? \{ question:/, 'view_attachment takes what to look for');
  assert.match(read('lib/tool-result-content.js'), /\.\.\.\(result\.question \? \[\{ type: "text", text: `Look for: \$\{result\.question\}` \}\] : \[\]\)/, 'and it rides with the picture');
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

test('a video file sent in chat always gets its frames, which a chat model that cannot see gets described', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '../lib/engine.js'), 'utf8'), /video: !!fileData\.isVideo, frames: fileData\.isVideo \? 8 : 0 \}/);
});

// Florence-2 often calls a white or pale background blue (tried on invented
// product shots: a green paddle and an orange-and-white grip on white were
// both "on a blue background"), so a search for "blue" found pictures with no
// blue in them. What it says of colours is held to the picture's own pixels.
test("a picture's description says only colours the picture has: a false background takes the edge's colour, a false colour goes", () => {
  const { keepSeenColours, namesColour } = require('../lib/picture-colours');
  const share = (o) => ({ black: 0, white: 0, grey: 0, red: 0, orange: 0, yellow: 0, green: 0, blue: 0, purple: 0, pink: 0, brown: 0, ...o });
  const grip = { whole: share({ white: 0.9, orange: 0.08, grey: 0.02 }), edge: share({ white: 0.98, grey: 0.02 }) };
  assert.equal(keepSeenColours('A blue and white object has the words Kestrel on it. There are black circles on the bottom.', grip),
    'A white object has the words Kestrel on it. There are black circles on the bottom.', 'black is easily taken for the grey there');
  assert.equal(keepSeenColours('A white and orange striped object is in the middle of a blue background.', grip), 'A white and orange striped object is in the middle of a white background.');
  assert.equal(keepSeenColours('The background is a light blue color. The stripes are orange.', grip), 'The background is a white color. The stripes are orange.');
  assert.equal(keepSeenColours('The image is a solid blue color. There are six solid blue squares in it. The object is long.', grip), 'The object is long.');
  assert.equal(keepSeenColours('A blue and orange ball.', grip), 'An orange ball.');
  assert.equal(keepSeenColours('A round black object is on a white background. A black ball. The colour is black.', { whole: share({ white: 0.7, green: 0.3 }), edge: share({ white: 1 }) }),
    'A round object is on a white background. A ball.', 'a false colour before a thing goes on its own; said of nothing, its sentence goes');
  // What is there stays, word for word.
  const sky = { whole: share({ blue: 0.7, green: 0.3 }), edge: share({ blue: 0.6, green: 0.4 }) };
  const said = 'The image is a silhouette of a mountain. The sky is light blue. The background is solid blue.';
  assert.equal(keepSeenColours(said, sky), said);
  // With no one colour round the edge, a false background colour is left out.
  const busy = { whole: share({ red: 0.3, green: 0.3, yellow: 0.4 }), edge: share({ red: 0.4, green: 0.3, yellow: 0.3 }) };
  assert.equal(keepSeenColours('A red mug on a blue background. A green plant.', busy), 'A green plant.');
  assert.ok(namesColour('A Navy coat') && !namesColour('A coat on a hook'));
});

test("the colours are measured from the picture, transparency counted as white, and every picture the VLM describes is checked", async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/local-models.js'), 'utf8');
  assert.match(src, /const picture = await pictureForModels\(bytes\);\n\s*const said = await _call\("describeImage", \{ data: picture \}, \{ urgent \}\);\n\s*return require\("\.\/picture-colours"\)\.checkColours\(said, picture\);/);
  let sharp; try { sharp = require('sharp'); } catch { return t.skip('sharp is not installed here'); }
  const { measure, checkColours } = require('../lib/picture-colours');
  const bar = await sharp({ create: { width: 60, height: 200, channels: 3, background: { r: 245, g: 120, b: 20 } } }).png().toBuffer();
  const onWhite = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 252, g: 252, b: 250 } } }).composite([{ input: bar, left: 170, top: 100 }]).jpeg().toBuffer();
  const m = await measure(onWhite);
  assert.ok(m.whole.white > 0.85 && m.whole.orange > 0.05 && m.whole.blue === 0, JSON.stringify(m.whole));
  assert.ok(m.edge.white > 0.99);
  assert.equal(await checkColours('An orange bar on a blue background.', onWhite), 'An orange bar on a white background.');
  const clear = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="60" fill="#1f7a3a"/></svg>')).png().toBuffer();
  assert.ok((await measure(clear)).edge.white > 0.99, 'a transparent background is white, as it is shown');
  assert.equal(await checkColours('A green circle on a white background.', clear), 'A green circle on a white background.');
  assert.equal(await checkColours('A bakery front.', Buffer.from('not a picture')), 'A bakery front.', 'no colour said, nothing measured');
  assert.equal(await checkColours('A red door.', Buffer.from('not a picture')), 'A red door.', 'a picture that cannot be measured keeps what was said');
});

// A ticket's handwritten price, read from a photo for a chat model that
// cannot see, was gone from the conversation by the next turn: the history
// kept only the reading's first line.
test('for a chat model that cannot see, what was read from a picture stays in the conversation', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/engine.js'), 'utf8');
  assert.match(src, /const kept = pictureText \? pictureText\.slice\(0, 1500\) : desc;/);
  assert.match(src, /\? `\[User uploaded file: \$\{attachmentId\}\. \$\{kept\}\]`/);
  assert.match(src, /const sub = pictureText \|\| "The picture could not be read just now\. Tell the user and do not infer what it contains\.";/, 'the same reading on the first turn');
  assert.ok(src.indexOf('let pictureText = null;') < src.indexOf('const uploadLabel = attachmentId'), 'read before it is kept');
});

// Where this computer can't make a picture, a person whose plan for the
// uncensored LLM holds gets one from the same model in NEAR AI's TEE
// (lib/near-private.js image, tested there); without one the tool says why.
test('a plan that holds makes the picture in the TEE where this computer cannot; without one the tool says why', async () => {
  const im = require('../lib/image-generation');
  const near = require('../lib/near-private');
  assert.equal(im.ready(), false, 'no model on this computer');
  const was = near.image, asked = [];
  near.image = async (conn, body) => { asked.push({ conn, body }); return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from('JPEG').toString('base64') }] }) }; };
  try {
    const settings = { included_api_key: 'near-test-key', included_ai: { plan: { name: 'plus' } } };
    const pic = await im.picture('a lighthouse at dusk', { shape: 'landscape', settings });
    assert.deepEqual({ ...pic, bytes: pic.bytes.toString() }, { bytes: 'JPEG', name: 'image.jpg', mime: 'image/jpeg' });
    assert.deepEqual(asked[0].body, { model: 'black-forest-labs/FLUX.2-klein-4B', prompt: 'a lighthouse at dusk', size: '1024x768' });
    assert.equal(asked[0].conn.apiKey, 'near-test-key');
    for (const name of ['first-month', 'ahead', 'maintainer']) await im.picture('x', { settings: { ...settings, included_ai: { plan: { name } } } });
    await assert.rejects(im.picture('x', { settings: { ...settings, included_ai: { plan: { name: 'ended', was: 'plus' } } } }), (e) => e.unavailable === true, 'an ended plan');
    await assert.rejects(im.picture('x', { settings: {} }), (e) => e.unavailable === true && /Image generation/.test(e.message), 'no plan');
    near.image = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'limit' } }) });
    await assert.rejects(im.picture('x', { settings }), (e) => !e.unavailable && /couldn't be made just now/.test(e.message));
  } finally { near.image = was; }
});

// Asked for a picture a computer can't make at all, with no plan that would,
// the person hears how to get one, after the answer: the subscription, or
// paying ahead again after a plan paid ahead. Off or still downloading, the
// reason says what to do, so nothing follows.
test('a picture this computer can never make is followed by how to get one', async () => {
  const im = require('../lib/image-generation');
  assert.match(im.offerText({}, true), /^With the Closedhand subscription, Closedhand makes pictures here too, with FLUX\.2 Klein in a TEE, so nobody but you can see them: \[closedhand\.com\/subscribe\]\(https:\/\/closedhand\.com\/subscribe\)$/);
  assert.match(im.offerText({ included_ai: { plan: { name: 'ended', was: 'plus' } } }, false), /: closedhand\.com\/subscribe$/);
  assert.match(im.offerText({ included_ai: { plan: { name: 'ended', was: 'ahead' } } }, true), /^Paying ahead again in My Account lets Closedhand make pictures here too/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/image-generation.js'), 'utf8');
  assert.match(src, /const never = \(_status \|\| \{\}\)\.eligible === false;\n  throw Object\.assign\(new Error\(unavailable\(\)\), \{ unavailable: true, offer: never, provider: never \? spec : null \}\);/);
  const engine = fs.readFileSync(path.join(__dirname, '..', 'lib/engine.js'), 'utf8');
  assert.match(engine, /if \(block\.name === "generate_image" && result\?\._imageOffer\) imageOffer = \{ provider: result\._imageProvider \|\| null, editing: !!result\._imageEdit \};/);
  assert.match(engine, /finalText = String\(finalText\)\.trim\(\) \+ "\\n\\n\[\[next\]\]\\n\\n" \+ require\("\.\/image-generation"\)\.offerText\(settings, \(deliverPlatform \|\| "web"\) === "web", provider, imageOffer\.editing\);/);
});

// Where nothing private can make a picture, the person's own LLM provider's
// picture model does, once they say so, and is offered until then. A person
// whose own provider is NEAR AI gets the TEE, never asked.
test("the person's own LLM provider makes pictures once they say so, the way each provider takes it, and is offered until then", async () => {
  const { im, restore } = loadImageMaking({ platform: 'linux', arch: 'x64', memoryGb: 64 });
  try {
    await im.boot();
    const providers = require('../lib/image-providers');
    const config = (provider, baseUrl) => ({ model_config: { roles: { chat: { connection: 'primary', model: 'm' } }, connections: { primary: { provider, ...(baseUrl ? { baseUrl } : {}), apiKey: 'test-key' } } } });
    assert.equal(providers.forSettings(config('openai')).model, 'gpt-image-2.6-sunburst');
    assert.equal(providers.forSettings(config('custom', 'https://api.x.ai/v1')).provider, 'xai', 'a provider saved by its address');
    for (const p of ['anthropic', 'deepseek', 'groq', 'moonshot']) assert.equal(providers.forSettings(config(p)), null, p);
    await assert.rejects(im.picture('a lighthouse', { settings: config('openai') }), (e) => e.unavailable && e.offer && e.provider?.name === 'OpenAI', 'not allowed yet: offered');

    const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300, 1)]);
    const asked = [];
    const answering = (answer) => async (url, opts) => { asked.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => answer }; };
    const b64 = { data: [{ b64_json: PNG.toString('base64') }] };
    let pic = await im.picture('a lighthouse', { shape: 'landscape', settings: config('openai'), useProvider: true, deps: { fetch: answering(b64) } });
    assert.equal(pic.via.name, 'OpenAI');
    assert.deepEqual([pic.mime, pic.name, pic.bytes.equals(PNG)], ['image/png', 'image.png', true]);
    assert.deepEqual(asked.at(-1), { url: 'https://api.openai.com/v1/images/generations', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: { model: 'gpt-image-2.6-sunburst', prompt: 'a lighthouse', n: 1, size: '1536x1024' } });
    await im.picture('x', { settings: { ...config('custom', 'https://api.x.ai/v1'), images_from_provider: true }, deps: { fetch: answering(b64) } });
    assert.deepEqual([asked.at(-1).url, asked.at(-1).body], ['https://api.x.ai/v1/images/generations', { model: 'grok-imagine-image-2.0', prompt: 'x', n: 1, response_format: 'b64_json' }], 'allowed once, kept');
    await im.picture('x', { settings: { ...config('deepinfra'), images_from_provider: true }, deps: { fetch: answering(b64) } });
    assert.equal(asked.at(-1).url, 'https://api.deepinfra.com/v1/openai/images/generations');
    await im.picture('x', { shape: 'portrait', settings: { ...config('gemini'), images_from_provider: true }, deps: { fetch: answering({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] }) } });
    assert.equal(asked.at(-1).url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent');
    assert.equal(asked.at(-1).headers['x-goog-api-key'], 'test-key');
    assert.deepEqual(asked.at(-1).body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } });
    pic = await im.picture('x', { settings: { ...config('openrouter'), images_from_provider: true }, deps: { fetch: answering({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG.toString('base64') } }] } }] }) } });
    assert.deepEqual([asked.at(-1).url, asked.at(-1).body.model, asked.at(-1).body.modalities], ['https://openrouter.ai/api/v1/chat/completions', 'google/gemini-3-pro-image', ['image', 'text']]);
    assert.ok(pic.bytes.equals(PNG));
    const quiet = console.warn; console.warn = () => {};
    try {
      await assert.rejects(im.picture('x', { settings: { ...config('openai'), images_from_provider: true }, deps: { fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Your organization must be verified' } }) }) } }), /^Error: OpenAI couldn't make the picture just now: Your organization must be verified$/);
    } finally { console.warn = quiet; }

    const near = require('../lib/near-private'), was = near.image, nearKeys = [];
    near.image = async (conn) => { nearKeys.push(conn.apiKey); return { ok: true, json: async () => b64 }; };
    try {
      pic = await im.picture('x', { settings: config('near') });
      assert.deepEqual([nearKeys, pic.via], [['test-key'], undefined], 'their own NEAR AI key: the TEE, never asked');
    } finally { near.image = was; }

    assert.equal(im.offerText({}, true, providers.forSettings(config('openai'))), 'OpenAI can make it with gpt-image-2.6-sunburst, and would see what the picture shows. Say so and Closedhand will use OpenAI for pictures from now on. Or subscribe at [closedhand.com/subscribe](https://closedhand.com/subscribe), and FLUX.2 Klein makes them in a TEE, so nobody but you can see them.');
    const handlers = fs.readFileSync(path.join(__dirname, '..', 'lib/tools/handlers.js'), 'utf8');
    assert.match(handlers, /if \(pic\.via && settings\?\.images_from_provider !== true\) \{\n\s*await require\("\.\.\/profile-settings"\)\.updateSettings\(userId, \{ images_from_provider: true \}, \{ store: ctx\.activeUserStore \}\);/, 'their yes is kept');
    const dash = fs.readFileSync(path.join(__dirname, '..', 'webapp/views/dashboard.html'), 'utf8');
    assert.match(dash, /var pv = !im\.eligible && !tee \? st\.imagesProvider : null;/);
  } finally { restore(); }
});

// Once a picture is in the chat, the LLM is given what it was seen to show,
// as a check, with nothing to claim beyond it: told only that it was sent, it
// said a picture of a plain cat had "retriever face and build, feline ears".
test('after a picture is sent, the LLM goes by what it was seen to show, never by what it asked for', async () => {
  const im = require('../lib/image-generation');
  const pic = { bytes: Buffer.from('JPEG'), mime: 'image/jpeg' };
  const looked = [];
  const got = await im.madeResult(pic, { settings: {}, userId: 'u1', look: async (bytes, mime, settings, userId) => { looked.push([bytes.toString(), mime, userId]); return 'A cat is sitting on the floor.'; } });
  assert.deepEqual(looked, [['JPEG', 'image/jpeg', 'u1']]);
  assert.equal(got.checked, 'Looked at after it was made, the picture shows: A cat is sitting on the floor.');
  assert.match(got.say, /Claim nothing about the picture beyond what 'checked' says\. If 'checked' shows it clearly misses what they asked for, make it once more with a clearer description; if it still misses, say so plainly\./);
  const blind = await im.madeResult(pic, { look: async () => null });
  assert.equal(blind.checked, undefined);
  assert.match(blind.say, /don't describe it/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib/image-generation.js'), 'utf8'), /require\("\.\/model-images"\)\.substituteImages\(/, 'seen as any picture is: the chosen picture model, or the VLM on this computer');
});

// A picture changed, or made from others: on this computer when its model is
// ready, or by the person's own provider once allowed and where it changes
// pictures; never in the TEE, whose gateway reads a picture sent to be changed
// unencrypted. Otherwise a plain reason, and the subscription is not offered,
// as it would not make it possible.
test("a picture is changed on this computer or by an allowed provider, never in the TEE, and otherwise said plainly", async () => {
  const { im, restore } = loadImageMaking({ platform: 'linux', arch: 'x64', memoryGb: 64 });
  try {
    await im.boot();
    const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 4, 0, 0, 0, 3, 0]), Buffer.alloc(300, 1)]);
    const edit = [{ bytes: PNG, mime: 'image/png' }, { bytes: PNG, mime: 'image/png' }];
    const config = (provider, extra = {}) => ({ model_config: { roles: { chat: { connection: 'primary', model: 'm' } }, connections: { primary: { provider, apiKey: 'test-key' } } }, ...extra });
    const subscriber = { included_api_key: 'near-key', included_ai: { plan: { name: 'plus' } } };
    const near = require('../lib/near-private'), was = near.image;
    near.image = async () => { throw new Error('a picture to change never goes to the TEE'); };
    try {
      await assert.rejects(im.picture('swap the racket', { settings: subscriber, edit }), (e) => e.unavailable && e.editing && !e.offer && /^Changing a picture can't be done on the computer running Closedhand yet\. On a Mac with Apple silicon and 8 GB of memory or more, or a computer with an NVIDIA graphics card with 8 GB or more, Closedhand changes pictures privately with its own image model\.$/.test(e.message), 'a subscriber on a server: said plainly, nothing offered');
      await assert.rejects(im.picture('x', { settings: config('openai'), edit }), (e) => e.offer && e.provider?.name === 'OpenAI', 'a provider that changes pictures is offered');
      await assert.rejects(im.picture('x', { settings: config('xai'), edit }), (e) => !e.offer && !e.provider, 'one that does not, is not');
    } finally { near.image = was; }
    assert.equal(im.offerText({}, true, require('../lib/image-providers').forSettings(config('openai')), true), 'OpenAI can change it with gpt-image-2.6-sunburst, and would see the pictures. Say so and Closedhand will use OpenAI for pictures from now on.');

    const asked = [];
    const answering = (answer) => async (url, opts) => { asked.push({ url, opts }); return { ok: true, status: 200, json: async () => answer }; };
    const b64 = { data: [{ b64_json: PNG.toString('base64') }] };
    let pic = await im.picture('swap the racket', { settings: config('openai', { images_from_provider: true }), edit, deps: { fetch: answering(b64) } });
    assert.equal(pic.via.name, 'OpenAI');
    assert.equal(asked.at(-1).url, 'https://api.openai.com/v1/images/edits');
    const form = asked.at(-1).opts.body;
    assert.ok(form instanceof FormData);
    assert.deepEqual([form.get('model'), form.get('prompt'), form.getAll('image[]').length], ['gpt-image-2.6-sunburst', 'swap the racket', 2], 'each picture as a file of its own');
    await im.picture('x', { settings: config('gemini', { images_from_provider: true }), edit, deps: { fetch: answering({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] }) } });
    const parts = JSON.parse(asked.at(-1).opts.body).contents[0].parts;
    assert.deepEqual(parts.map((p) => Object.keys(p)[0]), ['inlineData', 'inlineData', 'text']);
    await im.picture('x', { settings: config('openrouter', { images_from_provider: true }), edit, deps: { fetch: answering({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG.toString('base64') } }] } }] }) } });
    assert.deepEqual(JSON.parse(asked.at(-1).opts.body).messages[0].content.map((c) => c.type), ['image_url', 'image_url', 'text']);
  } finally { restore(); }
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/image-generation.js'), 'utf8');
  assert.match(src, /\.\.\.refs\.flatMap\(\(file\) => \["-r", file\]\),/, "on this computer, each picture is one of FLUX.2 Klein's references");
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'lib/tools/handlers.js'), 'utf8');
  assert.match(handlers, /const file = await loadAttachmentRaw\(String\(id\)\)\.catch\(\(\) => null\);/);
  assert.match(handlers, /return \{ \.\.\.await require\("\.\.\/image-generation"\)\.madeResult\(pic, \{ settings, userId \}\), picture_id: pictureId \};/, 'a picture made is kept, to be changed next');
});

// Before a move to Railway, where its own image model can't run, a computer
// that runs it says what changes for pictures, in the words agreed.
test("a move to Railway from a computer that runs the image model says what changes for pictures", () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'webapp/views/dashboard.html'), 'utf8');
  assert.match(dash, /<p class="account-action-desc" id="railway-pictures" hidden>Railway's servers can't run Closedhand's own image model: there, new pictures come with the Closedhand subscription, and changing existing pictures isn't possible yet\.<\/p>/);
  assert.match(dash, /document\.getElementById\('railway-pictures'\)\.hidden = !\(st && st\.localModels && st\.localModels\.images && st\.localModels\.images\.eligible\);/);
});

