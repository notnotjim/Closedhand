// A Docker Closedhand keeps itself up to date, as the Mac app does: install.sh
// schedules scripts/closedhand-update.sh daily, which installs a newer version only once
// Closedhand is between replies, by running install.sh again. These run the
// real scripts against stand-in docker, git, curl, launchctl and crontab.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.join(__dirname, "..");
const install = fs.readFileSync(path.join(root, "install.sh"), "utf8");

function tool(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// One daily run in a stand-in checkout. Returns what it did, in order.
function daily({ docker = true, containers = "c1", running = "sha256:new", pulled = "sha256:new", head = "a1", upstream = "a1", dirty = false, busy = 0, hangs = false, blips = 0 } = {}) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "ch-update-"));
  fs.mkdirSync(path.join(t, "scripts"));
  fs.mkdirSync(path.join(t, "bin"));
  fs.copyFileSync(path.join(root, "scripts", "closedhand-update.sh"), path.join(t, "scripts", "closedhand-update.sh"));
  fs.writeFileSync(path.join(t, ".env"), "POSTGRES_DB=closedhand\nBOT_PORT=3901   # bot\n");
  fs.writeFileSync(path.join(t, "head"), head);
  fs.writeFileSync(path.join(t, "busy"), String(busy));
  fs.writeFileSync(path.join(t, "install.sh"), `echo "installed plain=$CLOSEDHAND_PLAIN no-open=$CLOSEDHAND_NO_OPEN" >> "${t}/did"\n`);
  const did = (what) => `echo "${what}" >> "${t}/did"`;
  tool(path.join(t, "bin"), "docker", `case "$*" in
  "info") ${docker ? "exit 0" : "exit 1"} ;;
  "compose ps -q") printf '%s\\n' ${containers} ;;
  "compose pull -q") ${hangs ? "exec /bin/sleep 30" : `n=$(cat "${t}/blips" 2>/dev/null || echo ${blips}); if [ "$n" -gt 0 ]; then echo $((n - 1)) > "${t}/blips"; ${did("pull failed")}; exit 1; fi; ${did("pulled")}`} ;;
  "inspect --format {{.Config.Image}} "*) echo ghcr.io/x/closedhand-bot:latest ;;
  "inspect --format {{.Image}} "*) echo ${running} ;;
  "image inspect --format {{.Id}} ghcr.io/x/closedhand-bot:latest") echo ${pulled} ;;
esac`);
  tool(path.join(t, "bin"), "git", `case "$*" in
  "diff --quiet"|"diff --cached --quiet") ${dirty ? "exit 1" : "exit 0"} ;;
  "fetch -q") ${did("fetched")} ;;
  "rev-parse HEAD") cat "${t}/head" ;;
  "rev-parse @{u}") echo ${upstream} ;;
  "merge-base --is-ancestor HEAD @{u}") exit 0 ;;
  "merge -q --ff-only @{u}") echo ${upstream} > "${t}/head"; ${did("merged")} ;;
  *) exit 1 ;;
esac`);
  tool(path.join(t, "bin"), "curl", `${did("asked $4")}
n=$(cat "${t}/busy"); if [ "$n" -gt 0 ]; then echo $((n - 1)) > "${t}/busy"; echo '{"status":"ok","busy":true}'; else echo '{"status":"ok","busy":false}'; fi`);
  // The three-hour limit on a pull passes in a moment here.
  tool(path.join(t, "bin"), "sleep", `if [ "$1" = 10800 ]; then exec /bin/sleep ${hangs ? 1 : 5}; fi\n${did("waited")}`);
  execFileSync("sh", [path.join(t, "scripts", "closedhand-update.sh")], { env: { PATH: `${path.join(t, "bin")}:/usr/bin:/bin`, HOME: t } });
  const read = (f) => (fs.existsSync(path.join(t, f)) ? fs.readFileSync(path.join(t, f), "utf8").trim() : "");
  const out = { did: read("did").split("\n").filter(Boolean), log: read("update.log") };
  fs.rmSync(t, { recursive: true, force: true });
  return out;
}

test("nothing new: fetched, nothing installed", () => {
  const { did, log } = daily();
  assert.deepEqual(did, ["fetched", "pulled"]);
  assert.match(log, /Already the newest\./);
});

