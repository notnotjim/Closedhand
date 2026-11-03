const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../webapp/public/model-settings.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
// Small DOM fixture for asynchronous state tests. Layout and native controls
// are reviewed in the browser against the real setup page.
async function mount(respond = () => ({ config: null, runtime: 'docker' })) {
  const elements = new Map(), listeners = {}, timers = new Map(), calls = [];
  let timerId = 0;
  function element(selector = '') {
    if (elements.has(selector)) return elements.get(selector);
    const node = { value: '', dataset: {}, children: [], hidden: false,
      classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, focus() {}, after() {}, addEventListener() {},
      append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
      querySelector(s) { return element(selector + ' ' + s); },
    };
    node.parentElement = { after() {} };
    const attr = selector.match(/^\[data-(\w+)="(.*)"\]$/);
    if (attr) node.dataset[attr[1]] = attr[2];
    elements.set(selector, node); return node;
  }
  const root = element('root');
  root.querySelector = element;
  root.querySelectorAll = () => [...elements.values()];
  root.addEventListener = (event, fn) => { listeners[event] = fn; };
  const field = name => element('[data-field="' + name + '"]');
  field('visionMode').value = 'same';
  field('backgroundMode').value = 'same';
  const context = { window: {}, document: { createElement: () => {
    const node = element('created-' + elements.size);
    node.dataset = new Proxy({}, { set(target, key, value) { target[key] = value; if (key === 'modelId') elements.set('[data-model-id="' + value + '"]', node); return true; } });
    return node;
  } }, URL,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      const call = { path: url.replace('/api/model-config', ''), body: options.body ? JSON.parse(options.body) : null };
      calls.push(call); const response = await respond(call, calls);
      return { ok: !response.error, json: async () => response };
    },
  };
  vm.runInNewContext(source, context); context.window.ClosedHandModels.mount(root); await tick();
  return { root, field, calls, result: element('.model-result'), region: name => element('[data-region="' + name + '"]'),
    action: name => element('[data-action="' + name + '"]'),
    picker: name => element('[data-picker="' + name + '"]'),
    choose(name, value) { field(name).value = value; listeners.change({ target: field(name) }); },
    type(name, value) { field(name).value = value; listeners.input({ target: field(name) }); },
    pick(name, value) { const picker = element('[data-picker="' + name + '"]'); picker.value = value; listeners.change({ target: picker }); },
    async timers() { const tasks = [...timers.values()]; timers.clear(); for (const fn of tasks) await fn(); await tick(); },
  };
}
const catalog = { models: [{ id: 'chat', capabilities: { tools: true, vision: true } }] };

