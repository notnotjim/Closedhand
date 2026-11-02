// The New agent box: one description in the person's own words, then the plan
// Closedhand read from it as one sentence to change part by part; and every
// place results can go actually delivers, Email included.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const dashboard = read("webapp/views/dashboard.html");

test("one description holds the job and its limits; the words are saved whole and come back whole", () => {
  // Scope, rules and limits were fields of their own; an AI reads them from
  // the one description, so they are simply words in it.
  assert.doesNotMatch(dashboard, /id="auto-scope-input"|id="auto-quality-input"|id="auto-skills-picker"|id="auto-advanced"|id="auto-template-select"|id="auto-project-select"/);
  assert.match(dashboard, /task_prompt: prompt,\n/, "the words as written are the job");
  assert.match(dashboard, /document\.getElementById\('auto-prompt-input'\)\.value = a\.task_prompt \|\| a\.description \|\| '';/, "editing starts from the whole instructions");
  assert.match(read("webapp/server.js"), /project_id, task_prompt, task_tools, created_at, updated_at";/, "the list gives the editor the whole instructions, not the 200-character description");
  // Older routines carry their rules inside their words, and the bot still checks them.
  assert.match(read("lib/automations.js"), /If the task includes a RULES list \(or, in older tasks, a QUALITY CHECK section\), check the result against each one explicitly/);
});

test("each part of the plan says what it means, in the names the person sees elsewhere", () => {
  assert.match(dashboard, /rows\.push\(\{ kind: 'manual', label: 'When you ask', note: 'In any chat, or with Run on its card' \}\);/);
  assert.doesNotMatch(dashboard, /Preferred skills|>Urgent</, "skills come with the job, and urgency is said in the words");
  assert.match(dashboard, /<p class="plan-hint">In a project, it works with the project's instructions and files, and its results come in the project's conversation\.<\/p>/);
  assert.match(read("webapp/public/builtin-skills.json"), /"name": "Comment on Instagram posts",/);
  assert.doesNotMatch(dashboard, /'the workspace browser'|'the workspace'/, "the sandbox computer is called that on agent cards too");
});

test("the box: one roomy description, starting points under it, then the plan and one main action", () => {
  // It asks for a job, not an agent: titled New agent, adding agents inside it read as a loop.
  assert.match(dashboard, /<div class="modal agent-modal composer" role="dialog" aria-labelledby="auto-modal-title">\n\s*<h3 id="auto-modal-title">What should the agent do\?<\/h3>/);
  assert.match(dashboard, /<div class="ask-box">\n\s*<textarea id="auto-prompt-input" rows="3" aria-labelledby="auto-modal-title" placeholder="e\.g\. /);
  assert.match(dashboard, /\.ask-box \{ border: 1px solid rgba\(var\(--accent-rgb\),0\.24\);[^}]*box-shadow: 0 0 2\.5rem rgba\(var\(--accent-rgb\),0\.07\);/, "the ember edge of Connect anything");
  assert.match(dashboard, /<p class="starters-label">Or start from one of these<\/p>/);
  assert.match(dashboard, /<button type="button" class="cta" id="auto-save-btn" onclick="composerGo\(\)">Next<\/button>/, "one main action, as every screen has");
  assert.match(dashboard, /\.modal select \{\n\s*appearance: none;[\s\S]{0,120}padding-right: 2.125rem !important;[\s\S]{0,500}background-position: right 0.75rem center;/);
});


test("Email sends the results from the assistant's own address to its owner, as a new conversation", async () => {
  const inserts = [];
  const account = { user_id: "u1", address: "pete-1a2b3c4d@assist.closedhand.ai", owner_email: "sam@example.com", enabled: true };
  const fakeDb = { from(table) {
    let op = "select";
    const q = { select: () => q, eq: () => q, maybeSingle: () => q, single: () => q,
      insert(row) { op = "insert"; inserts.push({ table, row }); return q; },
      then(done) {
        if (op === "insert") return done({ data: null, error: null });
        if (table === "assistant_email_accounts") return done({ data: account, error: null });
        if (table === "profiles") return done({ data: { settings: { bot_name: "Pete", preferred_name: "Sam" }, display_name: null }, error: null });
        return done({ data: null, error: null });
      } };
    return q;
  } };
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && /lib\/(assistant-email|own-email)\.js$/.test(parent.filename)) {
      if (request === "./db") return { supabase: fakeDb };
      if (request === "./context") return { activeUserId: "u1" };
    }
    return load.call(this, request, parent, ...rest);
  };
  try {
    for (const m of ["../lib/assistant-email", "../lib/own-email"]) delete require.cache[require.resolve(m)];
    const id = await require("../lib/own-email").sendToSelf("Oil monitor", "Brent is up 2%.\n[[next]]\nSee the page.");
    assert.match(id, /^[0-9a-f-]{36}$/);
    account.enabled = false; account.address = null;
    await assert.rejects(require("../lib/own-email").sendToSelf("Oil monitor", "x"), /Turn on Closedhand’s email address in Settings/);
  } finally { Module._load = load; }
  const thread = inserts.find((i) => i.table === "assistant_email_threads").row;
  assert.deepEqual(thread.participants, ["sam@example.com"]);
  const message = inserts.find((i) => i.table === "assistant_email_messages").row;
  assert.equal(message.state, "outbox");
  assert.equal(message.direction, "out");
  assert.deepEqual(message.envelope.to, ["sam@example.com"], "to the owner only");
  assert.equal(message.envelope.replyToDelivery, null, "a new email, not a reply");
  assert.equal(message.envelope.displayName, "Pete, Sam’s assistant");
  assert.equal(message.envelope.text, "Brent is up 2%.\n\nSee the page.\n\nPete, Sam’s assistant");

  const { destinationsFor } = require("../lib/task-delivery");
  const row = (dests) => ({ user_id: "u", platform: "web", chat_id: "u", runtime: { config: { name: "Oil monitor", output_destinations: dests } } });
  assert.deepEqual(await destinationsFor(null, "automation_runs", row(["email"])), [{ platform: "own_email", chatId: "Oil monitor" }]);
  assert.deepEqual(await destinationsFor(null, "automation_runs", row(["dashboard"])), [], "dashboard only sends nothing to any chat");
  assert.match(read("lib/messaging.js"), /if \(platform === "own_email"\) return require\("\.\/own-email"\)\.sendToSelf\(chatId, message\);/);
});

test("with the assistant's address off, Email says where to turn it on and cannot be saved", () => {
  assert.match(dashboard, /_assistantEmail = \{ on: !!\(d\.available && d\.enabled && d\.address\), name: d\.name \|\| 'Closedhand' \};/);
  assert.match(dashboard, /hint\.innerHTML = 'Turn on ' \+ escapeHtml\(_assistantEmail\.name\) \+ '\\u2019s email address in <a href="#" onclick="openEmailSettings\(\);return false;">Settings<\/a> to use this\.';/);
  assert.match(dashboard, /if \(_selectedDest === 'email' && _assistantEmail && !_assistantEmail\.on\) \{ errEl\.textContent = 'Turn on '/);
  assert.match(dashboard, /function openCreateAutomationModal\(mode\) \{\n\s*loadAssistantEmailState\(\);/);
  assert.doesNotMatch(read("lib/own-email.js"), /gmail_send|outlook_send/, "one meaning for Email: from the assistant's address");
});
