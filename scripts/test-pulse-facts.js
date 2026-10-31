// What code works out exactly for Pulse (lib/pulse-facts.js), so the
// person's LLM judges instead of searching, and the writer that uses it: one
// call from the cited items, tools only when it asks. On a busy day the old
// writer was nine calls and some 300,000 tokens; this was three and 13,000.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const f = require("../lib/pulse-facts");
const pulse = fs.readFileSync(path.join(__dirname, "..", "lib", "pulse.js"), "utf8");

const H = 3600000, now = Date.parse("2026-10-24T12:00:00Z");
const msg = (chat, sender, iso, text = "") => ({ source: "whatsapp", type: "message", external_id: `${chat}-${iso}`, received_at: iso, data: { chat, sender, date: iso, text } });
const mail = (threadId, iso, labels = ["INBOX"]) => ({ source: "gmail", type: "email", external_id: `${threadId}-${iso}`, received_at: iso, data: { threadId, labels, from: "ravi@lantern.test", subject: "Hearth on Saturday" } });

test("how long, in words a person reads", () => {
  assert.equal(f.span(20 * 60000), "under an hour");
  assert.equal(f.span(14 * H), "14 h");
  assert.equal(f.span(50 * H), "2 days");
});

test("whether they wrote since, by chat and by mail thread", () => {
  const wrote = f.lastWritten({ mine: [msg("harbour", "me", "2026-10-24T09:00:00Z")], sentMail: [mail("t1", "2026-10-24T08:00:00Z", ["SENT"])] });
  assert.equal(f.replyNote(msg("harbour", "Ana", "2026-10-24T08:30:00Z"), wrote, now), "you have written in this chat since");
  assert.equal(f.replyNote(msg("harbour", "Ana", "2026-10-24T10:00:00Z"), wrote, now), "nothing from you in this chat since, 2 h");
  assert.equal(f.replyNote(msg("lantern", "Ravi", "2026-10-23T22:00:00Z"), wrote, now), "nothing from you in this chat since, 14 h");
  assert.equal(f.replyNote(mail("t1", "2026-10-24T07:00:00Z"), wrote, now), "you have replied in this thread since");
  assert.equal(f.replyNote(mail("t2", "2026-10-22T10:00:00Z"), wrote, now), "no reply from you in this thread, 2 days");
});

test("what came minutes after their own message was seen as it came, and says so", () => {
  const justWrote = f.lastWritten({ mine: [msg("aurora", "me", "2026-10-24T11:17:00Z")], sentMail: [mail("t3", "2026-10-24T11:40:00Z", ["SENT"])] });
  const away = msg("aurora", "Clinica Aurora", "2026-10-24T11:20:00Z", "Thanks for your message. The team is out until Monday and will reply then.");
  assert.equal(f.seenAsItCame(away, justWrote), true, "an away message three minutes after they wrote");
  assert.equal(f.seenAsItCame(mail("t3", "2026-10-24T11:40:20Z"), justWrote), true, "an out-of-office reply to mail they just sent");
  assert.equal(f.seenAsItCame(msg("aurora", "Clinica Aurora", "2026-10-24T11:45:00Z"), justWrote), false, "half an hour later they may have gone");
  assert.equal(f.seenAsItCame(msg("aurora", "Clinica Aurora", "2026-10-24T11:10:00Z"), justWrote), false, "before they wrote");
  assert.equal(f.seenAsItCame(msg("lantern", "Ravi", "2026-10-24T11:20:00Z"), justWrote), false, "a chat they did not write in");
  assert.equal(f.seenAsItCame({ type: "message", data: { chat: "aurora" } }, justWrote), false, "no time, not seen");
  assert.equal(f.replyNote(away, justWrote, now), "came 3 min after you wrote; nothing from you in this chat since, under an hour");
  assert.equal(f.replyNote(mail("t3", "2026-10-24T11:40:20Z"), justWrote, now), "came 1 min after you wrote; no reply from you in this thread, under an hour");
  assert.equal(f.replyNote(msg("aurora", "Clinica Aurora", "2026-10-24T11:45:00Z"), justWrote, now), "nothing from you in this chat since, under an hour");
  // Like what they sent, never news: it does not wake a look or count as new.
  assert.match(pulse, /const realEmails = \(newEmails \|\| \[\]\)\.filter\(e => [^\n]*&& !facts\.seenAsItCame\(e, wrote\)[^\n]*\);/);
  assert.match(pulse, /const otherItems = \(newOther \|\| \[\]\)\.filter\(\(r\) => !watches\.ignored\(r\) && unclaimed\(r\) && !facts\.seenAsItCame\(r, wrote\)\)/);
  assert.match(pulse, /if \(realEmails\.length === 0 && otherItems\.length === 0 && !world\.length && !enteringSoon && !lookDue\)/);
  // The other side owes the next word for half a day; after that it can
  // look forgotten.
  assert.deepEqual(f.waiting([away], justWrote, now), [], "now, 40 minutes on");
  assert.deepEqual(f.waiting([away], justWrote, Date.parse("2026-10-24T23:30:00Z")).map((r) => r.external_id), [away.external_id], "twelve hours on");
  assert.deepEqual(f.waiting([msg("aurora", "Clinica Aurora", "2026-10-24T11:45:00Z")], justWrote, now).length, 1, "what came later waits on them");
});

