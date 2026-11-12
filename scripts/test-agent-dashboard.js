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
function dashboard({ tasks = [], routines = [], runs = [], reminders = [], fail = '' } = {}) {
  const elements = new Map(), requests = [], timers = [], drawn = {}, telling = { on: false }, state = { fail };
  const get = id => {
    if (!elements.has(id)) {
      const el = { textContent: '', style: {}, hidden: true, _html: '' };
      Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { drawn[id] = (drawn[id] || 0) + 1; this._html = v; } });
      elements.set(id, el);
    }
    return elements.get(id);
  };
  const body = { '/api/agents': tasks, '/api/automations': routines, '/api/automations/recent': runs, '/api/reminders': reminders };
  const context = vm.createContext({ console, Date, window: {},
    document: { hidden: false, getElementById: get, addEventListener() {}, querySelector: (sel) => (sel === '.agent-tell' && telling.on ? {} : null) },
    fetch: async url => { requests.push(url); return { ok: url !== state.fail, json: async () => body[url] }; },
    renderAgentCard: a => '[task ' + a.id + ']',
    renderAutomationCard: a => '[routine ' + a.id + ']',
    renderWaitingCard: a => '[waiting ' + a.id + ']',
    renderWaitingJob: r => '[job ' + r.name + ']',
    renderRoutineRun: r => '[run ' + r.id + ']',
    loadUpcoming() { requests.push('upcoming'); },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval() {},
  });
  const team = html.indexOf('    function isTeam(a)');
  vm.runInContext(html.slice(team, html.indexOf('\n', team)), context);
  vm.runInContext(html.slice(html.indexOf('    var _agentsHtml = {};'), html.indexOf('    // Permission drift is invisible')), context);
  vm.runInContext(html.slice(html.indexOf('    var _tabPoll = null'), html.indexOf('    function fileSize(n) {')), context);
  return { context, get, requests, timers, drawn, telling, state };
}
const at = (mins) => new Date(Date.now() - mins * 60000).toISOString();
test('every routine is under Routines, one agent or a team; a job set to start once is a task, waiting', async () => {
  const h = dashboard({ routines: [{ id: 'r1' }, { id: 't1', members: [{ name: 'Bank', part: 'x' }] }, { id: 'w1', run_once: true, status: 'active', members: [{ name: 'Bank', part: 'x' }] }, { id: 'w2', run_once: true, status: 'done', fired_at: at(5) }],
    reminders: [{ name: 'Check the Lisbon fares', kind: 'task' }, { name: 'Call the plumber', kind: 'reminder' }, { name: 'Weekly fares', kind: 'task', repeats: 'every Monday' }, { name: 'Old', kind: 'task', archived: true }] });
  await h.context.loadAgents();
  assert.equal(h.get('auto-saved-list').innerHTML, '[routine r1][routine t1]', 'a team is a routine like any other');
  assert.equal(h.get('auto-active-list').innerHTML, '[waiting w1][job Check the Lisbon fares]', 'waiting is a task card, a team or not; a reminder is not a task; one that has run shows as its run');
});
test('Tasks: working first, then waiting, then a finished one whose answer is on its way; a routine runs on its own card, never as a task', async () => {
  const soon = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  const h = dashboard({
    tasks: [{ id: 't1', status: 'running', created_at: at(4) }, { id: 't2', status: 'awaiting_confirmation', created_at: at(25) },
      { id: 't3', status: 'completed', result: 'Done.', created_at: at(40), completed_at: at(30) },
      { id: 't4', status: 'failed', created_at: at(60 * 50), completed_at: at(60 * 49) }],
    routines: [{ id: 'r1' }, { id: 'w1', run_once: true, status: 'active', next_at: soon(90) }, { id: 'w3', run_once: true, status: 'done', fired_at: at(2) },
      { id: 'w4', run_once: true, status: 'done', fired_at: at(90) }, { id: 'w5', run_once: true, status: 'done', fired_at: at(90) }],
    runs: [{ id: 'u1', automation_id: 'r1', live: true, started_at: at(1) }, { id: 'u2', automation_id: 'r1', live: false, status: 'success', started_at: at(60), completed_at: at(55) },
      { id: 'u3', automation_id: 'w3', live: true, started_at: at(2) },
      { id: 'u4', automation_id: 'w4', live: false, status: 'success', started_at: at(90), completed_at: at(80), delivery_status: 'sent' },
      { id: 'u5', automation_id: 'w5', live: false, status: 'success', started_at: at(90), completed_at: at(35), delivery_status: 'waiting' }],
    reminders: [{ name: 'Sooner', kind: 'task', next_at: soon(30) }],
  });
  await h.context.loadAgents();
  assert.equal(h.get('auto-active-list').innerHTML, '[run u3][task t1][task t2][job Sooner][waiting w1][task t3][run u5][task t4]', 'a job set for once leaves once its answer is sent, as a task does');
  assert.equal(h.get('auto-saved-list').innerHTML, '[routine r1]');
  assert.equal(h.get('auto-active-empty').hidden, true);
  assert.equal(h.get('auto-active-desc').hidden, false, 'what it holds and where each answers, said once above them');
  assert.equal(h.get('auto-empty').style.display, 'none', 'no templates beside routines');
});
test("a routine's card goes live while it runs and says how its last run went", async () => {
  const given = [];
  const h = dashboard({ routines: [{ id: 'r1' }, { id: 'r2' }], runs: [{ id: 'u1', automation_id: 'r1', live: true, started_at: at(1) },
    { id: 'u2', automation_id: 'r2', live: false, status: 'success', started_at: at(300), completed_at: at(290) }, { id: 'u3', automation_id: 'r2', live: false, status: 'success', started_at: at(60), completed_at: at(55) }] });
  h.context.renderAutomationCard = (a) => { given.push(a); return '[routine ' + a.id + ']'; };
  await h.context.loadAgents();
  assert.equal(given[0].liveRun.id, 'u1');
  assert.equal(given[0].lastRunShown, null, 'its card is live, not last run');
  assert.equal(given[1].liveRun, null);
  assert.equal(given[1].lastRunShown.id, 'u3', 'its newest finished run');
  assert.equal(h.get('auto-active-list').innerHTML, '', 'never under Tasks');
});
test('with nothing working, it says so and how to hand something over; with no routines, the templates', async () => {
  const h = dashboard();
  await h.context.loadAgents();
  assert.equal(h.get('auto-active-empty').hidden, false);
  assert.equal(h.get('auto-active-desc').hidden, true);
  assert.equal(h.get('auto-empty').style.display, 'block');
  assert.match(html, /<p class="section-desc" id="auto-active-empty">Nothing right now\. Anything long you ask for in chat shows here while Closedhand works on it\.<\/p>/);
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
test('a refresh that fails keeps what is shown, and says so only once it keeps failing', async () => {
  // Waking from sleep, the first refresh goes before the network is back:
  // Working now emptied and said it could not refresh, then came back.
  const h = dashboard({ tasks: [{ id: 't1', status: 'running', created_at: at(1) }], routines: [{ id: 'r1' }] });
  await h.context.loadAgents();
  h.state.fail = '/api/agents';
  await h.context.loadAgents();
  assert.equal(h.get('auto-active-list').innerHTML, '[task t1]', 'still there');
  assert.equal(h.get('auto-active-error').hidden, true, 'one miss is not news');
  await h.context.loadAgents(); await h.context.loadAgents();
  assert.equal(h.get('auto-active-error').hidden, false, 'a minute or so of misses is');
  assert.equal(h.get('auto-active-list').innerHTML, '[task t1]', 'above the last list it had');
  h.state.fail = '';
  await h.context.loadAgents();
  assert.equal(h.get('auto-active-error').hidden, true);
  assert.match(html, /<p id="auto-active-error" class="section-desc" role="status" hidden>/, 'set like the line it stands in for');
});
test('an open card keeps the card inset and names no missing steps beside what it did', () => {
  assert.match(html, /\.agent-card \.agent-detail \{ display: none; margin: -0\.375rem 1\.25rem 1\.125rem;/);
  assert.match(html, /\.agent-card :is\(\.agent-detail, \.team-members, \.team-lead\) \{ margin-left: 1rem; margin-right: 1rem; \}/);
  assert.match(html, /\(steps \|\| \(toolsHtml \|\| errHtml \|\| reportHtml \? '' : '<div class="agent-step">No steps recorded\.<\/div>'\)\)/);
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
  h.telling.on = true;
  h.timers.at(-1).fn();
  assert.equal(h.requests.filter((u) => u === '/api/agents').length, 3, 'not while something is being typed to a task');
  h.telling.on = false;
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


// Starting tasks from the Agents tab: where one can answer, what is saved, a note while it works.
function agentRoutes(records, rpc = async () => ({ data: [{ id: 'x' }], error: null })) {
  const inserted = [], rpcs = [];
  const db = {
    from(table) {
      const filters = [];
      const q = {
        select() { return q; }, eq(k, v) { filters.push([k, v]); return q; },
        insert(row) { inserted.push({ table, row }); return { select: () => ({ single: async () => ({ data: { id: 'new-' + inserted.length, ...row }, error: null }) }) }; },
        maybeSingle: async () => ({ data: (records[table] || []).filter((r) => filters.every(([k, v]) => r[k] === v))[0] || null, error: null }),
        then(resolve) { return Promise.resolve({ data: (records[table] || []).filter((r) => filters.every(([k, v]) => r[k] === v)), error: null }).then(resolve); },
      };
      return q;
    },
    rpc: async (name, args) => { rpcs.push({ name, args }); return rpc(name, args); },
  };
  const handlers = {};
  const app = { get(p, fn) { handlers['GET ' + p] = fn; }, post(p, fn) { handlers['POST ' + p] = fn; } };
  const block = (from, to) => server.slice(server.indexOf(from), server.indexOf(to, server.indexOf(from)));
  const code = block('// The project a routine is saved into', 'app.post("/api/automations"')
    + block('// Where a task started on the Agents tab can answer:', 'app.get("/api/agents/:id", async')
    + block('// A task started from the Agents tab: what to do, its scope', '\n// ============================================================\n// AUTOMATIONS')
    + block('// Something to tell a task while it works', 'app.post("/api/agents/:id/stop"');
  vm.runInNewContext(code, { app, supabase: db, getUserIdFromRequest: () => 'owner', crypto: require('node:crypto'), console: { error() {} } });
  const call = async (key, req) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(v) { this.body = v; } }; await handlers[key]({ params: {}, body: {}, ...req }, res); return res; };
  return { call, inserted, rpcs };
}
const links = { chat_links: [{ user_id: 'owner', platform: 'telegram', platform_user_id: 'tg-1' }, { user_id: 'owner', platform: 'whatsapp_linked', platform_user_id: 'wa-1' }, { user_id: 'other', platform: 'slack', platform_user_id: 'sl-9' }], agent_tasks: [] };
test('a task can answer in the person\'s own chats, the web chat or only here, theirs first', async () => {
  const h = agentRoutes(links);
  const res = await h.call('GET /api/agents/places');
  assert.equal(res.body.map((p) => p.name).join(', '), 'WhatsApp, Telegram, The web chat, Only here');
  assert.ok(res.body.every((p) => !('chat_id' in p)), 'the page gets names, never chat ids');
});
test('a task started on the tab carries its scope and name, and answers in the chat chosen, looked up here', async () => {
  const h = agentRoutes(links);
  const ok = await h.call('POST /api/agents', { body: { goal: 'Compare hotels in Fukuoka for 14 to 17 Nov', scope: 'Under ¥20,000 a night. Do not book.', title: 'Fukuoka hotels', answer_in: 'whatsapp_linked' } });
  assert.equal(ok.code, 200);
  const row = h.inserted[0].row;
  assert.equal(row.goal, 'Compare hotels in Fukuoka for 14 to 17 Nov\n\nScope: Under ¥20,000 a night. Do not book.');
  assert.equal(row.title, 'Fukuoka hotels');
  assert.equal(JSON.stringify(row.runtime), '{"named":true}', 'the bot keeps the name it was given');
  assert.equal(row.platform, 'whatsapp_linked');
  assert.equal(row.chat_id, 'wa-1');
  await h.call('POST /api/agents', { body: { goal: 'Find flights to Seoul', answer_in: 'web' } });
  assert.equal(h.inserted[1].row.chat_id, 'owner', 'the web chat is the person\'s own');
  assert.equal(h.inserted[1].row.title, null);
  assert.equal(h.inserted[1].row.runtime, undefined);
  // In a project, as the plan's sentence can say: the task works inside it.
  const inProject = agentRoutes({ ...links, projects: [{ id: 'p1', user_id: 'owner', status: 'active' }, { id: 'p2', user_id: 'other', status: 'active' }] });
  await inProject.call('POST /api/agents', { body: { goal: 'Find a van for moving day', answer_in: 'web', project_id: 'p1' } });
  assert.equal(JSON.stringify(inProject.inserted[0].row.runtime), '{"projectId":"p1"}');
  const notTheirs = await inProject.call('POST /api/agents', { body: { goal: 'Find a van for moving day', answer_in: 'web', project_id: 'p2' } });
  assert.equal(notTheirs.code, 400, "another account's project is not theirs");
  const nope = await h.call('POST /api/agents', { body: { goal: 'Post to the team', answer_in: 'slack' } });
  assert.equal(nope.code, 400, 'another account\'s chat is not theirs');
  assert.equal(h.inserted.length, 2);
});
test('something told to a working task goes in as the chat\'s note does; a stopped one says so', async () => {
  const h = agentRoutes(links);
  const ok = await h.call('POST /api/agents/:id/note', { params: { id: 't1' }, body: { note: 'Only hotels with a gym' } });
  assert.equal(ok.code, 200);
  assert.equal(h.rpcs[0].name, 'append_agent_note');
  assert.equal(h.rpcs[0].args.p_task_id, 't1');
  assert.equal(h.rpcs[0].args.p_user_id, 'owner');
  assert.equal(h.rpcs[0].args.p_note.note, 'Only hotels with a gym');
  assert.equal((await h.call('POST /api/agents/:id/note', { params: { id: 't1' }, body: { note: ' ' } })).code, 400);
  const stopped = agentRoutes(links, async () => ({ data: [], error: null }));
  const res = await stopped.call('POST /api/agents/:id/note', { params: { id: 't9' }, body: { note: 'Faster please' } });
  assert.equal(res.code, 409);
  assert.match(res.body.error, /It has stopped/);
});
test('the bot keeps a name given on the tab, and names the rest itself', () => {
  assert.match(fs.readFileSync(path.join(root, 'lib/agents.js'), 'utf8'), /\.\.\.\(prepared\.title && !task\.runtime\?\.named \? \{ title: prepared\.title \} : \{\}\)/);
});
