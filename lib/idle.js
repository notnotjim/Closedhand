// lib/idle.js: whether Closedhand is otherwise idle.
//
// Hearing a long recording or video takes a while (a two-hour video, about
// half an hour) and nobody is waiting on it, so it is done only while nothing
// else is: no chat turn or agent step, no sync, no indexing, no File Search
// reading. Each of those marks itself here while it runs, or touches it as it
// goes; idle is none running, and none for a little while, so the gap between
// two steps of one job is not taken for quiet.

const QUIET_MS = 2 * 60000;
// How often something waiting for idle looks again.
const LOOK_MS = 30000;
let running = 0;
let last = 0;

// Runs fn, counted as busy until it ends.
async function during(fn) {
  running++;
  try { return await fn(); } finally { running--; last = Date.now(); }
}

// Something happened just now (an embedding asked for, an LLM call).
function touch() { last = Date.now(); }

function isIdle(now = Date.now()) {
  return running === 0 && now - last >= QUIET_MS;
}

// Long hearings, one at a time, whoever asks (the file step here, File
// Search through /internal/hear): two at once only slowed both.
let turn = Promise.resolve();
function oneAtATime(fn) {
  const run = turn.then(() => fn());
  turn = run.catch(() => {});
  return run;
}

module.exports = { during, touch, isIdle, oneAtATime, QUIET_MS, LOOK_MS };
