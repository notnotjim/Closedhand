// No stock phrases in what Closedhand says (lib/stock-phrases.js). A reply
// ended a point with "which is the part people miss", a phrase that adds
// nothing but the feel of an insight. Such phrases are cut in code, after the
// model, wherever cutting leaves a whole sentence, and a phrase the person
// says never to use is cut the same way. Invented sentences throughout.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { noStockPhrases: cut, ownPhrases } = require("../lib/stock-phrases");

test("a stock phrase goes wherever the sentence stands without it", () => {
  assert.equal(cut("The bakery raised prices twice, which is the part people miss. Caveat: it shuts in August.", null),
    "The bakery raised prices twice. Caveat: it shuts in August.", "a clause that trails off into it");
  assert.equal(cut("The ferry runs hourly - the bit most people miss.", null), "The ferry runs hourly.");
  assert.equal(cut("It sold out by noon. Let that sink in.\n\nNext, the stall.", null), "It sold out by noon.\n\nNext, the stall.", "a sentence that is only the phrase");
  assert.equal(cut("Book the 9:10. That’s the part most people miss.", null), "Book the 9:10.");
  assert.equal(cut("Here’s the thing: they close at six.", null), "They close at six.", "a sentence that leads in with it");
  assert.equal(cut("Here is the kicker - nobody checked the lock.", null), "Nobody checked the lock.");
  assert.equal(cut("What most people miss is that the fee doubles in May.", null), "The fee doubles in May.");
  assert.equal(cut("It sold, and here's the kicker: twice.", null), "It sold, and twice.");
});

test("where cutting it would break the sentence, or it is code, it stays", () => {
  assert.equal(cut("The part people miss is the fee.", null), "The part people miss is the fee.");
  assert.equal(cut("Run `here is the thing` in the shell.", null), "Run `here is the thing` in the shell.");
  assert.equal(cut("That’s the part most people miss.", null), "That’s the part most people miss.", "a reply that was nothing but the phrase is not emptied");
  assert.equal(cut("Nothing to cut here.", null), "Nothing to cut here.");
});

test("a phrase the person said never to use, kept as one of their preferences or a Pinned Fact about how they want things done, is cut the same way", () => {
  const store = {
    userRules: [{ rule: "Never say \"to be fair\" or \"honestly\"; call the allotment \"the plot\"." }, { rule: "Don't use emojis" }, "Never use the phrase at the end of the day."],
    facts: {
      "preference-sign-off": { value: "Prefers Closedhand not to use the word “cheers”.", category: "preference" },
      "person-ade": { value: "Ade never uses the name \"Adebayo\".", category: "person" },
    },
  };
  assert.deepEqual(ownPhrases(store), ["to be fair", "honestly", "at the end of the day", "cheers"], "only what the never names, quoted or after \"the phrase\"; a Pinned Fact only about how they want things done");
  assert.equal(cut("To be fair, the hedge is theirs. Honestly, it can wait.", store), "The hedge is theirs. It can wait.");
  assert.equal(cut("The shed is sorted, cheers.", store), "The shed is sorted.");
  assert.equal(cut("Thanks, Adebayo.", store), "Thanks, Adebayo.");
  assert.deepEqual(ownPhrases({ userRules: [{ rule: "Never use the phrase “…when all is said and done”." }] }), ["when all is said and done"]);
});

test("a preference keeps the words the person quoted when it is shortened", () => {
  const save = read("lib/tools/handlers.js").slice(read("lib/tools/handlers.js").indexOf('case "save_rule"'));
  assert.equal((save.slice(0, 6000).match(/in their words, keeping any words they quote exactly, in quotes/g) || []).length, 2);
});

test("every way Closedhand writes to the person goes through it", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /finalText = require\("\.\/stock-phrases"\)\.noStockPhrases\(finalText\);\n(?:\s*\/\/.*\n)*\s*finalText = await require\("\.\/chat-tables"\)\.forChatApp\(/, "a chat reply, before its page is kept");
  assert.ok(engine.indexOf("noStockPhrases(finalText)") > engine.indexOf("figures.correct({"), "after the figures check rewrites it");
  assert.match(engine, /let wrapText = require\("\.\/stock-phrases"\)\.noStockPhrases\(/, "the summary of a reply that ran out of time");
  const messaging = read("lib/messaging.js");
  assert.match(messaging, /sentElsewhere\(userId, platform, require\("\.\/stock-phrases"\)\.noStockPhrases\(/, "the web chat's copy of a message sent elsewhere");
  assert.match(messaging, /message = require\("\.\/chat-tables"\)\.flatten\(require\("\.\/stock-phrases"\)\.noStockPhrases\(/, "background answers, Pulse and reminders");
  assert.match(read("lib/pulse.js"), /text = require\("\.\/stock-phrases"\)\.noStockPhrases\(require\("\.\/plain-dashes"\)\.noEmDashes\(text\)\);/, "Pulse's kept copy");
  assert.match(read("lib/tools/handlers.js"), /const content = require\("\.\.\/stock-phrases"\)\.noStockPhrases\(noEmDashes\(/, "pages");
});
