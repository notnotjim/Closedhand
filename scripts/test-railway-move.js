// Go always-on in one button (webapp/railway-move.js): Railway's sign-in as a
// native app with PKCE, back through closedhand.com, then a project made from
// the template in the region nearest the person with a setup code Closedhand chose, and the move
// once the new Closedhand answers. Railway is played here by a stand-in.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

process.env.RAILWAY_CLIENT_ID = "test-client";
const railwayMove = require("../webapp/railway-move");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("only a personal URL or the computer itself can be sent back to", () => {
  assert.equal(railwayMove.backAddress("https://bright-fern-21.closedhand.ai"), "https://bright-fern-21.closedhand.ai");
  assert.equal(railwayMove.backAddress("http://localhost:3000"), "http://localhost:3000");
  assert.equal(railwayMove.backAddress("http://127.0.0.1:4100"), "http://127.0.0.1:4100");
  for (const bad of ["https://evil.example", "http://bright-fern-21.closedhand.ai", "https://a.closedhand.ai.evil.example", "https://user:pw@bright-fern-21.closedhand.ai", "", null])
    assert.equal(railwayMove.backAddress(bad), null, String(bad));
  assert.throws(() => railwayMove.begin("https://evil.example"), /personal URL/);
});

test("the sign-in is PKCE with no secret, and says where to come back to", () => {
  const url = new URL(railwayMove.begin("https://bright-fern-21.closedhand.ai"));
  assert.equal(url.origin + url.pathname, "https://backboard.railway.com/oauth/auth");
  const q = url.searchParams;
  assert.equal(q.get("client_id"), "test-client");
  assert.equal(q.get("redirect_uri"), "https://closedhand.com/railway/return");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.get("scope"), /\bworkspace:member\b/);
  const state = JSON.parse(Buffer.from(q.get("state"), "base64url").toString());
  assert.equal(state.b, "https://bright-fern-21.closedhand.ai");
  assert.ok(state.s.length >= 32);
  assert.ok(!url.href.includes("secret"));
});

test("a stale or cancelled sign-in moves nothing", () => {
  railwayMove.begin("http://localhost:3000");
  railwayMove.finish({ code: "c", state: Buffer.from(JSON.stringify({ b: "http://localhost:3000", s: "not-this-one" })).toString("base64url") }, { startMove: () => assert.fail("moved") });
  assert.equal(railwayMove.status().step, "failed");
  assert.match(railwayMove.status().error, /expired/);
  const state = new URL(railwayMove.begin("http://localhost:3000")).searchParams.get("state");
  railwayMove.finish({ error: "access_denied", state }, { startMove: () => assert.fail("moved") });
  assert.match(railwayMove.status().error, /cancelled\. Nothing has moved/);
});

