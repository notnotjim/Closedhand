// webapp/railway-move.js: Go always-on in one button.
//
// Railway asks the person to sign in (or make an account) and let Closedhand
// set itself up in their own Railway account: Login with Railway, as a
// native app with PKCE, so there is no secret to keep, and the access is used
// for this one move and then dropped. Closedhand then makes a project from its
// template, every service in Railway's region nearest the person and with a
// setup code it chose itself,
// waits for the new Closedhand to answer, and moves everything across
// (move.js). Nothing to copy or paste.
//
// Railway sends the person back to one fixed address, closedhand.com's
// /railway/return, which passes the code straight on to this Closedhand,
// wherever it is reached from. The code is no use without the verifier, which
// never leaves this computer.
const crypto = require("crypto");

// Closedhand's app on Railway, registered as native with PKCE: the ID is
// public, like Closedhand's Google app ID, and there is no secret to hold.
const CLIENT_ID = process.env.RAILWAY_CLIENT_ID || "rlwy_oaci_az4hdCpq4U0seDvW20wyzStx";
const AUTHORIZE = "https://backboard.railway.com/oauth/auth";
const TOKEN = "https://backboard.railway.com/oauth/token";
const API = "https://backboard.railway.com/graphql/v2";
const RETURN = "https://closedhand.com/railway/return";
// Closedhand's template on Railway (railway.com/deploy/closedhand), by its
// ID: its short name changed when it was published, its ID never does.
const TEMPLATE = "86557f2f-7a26-46c6-9599-0b9c8f422dab";
// Railway's regions (docs.railway.com/deployments/regions), and how Settings
// names each. A service's storage goes where the service does.
const REGIONS = {
  "us-west2": "the US", // California
  "us-east4-eqdc4a": "the US", // Virginia
  "europe-west4-drams3a": "Europe", // Amsterdam
  "asia-southeast1-eqsg3a": "Asia", // Singapore
};
// Where the server is, for My Account on Railway: the person's data is there.
const CITIES = {
  "us-west2": "California",
  "us-east4-eqdc4a": "Virginia",
  "europe-west4-drams3a": "Amsterdam",
  "asia-southeast1-eqsg3a": "Singapore",
};
const NO_ZONE_REGION = "europe-west4-drams3a";
const SETUP_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Long enough to make a Railway account and add a card on the way.
const SIGN_IN_TIME = 60 * 60 * 1000;
const START_TIME = 20 * 60 * 1000;

let pending = null; // { nonce, verifier, at }: a sign-in under way
let setup = null; // { step, error }: before the move itself starts

// The address this Closedhand is reached at, as the browser that pressed the
// button sees it: its personal URL, or this computer itself.
function backAddress(origin) {
  let u;
  try { u = new URL(String(origin || "")); } catch (_) { return null; }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
  if (u.protocol === "https:" && /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(u.hostname)) return u.origin;
  if (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)) return u.origin;
  return null;
}

const base64url = (buf) => Buffer.from(buf).toString("base64url");

function available() { return !!CLIENT_ID; }

// A time zone's standard offset from UTC in hours (the smaller of January's
// and July's, so summer time never moves it), or null for none.
function standardOffset(timeZone) {
  if (!timeZone) return null;
  try {
    const at = (month) => {
      const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(new Date(Date.UTC(2026, month, 1, 12))).find((p) => p.type === "timeZoneName").value;
      const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
      return m && m[1] ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) + Number(m[3]) / 60) : 0;
    };
    return Math.min(at(0), at(6));
  } catch (_) { return null; }
}

// The region nearest the person, from the time zone of their saved place:
// the Americas from the Rockies west to California and the rest to Virginia,
// Europe, Africa and the Middle East to Amsterdam, the rest of Asia and
// Oceania to Singapore. With no zone to go by, Amsterdam.
function regionFor(timeZone) {
  const hours = standardOffset(timeZone);
  if (hours === null) return NO_ZONE_REGION;
  if (hours <= -7) return "us-west2";
  if (hours < -2.5) return "us-east4-eqdc4a";
  if (hours < 4.5) return "europe-west4-drams3a";
  return "asia-southeast1-eqsg3a";
}

// Where Settings says Closedhand runs or would run. Only Europe is named, as
// it means something to people there; anywhere else is "near you".
function placeOf(region) { return REGIONS[region] === "Europe" ? "Europe" : null; }

// On Railway: where its server is and the person's project there, for the
// bill and for deleting it after a move. Null anywhere else.
function home(env = process.env) {
  if (!env.RAILWAY_PROJECT_ID) return null;
  return { city: CITIES[env.RAILWAY_REPLICA_REGION] || null, project: "https://railway.com/project/" + encodeURIComponent(env.RAILWAY_PROJECT_ID) };
}

