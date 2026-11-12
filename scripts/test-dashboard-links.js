const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..');
function load(file, dependencies = {}, extras = {}) {
  const context = { module: { exports: {} }, URL, URLSearchParams, console,
    process: { env: {} }, setInterval: () => ({ unref() {} }),
    require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; }, ...extras };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  return context.module.exports;
}
function config(values, env = {}) {
  const query = { select() { return this; }, eq() { return this; }, async maybeSingle() {
    await new Promise(resolve => setImmediate(resolve));
    return { data: { settings: { self_host_config: values } }, error: null };
  } };
  return load('lib/config.js', { './db': { isDbConfigured: () => true, supabase: { from: () => query } },
    './admin': { getAdminUserId: () => 'test' },
    './crypto-tokens': { encryptString: (v) => v, decryptString: (v) => v } }, { process: { env } });
}
function links(conf) { return load('lib/dashboard-links.js', { './config': conf }); }
const phone = 'https://quiet-isle-07.closedhand.ai';
test('first chat link awaits phone config, including a cold cache', async () => {
  const conf = config({ PHONE_ACCESS: '1', PHONE_ACCESS_URL: phone });
  assert.equal(await links(conf).dashboardUrl('whatsapp'), phone + '/dashboard#agents');
  assert.equal(await links(conf).dashboardUrl('telegram'), phone + '/dashboard#agents');
});
test('web stays relative and disabled phone access never emits localhost or stale URLs', async () => {
  const client = links(config({ PHONE_ACCESS_URL: phone }, { BASE_URL: 'http://localhost:3000' }));
  assert.equal(await client.dashboardUrl('web'), '/dashboard#agents');
  assert.equal(await client.agentLinkNotice('web', 'Full result'), '[Full result](/dashboard#agents)', 'the link sits on the words');
  assert.equal(await client.dashboardUrl('whatsapp'), null);
  assert.match(await client.agentLinkNotice('whatsapp', 'Full result'), /claim your personal URL/);
});
test('a configured HTTPS web address wins over the personal URL', async () => {
  const conf = config({ PHONE_ACCESS: '1', PHONE_ACCESS_URL: phone }, { WEBAPP_URL: 'https://my.example.com/' });
  assert.equal(await links(conf).dashboardUrl('telegram'), 'https://my.example.com/dashboard#agents');
});
test('unsafe or computer-only addresses are never sent to chat', async () => {
  for (const address of ['http://example.com', 'https://localhost:3000', 'https://127.0.0.1', 'https://192.168.1.3', 'https://bot', 'https://laptop.local', 'https://user:secret@example.com', 'https://example.com/?token=secret']) {
    assert.equal(await config({}, { WEBAPP_URL: address }).dashboardBase(), null, address);
  }
});
const flush = () => new Promise(resolve => setImmediate(resolve));
// The personal URL on this computer (webapp/phone-access.js), with the relay,
// the certificate and closedhand.com stood in for.
const named = 'https://amber-fox-42.closedhand.ai';
const PERMANENT = { url: named, pass: 'body.signature', relay: { address: 'relay.closedhand.ai:443', controlHost: 'relay.closedhand.ai', pin: 'p'.repeat(43) }, verify: false };
const healthy = async () => ({ ok: true, json: async () => ({ status: 'ok', service: 'closedhand-webapp' }) });
function personalUrl(initial = {}, permanent = PERMANENT, registration = {}) {
  const values = { ...initial }, clients = [], intervals = [], retries = [], confirmed = [], keys = [];
  let health = healthy, certReady = async () => {};
  const api = load('webapp/phone-access.js', {
    crypto: require('node:crypto'),
    './config': { getConf: async key => values[key], getConfStrict: async key => values[key], setConf: async patch => Object.assign(values, patch) },
    './crypto-tokens': { encryptString: v => 'enc:v1:' + v, decryptString: v => v?.replace(/^enc:v1:/, '') },
    './phone-registration': { connection: async ({ key }) => { keys.push(key); return permanent && { ...permanent }; }, confirm: async p => { confirmed.push(p.url); }, status: () => registration, begin: async () => 'https://closedhand.com/phone-access/pair#fixture' },
    './relay-client': {
      create(options) {
        const c = new EventEmitter();
        Object.assign(c, { options, start() { c.started = true; return c; }, stop() { c.stopped = true; }, challenge() {}, challengeGone() {} });
        clients.push(c);
        return c;
      },
      terminate: () => () => {},
    },
    './relay-cert': { create: () => ({ ensure: async () => certReady(), context: () => ({}) }) },
  }, { setTimeout: fn => { retries.push(fn); return { unref() {} }; }, clearTimeout() {}, console: { log() {}, error() {} },
    AbortSignal, fetch: (...args) => health(...args),
    setInterval: fn => { const timer = { fn, unref() {} }; intervals.push(timer); return timer; },
    clearInterval: timer => { if (timer) timer.cleared = true; } });
  return { api, values, clients, intervals, retries, confirmed, keys, setHealth: fn => { health = fn; }, setCert: fn => { certReady = fn; }, check: () => intervals.at(-1).fn };
}
test('the personal URL needs a dashboard password, on enable and on restart', async () => {
  const t = personalUrl({ PHONE_ACCESS: '1', PHONE_ACCESS_URL: named });
  await assert.rejects(t.api.enable(), /password/);
  await t.api.boot();
  assert.equal(t.clients.length, 0);
  assert.equal(t.values.PHONE_ACCESS_URL, null);
});
test('quitting stops the relay connection but keeps the setting needed to resume', async () => {
  const t = personalUrl({ DASHBOARD_PASSWORD_HASH: 'fixture' });
  await t.api.enable();
  assert.equal(t.clients[0].started, true);
  t.api.shutdown();
  assert.equal(t.clients[0].stopped, true);
  assert.equal(t.values.PHONE_ACCESS, '1');
  assert.equal(t.api.status().enabled, false);
  const resumed = personalUrl(t.values);
  await resumed.api.boot();
  assert.equal(resumed.clients.length, 1);
  assert.equal(resumed.keys[0], t.keys[0], 'the same key for the relay after a restart, kept sealed');
  assert.match(t.values.PHONE_RELAY_KEY, /^enc:v1:/);
  assert.match(t.keys[0], /^[A-Za-z0-9_-]{43}$/, 'only the public half goes to closedhand.com');
});
test('the address is published only once the relay is up, the certificate is ready and closedhand.com has checked it', async () => {
  const t = personalUrl({ DASHBOARD_PASSWORD_HASH: 'fixture' }, { ...PERMANENT, verify: true });
  let finish;
  t.setCert(() => new Promise(resolve => { finish = resolve; }));
  await t.api.enable();
  assert.equal(t.api.status().url, null, 'not before the relay is up');
  t.clients[0].emit('up', 'amber-fox-42.closedhand.ai'); await flush();
  assert.equal(t.api.status().url, null, 'nor before the certificate');
  assert.deepEqual(t.confirmed, []);
  finish(); await flush(); await flush();
  assert.deepEqual(t.confirmed, [named], 'closedhand.com checked it first');
  assert.equal(t.api.status().url, named);
  assert.equal(t.values.PHONE_ACCESS_URL, named);
  // An old connection's news never lands on a new one.
  await t.api.disable(); await t.api.enable();
  t.clients[0].emit('up'); await flush();
  assert.equal(t.api.status().url, null);
  // A certificate that can't be had yet: waits, longer each time, never publishes.
  const slow = personalUrl({ DASHBOARD_PASSWORD_HASH: 'fixture' });
  slow.setCert(async () => { throw new Error("Let's Encrypt is unreachable"); });
  await slow.api.enable();
  slow.clients[0].emit('up'); await flush(); await flush();
  assert.equal(slow.api.status().url, null);
  assert.match(slow.api.status().error, /Waiting to verify/);
  assert.equal(slow.values.PHONE_ACCESS_URL, null);
});
test('successful login preserves the Agents tab and rejects external redirects', async () => {
  const html = fs.readFileSync(path.join(root, 'webapp/views/login.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  for (const [next, expected] of [['/dashboard', '/dashboard#agents'], ['/dashboard?view=1', '/dashboard?view=1#agents'], ['//evil.example', '/#agents'], ['/\\evil.example', '/#agents']]) {
    let submit;
    const location = { origin: 'https://my.example.com', search: '?next=' + encodeURIComponent(next), hash: '#agents' };
    vm.runInNewContext(script, { URL, URLSearchParams, location,
      document: { getElementById: id => id === 'login-form' ? { addEventListener: (_, fn) => { submit = fn; } } : { style: {}, value: 'fixture', addEventListener() {}, focus() {} } },
      fetch: async () => ({ ok: true, json: async () => ({ success: true }) }) });
    submit({ preventDefault() {} });
    await flush();
    assert.equal(location.href, expected);
  }
});

test('an address that stops answering from outside is dropped and the connection made again', async () => {
  const t = personalUrl({ DASHBOARD_PASSWORD_HASH: 'fixture' });
  await t.api.enable();
  t.clients[0].emit('up'); await flush(); await flush();
  assert.equal(t.api.status().url, named);
  const check = t.check();
  t.setHealth(async () => { throw new Error('DNS address gone'); });
  await check(); await check();
  assert.equal(t.clients[0].stopped, undefined, 'a brief outage does not drop it');
  t.setHealth(healthy);
  await check();
  t.setHealth(async () => ({ ok: false }));
  await check(); await check();
  assert.equal(t.clients[0].stopped, undefined, 'success resets the count');
  await check(); await flush();
  assert.equal(t.clients[0].stopped, true);
  assert.equal(t.values.PHONE_ACCESS_URL, null);
  t.retries.at(-1)(); await flush(); await flush();
  assert.equal(t.clients.length, 2);
  t.clients[1].emit('up'); await flush(); await flush();
  assert.equal(t.api.status().url, named);
});

test('a health check finishing after disable cannot restart or clear a replacement connection', async () => {
  const t = personalUrl({ DASHBOARD_PASSWORD_HASH: 'fixture' });
  await t.api.enable();
  t.clients[0].emit('up'); await flush(); await flush();
  const check = t.check();
  t.setHealth(async () => { throw new Error('offline'); });
  await check(); await check();
  let reject;
  t.setHealth(() => new Promise((_, fail) => { reject = fail; }));
  const pending = check();
  const before = t.retries.length;
  await t.api.disable(); await t.api.enable();
  t.clients[1].emit('up'); await flush(); await flush();
  reject(new Error('old check')); await pending;
  assert.equal(t.api.status().url, named);
  assert.equal(t.clients[1].stopped, undefined);
  assert.equal(t.retries.length, before, 'nothing restarted');
});

test('the personal URL keeps its exact address across a dropped connection and a restart', async () => {
  const t = personalUrl({ DASHBOARD_PASSWORD_HASH: 'fixture' });
  await t.api.enable();
  t.clients[0].emit('up'); await flush(); await flush();
  assert.equal(t.api.status().url, named);
  assert.equal(t.clients[0].options.relay.pin, PERMANENT.relay.pin, 'the relay closedhand.com named, and only it');
  t.clients[0].emit('down', new Error('closed')); await flush();
  assert.equal(t.api.status().state, 'starting');
  t.clients[0].emit('up'); await flush(); await flush();
  assert.equal(t.api.status().url, named);
  const restarted = personalUrl(t.values); await restarted.api.boot();
  restarted.clients[0].emit('up'); await flush(); await flush();
  assert.equal(restarted.api.status().url, named);
  await restarted.api.disable();
  assert.equal(restarted.api.status().url, null);
  assert.equal(restarted.clients[0].stopped, true);
});
test('pending registration does not connect to the relay or publish a link', async () => {
  const t = personalUrl({ DASHBOARD_PASSWORD_HASH: 'fixture' }, null);
  await t.api.enable();
  assert.equal(t.clients.length, 0);
  assert.equal(t.api.status().state, 'pairing');
  assert.equal(t.api.status().permanent, true);
  assert.equal(t.api.status().url, null);
  await t.api.disable();
  t.retries.at(-1)(); await flush();
  assert.equal(t.clients.length, 0);
  assert.equal(t.api.status().pairingUrl, null);
});

test('confirmed ownership replaces pairing while waiting, without advertising an unverified URL', async () => {
  const registration = { ownershipConfirmed: false, registrationState: 'unconfirmed' };
  const t = personalUrl({ DASHBOARD_PASSWORD_HASH: 'fixture' }, null, registration);
  await t.api.enable();
  assert.ok(t.api.status().pairingUrl);
  registration.ownershipConfirmed = true; registration.registrationState = 'pending';
  t.retries.at(-1)(); await flush();
  assert.equal(t.api.status().state, 'provisioning');
  assert.equal(t.api.status().ownershipConfirmed, true);
  assert.equal(t.api.status().pairingUrl, null);
  assert.equal(t.api.status().url, null); assert.equal(t.clients.length, 0);
});

test("phone access starts only from settings it could read, and tries again if it could not", () => {
  const access = fs.readFileSync(path.join(__dirname, "..", "webapp/phone-access.js"), "utf8");
  const boot = access.slice(access.indexOf("async function boot()"), access.indexOf("module.exports"));
  assert.match(boot, /wanted = String\(await getConfStrict\("PHONE_ACCESS"\)\) === "1";/);
  assert.match(boot, /setTimeout\(\(\) => \{ void boot\(\); \}, 10000\);/);
  assert.doesNotMatch(access, /cloudflared|trycloudflare|spawn\(/, 'nothing of Cloudflare runs here any more');
});
