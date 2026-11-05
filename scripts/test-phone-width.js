// On a phone nothing may make a page wider than the screen: once it is, a
// sideways swipe drags the whole page off the edge (iOS Safari pans to it).
// The dashboard (every tab and My Account), the web chat and setup are opened
// in headless Chrome at phone widths with invented, empty data, and every
// running animation is stepped through its whole cycle, since light that runs
// round a box can poke past the screen for a moment and widen the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const assets = require(path.join(root, 'webapp/assets.js'));
const publicDir = path.join(root, 'webapp/public');
const WIDTHS = [320, 375, 390, 430];
const TABS = ['connections', 'upcoming', 'agents', 'projects', 'pages', 'brain', 'settings'];

function chrome() {
  const named = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const p of named) if (p && fs.existsSync(p)) return p;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null; } catch {}
  }
  return null;
}

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
const page = (name) => assets.stamp(assets.forHost(fs.readFileSync(path.join(root, 'webapp/views', name), 'utf8'), false));
const STUB = {
  '/api/chat/status': { authenticated: true, name: 'Rowan Hale' },
  '/api/conversations': { chat: { updated_at: '2026-01-05T09:00:00Z', message_count: 2 }, projects: [] },
  '/api/conversation': { messages: [] },
  '/api/chat/history': { messages: [] },
};
function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const html = (body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    if (url.pathname === '/frame') return html('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style><iframe id="f" src="/dashboard#connections"></iframe>');
    if (url.pathname === '/dashboard') return html(page('dashboard.html'));
    if (url.pathname === '/') return html(page('index.html'));
    if (url.pathname === '/setup') return html(page('setup.html'));
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/chat/ws-token') { res.writeHead(503); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(STUB[url.pathname] || {}));
    }
    const file = path.resolve(publicDir, '.' + decodeURIComponent(url.pathname));
    if (file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Chrome over its debugging pipe: no WebSocket needed, so it runs on any Node.
function launch(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-width-'));
  const proc = spawn(bin, ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--user-data-dir=' + dir, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0), id = 0;
  const pending = new Map();
  proc.stdio[4].on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let end;
    while ((end = buf.indexOf(0)) >= 0) {
      const msg = JSON.parse(buf.subarray(0, end).toString('utf8'));
      buf = buf.subarray(end + 1);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
    proc.stdio[3].write(JSON.stringify({ id: n, method, params, sessionId }) + '\0');
  });
  const close = () => { try { proc.kill(); } catch {} setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 300); };
  return { send, close };
}

// Runs in the page: how far past the screen the page reaches at its worst,
// each animation stepped through its cycle, and which boxes reach that far.
const MEASURE = String(async function measure(doc) {
  const win = doc.defaultView;
  const clipped = (el) => { for (let p = el.parentElement; p && p !== doc.body; p = p.parentElement) if (win.getComputedStyle(p).overflowX !== 'visible') return true; return false; };
  const culprits = () => {
    const W = doc.documentElement.clientWidth, out = [];
    for (const el of doc.querySelectorAll('body *')) {
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none' || cs.overflowX !== 'visible') continue;
      const r = el.getBoundingClientRect();
      if (r.left + Math.max(el.scrollWidth, r.width) > W + 1 && !clipped(el)) out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : ''));
    }
    return out.slice(-4);
  };
  const anims = doc.getAnimations();
  const length = (a) => { const t = a.effect && a.effect.getComputedTiming(); return t && Number.isFinite(t.duration) ? t.duration : 0; };
  anims.forEach((a) => { try { a.pause(); } catch {} });
  const longest = Math.min(12000, Math.max(0, ...anims.map(length)));
  let worst = 0, by = [];
  for (let ms = 0; ms <= longest; ms += 125) {
    anims.forEach((a) => { const d = length(a); if (d > 0) try { a.currentTime = ms % d; } catch {} });
    const over = doc.documentElement.scrollWidth - doc.documentElement.clientWidth;
    if (over > worst) { worst = over; by = culprits(); }
  }
  anims.forEach((a) => { try { a.play(); } catch {} });
  return { over: worst, by };
});

async function evaluate(send, sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

test('no page is wider than a phone screen, whatever is moving on it', { timeout: 240000 }, async (t) => {
  const bin = chrome();
  if (!bin) return t.skip('no Chrome or Chromium here');
  const server = await serve();
  const base = 'http://127.0.0.1:' + server.address().port;
  const { send, close } = launch(bin);
  const found = [];
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
    const open = async (url) => { await send('Page.navigate', { url }, sessionId); await new Promise((r) => setTimeout(r, 2500)); };
    for (const width of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
      await open(base + '/frame');
      const seen = await evaluate(send, sessionId, `(async () => {
        const measure = ${MEASURE};
        const f = document.getElementById('f'), w = f.contentWindow, d = f.contentDocument, out = {};
        const settle = () => new Promise((r) => setTimeout(r, 400));
        for (const tab of ${JSON.stringify(TABS)}) {
          w.switchTab(tab); await settle();
          d.querySelectorAll('details').forEach((x) => { if (!x.closest('.dashboard-toolbar')) x.open = true; });
          out[tab] = await measure(d);
        }
        w.setAccountMode(true); await settle();
        out['My Account'] = await measure(d);
        return out;
      })()`);
      for (const [where, r] of Object.entries(seen)) if (r.over > 0) found.push(`dashboard ${where} at ${width}px: ${r.over}px wider (${r.by.join(', ')})`);
      for (const [name, url] of [['web chat', '/'], ['setup', '/setup']]) {
        await open(base + url);
        const r = await evaluate(send, sessionId, `(${MEASURE})(document)`);
        if (r.over > 0) found.push(`${name} at ${width}px: ${r.over}px wider (${r.by.join(', ')})`);
      }
    }
  } finally {
    close();
    server.close();
  }
  assert.deepEqual(found, [], 'pages wider than the screen:\n' + found.join('\n'));
});