// The Railway sign-in to send the browser to, for a move to the region
// nearest the person (their saved place's time zone).
function begin(origin, timeZone) {
  if (!CLIENT_ID) throw new Error("Going always-on isn't available in this version of Closedhand.");
  const back = backAddress(origin);
  if (!back) throw new Error("Open Closedhand at its personal URL or on its own computer to move it.");
  if (setup && !["failed"].includes(setup.step)) throw new Error("A move is already under way.");
  const nonce = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(48));
  pending = { nonce, verifier, at: Date.now(), region: regionFor(timeZone) };
  setup = null;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: RETURN,
    scope: "openid email profile workspace:member",
    state: base64url(JSON.stringify({ b: back, s: nonce })),
    code_challenge: base64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return AUTHORIZE + "?" + params;
}

// Back from Railway: check it is this sign-in, take the access, and set up.
// Returns at once; status() follows it.
function finish({ code, state, error }, deps) {
  const p = pending;
  pending = null;
  let nonce = null;
  try { nonce = JSON.parse(Buffer.from(String(state || ""), "base64url").toString("utf8")).s; } catch (_) {}
  if (!p || !nonce || nonce !== p.nonce || Date.now() - p.at > SIGN_IN_TIME) {
    setup = { step: "failed", error: "That Railway sign-in has expired. Press Move to Railway again." };
    return;
  }
  if (error || !code) {
    setup = { step: "failed", error: "Railway sign-in was cancelled. Nothing has moved." };
    return;
  }
  setup = { step: "setting-up" };
  run(String(code), p.verifier, p.region, deps).catch((e) => {
    console.error("[railway-move]", e.message);
    setup = { step: "failed", error: e.said ? e.message : "Railway didn't finish setting it up. Nothing has moved; Closedhand carries on here." };
  });
}

const PLAN_NEEDED = "Railway's free trial can't keep Closedhand running, so it needs Railway's Hobby plan first. Choose it at railway.com/workspace/plans, then press Move to Railway again. Nothing has moved; Closedhand carries on here.";

// Each workspace's Railway plan, and whether it is still on the trial; null
// when Railway won't say.
async function workspacePlans(gql) {
  for (const query of ["query { me { workspaces { id plan customer { isTrialing } } } }", "query { me { workspaces { id plan } } }"]) {
    try {
      const list = ((await gql(query)).me || {}).workspaces;
      if (Array.isArray(list) && list.every((w) => w && w.plan)) return list;
    } catch (_) { /* fewer fields next */ }
  }
  return null;
}

async function run(code, verifier, region, deps) {
  const doFetch = deps.fetch || fetch;
  const said = (message) => Object.assign(new Error(message), { said: true });
  const tokenRes = await doFetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: RETURN, client_id: CLIENT_ID, code_verifier: verifier }),
    signal: AbortSignal.timeout(30000),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.access_token) throw new Error(`token exchange ${tokenRes.status}`);
  const gql = async (query, variables = {}) => {
    const r = await doFetch(API, {
      method: "POST",
      headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errors) {
      const reason = (j.errors && j.errors[0] && j.errors[0].message) || `Railway answered ${r.status}`;
      throw said(`Railway didn't set it up: ${reason}. Nothing has moved; Closedhand carries on here.`);
    }
    return j.data;
  };

  // 1. The workspace the person let Closedhand into, on a plan that can keep
  // it running. Railway's trial and Free plan can't: half a GB of storage, a
  // GB of memory, the internet restricted until the account is verified, and
  // a trial's data deleted a month after its credit runs out. A move leaves
  // nothing behind, so it starts only where Closedhand can stay. Where
  // Railway doesn't say, the move goes ahead as it always did.
  const workspaces = ((await gql("query { me { workspaces { id } } }")).me || {}).workspaces || [];
  if (!workspaces.length) throw said("Railway didn't give Closedhand a workspace to set up in. Press Move to Railway and choose one.");
  let workspaceId = workspaces[0].id;
  const plans = await workspacePlans(gql);
  if (plans) {
    const paid = plans.find((w) => ["HOBBY", "PRO"].includes(w.plan) && !(w.customer && w.customer.isTrialing));
    if (!paid) throw said(PLAN_NEEDED);
    workspaceId = paid.id;
  }

  // 2. The template, in the region nearest the person, with a setup code
  // chosen here.
  const template = (await gql("query($t: String!) { template(id: $t) { id serializedConfig } }", { t: TEMPLATE })).template;
  const config = template.serializedConfig;
  const setupCode = Array.from(crypto.randomBytes(24), (b) => SETUP_LETTERS[b % SETUP_LETTERS.length]).join("");
  for (const service of Object.values(config.services || {})) {
    service.deploy = { ...(service.deploy || {}), multiRegionConfig: { [region]: { numReplicas: 1 } } };
    if (service.name === "webapp") service.variables = { ...service.variables, SETUP_CODE: { ...(service.variables || {}).SETUP_CODE, defaultValue: setupCode } };
  }

  // 3. A project of its own, with the template deployed into it. A move that
  // fails from here on takes the project away again, so nothing is left
  // running on the person's Railway bill.
  const project = (await gql("mutation($i: ProjectCreateInput!) { projectCreate(input: $i) { id environments { edges { node { id } } } } }",
    { i: { name: "Closedhand", workspaceId } })).projectCreate;
  const removeProject = () => gql("mutation($p: String!) { projectDelete(id: $p) }", { p: project.id })
    .catch((e) => console.error("[railway-move] could not remove the project it made:", e.message));
  try {
    await deployAndMove(gql, doFetch, deps, { template, config, project, workspaceId, setupCode, region });
  } catch (e) {
    await removeProject();
    throw e;
  }
  watchMove(deps, removeProject);
}