function checked() { return { ticket: 'checked-ticket', config: { connections: { primary: { provider: 'openai' } }, roles: { chat: { model: 'chat', connection: 'primary' }, background: { model: 'chat', connection: 'primary' }, vision: null } } }; }
test('a failed initial load can be retried without leaving a stale error', async () => {
  const ui = await mount((_, calls) => calls.length === 1 ? { error: 'fetch failed' } : { config: null });
  assert.equal(ui.field('provider').disabled, true);
  assert.equal(ui.action('reload').hidden, false);
  assert.doesNotMatch(ui.result.textContent, /fetch failed/);
  await ui.action('reload').onclick();
  assert.equal(ui.field('provider').disabled, false);
  assert.equal(ui.action('reload').hidden, true);
  assert.equal(ui.result.textContent, '');
});
for (const [runtime, url] of [['docker', 'http://host.docker.internal:11434/v1'], ['desktop', 'http://localhost:11434/v1'], ['hosted', '']]) {
  test(runtime + ' local model connections use the correct host', async () => {
    const ui = await mount(() => ({ config: null, runtime })); ui.choose('provider', 'ollama');
    assert.equal(ui.field('baseUrl').value, url); assert.equal(ui.region('key').hidden, true);
  });
}
test('entering a key automatically loads models once, without a duplicate on blur', async () => {
  const ui = await mount(call => call.path === '/models' ? catalog : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture');
  assert.equal(ui.calls.length, 1);
  await ui.timers();
  assert.equal(ui.calls[1].path, '/models'); assert.equal(ui.region('selection').hidden, false);
  assert.equal(ui.action('load').hidden, true);
  ui.choose('apiKey', 'fixture'); await ui.timers();
  assert.equal(ui.calls.filter(c => c.path === '/models').length, 1);
  assert.equal(ui.region('selection').hidden, false);
});
test('provider changes discard late model lists and clear old selections', async () => {
  let finish;
  const ui = await mount(call => call.path === '/models' ? new Promise(resolve => { finish = resolve; }) : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); ui.action('load').onclick(); await tick();
  ui.choose('provider', 'ollama'); finish(catalog); await tick();
  assert.equal(ui.region('selection').hidden, true); assert.equal(ui.field('apiKey').value, '');
  assert.equal(ui.field('model').value, ''); assert.equal(ui.result.textContent, '');
});
test('failed catalogs leave manual model entry available', async () => {
  const ui = await mount(call => call.path === '/models' ? { error: 'fetch failed' } : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); await ui.action('load').onclick(); await tick();
  assert.equal(ui.region('selection').hidden, false); assert.equal(ui.action('load').hidden, false);
  assert.match(ui.result.textContent, /selected model service/);
  ui.pick('model', '__manual__'); assert.equal(ui.field('model').value, '');
});
test('saving after the check has expired, or after a restart, checks again and saves, instead of only saying to check again', async () => {
  let saves = 0, checks = 0;
  const ui = await mount(call => call.path === '/models' ? catalog
    : call.path === '/check' ? (checks++, { ...checked(), ticket: 'ticket-' + checks })
    : call.path === '/save' ? (++saves === 1 ? { error: 'Check the models again before saving.', checkExpired: true } : { ok: true })
    : saves > 1 ? { config: checked().config } : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); await ui.action('load').onclick(); await tick();
  ui.choose('visionMode', 'off'); ui.pick('model', 'chat'); await ui.timers();
  assert.equal(checks, 1);
  await ui.action('save').onclick(); await tick(); await tick();
  assert.equal(checks, 2, 'checked again');
  assert.deepEqual(ui.calls.filter((c) => c.path === '/save').map((c) => c.body.ticket), ['ticket-1', 'ticket-2'], 'then saved with the new check');
  assert.equal(ui.result.textContent, 'Models updated. New requests use these choices.');
  assert.match(source, /show\("Models updated\. New requests use these choices\.", "done"\)/, 'a save that worked reads as done');
  const css = fs.readFileSync(require.resolve('../webapp/public/model-settings.css'), 'utf8');
  assert.match(css, /\.model-result \{ line-height: 1\.6; color: var\(--fg\); \}/, 'progress reads neutral');
  assert.match(css, /\.model-result\.is-done \{ color: var\(--ok\); \}/, 'done in green, which means working');
});
test('editing a checked connection immediately removes save, and late checks cannot restore it', async () => {
  let finish, delayed = false;
  const ui = await mount(call => call.path === '/models' ? catalog : call.path === '/check' ? (delayed ? new Promise(resolve => { finish = resolve; }) : checked()) : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); await ui.action('load').onclick(); await tick();
  ui.choose('visionMode', 'off'); ui.pick('model', 'chat'); await ui.timers();
  assert.equal(ui.action('save').hidden, false);
  ui.type('apiKey', 'changed'); assert.equal(ui.action('save').hidden, true);
  await ui.timers(); ui.pick('model', 'chat');
  delayed = true; ui.action('recheck').onclick(); await tick();
  ui.choose('provider', 'ollama'); finish(checked()); await tick();
  assert.equal(ui.action('save').hidden, true); assert.equal(ui.region('check').hidden, true);
});

test('saved hosted connections can be changed without entering the key again', async () => {
  let config = null;
  const verified = checked();
  verified.config.connections.primary = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', hasKey: true };
  const ui = await mount(call => {
    if (call.path === '/models') return catalog;
    if (call.path === '/check') return verified;
    if (call.path === '/save') { config = verified.config; return { success: true }; }
    return { config };
  });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); await ui.timers(); ui.choose('visionMode', 'off'); ui.pick('model', 'chat'); await ui.timers();
  ui.action('save').onclick(); await tick();
  assert.equal(ui.field('apiKey').value, '');
  ui.pick('backgroundModel', 'small'); await ui.timers();
  assert.equal(ui.calls.at(-1).path, '/check'); assert.equal(ui.calls.at(-1).body.primary.useSavedKey, true);
  assert.equal(ui.action('save').hidden, false);
});