test("back from Railway: a project from the template in the region nearest the person, its own setup code, then the move", async () => {
  const signIn = new URL(railwayMove.begin("http://localhost:3000", "Asia/Tokyo"));
  const challenge = signIn.searchParams.get("code_challenge");
  const calls = [];
  let polls = 0;
  const config = { services: {
    a: { name: "db", variables: { POSTGRES_PASSWORD: { defaultValue: "${{secret(32)}}" } } },
    b: { name: "webapp", deploy: { healthcheckPath: "/health" }, variables: { PORT: { defaultValue: "3000" }, SETUP_CODE: { defaultValue: "${{secret(24)}}" } } },
    c: { name: "bot", variables: {} },
    d: { name: "sandbox", variables: {} },
  } };
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url === "https://backboard.railway.com/oauth/token") {
      const form = new URLSearchParams(String(opts.body));
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "the-code");
      assert.equal(form.get("client_id"), "test-client");
      assert.equal(form.get("redirect_uri"), "https://closedhand.com/railway/return");
      assert.equal(crypto.createHash("sha256").update(form.get("code_verifier")).digest("base64url"), challenge, "the verifier matches the challenge");
      assert.ok(!form.has("client_secret") && !(opts.headers || {}).Authorization, "no secret");
      return reply({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });
    }
    if (url === "https://backboard.railway.com/graphql/v2") {
      assert.equal(opts.headers.Authorization, "Bearer tok");
      const { query, variables } = JSON.parse(opts.body);
      if (/me \{ workspaces/.test(query)) return reply({ data: { me: { workspaces: [{ id: "ws1" }] } } });
      if (/template\(id/.test(query)) { assert.equal(variables.t, "86557f2f-7a26-46c6-9599-0b9c8f422dab"); return reply({ data: { template: { id: "tpl", serializedConfig: JSON.parse(JSON.stringify(config)) } } }); }
      if (/projectCreate/.test(query)) { assert.equal(variables.i.workspaceId, "ws1"); return reply({ data: { projectCreate: { id: "proj", environments: { edges: [{ node: { id: "env" } }] } } } }); }
      if (/environmentStagedChanges/.test(query)) return reply({ data: { environmentStagedChanges: { id: "patch", patch: { services: { "svc-web": {}, "svc-db": {} } } } } });
      if (/environmentStageChanges/.test(query)) return reply({ data: { environmentStageChanges: { id: "patch" } } });
      if (/environmentPatchCommitStaged/.test(query)) return reply({ data: { environmentPatchCommitStaged: "ok" } });
      if (/templateDeployV2/.test(query)) return reply({ data: { templateDeployV2: { projectId: "proj" } } });
      if (/project\(id/.test(query)) {
        polls++;
        const status = polls < 2 ? "DEPLOYING" : "SUCCESS";
        return reply({ data: { project: { services: { edges: [{ node: { name: "webapp", serviceInstances: { edges: [{ node: { latestDeployment: { status }, domains: { serviceDomains: [{ domain: "webapp-production-1.up.railway.app" }] } } }] } } }] } } } });
      }
    }
    if (url === "https://webapp-production-1.up.railway.app/health") return reply({ ok: true });
    throw new Error("unexpected " + url);
  };
  const moved = new Promise((resolve) => {
    railwayMove.finish({ code: "the-code", state: signIn.searchParams.get("state") }, { fetch: fakeFetch, pollMs: 1, startMove: resolve });
  });
  assert.equal(railwayMove.status().step, "setting-up");
  const to = await moved;
  assert.equal(to.address, "https://webapp-production-1.up.railway.app");
  assert.match(to.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{24}$/);
  const deploy = JSON.parse(calls.find((c) => /templateDeployV2/.test(c.opts.body || "")).opts.body).variables.i;
  assert.deepEqual([deploy.templateId, deploy.projectId, deploy.environmentId, deploy.workspaceId], ["tpl", "proj", "env", "ws1"]);
  for (const svc of Object.values(deploy.serializedConfig.services))
    assert.deepEqual(svc.deploy.multiRegionConfig, { "asia-southeast1-eqsg3a": { numReplicas: 1 } }, svc.name + " in Singapore, nearest someone in Tokyo");
  assert.equal(deploy.serializedConfig.services.b.deploy.healthcheckPath, "/health", "the template's own settings kept");
  assert.equal(deploy.serializedConfig.services.b.variables.SETUP_CODE.defaultValue, to.code, "the setup code the move then uses");
  assert.equal(deploy.serializedConfig.services.a.variables.POSTGRES_PASSWORD.defaultValue, "${{secret(32)}}", "other secrets still made by Railway");
  assert.equal(railwayMove.status(), null, "from here the move itself reports");
});