test("what a booking's provider sends around its confirmation is part of the booking they just made", () => {
  const from = (who, iso, subject = "") => ({ source: "gmail", type: "email", external_id: `${who}-${iso}`, received_at: iso, data: { from: who, date: iso, subject } });
  const booked = [{ domain: f.domainOf('"Stays" <noreply-payments@stays.example>'), at: Date.parse("2026-10-24T10:08:57Z") }];
  assert.equal(booked[0].domain, "stays.example");
  assert.equal(f.domainOf("Front desk <desk@mail.harbourinn.co.uk>"), "harbourinn.co.uk", "a country's second level stays with the name");
  assert.equal(f.domainOf("no address"), "");
  assert.equal(f.partOfBooking(from("customer.service@stays.example", "2026-10-24T10:09:07Z", "Request sent to Hotel Aurora Seoul"), booked), true, "a check-in request passed on, ten seconds later");
  assert.equal(f.partOfBooking(from("Stays <welcome@stays.example>", "2026-10-24T10:06:52Z", "Verify your identity"), booked), true, "and just before");
  assert.equal(f.partOfBooking(from("customer.service@stays.example", "2026-10-24T14:00:00Z", "Your host sent a message"), booked), false, "hours later it is its own news");
  assert.equal(f.partOfBooking(from("ravi@lantern.test", "2026-10-24T10:09:00Z"), booked), false, "another sender");
  assert.equal(f.partOfBooking(msg("stays", "Stays", "2026-10-24T10:09:00Z"), booked), false, "mail only");
  assert.equal(f.partOfBooking(from("customer.service@stays.example", "2026-10-24T10:09:07Z"), []), false, "no booking made");
  // Neither new nor waiting on them, whatever its sender.
  assert.match(pulse, /const realEmails = [^\n]*&& !facts\.partOfBooking\(e, bookingMail\)\);/);
  assert.match(pulse, /const inboundMail = [^\n]*\n[^\n]*&& !facts\.partOfBooking\(e, bookingMail\)\);/);
  assert.match(pulse, /from\("bookings"\)\.select\("source_email_id"\)/);
});

test("waiting on them: the latest message in each conversation they have not written in since", () => {
  const wrote = f.lastWritten({ mine: [msg("harbour", "me", "2026-10-24T09:00:00Z")] });
  const rows = [
    msg("harbour", "Ana", "2026-10-24T08:00:00Z"), // answered
    msg("lantern", "Ravi", "2026-10-23T20:00:00Z"),
    msg("lantern", "Ravi", "2026-10-23T22:00:00Z"), // the latest in that chat
    mail("t9", "2026-10-24T11:00:00Z"),
  ];
  assert.deepEqual(f.waiting(rows, wrote, now).map((r) => r.external_id), ["t9-2026-10-24T11:00:00Z", "lantern-2026-10-23T22:00:00Z"]);
});