test("newer images: installed once Closedhand is between replies", () => {
  const { did } = daily({ running: "sha256:old", busy: 2 });
  assert.deepEqual(did, ["fetched", "pulled", "asked http://127.0.0.1:3901/health", "waited", "asked http://127.0.0.1:3901/health", "waited", "asked http://127.0.0.1:3901/health", "installed plain=1 no-open=1"]);
});

test("newer code: put in place only when it is going in", () => {
  assert.deepEqual(daily({ head: "a1", upstream: "b2" }).did, ["fetched", "pulled", "asked http://127.0.0.1:3901/health", "merged", "installed plain=1 no-open=1"]);
  const busy = daily({ head: "a1", upstream: "b2", busy: 999 });
  assert.ok(!busy.did.includes("merged") && !busy.did.some((d) => d.startsWith("installed")), "still behind, so tomorrow sees it again");
  assert.equal(busy.did.filter((d) => d === "waited").length, 60, "an hour, looked at once a minute");
  assert.match(busy.log, /Busy for an hour\. Trying again tomorrow\./);
});

test("a connection lost for a moment is tried again a minute later, and the update goes ahead", () => {
  const { did } = daily({ running: "sha256:old", blips: 1 });
  assert.deepEqual(did.slice(0, 4), ["fetched", "pull failed", "waited", "pulled"]);
  assert.equal(did.at(-1), "installed plain=1 no-open=1");
});

test("a pull that hangs is stopped, tried once more a minute later, then tomorrow", () => {
  const { did, log } = daily({ running: "sha256:old", hangs: true });
  assert.deepEqual(did, ["fetched", "waited"]);
  assert.match(log, /Couldn't fetch the images\. Trying again tomorrow\./);
});

test("left alone: Docker off, Closedhand stopped, or the code edited here", () => {
  assert.deepEqual(daily({ docker: false, running: "sha256:old" }).did, []);
  assert.deepEqual(daily({ containers: "", running: "sha256:old" }).did, [], "someone stopped it");
  assert.deepEqual(daily({ dirty: true, head: "a1", upstream: "b2" }).did, ["pulled"], "local edits stay, as install.sh leaves them");
});

// install.sh's own scheduling code, run against stand-ins.
const schedule = install.match(/UPDATES=""\nkeep_up_to_date\(\) \{[\s\S]*?\n\}\nkeep_up_to_date\n\{[^\n]*\n[^\n]*\n/)[0];

function scheduleOn(system, t, { loaded = false, running = false, cron = true } = {}) {
  fs.mkdirSync(path.join(t, "bin"), { recursive: true });
  fs.mkdirSync(path.join(t, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(t, "scripts", "closedhand-update.sh"), "");
  if (!fs.existsSync(path.join(t, ".env"))) fs.writeFileSync(path.join(t, ".env"), "POSTGRES_DB=closedhand\n");
  const did = (what) => `echo "${what}" >> "${t}/did"`;
  tool(path.join(t, "bin"), "uname", `echo ${system}`);
  tool(path.join(t, "bin"), "docker", "");
  tool(path.join(t, "bin"), "id", "echo 501");
  tool(path.join(t, "bin"), "launchctl", `case "$1" in print) ${loaded || running ? `echo "state = ${running ? "running" : "not running"}"` : "exit 1"} ;; *) ${did("launchctl $1 $2")} ;; esac`);
  tool(path.join(t, "bin"), "pgrep", cron ? `[ "$2" = cron ]` : "exit 1");
  tool(path.join(t, "bin"), "crontab", `if [ "$1" = -l ]; then cat "${t}/crontab" 2>/dev/null; else cat > "${t}/crontab.new" && mv "${t}/crontab.new" "${t}/crontab"; ${did("crontab")}; fi`);
  const run = path.join(t, "run.sh");
  fs.writeFileSync(run, `set -eu\ncd "${t}"\n${schedule}echo "UPDATES=$UPDATES"\n`);
  return execFileSync("sh", [run], { env: { PATH: `${path.join(t, "bin")}:/usr/bin:/bin`, HOME: t }, encoding: "utf8" });
}

test("on a Mac, a LaunchAgent at 4 each morning, and Closedhand told", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "ch-schedule-"));
  assert.match(scheduleOn("Darwin", t), /UPDATES=on/);
  const plist = fs.readFileSync(path.join(t, "Library/LaunchAgents/com.closedhand.update.plist"), "utf8");
  assert.ok(plist.includes(`<key>ProgramArguments</key><array><string>${t}/scripts/closedhand-update.sh</string></array>`), "by its own name, not sh");
  assert.match(plist, /<key>StartCalendarInterval<\/key><dict><key>Hour<\/key><integer>4<\/integer><key>Minute<\/key><integer>0<\/integer><\/dict>/);
  assert.ok(plist.includes(`<key>PATH</key><string>${t}/bin:/usr/local/bin:`), "finds docker where the installer did");
  if (process.platform === "darwin") execFileSync("plutil", ["-lint", path.join(t, "Library/LaunchAgents/com.closedhand.update.plist")]);
  assert.deepEqual(fs.readFileSync(path.join(t, "did"), "utf8").trim().split("\n"), ["launchctl bootout gui/501/com.closedhand.update", "launchctl bootstrap gui/501"]);
  assert.equal(fs.readFileSync(path.join(t, ".env"), "utf8"), "POSTGRES_DB=closedhand\nCLOSEDHAND_AUTO_UPDATE=1\n");
  fs.rmSync(path.join(t, "did"));
  scheduleOn("Darwin", t, { loaded: true });
  assert.ok(!fs.existsSync(path.join(t, "did")), "unchanged and loaded: left running, since the update itself runs this");
  assert.equal(fs.readFileSync(path.join(t, ".env"), "utf8"), "POSTGRES_DB=closedhand\nCLOSEDHAND_AUTO_UPDATE=1\n", "said once");
  const agent = path.join(t, "Library/LaunchAgents/com.closedhand.update.plist");
  fs.writeFileSync(agent, "an older schedule");
  scheduleOn("Darwin", t, { running: true });
  assert.ok(!fs.existsSync(path.join(t, "did")), "changed while running: reloading would stop the update it is doing");
  assert.equal(fs.readFileSync(agent, "utf8"), plist, "written, to take over at the next sign-in");
  fs.rmSync(t, { recursive: true, force: true });
});

