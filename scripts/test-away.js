// A message that waited while Closedhand was offline (lib/away.js), and the
// answer that says so (lib/engine.js), from every chat app.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { create, TICK_MS } = require("../lib/away");

const root = path.join(__dirname, "..");
const MIN = 60000;

test("a message sent before Closedhand started, or while the computer slept, waited; one just sent did not", () => {
  const start = Date.parse("2026-11-10T09:00:00Z");
  const away = create({ startedAt: start });
  assert.deepEqual(away.waited(start - 30000, start + MIN), null, "sent just before a restart and answered a minute later: no note");
  assert.deepEqual(away.waited(start - 2 * 3600000, start + 120 * MIN + MIN), { to: start }, "sent while it was off");
  assert.equal(away.waited(start + 20 * MIN, start + 30 * MIN), null, "sent while it was running");
  // The computer sleeps from 09:30 to 11:00: its clock jumps between ticks.
  away.tick(start + 30 * MIN);
  away.tick(start + 30 * MIN + TICK_MS);
  away.tick(start + 120 * MIN);
  assert.deepEqual(away.waited(start + 45 * MIN, start + 121 * MIN), { to: start + 120 * MIN }, "sent while it slept");
  assert.equal(away.waited(start + 125 * MIN, start + 140 * MIN), null, "sent after it woke");
  assert.equal(away.waited(undefined), null);
  assert.equal(away.waited("not a time"), null);
});

test("the person hears it was offline once a spell, not on every message that waited", () => {
  const start = Date.parse("2026-11-10T09:00:00Z");
  const away = create({ startedAt: start });
  const spell = away.waited(start - 3600000, start + 10 * MIN);
  assert.equal(away.firstOf(spell), true);
  assert.equal(away.firstOf(away.waited(start - 1800000, start + 11 * MIN)), false, "a second message from the same spell");
  away.tick(start + 20 * MIN);
  away.tick(start + 90 * MIN);
  assert.equal(away.firstOf(away.waited(start + 40 * MIN, start + 95 * MIN)), true, "a new spell");
  assert.equal(away.firstOf(null), false);
});

test("its answer adds one short message saying so, and the first time ever where Always on is", () => {
  const engine = fs.readFileSync(path.join(root, "lib/engine.js"), "utf8");
  assert.match(engine, /if \(turnOpts\.sentAt\) \{\n\s*const away = require\("\.\/away"\);\n\s*const spell = away\.waited\(turnOpts\.sentAt\);\n\s*if \(spell && away\.firstOf\(spell\)\) turnOpts\.awayNote = await awayNote\(userId\)/);
  assert.match(engine, /add a line holding only \[\[next\]\] and then one short message in your own voice, light or playful as fits, saying you were offline when it came in\. No apology, and never tell them to keep the computer on\./);
  assert.match(engine, /const alwaysOn = !settings\.away_always_on_said && !process\.env\.RAILWAY_ENVIRONMENT_ID && require\("\.\/move-marker"\)\.available\(\);/, "once, and only where it can be had");
  assert.match(engine, /Always on, in My Account on the dashboard, keeps you reachable even when the computer is off\./);
  assert.match(engine, /buildQuickTail\(userMessage \|\| ""\) \+ \(opts\.awayNote \? "\\n\\n" \+ opts\.awayNote : ""\)/, "a quick reply says it too");
  assert.match(engine, /\(opts\.awayNote \? "\\n\\n" \+ opts\.awayNote : ""\) \+ "\\n\\n" \+ \(opts\.spoken/);
  assert.match(fs.readFileSync(path.join(root, "index.js"), "utf8"), /const away = require\("\.\/lib\/away"\);[\s\S]*away\.start\(\);/, "loaded early, ticking once running");
});

test("every chat app says when its message was sent", () => {
  const read = (f) => fs.readFileSync(path.join(root, "lib/platforms", f), "utf8");
  assert.equal((read("telegram.js").match(/createTelegramStatusOpts\(chatId, msg\.date \* 1000\)/g) || []).length, 5);
  assert.match(read("telegram.js"), /\.\.\.\(sentAt \? \{ sentAt \} : \{\}\),/);
  assert.match(read("whatsapp-linked.js"), /const sentAt = Number\(msg\.messageTimestamp \|\| 0\) \* 1000 \|\| undefined;/);
  assert.equal((read("whatsapp-linked.js").match(/_selfJid, \{ sentAt \}\)/g) || []).length, 2);
  assert.equal((read("whatsapp.js").match(/Number\(msg\.timestamp\) \* 1000 \|\| undefined/g) || []).length, 3);
  assert.match(read("discord.js"), /opts\.sentAt = msg\.createdTimestamp;/);
  assert.match(read("slack-handler.js"), /opts\.sentAt = Number\(slackTs\) \* 1000 \|\| undefined;/);
  assert.match(read("line.js"), /queuedAsk\(userId, text, null, lineUserId, \{ sentAt: event\.timestamp \}\)/);
});
