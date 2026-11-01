// A team: Closedhand leads, parts with their own jobs work for it. Chat's
// tasks start one with agent_map; a team made on the dashboard is the same
// thing. Parts only look things up (no sends, no browser, no agents of their
// own), report to the task that started them and never to each other, and a
// part that needs another's result starts once that one is done and is
// handed its findings. Each part's state is kept on the task (agent_tasks.team)
// for a line per agent on the Agents tab.
const { updateTask, getTask } = require("./agents-store");
const { withTaskRun, currentTask } = require("./task-model");

const MAP_MAX_ITEMS = 8;
const MAP_CONCURRENCY = 3;
// A named part is a whole job: room for one, beyond the six quick steps of a
// like-item lookup. Each part adds its own share to the task's allowance, and
// each wave of parts its own time.
const TEAM_PART_LIMITS = { iterations: 20, tokens: 60000 };
const TEAM_PART_ALLOWANCE = { input: 1000000, output: 60000, toolCalls: 40 };
const TEAM_WAVE_MS = 15 * 60 * 1000;
const TEAM_FINDINGS_KEPT = 6000;

// Parts waiting on others, in waves: the first wave waits on nobody. Names a
// part waits for that are not in the team are ignored; a loop of waits is
// broken by starting what is left.
function teamWaves(parts) {
  const names = new Set(parts.map((p) => p.name));
  const done = new Set(); const waves = [];
  let left = parts.map((p) => ({ ...p, after: (p.after || []).filter((n) => names.has(n) && n !== p.name) }));
  while (left.length) {
    let wave = left.filter((p) => p.after.every((n) => done.has(n)));
    if (!wave.length) wave = left;
    waves.push(wave.map((p) => p.name));
    wave.forEach((p) => done.add(p.name));
    left = left.filter((p) => !wave.includes(p));
  }
  return waves;
}

// A team's share of the allowance, kept on the task so a restart keeps it.
function growBudget(b, growth) {
  if (!b || !growth) return;
  b.maxInput += growth.input || 0; b.maxOutput += growth.output || 0;
  b.maxToolCalls += growth.toolCalls || 0; b.durationMs += growth.durationMs || 0;
}

// What agent_map was asked for, as parts: one job over like items (items +
// prompt), or named parts with their own jobs (parts).
function partsFromInput(input = {}) {
  const label = String(input.label || "").substring(0, 40);
  if (Array.isArray(input.parts) && input.parts.length) {
    const parts = input.parts.map((p) => ({ name: String(p?.name || "").trim().slice(0, 40), goal: String(p?.job || p?.goal || "").trim(), after: Array.isArray(p?.after) ? p.after.map(String) : [] }))
      .filter((p) => p.name && p.goal);
    if (new Set(parts.map((p) => p.name)).size !== parts.length) return { error: "Give each part its own name." };
    if (parts.length < 2) return { error: "A team needs 2 or more parts, each with a name and a job. For one job, just do the work directly." };
    if (parts.length > MAP_MAX_ITEMS) return { error: `A team caps at ${MAP_MAX_ITEMS} parts. Fold some together.` };
    return { parts, label, quick: false };
  }
  const items = Array.isArray(input.items) ? [...new Set(input.items.map((s) => String(s)).filter((s) => s.trim()))] : [];
  const template = String(input.prompt || "");
  if (items.length < 2) return { error: "agent_map needs 2 or more items. For one item, just do the work directly." };
  if (items.length > MAP_MAX_ITEMS) return { error: `agent_map caps at ${MAP_MAX_ITEMS} items. Narrow the list or batch the rest into a second call.` };
  if (!template.trim()) return { error: "agent_map needs the prompt template." };
  const seen = new Map();
  const parts = items.map((item) => {
    let name = item.replace(/\s+/g, " ").trim().slice(0, 40);
    const n = (seen.get(name) || 0) + 1; seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    return { name, goal: template.includes("{item}") ? template.split("{item}").join(item) : `${template}\n\nThis run covers: ${item}`, after: [] };
  });
  return { parts, label, quick: true };
}