test('typing is debounced and only the chosen provider receives the latest key', async () => {
  const ui = await mount(call => call.path === '/models' ? catalog : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'first'); ui.type('apiKey', 'latest'); await ui.timers();
  const requests = ui.calls.filter(c => c.path === '/models');
  assert.equal(requests.length, 1); assert.equal(requests[0].body.primary.apiKey, 'latest');
  assert.equal(requests[0].body.primary.provider, 'openai');
  assert.ok(ui.calls.every(c => !c.path.includes('detect')));
});
test('changing provider before the delay cancels the old key request', async () => {
  const ui = await mount(call => call.path === '/models' ? catalog : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'old'); ui.choose('provider', 'anthropic'); await ui.timers();
  assert.equal(ui.calls.length, 1);
  ui.type('apiKey', 'new'); await ui.timers();
  assert.equal(ui.calls[1].body.primary.provider, 'anthropic'); assert.equal(ui.calls[1].body.primary.apiKey, 'new');
});
test('clearing a key discards late catalogs and hides old selections', async () => {
  let finish;
  const ui = await mount(call => call.path === '/models' ? new Promise(resolve => { finish = resolve; }) : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); ui.action('load').onclick(); await tick();
  ui.type('apiKey', ''); finish(catalog); await tick(); await ui.timers();
  assert.equal(ui.region('selection').hidden, true); assert.equal(ui.field('model').value, '');
  assert.equal(ui.calls.filter(c => c.path === '/models').length, 1);
});
test('failed automatic loading offers Retry and succeeds without re-entering the key', async () => {
  let failed = true;
  const ui = await mount(call => call.path === '/models' ? (failed ? { error: 'fetch failed' } : catalog) : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); await ui.timers();
  assert.equal(ui.action('load').hidden, false);
  failed = false; await ui.action('load').onclick();
  assert.equal(ui.action('load').hidden, true); assert.equal(ui.region('selection').hidden, false);
});
test('local models load without a key; custom URLs wait until they are valid', async () => {
  const ui = await mount(call => call.path === '/models' ? catalog : { config: null, runtime: 'desktop' });
  ui.choose('provider', 'ollama'); await ui.timers();
  assert.equal(ui.calls[1].body.primary.baseUrl, 'http://localhost:11434/v1');
  ui.choose('provider', 'custom'); ui.type('baseUrl', 'https://'); await ui.timers();
  assert.equal(ui.calls.filter(c => c.path === '/models').length, 1);
  ui.type('baseUrl', 'https://fixture.example/v1'); await ui.timers();
  assert.equal(ui.calls.at(-1).body.primary.baseUrl, 'https://fixture.example/v1');
});
test('separate image providers load automatically and lose stale models when their key changes', async () => {
  const ui = await mount(call => call.path === '/models' ? catalog : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'chat-key'); await ui.timers();
  ui.choose('visionMode', 'separate'); ui.choose('visionProvider', 'anthropic'); ui.type('visionKey', 'image-key'); await ui.timers();
  assert.equal(ui.calls.at(-1).body.connection, 'vision'); assert.equal(ui.calls.at(-1).body.vision.apiKey, 'image-key');
  assert.equal(ui.action('load-vision').hidden, true);
  ui.pick('visionModel', 'chat'); ui.type('visionKey', 'replacement'); assert.equal(ui.field('visionModel').value, '');
  ui.choose('visionMode', 'off'); await ui.timers();
  assert.equal(ui.calls.filter(c => c.path === '/models' && c.body.connection === 'vision').length, 1);
});

