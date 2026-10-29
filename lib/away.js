// lib/away.js: whether a message waited for Closedhand to come back, so its
// answer can say it was offline. Closedhand was away before this process
// started (the computer was off, or Closedhand not running) and while the
// computer slept, which shows as its own clock jumping between ticks. A
// message counts as having waited when its chat app's send time falls in
// such a spell and it is answered minutes later. Nothing is stored: each
// message's own send time says whether it waited.
const TICK_MS = 30 * 1000;
// A jump this long between ticks is a sleep, not a busy moment.
const SLEPT_MS = 3 * 60 * 1000;
// Answered this long after it was sent, at least, to count as having waited.
const WAITED_MS = 5 * 60 * 1000;
const KEEP_MS = 24 * 3600 * 1000;

function create({ startedAt = Date.now() } = {}) {
  let lastTick = startedAt, toldUntil = 0;
  const slept = [];
  function tick(now = Date.now()) {
    if (now - lastTick > SLEPT_MS) slept.push({ from: lastTick, to: now });
    lastTick = now;
    while (slept.length && now - slept[0].to > KEEP_MS) slept.shift();
  }
  // The spell a message sent at sentAt waited out, { to }, or null.
  function waited(sentAt, now = Date.now()) {
    const at = Number(sentAt);
    if (!Number.isFinite(at) || at <= 0 || now - at < WAITED_MS) return null;
    if (at < startedAt) return { to: startedAt };
    const spell = slept.find((s) => at >= s.from - TICK_MS && at <= s.to);
    return spell ? { to: spell.to } : null;
  }
  // True for the first message of a spell to be answered, once: the person
  // hears they waited once per spell, not on every message.
  function firstOf(spell) {
    if (!spell || spell.to <= toldUntil) return false;
    toldUntil = spell.to;
    return true;
  }
  return { tick, waited, firstOf };
}

const away = create();
function start() { setInterval(() => away.tick(), TICK_MS).unref?.(); }

module.exports = { create, start, waited: away.waited, firstOf: away.firstOf, TICK_MS, WAITED_MS };