// Runs the team: as many parts at once as `atOnce` allows (asked again as
// each one starts), each with `runPart` (the agent engine's part runner).
async function runTeam(userId, platform, chatId, parentTaskId, parts, model, opts = {}) {
  const atOnce = opts.atOnce || (() => MAP_CONCURRENCY);
  const limits = opts.partLimits || TEAM_PART_LIMITS;
  const runPart = opts.runPart;
  const team = parts.map((p) => ({ name: p.name, job: p.goal, after: (p.after || []).filter((n) => n !== p.name), status: "waiting", last: null, findings: null, error: null, key: null }));
  const byName = new Map(team.map((m) => [m.name, m]));
  team.forEach((m) => { m.after = m.after.filter((n) => byName.has(n)); });
  const waves = teamWaves(team);

  const growth = opts.grow === false ? null : {
    input: team.length * TEAM_PART_ALLOWANCE.input, output: team.length * TEAM_PART_ALLOWANCE.output,
    toolCalls: team.length * TEAM_PART_ALLOWANCE.toolCalls, durationMs: waves.length * TEAM_WAVE_MS,
  };
  growBudget(currentTask()?.budget, growth);
  const capacity = require("./llm-capacity");
  const k = capacity.key(userId, model);

  let saving = Promise.resolve();
  const save = () => (saving = saving.then(() => updateTask(parentTaskId, { team: team.map(({ name, job, after, status, last, findings, error, key }) => ({ name, job, after, status, last, findings, error, key })) }).catch(() => {})));
  // One write at a time: parts finishing together would each read the old
  // progress and write over the other's line.
  const pushProgress = (text) => (saving = saving.then(async () => {
    try {
      const t = await getTask(parentTaskId);
      await updateTask(parentTaskId, { progress: [...(t?.progress || []), { text, time: new Date().toISOString() }] });
    } catch (_) { /* progress is a nicety */ }
  }));
  await save();
  await pushProgress(opts.label ? `${opts.label[0].toUpperCase()}${opts.label.slice(1)}: a team of ${team.length} at work` : `A team of ${team.length} at work`);

  const goalFor = (m) => {
    const inputs = m.after.map((n) => byName.get(n)).filter((u) => u.findings);
    return inputs.length
      ? `${m.job}\n\nWhat the rest of the team found that this needs:\n${inputs.map((u) => `${u.name}:\n${u.findings}`).join("\n\n")}`
      : m.job;
  };
  const runOne = async (m) => {
    const subGoal = goalFor(m);
    m.status = "working"; await save();
    capacity.begin(k);
    try {
      const { supabase } = require("./db");
      const itemKey = require("crypto").createHash("sha256").update(JSON.stringify([subGoal, model])).digest("hex");
      m.key = itemKey;
      const { data: cached, error: readError } = await supabase.from("task_worker_results").select("result")
        .eq("user_id", userId).eq("task_id", parentTaskId).eq("item_key", itemKey).limit(1);
      if (readError) throw readError;
      const onStep = (line) => { if (line && line !== m.last) { m.last = line; save(); } };
      const result = cached?.[0]?.result || await withTaskRun({ purpose: "map_worker" },
        () => runPart(userId, subGoal, platform, chatId, model, { ...limits, onStep }));
      if (!cached?.length && !result.error && !result.partial) {
        const { error: saveError } = await supabase.from("task_worker_results").upsert({ user_id: userId, task_id: parentTaskId, item_key: itemKey, result }, { onConflict: "task_id,item_key" });
        if (saveError) throw saveError;
      }
      m.result = result;
      m.findings = result.error ? null : String(result.findings || "").slice(0, TEAM_FINDINGS_KEPT);
      m.error = result.error || null;
      m.status = result.error ? "stopped" : "done";
    } catch (e) {
      m.result = { error: e.message }; m.error = e.message; m.status = "stopped";
      if (e.code === "TASK_STOPPED") throw e;
    } finally { capacity.end(k); }
    m.last = null;
    await save();
    await pushProgress(`${m.name} ${m.status === "done" ? "done" : "could not finish"}`);
  };

  // Start whatever may start, as many as allowed now, until all are done.
  const running = new Set();
  const settled = (n) => ["done", "stopped"].includes(byName.get(n).status);
  const ready = (m) => m.status === "waiting" && m.after.every(settled);
  for (;;) {
    if (!running.size && team.some((m) => m.status === "waiting") && !team.some(ready)) {
      team.filter((m) => m.status === "waiting").forEach((m) => { m.after = []; });
    }
    for (const m of team) {
      if (running.size >= Math.max(1, atOnce(team.length))) break;
      if (!ready(m)) continue;
      const p = runOne(m).finally(() => running.delete(p));
      running.add(p);
    }
    if (!running.size) break;
    await Promise.race(running);
  }
  await saving;

  return {
    growth,
    results: team.map((m) => ({ name: m.name, ...m.result })),
    note: "Put these into one answer. Parts could not see each other except where one waited for another's findings, so reconcile overlap or disagreement yourself, show both where they conflict and you cannot settle it, and say plainly which part did not finish.",
  };
}

module.exports = { runTeam, teamWaves, growBudget, partsFromInput, MAP_MAX_ITEMS, MAP_CONCURRENCY, TEAM_PART_LIMITS };