test('separate support models load automatically and incomplete choices cannot be saved', async () => {
  const ui = await mount(call => call.path === '/models' ? catalog : call.path === '/check' ? checked() : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'chat-key'); await ui.timers();
  ui.pick('model', 'chat'); ui.choose('visionMode', 'off');
  ui.choose('backgroundMode', 'separate'); ui.choose('backgroundProvider', 'deepseek');
  await ui.timers(); assert.equal(ui.calls.filter(c => c.path === '/check').length, 0);
  ui.type('backgroundKey', 'support-key'); await ui.timers();
  const call = ui.calls.filter(c => c.path === '/models').at(-1);
  assert.equal(call.body.connection, 'background'); assert.equal(call.body.background.apiKey, 'support-key');
  ui.pick('backgroundModel', 'chat'); await ui.timers();
  assert.equal(ui.calls.filter(c => c.path === '/check').at(-1).body.backgroundMode, 'separate');
  ui.type('backgroundKey', 'replacement');
  assert.equal(ui.action('save').hidden, true); assert.equal(ui.field('backgroundModel').value, '');
});
test('changing support back to chat cancels pending provider loading', async () => {
  const ui = await mount(() => ({ config: null }));
  ui.choose('backgroundMode', 'separate'); ui.choose('backgroundProvider', 'openai');
  ui.type('backgroundKey', 'support-key'); ui.choose('backgroundMode', 'same'); await ui.timers();
  assert.equal(ui.calls.filter(c => c.path === '/models').length, 0);
  assert.equal(ui.region('background').hidden, true);
});

// A localhost provider is not necessarily one of Closedhand's bundled models.
test('only bundled recall and ranking models receive the built-in badge', async () => {
  const ui = await mount(() => ({ config: { connections: { primary: { provider: 'custom' } } }, activeModels: [
    { label: 'Chat model', model: 'local:primary', provider: 'On your computer' },
    { label: 'Recall', model: 'local:embedder', provider: 'On your computer' },
    { label: 'Search ranking', model: 'local:reranker', provider: 'On your computer' },
    { label: 'Recall', model: 'remote-embedder', provider: 'Hosted provider' },
  ] }));
  const rows = ui.region('current').children[0].children;
  const providers = [rows[1], rows[3], rows[5], rows[7]].map(row => row.children[1]);
  assert.deepEqual(providers.map(p => p.textContent), ['On your computer', 'Built in · Local', 'Built in · Local', 'Hosted provider']);
  assert.equal(providers[0].className, undefined);
  assert.equal(providers[3].className, undefined);
});

test('the settings panel and its route have no Jev (TypeSafe) option any more', () => {
  const server = fs.readFileSync(require.resolve('../webapp/model-config.js'), 'utf8');
  for (const text of [source, server]) assert.equal(text.match(/jev|typesafe|tokenmaxx|\/decisions/i), null);
});

test('support work on the primary model says it runs at low effort', () => {
  // Support jobs call the model at effort "fast" (lib/llm.js getConfiguredRole, lib/model-jobs.js).
  assert.match(source, /<option value="same">Use the primary model \(low effort\)<\/option>/);
  assert.match(source, /cap\.reasoning \? "The primary model, at low effort" : "Same as the primary model"/);
  assert.match(fs.readFileSync(require.resolve('../lib/llm.js'), 'utf8'), /effort: role === "background" \? "fast"/);
});

