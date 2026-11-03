// What the bot is busy with right now, by kind and size, never by content, for
// the lines that report on it (lib/memory-watch.js). Each start returns its own
// end; work still running past its time limit stays listed until it ends.
const now = new Map();
let next = 0;

function start(label) {
  const id = ++next;
  now.set(id, { label, at: Date.now() });
  return () => { now.delete(id); };
}

function list() {
  return [...now.values()].map((d) => `${d.label} (${Math.round((Date.now() - d.at) / 1000)}s)`);
}

module.exports = { start, list };
