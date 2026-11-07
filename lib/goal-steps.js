// lib/goal-steps.js: the steps of a goal's plan that are Closedhand's, done by
// Closedhand. A plan has the person's steps and Closedhand's (looking things
// up, comparing options, drafting something for them to check). Each of
// Closedhand's starts by itself as a background task once it comes next in
// the plan or its day comes, one at a time per goal and never in quiet hours.
// The task works in the goal's project, so its result is posted in the
// project's conversation like any task's (lib/task-delivery.js), which then
// ticks the step. A task the person stopped, or one that could not finish, is
// not started again: the step stays for them to tick or ask about. Sending and
// paying ask first, as in every task (lib/agents.js).

const { supabase } = require("./db");

// A task in these is still under way, paused for a yes or for the LLM's
// allowance included.
const UNDER_WAY = ["pending", "running", "awaiting_confirmation", "blocked"];

function dayIn(tz, at) { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at); }

// The step of Closedhand's to start now, if any: the next step of the plan,
// or one whose day has come.
function stepToStart(goal, today) {
  if (goal.status !== "active" || goal.shape === "habit") return null;
  const plan = goal.plan || [];
  const next = plan.find((s) => s.status === "todo");
  return plan.find((s) => s.owner === "closedhand" && s.status === "todo" && !s.task_id && (s === next || (s.due && s.due <= today))) || null;
}

function stepAsk(goal, step) {
  return `${step.text}\n\nThis is your step in the plan for their goal: ${goal.title}. Do only this step, and give them what you found or made, ready to use.`;
}

async function startStep(goal, now) {
  const { UserStore } = require("../user-store");
  const store = await UserStore.load(goal.user_id);
  if (require("./proactive").quietNow(store, now)) return;
  const step = stepToStart(goal, dayIn(require("./time-context").personZone(store, now), now));
  if (!step) return;
  const [target] = await require("./goal-check-ins").targetsFor(goal.user_id, store);
  const model = require("./llm").resolveUserModel(goal.user_id, "default", store);
  const task = await require("./agents-store").createTask(goal.user_id, stepAsk(goal, step), model, target.platform, target.platform_user_id,
    step.text.length > 70 ? step.text.slice(0, 70).replace(/\s+\S*$/, "") + "…" : step.text, null,
    { projectId: goal.project_id, goalStep: { goal: goal.id, step: step.id } });
  // The plan as it is now: the person may have changed it meanwhile.
  const { data: fresh, error } = await supabase.from("goals").select("plan").eq("id", goal.id).single();
  if (error) throw new Error(error.message);
  const plan = (fresh.plan || []).map((s) => (s.id === step.id ? { ...s, task_id: task.id } : s));
  const { error: e } = await supabase.from("goals").update({ plan }).eq("id", goal.id);
  if (e) throw new Error(e.message);
}

// Every few minutes, from the goal check-ins' sweep, with its active goals.
async function startDue(goals, now = new Date()) {
  // The day furthest ahead anywhere, so nobody's today is missed before their
  // own zone is read.
  const waiting = goals.filter((g) => stepToStart(g, dayIn("Pacific/Kiritimati", now)));
  if (!waiting.length) return;
  const ids = waiting.flatMap((g) => g.plan.map((s) => s.task_id).filter(Boolean));
  const { data, error } = ids.length ? await supabase.from("agent_tasks").select("id").in("id", ids).in("status", UNDER_WAY) : { data: [] };
  if (error) { console.error("[goal-steps] could not read tasks:", error.message); return; }
  const busy = new Set((data || []).map((t) => t.id));
  for (const goal of waiting) {
    if (goal.plan.some((s) => busy.has(s.task_id))) continue;
    try { await startStep(goal, now); }
    catch (e) { console.error(`[goal-steps] step for ${goal.id.slice(0, 8)} not started:`, e.message); }
  }
}

// A step's task is done and its result posted: the step is ticked, unless
// the person or the task already did.
async function ran(row) {
  if (row.status !== "completed") return;
  const goals = require("./goals");
  const { goal: goalId, step: stepId } = row.runtime.goalStep;
  const goal = await goals.findGoal(row.user_id, goalId).catch(() => null);
  const step = goal && (goal.plan || []).find((s) => s.id === stepId);
  if (!step || step.status !== "todo") return;
  await goals.recordProgress(row.user_id, { id: goalId, action: "step_done", step: stepId });
}

module.exports = { startDue, ran, stepToStart, stepAsk };
