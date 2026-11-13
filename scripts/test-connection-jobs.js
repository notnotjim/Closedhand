// A connected service takes over a job Closedhand does itself, whatever the
// service and however it is connected: its tools are read once, it gets a
// switch on its tile, on from the start, and Closedhand uses it first without
// being asked, falling back to its own when it fails. Search here; the voice
// is the same mechanism (test-voice-connections.js). Every service, tool and
// address here is invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { findJobs, saved, checkTool, TOOL_JOBS } = require("../webapp/connection-jobs");
const jobs = require("../lib/connection-jobs");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const MODEL = { model: "kestrel-1" };
const answer = (input) => async () => ({ content: [{ type: "tool_use", name: "report_jobs", input }] });

// An invented search service's tools, as services publish them.
const TOOLS = [
  { name: "kestrel_web_search", description: "Search the web and return ranked results with titles, links and snippets.",
    inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, num: { type: "integer", default: 5 }, safe: { type: "string", enum: ["on", "off"] } } } },
  { name: "kestrel_account", description: "Show how many searches are left this month.", inputSchema: { type: "object", properties: {} } },
];

test("one check finds every job a service can do, and keeps only what its tools bear out", async () => {
  const found = await findJobs(TOOLS, MODEL, { request: answer({
    speak: { found: false }, hear: { found: false },
    search: { found: true, tool: "kestrel_web_search", query_argument: "q", fixed_arguments: { safe: "on" } },
  }) });
  assert.equal(found.voice, null);
  assert.deepEqual(found.jobs.search, { tool: "kestrel_web_search", args: { query: "q" }, fixed: { safe: "on" } });
  assert.equal(checkTool(TOOLS, { found: true, tool: "kestrel_web_search", query_argument: "query" }, "search"), null, "an argument it doesn't take");
  assert.equal(checkTool(TOOLS, { found: true, tool: "kestrel_web_search", query_argument: "q", fixed_arguments: { safe: "maybe" } }, "search"), null, "a value its list doesn't allow");
  assert.equal(checkTool(TOOLS, { found: true, tool: "kestrel_search_v2", query_argument: "q" }, "search"), null, "a tool it doesn't have");
  assert.ok(Object.keys(TOOL_JOBS).includes("search"));
});

test("a job found is switched on the first time, left as the person set it after, and kept when the check can't run", () => {
  const plan = { tool: "kestrel_web_search", args: { query: "q" }, fixed: {} };
  const first = saved({ voice: null, jobs: { search: plan } }, null, null);
  assert.equal(first.jobs.search.on, true);
  const again = saved({ voice: null, jobs: { search: plan } }, null, { search: { ...plan, on: false } });
  assert.equal(again.jobs.search.on, false, "the person's switch stays");
  const unchecked = saved({ voice: undefined, jobs: undefined }, null, { search: { ...plan, on: false } });
  assert.deepEqual(unchecked.jobs, { search: { ...plan, on: false } });
  const gone = saved({ voice: null, jobs: { search: null } }, null, { search: { ...plan, on: true } });
  assert.deepEqual(gone.jobs, {}, "a tool that went away takes its switch with it");
});

// A stand-in for the database: one connection that searches.
function store(plan, transport = "http") {
  const row = { id: "kestrel-row", name: "Kestrel Search", updated_at: "1", transport, caps: { jobs: { search: plan } } };
  const writes = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({ eq: async () => ({ data: [row], error: null }), single: async () => ({ data: { caps: row.caps }, error: null }) }),
      }),
      update: (patch) => ({ eq: async () => { writes.push(patch.caps.jobs.search); row.caps = patch.caps; return { error: null }; } }),
    }),
  };
  return { db, writes, row };
}
const PLAN = { tool: "kestrel_web_search", args: { query: "q" }, fixed: { safe: "on" }, on: true };