test("Settings is one button, and closedhand.com passes the sign-in straight on", () => {
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /<button type="button" class="cta" id="move-go" onclick="startRailwayMove\(\)">Move to Railway<\/button>/);
  // A section of its own, before Your data, shown as Models are: a card for
  // each computer, the one it runs on In use, then the ways to move it with
  // what each costs and that the computer it leaves stops running Closedhand.
  assert.match(dash, /<div class="settings-group" id="always-on" hidden>\n\s*<div class="settings-group-header">\n\s*<h2>Always on<\/h2>\n\s*<p class="section-desc">Choose the computer Closedhand runs on<\/p>/);
  assert.match(dash, /<section class="choice-card in-use" id="always-on-here" aria-labelledby="always-on-here-name">\n\s*<header class="choice-head"><h3 id="always-on-here-name"><\/h3><span class="plan-status on">In use<\/span><\/header>/, "where it runs now, said as Models say it");
  for (const id of ["always-on-computer", "always-on-move"])
    assert.match(dash, new RegExp(`<section class="choice-card" id="${id}" aria-labelledby="${id}-name" hidden>\\n\\s*<header class="choice-head"><h3 id="${id}-name">[^<]+<\\/h3><span class="plan-status over">Not in use<\\/span><\\/header>`), id);
  assert.ok(dash.indexOf('id="always-on-here"') < dash.indexOf('id="always-on-computer"'), "the one in use first");
  assert.match(dash, /document\.getElementById\("always-on-here-name"\)\.textContent = hostText\('Your computer', 'A server on Railway'\);/);
  assert.match(dash, /'Closedhand runs day and night on your server' \+ \(railwayHome && railwayHome\.city \? ' in ' \+ railwayHome\.city : ''\) \+ '\. Railway bills you for it, about \$10 to \$20 a month\.'/);
  assert.match(dash, /<a class="quiet-link" id="always-on-railway-open" target="_blank" rel="noopener" hidden>Open Railway<\/a>/, "their own project on Railway, for the bill and deleting it");
  assert.match(dash, /var place = data\.alwaysOnPlace \? ' in ' \+ data\.alwaysOnPlace : '', railwayHome = data\.railwayHome;/);
  assert.match(dash, /document\.getElementById\("always-on-railway"\)\.textContent = 'Railway rents you a server' \+ \(place \|\| ' near you'\) \+ ' on its Hobby plan, for about \$10 to \$20 a month\. Everything moves there and your computer stops running Closedhand\.';/, "named where it would run");
  assert.ok(dash.indexOf('id="always-on"') < dash.indexOf('id="account-section"'), "before Account");
  assert.match(dash, /document\.getElementById\("always-on"\)\.hidden = !data\.canGoAlwaysOn && !data\.canMoveToComputer && document\.documentElement\.dataset\.host !== 'railway';[\s\S]{0,1600}document\.getElementById\("always-on-move"\)\.hidden = !data\.canGoAlwaysOn;/, "on Railway it says it is there");
  assert.ok(dash.indexOf('id="always-on-computer"') < dash.indexOf('id="always-on-move"'), "a computer of their own first, Railway second");
  assert.doesNotMatch(dash, /always-on-handle|toggleAlwaysOn/, "no quiet line to open");
  assert.match(read("webapp/railway-move.js"), /Press Move to Railway again\./, "errors name the button as it is");
  assert.doesNotMatch(read("webapp/railway-move.js").replace(/^\/\/.*$/gm, ""), /Press Go always-on/);
  const railwayRow = dash.slice(dash.indexOf('<section class="choice-card" id="always-on-move"'), dash.indexOf('<div class="settings-group" id="account-section">'));
  assert.doesNotMatch(railwayRow, /move-address|move-code|railway\.com\/deploy/, "nothing to copy or paste for Railway");
  assert.match(dash, /window\.top\.location\.href = j\.url;/);
  const server = read("webapp/server.js");
  assert.match(server, /app\.get\("\/api\/move\/railway\/return"[\s\S]{0,400}res\.redirect\("\/\?dash=%23account"\)/, "back to My Account, where the move shows");
  assert.match(server, /canGoAlwaysOn: !setupCode\.enabled && moveMarker\.available\(\) && railwayMove\.available\(\)/);
  const site = read("closedhand-com/server.js");
  assert.match(site, /app\.get\('\/railway\/return'[\s\S]{0,500}new URL\('\/api\/move\/railway\/return', back\)/);
  assert.match(site, /if \(u\.protocol === 'https:'\) return require\('\.\/public\/entry-navigation'\)\.registeredAddress\(u\.origin\);/);
});

test("Closedhand's own Railway app is built in, so Go always-on is there without setup", () => {
  assert.match(read("webapp/railway-move.js"), /const CLIENT_ID = process\.env\.RAILWAY_CLIENT_ID \|\| "rlwy_oaci_[A-Za-z0-9]+";/);
  assert.doesNotMatch(read("webapp/railway-move.js"), /client_secret|CLIENT_SECRET/, "no secret, anywhere");
});

test("a move that fails after the project was made takes the project away, so nothing is left on the bill", async () => {
  const run = async (failAt) => {
    const signIn = new URL(railwayMove.begin("http://localhost:3000"));
    const calls = [];
    const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const fakeFetch = async (url, opts = {}) => {
      if (url.endsWith("/oauth/token")) return reply({ access_token: "tok" });
      if (url.endsWith("/health")) return reply({ ok: true });
      const { query } = JSON.parse(opts.body);
      calls.push(query.match(/\b(me|template|projectCreate|templateDeployV2|projectDelete|project)\b/)[1]);
      if (/me \{ workspaces/.test(query)) return reply({ data: { me: { workspaces: [{ id: "ws1" }] } } });
      if (/template\(id/.test(query)) return reply({ data: { template: { id: "tpl", serializedConfig: { services: { b: { name: "webapp", variables: {} } } } } } });
      if (/projectCreate/.test(query)) return reply({ data: { projectCreate: { id: "proj", environments: { edges: [{ node: { id: "env" } }] } } } });
      if (/environmentStagedChanges/.test(query)) return reply({ data: { environmentStagedChanges: { id: "patch", patch: { services: { "svc-web": {}, "svc-db": {} } } } } });
      if (/environmentStageChanges/.test(query)) return reply({ data: { environmentStageChanges: { id: "patch" } } });
      if (/environmentPatchCommitStaged/.test(query)) return reply({ data: { environmentPatchCommitStaged: "ok" } });
      if (/templateDeployV2/.test(query)) return failAt === "deploy" ? reply({ errors: [{ message: "Your trial has ended" }] }) : reply({ data: { templateDeployV2: { projectId: "proj" } } });
      if (/projectDelete/.test(query)) return reply({ data: { projectDelete: true } });
      return reply({ data: { project: { services: { edges: [{ node: { name: "webapp", serviceInstances: { edges: [{ node: { latestDeployment: { status: "SUCCESS" }, domains: { serviceDomains: [{ domain: "w.up.railway.app" }] } } }] } } }] } } } });
    };
    let moveStep = "sending";
    await new Promise((resolve) => {
      railwayMove.finish({ code: "c", state: signIn.searchParams.get("state") },
        { fetch: fakeFetch, pollMs: 1, startMove: () => { moveStep = "failed"; }, moveStatus: () => ({ step: moveStep }) });
      setTimeout(resolve, 80);
    });
    return calls;
  };
  const atDeploy = await run("deploy");
  assert.deepEqual(atDeploy.slice(-2), ["templateDeployV2", "projectDelete"], "a deploy Railway refuses");
  assert.match(railwayMove.status().error, /Your trial has ended\. Nothing has moved/);
  const laterOn = await run("move");
  assert.equal(laterOn[laterOn.length - 1], "projectDelete", "a move that stops after it started");
});

test("Closedhand goes to Railway's region nearest the person, and Settings names it only when it is Europe", () => {
  const near = (zone) => (railwayMove.placeOf(railwayMove.regionFor(zone)) || "near you") + " " + railwayMove.regionFor(zone);
  assert.equal(near("Europe/London"), "Europe europe-west4-drams3a");
  assert.equal(near("Africa/Lagos"), "Europe europe-west4-drams3a");
  assert.equal(near("America/New_York"), "near you us-east4-eqdc4a");
  assert.equal(near("America/Chicago"), "near you us-east4-eqdc4a");
  assert.equal(near("America/Denver"), "near you us-west2", "the Rockies west, in winter and summer alike");
  assert.equal(near("America/Los_Angeles"), "near you us-west2");
  assert.equal(near("Asia/Tokyo"), "near you asia-southeast1-eqsg3a");
  assert.equal(near("Australia/Sydney"), "near you asia-southeast1-eqsg3a");
  assert.equal(near(null), "Europe europe-west4-drams3a", "with no zone to go by");
  assert.equal(near("Not/AZone"), "Europe europe-west4-drams3a");
  const server = read("webapp/server.js");
  assert.match(server, /return \(settings\.location && settings\.location\.timezone\) \|\| settings\.timezone \|\| null;/, "the saved place, not where the phone is this week");
  assert.match(server, /res\.json\(\{ url: railwayMove\.begin\(req\.get\("origin"\), await homeZone\(userId\)\) \}\)/);
  assert.match(server, /alwaysOnPlace: railwayMove\.placeOf\(process\.env\.RAILWAY_REPLICA_REGION \|\| railwayMove\.regionFor\(await homeZone\(userId\)\.catch\(\(\) => null\)\)\),/, "the card names the same place the move goes to");
});

// Moving away from Railway, where the bot and the dashboard each have a
// folder of their own (lib/move-idle.js, lib/move-files.js).
test("moving away from Railway: the bot writes the dashboard's move marker into its own folder, and puts its own files in the database to go along", async () => {
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "railway-bot-"));
  const saved = { dir: process.env.STORAGE_DIR, exit: process.exit };
  process.env.STORAGE_DIR = dir;
  const ticket = require("../lib/ws-ticket");
  const realVerify = ticket.verifyToken;
  ticket.verifyToken = (t) => t === "the-dashboard";
  let exits = 0;
  process.exit = () => { exits += 1; };
  // express isn't installed where these tests run: the routes need only its JSON parser's place.
  const Module = require("node:module");
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "express") return Object.assign(() => ({}), { json: () => (req, res, next) => next() });
    return realLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve("../lib/move-idle")];
    const routes = {};
    require("../lib/move-idle").registerRestart({ post: (p, ...handlers) => { routes[p] = handlers[handlers.length - 1]; } }, async () => {});
    const answer = () => { const r = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; return r; };
    const ask = async (route, body, token = "the-dashboard") => { const r = answer(); await routes[route]({ get: () => token, body }, r); return r; };
    const marker = require("../lib/move-marker");

    assert.equal((await ask("/internal/restart", { marker: { state: "moving", to: "https://quiet-test.example" } }, "someone-else")).code, 401);
    assert.equal(marker.read(), null, "nobody else can write it");
    await ask("/internal/restart", { marker: { state: "moving", to: "https://quiet-test.example" } });
    assert.equal(marker.read().state, "moving", "the bot sits still on its own volume too");
    await ask("/internal/restart", { marker: null });
    assert.equal(marker.read(), null, "and carries on when the move is given back");
    await ask("/internal/restart", { marker: { state: "moved", to: "https://quiet-test.example" } });
    assert.equal(marker.read().state, "moved", "and never starts again once it has moved");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(exits, 3, "each time it restarts to read it afresh");

    fs.mkdirSync(path.join(dir, "wa-linked-session"), { recursive: true });
    fs.writeFileSync(path.join(dir, "wa-linked-session", "creds.json"), '{"me":"made-up"}');
    const queries = [];
    const pool = { query: async (sql, params) => { queries.push([sql.split(" ")[0], ...(params || []).map((p) => (Buffer.isBuffer(p) ? p.toString() : p))]); return { rows: [] }; } };
    assert.equal(await require("../lib/move-files").stash(pool), 1);
    assert.deepEqual(queries, [["DELETE", "_moved-bot-files"], ["INSERT", "_moved-bot-files", "wa-linked-session/creds.json", '{"me":"made-up"}']], "the WhatsApp session goes along");
  } finally {
    Module._load = realLoad;
    ticket.verifyToken = realVerify;
    process.exit = saved.exit;
    if (saved.dir === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = saved.dir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const move = fs.readFileSync(path.join(__dirname, "..", "webapp", "move.js"), "utf8");
  assert.match(move, /if \(!deps\.storageDir && deps\.stashBotFiles\) await deps\.stashBotFiles\(\)/, "asked for before the export, where this side can't read the bot's folder");
  const server = fs.readFileSync(path.join(__dirname, "..", "webapp", "server.js"), "utf8");
  assert.match(server, /body: JSON\.stringify\(\{ marker: moveMarker\.read\(\) \}\)/, "every restart carries the marker");
});

