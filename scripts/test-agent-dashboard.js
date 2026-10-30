const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'webapp/views/dashboard.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'webapp/server.js'), 'utf8');
// The Agents tab's loading (loadAgents): what is working now, the routines
// and what finished this week, from three reads drawn together.
function dashboard({ tasks = [], routines = [], runs = [], fail = '' } = {}) {
  const elements = new Map(), requests = [], timers = [], drawn = {};
  const get = id => {
    if (!elements.has(id)) {
      const el = { textContent: '', style: {}, hidden: true, _html: '' };
      Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { drawn[id] = (drawn[id] || 0) + 1; this._html = v; } });
      elements.set(id, el);
    }
    return elements.get(id);
  };
  const body = { '/api/agents': tasks, '/api/automations': routines, '/api/automations/recent': runs };
  const context = vm.createContext({ console, Date, window: {},
    document: { hidden: false, getElementById: get, addEventListener() {} },
    fetch: async url => { requests.push(url); return { ok: url !== fail, json: async () => body[url] }; },
    renderAgentCard: a => '[task ' + a.id + ']',
    renderAutomationCard: a => '[routine ' + a.id + ']',
    renderRoutineRun: r => '[run ' + r.id + ']',
    loadUpcoming() { requests.push('upcoming'); },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval() {},
  });
  vm.runInContext(html.slice(html.indexOf('    var _agentsHtml = {};'), html.indexOf('    // Permission drift is invisible')), context);
  vm.runInContext(html.slice(html.indexOf('    var _tabPoll = null'), html.indexOf('    function fileSize(n) {')), context);
  return { context, get, requests, timers, drawn };
}
const at = (mins) => new Date(Date.now() - mins * 60000).toISOString();
test('Working now holds tasks going or waiting and routines mid-run; Done lately what finished this week', async () => {
  const h = dashboard({
    tasks: [{ id: 't1', status: 'running', created_at: at(4) }, { id: 't2', status: 'awaiting_confirmation', created_at: at(25) }, { id: 't3', status: 'completed', created_at: at(900), completed_at: at(880) }],
    routines: [{ id: 'r1' }],
    runs: [{ id: 'u1', live: true, started_at: at(1) }, { id: 'u2', live: false, status: 'success', started_at: at(60), completed_at: at(55) }],
  });
  await h.context.loadAgents();
  assert.equal(h.get('auto-active-list').innerHTML, '[run u1][task t1][task t2]', 'newest first, routines and tasks together');
  assert.equal(h.get('agents-done-list').innerHTML, '[run u2][task t3]');
  assert.equal(h.get('auto-saved-list').innerHTML, '[routine r1]');
  assert.equal(h.get('auto-active-empty').hidden, true);
  assert.equal(h.get('auto-active-desc').hidden, false, 'where each will answer, said once above them');
  assert.equal(h.get('agents-done').hidden, false);
  assert.equal(h.get('auto-empty').style.display, 'none', 'no templates beside routines');
});
test('with nothing working, it says so and how to hand something over; with no routines, the templates', async () => {
  const h = dashboard();
  await h.context.loadAgents();
  assert.equal(h.get('auto-active-empty').hidden, false);
  assert.equal(h.get('auto-active-desc').hidden, true);
  assert.equal(h.get('agents-done').hidden, true, 'no Done lately with nothing done');
  assert.equal(h.get('auto-empty').style.display, 'block');
  assert.match(html, /<p class="section-desc" id="auto-active-empty">Nothing right now\. Ask in chat for anything that takes a while, like comparing hotels or looking into a purchase, and Closedhand works on it here while you carry on\.<\/p>/);
});
test('a failed read shows its own error and leaves the rest', async () => {
  const h = dashboard({ fail: '/api/agents', routines: [{ id: 'r1' }] });
  await h.context.loadAgents();
  assert.equal(h.get('auto-active-error').hidden, false);
  assert.equal(h.get('auto-active-empty').hidden, true, 'never "nothing right now" when it could not look');
  assert.equal(h.get('auto-saved-list').innerHTML, '[routine r1]');
  const g = dashboard({ fail: '/api/automations', tasks: [{ id: 't1', status: 'running', created_at: at(1) }] });
  await g.context.loadAgents();
  assert.equal(g.get('auto-saved-error').hidden, false);
  assert.notEqual(g.get('auto-empty').style.display, 'block', 'not mistaken for having no routines');
  assert.equal(g.get('auto-active-list').innerHTML, '[task t1]', 'what is working still shows');
});
test('a list is drawn again only when it changed, and the tab on screen is asked again while it is', async () => {
  const h = dashboard({ tasks: [{ id: 't1', status: 'running', created_at: at(1) }] });
  await h.context.loadAgents();
  await h.context.loadAgents();
  assert.equal(h.drawn['auto-active-list'], 1, 'no flicker on a refresh');
  h.context.startTabPolling('agents');
  assert.equal(h.timers.at(-1).ms, 15000);
  h.timers.at(-1).fn();
  assert.equal(h.requests.filter((u) => u === '/api/agents').length, 3);
  h.context.startTabPolling('upcoming');
  assert.equal(h.timers.at(-1).ms, 30000);
  h.timers.at(-1).fn();
  assert.ok(h.requests.includes('upcoming'), 'Upcoming keeps itself current on its own tab');
  const before = h.timers.length;
  h.context.startTabPolling('settings');
  assert.equal(h.timers.length, before, 'nothing asked again on a tab that does not change');
});
function route(url, records, fail = '') {
  let handler;
  // The profile is read by id for the person's time zone; everything else by owner.
  const db = { from(table) { let owner; const q = { select() { return q; }, eq(k, value) { assert.equal(k, table === 'profiles' ? 'id' : 'user_id'); owner = value; return q; },
    maybeSingle() { return Promise.resolve({ data: (records.profiles || []).find(r => r.id === owner) || null }); },
    then(resolve) { return Promise.resolve(table === fail ? { error: new Error('offline') } : { data: (records[table] || []).filter(r => r.user_id === owner) }).then(resolve); } }; return q; } };
  const start = server.indexOf('app.get("' + url + '",');
  const end = server.indexOf('\napp.', start + 1);
  vm.runInNewContext(server.slice(start, end), { app: { get(name, fn) { handler = fn; } }, supabase: db, getUserIdFromRequest: () => 'owner', phoneZone: require('../webapp/phone-zone'), Date, Intl, Number, Object, console: { error() {} } });
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
  return handler({}, res).then(() => res);
}
for (const dates of ['postgres', 'supabase']) test('agent stats count ' + dates + ' timestamps and isolate owners', async () => {
  const stamp = ms => dates === 'postgres' ? new Date(ms) : new Date(ms).toISOString();
  const at = stamp(Date.now());
  const records = { agent_tasks: [{ user_id: 'owner', status: 'running', created_at: at }, { user_id: 'owner', status: 'completed', created_at: at, completed_at: at }, { user_id: 'other', status: 'running', created_at: at }] };
  const agentStats = await route('/api/agents/stats', records);
  assert.equal(agentStats.body.active, 1);
  assert.equal(agentStats.body.completedToday, 1);
});
test('the routine counts and per-routine run lists are gone: their runs are under Working now and Done lately', () => {
  assert.doesNotMatch(server, /app\.get\("\/api\/automations\/stats"|app\.get\("\/api\/automations\/:id\/runs"|function startOfTodayIn/);
  assert.doesNotMatch(html, /auto-summary|loadAutomationStats|loadAutoRuns|auto-history-list/);
});