test("Closedhand searches with the connected service first, unasked, and its own search stands in when it fails", async () => {
  const { db, writes } = store(PLAN);
  const calls = [];
  const callTool = async (userId, rowId, tool, args) => { calls.push([tool, args]); return { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Ferry times", url: "https://ferries.example/times" }] }) }] }; };
  const got = await jobs.takeOver("web_search", { query: "ferry times", _userId: "u1" }, { db, callTool, ctx: {} });
  assert.deepEqual(calls, [["kestrel_web_search", { safe: "on", q: "ferry times" }]]);
  assert.deepEqual(got, { results: [{ title: "Ferry times", url: "https://ferries.example/times" }], query: "ferry times", count: 1, source: "Kestrel Search" });

  const quiet = console.warn; console.warn = () => {};
  try {
    const failing = async () => { throw new Error("monthly limit reached"); };
    assert.equal(await jobs.takeOver("web_search", { query: "ferry times", _userId: "u1" }, { db, callTool: failing, ctx: {} }), null, "the tool's own search runs");
    assert.match(writes.at(-1).fallback.why, /Kestrel Search couldn't search: monthly limit reached/, "the tile says why");
  } finally { console.warn = quiet; }
});

test("every lookup tool can be taken over, with the saved location where the tool would use it, and tools on the person's own accounts never are", async () => {
  const { forTool, JOBS, texts } = require("../lib/tool-jobs");
  for (const tool of ["web_search", "web_fetch", "watch_video", "weather_lookup", "air_quality", "maps_search_places", "maps_directions", "maps_geocode"]) assert.ok(forTool(tool), tool);
  for (const tool of ["gmail_send", "gcal_create_event", "drive_search", "add_schedule", "api_request", "sandbox_exec"]) assert.equal(forTool(tool), null, tool);
  for (const job of Object.keys(JOBS)) assert.ok(texts(job).title && texts(job).on.includes("{name}") && !/\u2014/.test(JSON.stringify(texts(job))), job);

  const row = { id: "heron-row", name: "Heron Weather", updated_at: "1", transport: "api", caps: { jobs: { weather: { tool: "GET /now", args: { latitude: "lat", longitude: "lon" }, fixed: { units: "metric" }, on: true } } } };
  const db = { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [row], error: null }) }) }) }) };
  const calls = [];
  const callTool = async (u, id, tool, args) => { calls.push([tool, args]); return { content: [{ type: "text", text: '{"temp":21,"sky":"light rain"}' }] }; };
  const ctx = { store: { location: { latitude: 38.72, longitude: -9.14, name: "Lisbon" } } };
  const got = await jobs.takeOver("weather_lookup", { _userId: "u1" }, { db, callTool, ctx });
  assert.deepEqual(calls, [["GET /now", { units: "metric", lat: 38.72, lon: -9.14 }]], "no place given: the saved one, as the tool itself would");
  assert.deepEqual(got.result, { temp: 21, sky: "light rain" });
  assert.equal(got.source, "Heron Weather");
  assert.equal(await jobs.takeOver("gmail_send", { _userId: "u1", to: "x" }, { db, callTool, ctx }), null);
  assert.equal(calls.length, 1);
});

test("switched off, or for someone else, the connection isn't asked", async () => {
  const { db } = store({ ...PLAN, on: false });
  let asked = 0;
  assert.equal(await jobs.run("u1", "search", { query: "x" }, { db, callTool: async () => { asked++; } }), null);
  assert.equal(await jobs.run(null, "search", { query: "x" }, { db, callTool: async () => { asked++; } }), null);
  assert.equal(asked, 0);
});

test("a service connected with a key does it through its own endpoint", async () => {
  const finder = require("../webapp/api-finder");
  const keys = require("../lib/api-keys");
  const description = { openapi: "3.1.0", servers: [{ url: "https://api.kestrel-search.example/v1" }],
    components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Kestrel-Key" } } },
    paths: { "/search": { get: { summary: "Web search", parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }] } },
      "/usage": { get: { summary: "Usage this month" } } } };
  const list = keys.readApiDescription(description, "https://api.kestrel-search.example").endpoints;
  const plan = { base: "https://api.kestrel-search.example/v1", auth: { in: "header", name: "X-Kestrel-Key" }, list };
  const { jobs: found } = await finder.jobsFor(plan, "kk_invented", MODEL, null, { request: answer({ speak: { found: false }, hear: { found: false }, search: { found: true, tool: "GET /search", query_argument: "q" } }) });
  assert.deepEqual({ tool: found.search.tool, args: found.search.args, on: found.search.on }, { tool: "GET /search", args: { query: "q" }, on: true });
  const req = keys.requestFor(list.find((e) => e.path === "/search"), plan.base, { q: "ferry times" });
  assert.equal(req.url, "https://api.kestrel-search.example/v1/search?q=ferry+times");
});