test("a move shows as the journey it is: from here to where it goes, the steps ticked, a real percentage, and the ways to move out of the way meanwhile", () => {
  const dash = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "dashboard.html"), "utf8");
  assert.match(dash, /<div class="move-progress-box" id="move-progress-box" hidden><\/div>/);
  assert.match(dash, /document\.getElementById\('always-on-places'\)\.classList\.toggle\('mp-aside', busy \|\| st\.step === 'done'\);/, "no offer to move while moving");
  assert.match(dash, /\.account-action-btn\[hidden\] \{ display: none; \}/, "a hidden button stays hidden");
  assert.match(dash, /var steps = toRailway \? \['Setting up on Railway', 'Moving everything', 'Handing over'\]/);
  const setup = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "setup.html"), "utf8");
  assert.match(setup, /var BRING_STEPS = \["Checking with the other computer", "Moving everything", "Taking it all in", "Starting here"\];/, "the same picture on the computer it goes to");
  const css = fs.readFileSync(path.join(__dirname, "..", "webapp", "public", "interface.css"), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n\s*\.move-progress \.mp-rail, \.move-progress \.mp-fist/, "still for anyone who asks for less motion");

  // The picture, drawn into a stand-in page and changed in place.
  const vm = require("node:vm");
  const made = [];
  const node = (tag) => {
    const n = { tag, className: "", textContent: "", innerHTML: "", children: [], style: { setProperty() {} }, attrs: {}, src: "", alt: "",
      classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      setAttribute(k, v) { this.attrs[k] = v; }, append(...k) { this.children.push(...k); }, get childElementCount() { return this.children.length; },
      querySelector(sel) { const want = sel.replace(".", ""); const find = (x) => { for (const c of x.children || []) { if (String(c.className).split(" ").includes(want)) return c; const f = find(c); if (f) return f; } return null; }; return find(this); } };
    made.push(n);
    return n;
  };
  let confetti = 0;
  const ctx = vm.createContext({ document: { createElement: node }, window: { Delight: { confetti: () => { confetti++; } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "webapp", "public", "move-progress.js"), "utf8"), ctx);
  const box = node("div");
  const show = (s) => ctx.window.MoveProgress.show(box, { from: "This computer", to: "Railway", toKind: "server", steps: ["Setting up on Railway", "Moving everything", "Handing over"], ...s });
  show({ at: 1, percent: 62, moved: "403 MB moved" });
  const m = box._mp;
  assert.deepEqual([m.fill.style.width, m.fist.style.left, m.figures.querySelector(".mp-percent").textContent, m.figures.querySelector(".mp-moved").textContent], ["62%", "62%", "62%", "403 MB moved"]);
  assert.deepEqual(m.steps.children.map((li) => li.className), ["is-done", "is-now", ""]);
  const root = m.root;
  show({ at: 3, percent: 100, done: true });
  assert.equal(box._mp.root, root, "changed in place, so the motion carries on");
  assert.equal(m.figures.querySelector(".mp-percent").textContent, "Done");
  assert.equal(confetti, 1, "it arrives with the one confetti");
  show({ at: 3, percent: 100, done: true });
  assert.equal(confetti, 1, "once");
});