test("how soon a coming entry starts, and which overlap", () => {
  const ev = (start, end) => ({ type: "event", received_at: start, data: { start, end } });
  assert.equal(f.untilNote(ev("2026-10-24T15:00:00Z", "2026-10-24T16:00:00Z"), now), "starts in 3 h");
  assert.equal(f.untilNote(ev("2026-10-26", "2026-10-27"), now), "", "an all-day entry's date says enough");
  const coming = [ev("2026-10-24T15:00:00Z", "2026-10-24T16:00:00Z"), ev("2026-10-24T15:30:00Z", "2026-10-24T17:00:00Z"), ev("2026-10-24T16:00:00Z", "2026-10-24T16:30:00Z"), ev("2026-10-24", "2026-10-25")];
  assert.deepEqual(f.overlaps(coming), [[0, 1], [1, 2]], "touching is not overlapping; all-day is left out");
});

test("Pulse: the picture carries the facts, and conversations waiting on them", () => {
  assert.match(pulse, /\.eq\("type", "message"\)\.neq\("data->>sender", "me"\)/, "what others wrote, three days back");
  assert.match(pulse, /const waitingRows = facts\.waiting\(\[\.\.\.\(theirs \|\| \[\]\), \.\.\.inboundMail\], wrote\)\n\s*\.filter\(\(r\) => !watches\.ignored\(r\) && unclaimed\(r\) && !isNew\.has/);
  assert.match(pulse, /noted\(l, "overlaps " \+ overlapsOf\.get\(i\)/);
  assert.match(pulse, /coming\.map\(\(r\) => noted\(line\(r\), facts\.untilNote\(r\),/);
  assert.match(require("../lib/pulse-triage").notice.toString(), /WAITING ON THEM \(in each conversation, the latest message from someone else that they have not written in since\)/);
});

test("the writer: one call from the cited items, tools only when it asks", () => {
  const one = pulse.indexOf("let written = await writeOnce();"), loop = pulse.indexOf("while (iteration < MAX_PULSE_ITERATIONS)");
  assert.ok(one > 0 && one < loop, "the one call comes first");
  assert.match(pulse, /if \(written && typeof written === "object" && !written\.lookup\) \{[\s\S]{0,1200}await markChecked\(\);\n\s*return;\n\s*\}/, "and ends the check unless it asked for a lookup");
  assert.match(pulse, /if \(written\?\.lookup\) messages\[0\]\.content \+= `\\n\\nLook this up first: /);
  assert.match(pulse, /Write it again with exactly those parts removed or corrected to what the items say, and nothing else changed or added\./, "one more go, fixing only what was held");
  assert.match(pulse, /Every fact comes from the items\. Add no guesses or advice that rest on what they do not say/);
  assert.match(pulse, /One point: the fewest short sentences that carry it, four at most, one thing in each\. Several: one short, plain line each/);
  assert.match(pulse, /THE CITED EMAILS IN FULL/);
  // A cited chat message comes with its conversation, the person's side too:
  // alone, "will you be back before the 20th?" from a dad abroad read as back
  // where their flight home lands.
  assert.match(pulse, /\.eq\("type", "message"\)\.eq\("data->>chat", chat\)\.order\("received_at", \{ ascending: false \}\)\.limit\(12\)/);
  assert.match(pulse, /THE CITED CHATS, LAST MESSAGES \(oldest first\):/);
  assert.match(pulse, /const brief = `\$\{about \? `ABOUT THEM \(who they are, the people in their life and where they live/, "the writer knows who the people are, as the noticing does");
  assert.match(pulse, /const result = await sendChecked\(String\(\(block\.input && block\.input\.text\) \|\| ""\)\.trim\(\), lookedUp, null, block\.input && block\.input\.project\);/, "both ways go through the same check");
  assert.match(pulse, /ctx\.store\.facts\._pulse_last = \{ value: /, "what it told them is kept in code");
  assert.match(pulse, /text = require\("\.\/plain-dashes"\)\.noEmDashes\(text\);/);
  assert.match(require("../lib/pulse-triage").notice.toString(), /say only what they show: no guesses about the person's circumstances/);
});

// Someone a cited chat is with whom Closedhand knows nothing about is asked
// about once, never guessed: from the chat alone, "will you be back before
// the 20th?" from a dad abroad was answered with the flight home.
test("who of the people a message is from no Pinned Fact names, asked about once", () => {
  const m = (chat, chat_name) => ({ type: "message", data: { chat, chat_name } });
  const known = { "family-partner": { value: "Mina is Sam's partner; she is from Lyon", subject: "Mina" }, "family-dad": { value: "Pete is Sam's dad", subject: "Pete" }, _pulse_last: { value: "Mike's moved the weekend" } };
  assert.equal(f.unknownPerson([m("447700900002@s.whatsapp.net", "Mike")], known), "Mike", "Closedhand's own note of what it said does not make him known");
  assert.equal(f.unknownPerson([m("447700900003@s.whatsapp.net", "Minako")], known), null, "a fact's short form covers the chat's name");
  assert.equal(f.unknownPerson([m("447700900004@s.whatsapp.net", "Peter")], known), null);
  assert.equal(f.unknownPerson([m("447700900002@s.whatsapp.net", "Mike")], known, ["mike"]), null, "asked once");
  assert.equal(f.unknownPerson([m("120363000000000001@g.us", "Flat 4 group")], known), null, "not a group");
  assert.equal(f.unknownPerson([m("447700900005@s.whatsapp.net", "Clinica Sorriso")], known), null, "nor an organisation");
  assert.equal(f.unknownPerson([m("447700900006@s.whatsapp.net", "+44 7700 900006")], known), null, "nor a number");
  assert.equal(f.unknownPerson([{ type: "email", data: { from: "Ana <ana@example.test>" } }], known), null, "chats only");
  // The writer is told, and when what it would say rests on who they are or
  // where they live (one narrow question to their LLM), it asks first.
  assert.match(pulse, /const askWho = facts\.unknownPerson\(numbered\.filter\(\(r, i\) => r && r\.type === "message" && cited\.has\(i \+ 1\)\), store\.facts, settings\.asked_who\);/);
  assert.match(pulse, /if \(askWho\) chatText \+= `\\n\\nNOT KNOWN TO CLOSEDHAND: who \$\{askWho\} is to \$\{userName\}, and where they live\. Never assume either/);
  assert.match(pulse, /Would anything you would tell \$\{userName\} here depend on who \$\{askWho\} is to \$\{userName\} or where \$\{askWho\} lives/);
  assert.match(pulse, /await deliver\(`\$\{said \? `\$\{askWho\} wrote: "\$\{said\}"\\n\\n` : ""\}Before I say anything about it: who's \$\{askWho\} to you, and where do they live\? Tell me once and I'll remember, so I get things like this right\.`\);/);
  const first = pulse.indexOf("if (askWho) {"), writer = pulse.indexOf("let written = await writeOnce();");
  assert.ok(first > 0 && first < writer, "before the writer");
  assert.doesNotMatch(pulse.slice(first, writer), /recordTold/, "and nothing is recorded as told");
  assert.match(pulse, /if \(askWho\) text \+= `\\n\\nWho's \$\{askWho\} to you, and where do they live\? Tell me once and I'll remember\.`;/, "otherwise the message goes with the question");
  assert.equal((pulse.match(/s\.asked_who = \[\.\.\.\(s\.asked_who \|\| \[\]\), askWho\.toLowerCase\(\)\]\.slice\(-500\)/g) || []).length, 2, "asked once, either way");
});
