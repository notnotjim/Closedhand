// Closedhand's own writing has no emdashes. The model is asked not to use
// them and to write a spaced hyphen where a dash reads best, and every
// reply, background answer, report and sent message has any that slip
// through turned into that hyphen, a colon or a bullet: a dash the model
// chose stays a dash, never forced into a comma. Code and number ranges are
// left alone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { noEmDashes } = require("../lib/plain-dashes");
const EM = "—", EN = "–";

test("an emdash becomes the hyphen a person types for a dash", () => {
  assert.equal(noEmDashes(`Cà Phê Zoom ${EM} 169A Trần Hưng Đạo, open 06:00${EN}22:00.`), `Cà Phê Zoom - 169A Trần Hưng Đạo, open 06:00${EN}22:00.`);
  assert.equal(noEmDashes(`Two options${EM}both close.`), "Two options - both close.");
  assert.equal(noEmDashes(`It is cheap ${EM} £14 a night ${EM} and close.`), "It is cheap - £14 a night - and close.");
  assert.equal(noEmDashes(`Here is what I found ${EM}\n- one`), "Here is what I found:\n- one");
  assert.equal(noEmDashes(`${EM} first\n${EM} second`), "- first\n- second");
  assert.equal(noEmDashes(`Done ${EM}.`), "Done.");
  assert.equal(noEmDashes(`A spaced ${EN} en dash`), "A spaced - en dash");
});

test("hyphens stay wherever they belong", () => {
  const hyphens = "A well-known follow-up on 2026-10-27, 10-12 October, -5°C, ref AB-1234, https://a-b.example/x-y\n- a bullet";
  assert.equal(noEmDashes(hyphens), hyphens);
  assert.equal(noEmDashes(`${hyphens} ${EM} and more`), `${hyphens} - and more`, "untouched when an emdash beside them goes");
  const told = read("lib/response-presentation.js");
  assert.match(told, /Punctuate as reads best: where a dash does, use a hyphen with a space each side \( - \), and otherwise a comma, colon or full stop\./, "the model is told a dash is still a dash, so banning the long one never forces a comma");
  assert.match(told, /Hyphens also stay wherever else they belong: compound words \(follow-up, well-known\), list bullets and codes\./);
  assert.match(read("lib/engine.js"), /No emdash \(the long dash\); where a dash reads best, a hyphen with a space each side\./, "in short replies too");
});

test("code and ranges are left as written", () => {
  assert.equal(noEmDashes(`Use \`a ${EM} b\` here`), `Use \`a ${EM} b\` here`);
  assert.equal(noEmDashes("```\nx = 'a " + EM + " b'\n```"), "```\nx = 'a " + EM + " b'\n```");
  assert.equal(noEmDashes(`10${EN}12 October`), `10${EN}12 October`);
  assert.equal(noEmDashes(null), null);
});

test("every way Closedhand writes to the person goes through it", () => {
  // Chat replies, last of all: the figures check rewrites some answers after
  // they are written, and once put an emdash back that reached the person.
  const engine = read("lib/engine.js");
  const cleaned = engine.indexOf('finalText = require("./plain-dashes").noEmDashes(marked.text);');
  assert.ok(cleaned > engine.indexOf('figures.correct({'), "chat replies, after the figures check");
  assert.match(engine, /finalText = require\("\.\/plain-dashes"\)\.noEmDashes\(marked\.text\);\n\s*conversation\.push\(\{ role: "assistant", content: finalText \}\);/, "right before the reply is kept and sent");
  assert.match(engine, /const wrapText = require\("\.\/plain-dashes"\)\.noEmDashes\(/, "the summary of a reply that ran out of time");
  assert.match(read("lib/engine.js"), /return require\("\.\/plain-dashes"\)\.noEmDashes\(line \|\|/, "the hand-over note");
  assert.match(read("lib/messaging.js"), /async function sendToPlatform\(platform, chatId, message\) \{\n  message = require\("\.\/plain-dashes"\)\.noEmDashes\(message\);/, "background answers, reminders and notices");
  assert.match(read("lib/tools/handlers.js"), /const title = noEmDashes\([\s\S]{0,80}const content = noEmDashes\(/, "reports");
  assert.match(read("lib/response-presentation.js"), /Never write the emdash \(the long dash\), in anything/);
  assert.doesNotMatch(read("lib/plain-dashes.js"), new RegExp(EM), "the rule's own code holds none either");
});

test("projects are saved without emdashes too", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../lib/projects.js"), "utf8");
  assert.match(src, /const cleanText = \(x, n\) => require\("\.\/plain-dashes"\)\.noEmDashes\(String\(x \|\| ""\)\)\.trim\(\)\.slice\(0, n\);/);
  assert.match(src, /summary: cleanText\(t\.summary, 300\),\n\s*state: cleanState\(t\.state\),/);
  const { noEmDashes } = require("../lib/plain-dashes");
  const json = JSON.stringify({ facts: ["Not in email or calendar originally \u2014 WhatsApp only"] });
  assert.deepEqual(JSON.parse(noEmDashes(json)).facts, ["Not in email or calendar originally - WhatsApp only"]);
});