test("after a move: WhatsApp's card says when WhatsApp asks to link again, and setup's hello is never said twice, wherever setup is opened", () => {
  const { split } = require("../webapp/connection-health");
  assert.deepEqual(split([
    { service: "whatsapp_linked", metadata: { linked: false, qr: "2@made-up" } },
    { service: "google", metadata: {} },
  ]), { working: ["google"], signInAgain: ["whatsapp_linked"] }, "asking to pair again is a sign-in to do again");
  assert.deepEqual(split([{ service: "whatsapp_linked", metadata: { linked: true, jid: "made-up" } }]).signInAgain, [], "linked is linked");
  const server = fs.readFileSync(path.join(__dirname, "..", "webapp", "server.js"), "utf8");
  assert.match(server, /platforms\[key\]\.linkAgain = health\.signInAgain\.includes\("whatsapp_linked"\);/);
  assert.match(server, /res\.json\(\{ \.\.\.state, finished: !!\(await getRuntimeConf\("SETUP_FINISHED"\)\) \}\);/);
  const dash = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "dashboard.html"), "utf8");
  assert.match(dash, /\$\{platform\.linkAgain \? `<span class="int-badge problem"/, "the same mark as any connection that stopped working");
  assert.match(dash, /href="\/setup#step-chat=whatsapp" onclick="event\.stopPropagation\(\)">Link again<\/a>/);
  const setup = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "setup.html"), "utf8");
  assert.match(setup, /if \(lastComplete === false && complete && !finishedBefore && !celebrated\(\)\) celebrate\(\);/, "finished before: no hello, on any address");
  assert.match(setup, /var stays = document\.documentElement\.dataset\.host === "railway" \? "It all stays in your Railway account\." : "It all stays on your computer\.";/);
});

test("a move stages the template, places every service in the region nearest the person, then commits; nothing is moved after it exists", async () => {
  const play = ({ stageRefused = false } = {}) => new Promise((resolve) => {
    const signIn = new URL(railwayMove.begin("http://localhost:3000", "Asia/Tokyo"));
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    const calls = [];
    const fakeFetch = async (url, opts = {}) => {
      if (url.endsWith("/oauth/token")) return reply({ access_token: "tok" });
      if (url.endsWith("/health")) return reply({ ok: true });
      const { query, variables } = JSON.parse(opts.body);
      if (/me \{ workspaces/.test(query)) return reply({ data: { me: { workspaces: [{ id: "ws1" }] } } });
      if (/template\(id/.test(query)) return reply({ data: { template: { id: "tpl", serializedConfig: { services: { b: { name: "webapp", variables: {} } } } } } });
      if (/projectCreate/.test(query)) return reply({ data: { projectCreate: { id: "proj", environments: { edges: [{ node: { id: "env" } }] } } } });
      calls.push([query.match(/\b(templateDeployV2|environmentStagedChanges|environmentStageChanges|environmentPatchCommitStaged|serviceInstanceUpdate|serviceInstanceDeployV2|project)\b/)[1], variables]);
      if (/templateDeployV2/.test(query)) return stageRefused && variables.i.stageOnly ? reply({ errors: [{ message: "stageOnly is not allowed" }] }) : reply({ data: { templateDeployV2: { projectId: "proj" } } });
      if (/environmentStagedChanges/.test(query)) return reply({ data: { environmentStagedChanges: { id: "patch", patch: { services: { "svc-web": {}, "svc-db": {} } } } } });
      if (/environmentStageChanges/.test(query)) return reply({ data: { environmentStageChanges: { id: "patch" } } });
      if (/environmentPatchCommitStaged/.test(query)) return reply({ data: { environmentPatchCommitStaged: "ok" } });
      return reply({ data: { project: { services: { edges: [{ node: { name: "webapp", serviceInstances: { edges: [{ node: { latestDeployment: { status: "SUCCESS" }, domains: { serviceDomains: [{ domain: "w.up.railway.app" }] } } }] } } }] } } } });
    };
    railwayMove.finish({ code: "c", state: signIn.searchParams.get("state") }, { fetch: fakeFetch, pollMs: 1, startMove: (to) => resolve({ to, calls }) });
  });
  const { to, calls } = await play();
  const names = calls.map((c) => c[0]).filter((n) => n !== "project");
  assert.deepEqual(names, ["templateDeployV2", "environmentStagedChanges", "environmentStageChanges", "environmentPatchCommitStaged"]);
  assert.equal(calls[0][1].i.stageOnly, true, "staged, not deployed");
  assert.deepEqual(calls[2][1], { e: "env", i: { services: { "svc-web": { deploy: { multiRegionConfig: { "asia-southeast1-eqsg3a": { numReplicas: 1 } } } }, "svc-db": { deploy: { multiRegionConfig: { "asia-southeast1-eqsg3a": { numReplicas: 1 } } } } } } }, "every service placed while nothing exists");
  assert.equal(to.address, "https://w.up.railway.app");
  const refused = await play({ stageRefused: true });
  assert.deepEqual(refused.calls.filter((c) => c[0] === "templateDeployV2").map((c) => !!c[1].i.stageOnly), [true, false], "Railway won't stage: a plain deploy, in its default region");
  assert.ok(!refused.calls.some((c) => /serviceInstanceUpdate|serviceInstanceDeployV2/.test(c[0])), "and nothing is moved after it exists");
  assert.doesNotMatch(read("webapp/railway-move.js"), /serviceInstanceUpdate/, "no region change once a database has started");
});
test("on Railway, My Account says where the server is and links to the person's own project; anywhere else nothing", () => {
  assert.equal(railwayMove.home({}), null);
  assert.deepEqual(railwayMove.home({ RAILWAY_PROJECT_ID: "proj-123", RAILWAY_REPLICA_REGION: "asia-southeast1-eqsg3a" }),
    { city: "Singapore", project: "https://railway.com/project/proj-123" });
  assert.deepEqual(railwayMove.home({ RAILWAY_PROJECT_ID: "proj-123", RAILWAY_REPLICA_REGION: "somewhere-new" }).city, null, "a region not known yet is not named");
  assert.match(read("webapp/server.js"), /railwayHome: railwayMove\.home\(\),/);
});

test("a Railway account on the trial or Free plan is told what it needs before anything is made; with several workspaces, the paid one is used", async () => {
  const play = (workspaces) => new Promise((resolve) => {
    const signIn = new URL(railwayMove.begin("http://localhost:3000", "Europe/London"));
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    const made = [];
    const fakeFetch = async (url, opts = {}) => {
      if (url.endsWith("/oauth/token")) return reply({ access_token: "tok" });
      if (url.endsWith("/health")) return reply({ ok: true });
      const { query, variables } = JSON.parse(opts.body);
      if (/me \{ workspaces/.test(query)) return reply({ data: { me: { workspaces: /plan/.test(query) ? workspaces : workspaces.map((w) => ({ id: w.id })) } } });
      if (/template\(id/.test(query)) return reply({ data: { template: { id: "tpl", serializedConfig: { services: { b: { name: "webapp", variables: {} } } } } } });
      if (/projectCreate/.test(query)) { made.push(variables.i.workspaceId); return reply({ data: { projectCreate: { id: "proj", environments: { edges: [{ node: { id: "env" } }] } } } }); }
      if (/environmentStagedChanges/.test(query)) return reply({ data: { environmentStagedChanges: { id: "patch", patch: { services: { "svc-web": {}, "svc-db": {} } } } } });
      if (/environmentStageChanges/.test(query)) return reply({ data: { environmentStageChanges: { id: "patch" } } });
      if (/environmentPatchCommitStaged/.test(query)) return reply({ data: { environmentPatchCommitStaged: "ok" } });
      if (/templateDeployV2/.test(query)) return reply({ data: { templateDeployV2: { projectId: "proj" } } });
      return reply({ data: { project: { services: { edges: [{ node: { id: "w", name: "webapp", serviceInstances: { edges: [{ node: { latestDeployment: { status: "SUCCESS" }, domains: { serviceDomains: [{ domain: "w.up.railway.app" }] } } }] } } }] } } } });
    };
    railwayMove.finish({ code: "c", state: signIn.searchParams.get("state") }, { fetch: fakeFetch, pollMs: 1, startMove: () => resolve({ moved: true, made }) });
    setTimeout(() => resolve({ moved: false, made, status: railwayMove.status() }), 100);
  });
  const trial = await play([{ id: "ws-trial", plan: "FREE", customer: { isTrialing: true } }]);
  assert.equal(trial.moved, false);
  assert.deepEqual(trial.made, [], "no project made, nothing on a bill");
  assert.match(trial.status.error, /needs Railway's Hobby plan first\. Choose it at railway\.com\/workspace\/plans, then press Move to Railway again\. Nothing has moved/);
  const trialHobby = await play([{ id: "ws", plan: "HOBBY", customer: { isTrialing: true } }]);
  assert.equal(trialHobby.moved, false, "still on the trial");
  const two = await play([{ id: "ws-free", plan: "FREE", customer: { isTrialing: false } }, { id: "ws-team", plan: "PRO", customer: { isTrialing: false } }]);
  assert.equal(two.moved, true);
  assert.deepEqual(two.made, ["ws-team"], "the workspace that can keep it running");
});