test("elsewhere, one cron line beside the person's own", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "ch-schedule-"));
  fs.writeFileSync(path.join(t, "crontab"), "30 2 * * * /home/sam/backup.sh\n0 3 * * * /bin/sh '/old/scripts/update.sh' # closedhand-update\n");
  assert.match(scheduleOn("Linux", t), /UPDATES=on/);
  const line = `0 4 * * * PATH='${t}/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' /bin/sh '${t}/scripts/closedhand-update.sh' # closedhand-update`;
  assert.equal(fs.readFileSync(path.join(t, "crontab"), "utf8"), `30 2 * * * /home/sam/backup.sh\n${line}\n`);
  scheduleOn("Linux", t);
  assert.equal(fs.readFileSync(path.join(t, "did"), "utf8").trim(), "crontab", "written once");
  fs.rmSync(t, { recursive: true, force: true });
});

test("with nothing to run it, Settings keeps saying how to update", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "ch-schedule-"));
  fs.writeFileSync(path.join(t, ".env"), "POSTGRES_DB=closedhand\nCLOSEDHAND_AUTO_UPDATE=1\n");
  const out = scheduleOn("Linux", t, { cron: false });
  assert.match(out, /UPDATES=$/m);
  assert.equal(fs.readFileSync(path.join(t, ".env"), "utf8"), "POSTGRES_DB=closedhand\n");
  fs.rmSync(t, { recursive: true, force: true });
});

test("the schedule is set before Closedhand starts, so it starts knowing", () => {
  const at = install.indexOf("keep_up_to_date\n{ grep");
  assert.ok(at > 0 && at < install.indexOf("run docker compose up -d") && at < install.indexOf("pull_progress docker compose pull"));
  assert.match(install, /if \[ "\$\{CLOSEDHAND_NO_OPEN:-0\}" != "1" \] && browser_here; then/, "the daily run opens no browser");
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^update\.log$/m);
});