test("the server, tile and privacy pages carry every job, not only the voice", () => {
  const server = read("webapp/server.js");
  assert.match(server, /app\.post\("\/api\/mcps\/:id\/job"/);
  assert.match(server, /async function mcpJobsFor\(userId, tools, previousCaps\)/);
  assert.doesNotMatch(server, /voice-tools/);
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /var mcpJobTexts = fetch\('\/api\/mcps\/job-texts'\)/);
  assert.match(server, /app\.get\("\/api\/mcps\/job-texts"/);
  assert.match(dash, /Object\.keys\(caps\.jobs \|\| \{\}\)\.forEach\(function\(job\) \{/);
  const handlers = read("lib/tools/handlers.js");
  const top = handlers.slice(handlers.indexOf("async function handleInternalTool("));
  assert.ok(top.indexOf('require("../connection-jobs").takeOver(toolName') < top.indexOf("switch (toolName)"), "tried before any tool runs");
  for (const page of ["webapp/views/privacy.html", "closedhand-com/views/privacy.html"]) {
    assert.match(read(page), /web searches go to a search service you connected, if you did, then to your LLM provider's own search/);
    assert.match(read(page), /anything else a service you connect does in Closedhand's place, such as reading web pages, watching videos, the weather or maps/);
  }
});

// A picture service connected with a key or as an MCP server is a job like
// any other: on from the start, used first, its picture sent to the chat it
// was asked in, whatever form it comes back in, and Closedhand's own makes
// it when the service sends back no picture.
test("a connected image service makes the picture first and sends it to the chat, from an image, base64 or a link", async () => {
  const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(300, 1)]);
  const row = { id: "wren-row", name: "Wren Pictures", updated_at: "1", transport: "mcp", caps: { jobs: { images: { tool: "wren_create", args: { prompt: "text" }, fixed: { size: "1024x1024" }, on: true } } } };
  const db = { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [row], error: null }) }) }) }) };
  const sent = [];
  const take = (result, extra = {}) => jobs.takeOver("generate_image", { prompt: "a lighthouse at dusk", shape: "square", _userId: "u1", _chatId: "c1" }, {
    db, ctx: {}, sendDocument: async (...a) => { sent.push(a); }, look: async () => "a stone lighthouse on a headland at dusk",
    callTool: async (u, id, tool, args) => { assert.deepEqual([tool, args], ["wren_create", { size: "1024x1024", text: "a lighthouse at dusk" }]); return result; },
    ...extra,
  });
  const got = await take({ content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] });
  assert.equal(got.source, "Wren Pictures");
  assert.equal(got.checked, "Looked at after it was made, the picture shows: a stone lighthouse on a headland at dusk", "what it really shows, for the LLM to go by");
  assert.deepEqual([sent[0][0], sent[0][2], sent[0][3]], ["c1", "image.png", "image/png"]);
  assert.ok(sent[0][1].equals(PNG));
  await take({ content: [{ type: "text", text: JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }) }] });
  assert.ok(sent[1][1].equals(PNG), "base64 in its answer");
  const fetched = [];
  await take({ content: [{ type: "text", text: JSON.stringify({ images: [{ url: "https://cdn.wren.example/p/1.png" }] }) }] }, { fetch: async (u) => { fetched.push(u); return { ok: true, arrayBuffer: async () => PNG }; } });
  assert.deepEqual(fetched, ["https://cdn.wren.example/p/1.png"], "a link, fetched");
  assert.ok(sent[2][1].equals(PNG));
  const quiet = console.warn; console.warn = () => {};
  try {
    assert.equal(await take({ content: [{ type: "text", text: '{"url":"https://127.0.0.1/p.png"}' }] }, { fetch: async () => { throw new Error("must not be fetched"); } }), null, "a private address is never fetched, and Closedhand's own makes it");
    assert.equal(await take({ content: [{ type: "text", text: "Queued as job 42." }] }), null, "no picture back");
    const hops = [];
    const redirecting = async (u) => { hops.push(u); return { ok: false, status: 302, headers: { get: () => "https://169.254.169.254/latest" } }; };
    assert.equal(await take({ content: [{ type: "text", text: '{"url":"https://cdn.wren.example/p/2.png"}' }] }, { fetch: redirecting }), null, "nor one a link redirects to");
    assert.deepEqual(hops, ["https://cdn.wren.example/p/2.png"]);
  } finally { console.warn = quiet; }
  assert.equal(sent.length, 3);
  const { texts } = require("../lib/tool-jobs");
  assert.equal(texts("images").on, "Closedhand makes pictures with {name} first. What a picture shows goes to {name}, which may charge your account for it.");
  assert.match(read("webapp/connection-jobs.js"), /A tool that edits, enlarges or describes a picture it is given is not images\./);
  assert.match(read("lib/api-connections.js"), /if \(\/\^image\\\/\/\.test\(type\)\) return \{ content: \[\{ type: "image", data: buffer\.toString\("base64"\), mimeType: type \}\] \};/);
});