// A saved setup someone is changing, with invented models: the primary model
// reads images itself and has been checked.
const savedSetup = () => ({ config: { version: 1,
  connections: { primary: { provider: 'deepseek', backend: 'openai', baseUrl: '', hasKey: true } },
  roles: { chat: { connection: 'primary', model: 'chat', capabilities: { tools: true, vision: true, reasoning: 'deepseek', contextWindow: 1048576 } },
    background: { connection: 'primary', model: 'chat' }, vision: { connection: 'primary', model: 'chat', capabilities: { vision: true } } } }, runtime: 'docker' });
const panel = (ui) => { const rows = ui.region('check-rows').children.map((n) => n.textContent); return (label) => rows[rows.indexOf(label) + 1]; };

test('a saved key shows by its last four characters, and the field says it is kept until a new one is pasted', async () => {
  const withEnd = () => { const s = savedSetup(); s.config.connections.primary.keyEnd = '7f3a'; return s; };
  const ui = await mount((call) => call.path === '' ? withEnd() : call.path === '/models' ? catalog : { config: null });
  await ui.timers();
  assert.equal(ui.field('apiKey').placeholder, '••••••••••••7f3a');
  assert.equal(ui.region('connection-help').textContent, 'Your saved key is kept unless you paste a new one.');
  ui.type('apiKey', 'new-key'); await ui.timers();
  assert.equal(ui.region('connection-help').textContent, 'Paste an API key from this provider to load its models.', 'a pasted key replaces it');
  assert.doesNotMatch(fs.readFileSync(require.resolve('../webapp/public/model-settings.js'), 'utf8'), /leave blank to keep|Paste your key/);
});

// A primary model that can't see pictures, with no image model: the choice of
// an image model is offered only then.
const textOnlySetup = () => { const s = savedSetup(); s.config.roles.chat.capabilities.vision = false; s.config.roles.vision = null; return s; };
test('while a new image model is chosen, the unchanged primary keeps its checked results', async () => {
  const ui = await mount((call) => call.path === '' ? textOnlySetup() : call.path === '/models' ? catalog : { config: null });
  await ui.timers();
  ui.choose('visionMode', 'separate'); ui.choose('visionProvider', 'xai'); ui.type('visionKey', 'image-key'); await ui.timers();
  const row = panel(ui);
  assert.equal(row('Tool calls'), 'Works', 'not "Not checked yet" for a primary model that is in use and unchanged');
  assert.equal(row('Images'), 'Choose an image and video model', "not the primary model's own image result");
  assert.equal(ui.region('check-title').textContent, 'Choose an image and video model to check these models', 'the title names what is missing');
});

test('the image and video choice appears only when the primary model does not see pictures itself', async () => {
  const seeing = await mount((call) => call.path === '' ? savedSetup() : call.path === '/models' ? catalog : { config: null });
  await seeing.timers();
  assert.equal(seeing.region('vision-role').hidden, true, 'a primary model that sees does it all');
  seeing.choose('visionMode', 'separate');
  assert.equal(seeing.field('visionMode').value, 'same');
  assert.equal(seeing.region('vision').hidden, true);

  const blind = await mount((call) => call.path === '' ? textOnlySetup() : call.path === '/models' ? catalog : { config: null });
  await blind.timers();
  assert.equal(blind.region('vision-role').hidden, false);
  assert.equal(blind.field('visionMode').value, 'off', 'the vision language model on this computer, unless another is chosen');
  assert.equal(blind.root.querySelector('[data-field="visionMode"] option[value="same"]').hidden, true, '"Use the primary model" is not offered');
});

