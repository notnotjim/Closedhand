// The sandbox computer's screen, kept working with nobody watching it.
// entrypoint.sh restarts each part of the screen when it quits. This catches
// a part that stops working without quitting: a display that no longer
// answers, a Chrome that froze, the stream to the Computers tab gone. Every
// 30 seconds the parts are asked to answer, in the order they depend on each
// other, and the first that fails twice in a row is ended, so entrypoint.sh
// starts it again. A part restarted three times in ten minutes that still
// fails is left to its next turn rather than ended again and again.
// /desktop/status reports what this finds, so the Computers tab says the
// browser is restarting instead of showing a grey screen.
const fs = require("fs");
const net = require("net");
const http = require("http");
const { execFile } = require("child_process");

const EVERY_MS = 30 * 1000;
const SETTLE_MS = 60 * 1000; // a part just started is left this long to come up
const MAX_RESTARTS = 3;
const WINDOW_MS = 10 * 60 * 1000;

// The running (not finished) processes with this name, oldest first.
function processes(name) {
  const out = [];
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (comm !== name || fields[0] === "Z") continue;
      out.push({ pid: Number(pid), started: Number(fields[19]), args: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8") });
    } catch { /* gone meanwhile */ }
  }
  return out.sort((a, b) => a.started - b.started);
}

function end(part) {
  // Chrome's own process, not its tabs: they go with it.
  const all = processes(part.proc);
  const targets = part.proc === "chromium" ? all.filter((p) => !p.args.includes("--type=")).slice(0, 1) : all;
  for (const p of targets) { try { process.kill(p.pid, "SIGKILL"); } catch {} }
  console.log(`[screen] the ${part.name} stopped answering, restarted it`);
}

function displayAnswers() {
  return new Promise((resolve) => execFile("xdpyinfo", ["-display", ":99"], { timeout: 5000 }, (err) => resolve(!err)));
}
function browserAnswers(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 10000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
// x11vnc greets every new connection with its version ("RFB 003.008").
function screenAnswers() {
  return new Promise((resolve) => {
    const s = net.connect(5900, "127.0.0.1");
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(5000, () => done(false));
    s.once("data", (d) => done(d.toString("latin1").startsWith("RFB ")));
    s.once("error", () => done(false));
  });
}
// websockify listens on IPv6 or IPv4, whichever the host has (entrypoint.sh).
function listens(port) {
  const one = (host) => new Promise((resolve) => {
    const s = net.connect(port, host);
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(3000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
  return one("127.0.0.1").then((ok) => ok || one("::1"));
}

function screenParts(cdpPort) {
  return [
    { name: "display", proc: "Xvfb", check: displayAnswers },
    { name: "browser", proc: "chromium", check: () => browserAnswers(cdpPort) },
    { name: "screen", proc: "x11vnc", check: screenAnswers },
    { name: "stream", proc: "websockify", check: () => listens(6080) },
  ];
}

// "ok", "restarting" (a part is being brought back) or "stuck" (it was
// restarted three times in ten minutes and still fails; it is tried again
// when the oldest of those leaves the ten minutes).
function createWatch({ parts, end: stop = end, now = Date.now }) {
  const state = { screen: "ok", part: null };
  const fails = new Map(), restarts = new Map();
  let quietUntil = now() + SETTLE_MS;
  async function tick() {
    if (now() < quietUntil) return state;
    for (const part of parts) {
      if (await part.check()) { fails.set(part.name, 0); continue; }
      const n = (fails.get(part.name) || 0) + 1;
      fails.set(part.name, n);
      if (n < 2) return state; // one slow answer is not a failure
      const recent = (restarts.get(part.name) || []).filter((t) => now() - t < WINDOW_MS);
      if (recent.length < MAX_RESTARTS) {
        stop(part);
        recent.push(now());
        fails.set(part.name, 0);
        quietUntil = now() + SETTLE_MS;
        Object.assign(state, { screen: "restarting", part: part.name });
      } else {
        Object.assign(state, { screen: "stuck", part: part.name });
      }
      restarts.set(part.name, recent);
      return state;
    }
    Object.assign(state, { screen: "ok", part: null });
    return state;
  }
  return { tick, state };
}

let _watch = null;
function startScreenWatch(cdpPort) {
  _watch = createWatch({ parts: screenParts(cdpPort) });
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    _watch.tick().catch(() => {}).finally(() => { running = false; });
  }, EVERY_MS);
  if (timer.unref) timer.unref();
}
function screenState() {
  return _watch ? { screen: _watch.state.screen, part: _watch.state.part || undefined } : { screen: "ok" };
}

module.exports = { createWatch, startScreenWatch, screenState, processes };
