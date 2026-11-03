// A line in the log each time the bot's memory reaches a new high, saying what
// it was doing then (lib/doing.js), so a spike names its cause. Memory once
// went from 4.6 to over 9 GB on a busy server with nothing in the log to say
// why.
const doing = require("./doing");

const FLOOR = 1.5 * 1024 ** 3; // below this, nothing worth a line
const STEP = 256 * 1024 ** 2; // a new high by at least this much
const gb = (n) => (n / 1024 ** 3).toFixed(1);

function start() {
  let high = 0;
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    if (m.rss < Math.max(FLOOR, high + STEP)) return;
    high = m.rss;
    console.log(`[memory] new high ${gb(m.rss)} GB (JavaScript ${gb(m.heapUsed)} GB) while: ${doing.list().join(", ") || "nothing in particular"}`);
  }, 15000);
  timer.unref();
}

module.exports = { start };