// 3b. The template deployed in the region nearest the person. Railway's
// plain template deploy puts every service in the account's default region
// whatever the template asks, and moving a database to another region after
// it has started writing can damage it (a damaged index on the first move,
// 2026-10-28). So the template is staged first, each service is given the
// region while nothing exists yet, and only then is it committed: every
// service and its storage starts life in that region. Where Railway won't
// stage, it deploys as before, in the default region, and nothing is moved
// after: a Closedhand further away beats a damaged one.
async function deployInRegion(gql, { template, config, project, environmentId, workspaceId, region }, pollMs = 2000) {
  const deploy = (stageOnly) => gql("mutation($i: TemplateDeployV2Input!) { templateDeployV2(input: $i) { projectId } }",
    { i: { templateId: template.id, serializedConfig: config, projectId: project.id, environmentId, workspaceId, ...(stageOnly ? { stageOnly: true } : {}) } });
  try { await deploy(true); }
  catch (e) {
    console.warn(`[railway-move] staging was refused (${e.message}); deploying in Railway's default region`);
    return deploy(false);
  }
  // The staged services, as the template's workflow writes them.
  let services = {};
  for (let i = 0; i < 15 && !Object.keys(services).length; i++) {
    if (i) await new Promise((r) => setTimeout(r, pollMs));
    const staged = (await gql("query($e: String!) { environmentStagedChanges(environmentId: $e) { id patch } }", { e: environmentId }).catch(() => ({}))).environmentStagedChanges;
    services = (staged && staged.patch && staged.patch.services) || {};
  }
  try {
    const placed = {};
    for (const id of Object.keys(services)) placed[id] = { deploy: { multiRegionConfig: { [region]: { numReplicas: 1 } } } };
    if (Object.keys(placed).length) await gql("mutation($e: String!, $i: EnvironmentConfig!) { environmentStageChanges(environmentId: $e, input: $i, merge: true) { id } }", { e: environmentId, i: { services: placed } });
    else console.warn("[railway-move] no staged services to place; committing in Railway's default region");
  } catch (e) { console.warn(`[railway-move] the region could not be staged (${e.message}); committing in Railway's default region`); }
  await gql("mutation($e: String!, $m: String) { environmentPatchCommitStaged(environmentId: $e, commitMessage: $m) }", { e: environmentId, m: "Closedhand, in the region nearest you" });
}

async function deployAndMove(gql, doFetch, deps, { template, config, project, workspaceId, setupCode, region }) {
  const said = (message) => Object.assign(new Error(message), { said: true });
  const environmentId = project.environments.edges[0].node.id;
  await deployInRegion(gql, { template, config, project, environmentId, workspaceId, region }, deps.pollMs);

  // 4. The new Closedhand answering at its address.
  const started = Date.now();
  let address = null;
  while (Date.now() - started < START_TIME) {
    await new Promise((r) => setTimeout(r, deps.pollMs || 10000));
    const services = (await gql(`query($p: String!) { project(id: $p) { services { edges { node { name serviceInstances { edges { node {
      latestDeployment { status } domains { serviceDomains { domain } } } } } } } } } }`, { p: project.id })).project.services.edges.map((e) => e.node);
    const webapp = services.find((s) => s.name === "webapp");
    const instance = webapp && webapp.serviceInstances.edges[0] && webapp.serviceInstances.edges[0].node;
    const status = instance && instance.latestDeployment && instance.latestDeployment.status;
    if (["FAILED", "CRASHED"].includes(status)) throw said("Closedhand didn't start on Railway. Nothing has moved; Closedhand carries on here.");
    const domain = instance && instance.domains.serviceDomains[0] && instance.domains.serviceDomains[0].domain;
    if (status !== "SUCCESS" || !domain) continue;
    const health = await doFetch(`https://${domain}/health`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (health && health.ok) { address = `https://${domain}`; break; }
  }
  if (!address) throw said("Closedhand took too long to start on Railway. Nothing has moved; Closedhand carries on here.");

  // 5. The move itself, as if its address and code had been pasted in.
  setup = null;
  deps.startMove({ address, code: setupCode });
}

// Follows the move it started: one that stops takes the Railway project away.
function watchMove(deps, removeProject) {
  if (!deps.moveStatus) return;
  const timer = setInterval(() => {
    const step = (deps.moveStatus() || {}).step;
    if (step === "done") clearInterval(timer);
    else if (step === "failed") { clearInterval(timer); removeProject(); }
  }, deps.pollMs || 5000);
  if (timer.unref) timer.unref();
}

function status() { return setup; }

module.exports = { available, begin, finish, status, backAddress, regionFor, placeOf, home, RETURN };