test('a primary model not known to see is checked as it is, and one found not to see uses the vision language model with nothing more to check', async () => {
  const unknown = { models: [{ id: 'own-model', capabilities: { tools: true, vision: null } }] };
  const found = { ticket: 'checked-ticket', config: { connections: { primary: { provider: 'openai' } }, roles: { chat: { model: 'own-model', connection: 'primary', capabilities: { tools: true, vision: false } }, background: { model: 'own-model', connection: 'primary' }, vision: null } } };
  const ui = await mount((call) => call.path === '/models' ? unknown : call.path === '/check' ? found : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); await ui.action('load').onclick(); await tick();
  ui.pick('model', 'own-model');
  assert.equal(ui.region('vision-role').hidden, false);
  assert.equal(ui.field('visionMode').value, 'same', 'not known yet: the check finds out');
  await ui.timers();
  assert.equal(ui.calls.filter((c) => c.path === '/check').at(-1).body.visionMode, 'same');
  assert.equal(ui.field('visionMode').value, 'off');
  assert.equal(ui.action('save').hidden, false, 'what was checked is what is saved: nothing to check again');
});

test('an image model whose abilities are unknown is not offered for images, but can still be typed in', async () => {
  const listing = { models: [{ id: 'grok-4.7', capabilities: { tools: true, vision: true } }, { id: 'grok-imagine-image', capabilities: { tools: null, vision: null } }] };
  const ui = await mount((call) => call.path === '/models' ? (call.body.connection === 'vision' ? listing : catalog) : { config: null });
  ui.choose('provider', 'deepseek'); ui.type('apiKey', 'chat-key'); await ui.timers();
  ui.choose('visionMode', 'separate'); ui.choose('visionProvider', 'xai'); ui.type('visionKey', 'image-key'); await ui.timers();
  const ids = ui.picker('visionModel').children.map((o) => o.value);
  assert.ok(ids.includes('grok-4.7'));
  assert.ok(!ids.includes('grok-imagine-image'), 'a model that makes pictures is not offered for reading them');
  assert.ok(ids.includes('__manual__'));
});

test('the panel says how videos are handled, from what the checked models can do', async () => {
  const withRoles = (chatCap, vision) => () => { const s = savedSetup(); s.config.roles.chat.capabilities = chatCap; s.config.roles.vision = vision; if (vision?.connection === 'vision') s.config.connections.vision = { provider: 'xai', backend: 'custom', baseUrl: '', hasKey: true }; return s; };
  const cases = [
    [{ tools: true, vision: true, video: true, videoLinks: true }, { connection: 'primary', model: 'chat', capabilities: { vision: true } }, /^Watches them whole, and opens YouTube links itself$/],
    [{ tools: true, vision: true }, { connection: 'primary', model: 'chat', capabilities: { vision: true } }, /^Sees frames and reads what's said$/],
    [{ tools: true, vision: false }, { connection: 'vision', model: 'grok-4.7', capabilities: { vision: true } }, /^grok-4\.7 via xAI sees frames, and Closedhand writes out what's said$/],
    [{ tools: true, vision: false }, null, /^The vision language model on this computer describes frames, and Closedhand writes out what's said$/],
  ];
  for (const [chatCap, vision, expected] of cases) {
    const respond = withRoles(chatCap, vision);
    const ui = await mount((call) => call.path === '' ? respond() : call.path === '/models' ? catalog : { config: null });
    await ui.timers();
    assert.match(panel(ui)('Videos'), expected);
  }
});

test("an Ollama image model with a small window is shown with what that means for videos", async () => {
  const respond = () => { const s = savedSetup(); s.config.roles.chat.capabilities = { tools: true, vision: false };
    s.config.connections.vision = { provider: 'ollama', backend: 'custom', baseUrl: 'http://host.docker.internal:11434/v1', hasKey: false };
    s.config.roles.vision = { connection: 'vision', model: 'local-vl', capabilities: { vision: true, video: false, contextWindow: 4096 } }; return s; };
  const ui = await mount((call) => call.path === '' ? respond() : call.path === '/models' ? catalog : { config: null });
  await ui.timers();
  assert.match(panel(ui)('Videos'), /^local-vl via .* sees frames, and Closedhand writes out what's said\. Ollama gives it 4,096 tokens, so only a few frames fit; raise its context length for more$/);
});
