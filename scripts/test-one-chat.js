// One conversation, whole wherever it is opened (lib/one-chat.js). Each app
// showed only what passed through it, so a question asked on WhatsApp was
// missing from the web chat and carrying on elsewhere meant carrying on half
// blind. Invented people and messages throughout.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
// The module reaches the web chat and WhatsApp as it sends, so the stand-ins
// stay in place until the test ends.
function load(stubs, t) {
  const full = require.resolve("../lib/one-chat");
  delete require.cache[full];
  const real = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.call(this, request, parent, isMain);
  };
  t.after(() => { Module._load = real; delete require.cache[full]; });
  return require(full);
}
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();

test("switching to a bot app mid-topic shows where they left off, both sides, as a quote; not when they stay, or it was hours ago", () => {
  const { catchUp, catchUpMessage } = require("../lib/one-chat");
  const chat = (via, ts, content = "Can you find the Harbour Hall booking form?") => [
    { role: "user", content: "earlier", via: "telegram", ts: ago(30) },
    { role: "assistant", content: "Sure", via: "telegram", ts: ago(30) },
    { role: "user", content, via, ts },
    { role: "assistant", content: "**Found it**: it's attached to the venue's email from Tuesday.\n\nWant me to fill it in?", via, ts },
  ];
  const card = catchUp(chat("web", ago(1)), "telegram", { botName: "Pete" });
  assert.deepEqual(card, { from: "the web chat", you: "Can you find the Harbour Hall booking form?", them: "Found it: it's attached to the venue's email from Tuesday.", botName: "Pete" });
  assert.equal(catchUpMessage(card, "discord").text, "Earlier, in the web chat:\n> You: Can you find the Harbour Hall booking form?\n> Pete: Found it: it's attached to the venue's email from Tuesday.");
  assert.equal(catchUpMessage(card, "telegram").text, "Earlier, in the web chat:\n<blockquote>You: Can you find the Harbour Hall booking form?\nPete: Found it: it's attached to the venue's email from Tuesday.</blockquote>");
  assert.equal(catchUpMessage(card, "telegram").html, true);
  assert.equal(catchUpMessage(card, "line").text, "Earlier, in the web chat:\nYou: Can you find the Harbour Hall booking form?\nPete: Found it: it's attached to the venue's email from Tuesday.", "LINE shows no quote marks");
  assert.equal(catchUp(chat("whatsapp_linked", ago(1)), "slack").from, "WhatsApp");
  assert.equal(catchUp(chat("telegram", ago(1)), "telegram"), null, "same app: the chat shows it already");
  assert.equal(catchUp(chat("telegram", ago(1)), "web"), null, "the web chat shows everything, so never");
  assert.equal(catchUp(chat("telegram", ago(1)), "whatsapp_linked"), null, "nor WhatsApp linked to their account, which gets every turn");
  assert.equal(catchUp(chat("web", ago(4)), "telegram"), null, "hours later is a new start");
  assert.equal(catchUp([{ role: "user", content: "untagged", ts: ago(1) }], "telegram"), null, "older messages say no app");
  const quoted = catchUp(chat("web", ago(1), "[replying to Closedhand's message: \"Found two forms\"]\nthe second one"), "telegram");
  assert.equal(quoted.you, "the second one", "their words, not the message they replied to");
  assert.ok(catchUp(chat("web", ago(1), "word ".repeat(40)), "telegram").you.endsWith("…"));
  assert.match(catchUpMessage({ from: "the web chat", you: "a < b & c", them: "", botName: "Pete" }, "telegram").text, /You: a &lt; b &amp; c<\/blockquote>$/, "their words are text, never markup");
});

test("after the card, the answer goes as a reply to their new message, in each app that has replies", () => {
  assert.match(read("lib/platforms/telegram.js"), /if \(statusOpts\.opts\.caughtUp\) \{[\s\S]{0,800}i === 0 \? \{ reply_to_message_id: msg\.message_id, allow_sending_without_reply: true \} : undefined/);
  assert.match(read("lib/platforms/discord.js"), /sendDiscordMessage\(discordUserId, response, opts\.caughtUp \? \{ replyTo: msg\.id \} : \{\}\)/);
  assert.match(read("lib/platforms/line.js"), /sendLinePush\(lineUserId, response, lineOpts\.caughtUp \? \{ quoteToken: event\.message\?\.quoteToken \} : \{\}\)/);
  assert.match(read("lib/platforms/whatsapp.js"), /sendWhatsAppMessage\(waId, response, opts\.caughtUp \? \{ replyTo: waMessageId \} : \{\}\)/);
  const messaging = read("lib/messaging.js");
  assert.match(messaging, /\.\.\.\(answering \? \{ context: \{ message_id: answering \} \} : \{\}\)/);
  assert.match(messaging, /reply: \{ messageReference: replyTo, failIfNotExists: false \}/);
  // A reply in parts quotes their message on its first part only.
  const sent = [];
  const bot = require("../lib/follow-on").splitTelegram({ sendMessage: async (id, text, o) => sent.push(o || null) });
  return bot.sendMessage(1, "First part.\n[[next]]\nSecond part.", { reply_to_message_id: 9, parse_mode: "HTML" }).then(() => {
    assert.deepEqual(sent, [{ reply_to_message_id: 9, parse_mode: "HTML" }, { parse_mode: "HTML" }]);
  });
});

test("a turn's messages carry the app; the other apps get the turn: the web chat live, WhatsApp in the person's own chat", async (t) => {
  const web = [], wa = [];
  const oneChat = load({
    "./web-chat-ws": { hasWebChatConnection: () => true, sendToUser: (userId, msg) => web.push(msg) },
    "./platforms/whatsapp-linked": { selfChat: () => "447700900001@s.whatsapp.net", mirrorPersonToSelf: async (x) => wa.push(["me", x]), sendLinkedMessage: async (jid, x) => wa.push(["closedhand", x]) },
  }, t);
  const before = { role: "user", content: "old" };
  const conv = [before, { role: "user", content: "new" }, { role: "assistant", content: "reply" }];
  assert.equal(oneChat.tag(conv, new Set([before]), "telegram"), 2);
  assert.equal(before.via, undefined, "what was there before keeps what it had");
  assert.deepEqual(conv.slice(1).map((m) => m.via), ["telegram", "telegram"]);

  await oneChat.after({ userId: "u1", via: "telegram", said: "Is the boiler service booked?", reply: "Yes, Tuesday 9:00." });
  assert.deepEqual(web.pop(), { type: "elsewhere", project: null, messages: [{ role: "user", content: "Is the boiler service booked?", via: "telegram" }, { role: "assistant", content: "Yes, Tuesday 9:00.", via: "telegram" }] });
  assert.deepEqual(wa.splice(0), [["me", "Is the boiler service booked?"], ["closedhand", "Yes, Tuesday 9:00."]], "their words as theirs, the reply as Closedhand's");

  await oneChat.after({ userId: "u1", via: "web", said: "And the gas check?", reply: "Booked for Friday." });
  assert.equal(web.length, 0, "a web turn is in the web chat already");
  assert.equal(wa.length, 2);
  wa.splice(0);
  await oneChat.after({ userId: "u1", via: "whatsapp_linked", said: "Thanks", reply: "Any time." });
  assert.equal(wa.length, 0, "a WhatsApp turn is in WhatsApp already");
  assert.equal(web.length, 1);
  await oneChat.after({ userId: "u1", via: "telegram", said: "", reply: "", fileData: { mimeType: "image/jpeg" } });
  assert.deepEqual(wa.splice(0), [["me", "(a photo)"]], "a photo on its own is said to be one");
  await oneChat.after({ userId: "u1", via: "telegram", said: "📦 any news?", reply: "📦 It left the depot.", project: { id: "p1", emoji: "📦" } });
  assert.deepEqual(web.pop().project, { id: "p1", emoji: "📦" }, "a project's turn goes to that project's conversation");
});

test("the turn's hook, proactive messages and the web chat page", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /const card = oneChat\.catchUp\(conversation, platform, \{ botName: ctx\.activeUserStore\?\.profile\?\.settings\?\.bot_name \|\| "Closedhand" \}\);\n\s*if \(card && await oneChat\.sendCatchUp\(platform, chatId, card\)[\s\S]{0,140}opts\.caughtUp = true;/, "the card goes before the answer, in the app they are in");
  assert.match(engine, /oneChat\.after\(\{ userId, via: platform, said: userMessage, reply, fileData, project: project \? project\.project : null \}\)/);
  const messaging = read("lib/messaging.js");
  assert.match(messaging, /if \(userId && !\(ctx\.currentAsk && ctx\.currentAsk\[userId\]\)\) \{\n\s*try \{ require\("\.\/one-chat"\)\.sentElsewhere\(/, "a proactive message shows in the web chat; a turn's own sends do not show twice");
  const wa = read("lib/platforms/whatsapp-linked.js");
  assert.match(wa, /const id = require\("@whiskeysockets\/baileys"\)\.generateMessageIDV2\(_sock\.user\?\.id\);\n\s*_sentIds\.add\(id\);/, "a mirrored message is never answered, even if its echo comes first");
  assert.match(read("lib/pulse.js"), /via = via \|\| t\.platform;/);
  assert.match(read("lib/task-delivery.js"), /sentText = sent; sentVia = dest\.platform;/);
  const page = read("webapp/views/index.html");
  assert.match(page, /if \(msg\.type === 'elsewhere'\) \{ showElsewhere\(msg\); return; \}/);
  assert.match(page, /where\.textContent = 'on ' \+ VIA_NAMES\[via\];/);
  assert.match(page, /var firstOfVisit = !hasMessages && !_openProject;\n(\s*\/\/[^\n]*\n)*\s*if \(spoken === true && !hasMessages && window\.talkFirst && window\.talkFirst\(\)\) holdForAnswer\(\); else enterChatMode\(\);\n\s*if \(firstOfVisit\) loadEarlier\(\);/, "typing (or talking) from the opening screen carries the conversation on");
  assert.match(page, /addMessage\(m\.content, m\.role === 'user' \? 'user' : 'bot', null, m\.ts \|\| null, m\.via \|\| null\);/, "history says which app too");
});

// A picture made in the web chat once reached WhatsApp only as the words
// "sent as ferrari_spider.jpg": the turn's pictures and files go with it.
test("the pictures and files Closedhand sent in a turn go with it to the other apps", async (t) => {
  const web = [], wa = [];
  const oneChat = load({
    "./web-chat-ws": { hasWebChatConnection: () => true, sendToUser: (userId, msg) => web.push(msg) },
    "./platforms/whatsapp-linked": { selfChat: () => "447700900001@s.whatsapp.net", mirrorPersonToSelf: async (x) => wa.push(["me", x]), sendLinkedMessage: async (jid, x) => wa.push(["closedhand", x]),
      sendLinkedDocument: async (jid, buffer, name, mime, picture) => wa.push(["file", name, mime, picture, buffer.toString()]) },
  }, t);
  oneChat.noteFile("u1", "draw a lighthouse", { buffer: Buffer.from("JPEG"), filename: "image.jpg", mimeType: "image/jpeg" });
  await oneChat.after({ userId: "u1", via: "web", said: "draw a lighthouse", reply: "Here it is." });
  assert.deepEqual(wa.splice(0), [["me", "draw a lighthouse"], ["closedhand", "Here it is."], ["file", "image.jpg", "image/jpeg", true, "JPEG"]], "the picture follows the reply, as a picture");

  oneChat.noteFile("u1", "the receipt?", { buffer: Buffer.from("%PDF"), filename: "receipt.pdf", mimeType: "application/pdf" });
  await oneChat.after({ userId: "u1", via: "whatsapp_linked", said: "the receipt?", reply: "Attached." });
  assert.equal(wa.length, 0);
  assert.equal(web[0].type, "elsewhere");
  assert.deepEqual(web[1], { type: "file", filename: "receipt.pdf", mediaType: "application/pdf", size: 4, base64: Buffer.from("%PDF").toString("base64") }, "and the web chat gets it too");

  oneChat.noteFile("u1", "an older turn", { buffer: Buffer.from("x"), filename: "old.png", mimeType: "image/png" });
  await oneChat.after({ userId: "u1", via: "web", said: "something else", reply: "Ok." });
  assert.deepEqual(wa.splice(0).map((m) => m[0]), ["me", "closedhand"], "a file from another turn never goes with this one");

  const messaging = read("lib/messaging.js");
  assert.match(messaging, /const userId = ctx\.activeUserId, said = ctx\.currentAsk && userId && ctx\.currentAsk\[userId\];\n\s*if \(said && Buffer\.isBuffer\(buffer\)\) \{/);
  assert.match(messaging, /require\("\.\/one-chat"\)\.noteFile\(userId, said, \{ buffer, filename, mimeType, id \}\);/);
});

// Looking back, a picture Closedhand sent was gone: only the words of the
// reply were kept. The files a turn sends are kept and named on its answer,
// and the web chat draws them above it again.
test("the files a turn sent are named on its answer, so looking back shows them", (t) => {
  const oneChat = load({}, t);
  const before = new Set([{ role: "user", content: "earlier" }]);
  const conv = [...before, { role: "user", content: "draw a lighthouse" }, { role: "assistant", content: "Here it is." }];
  oneChat.noteFile("u1", "draw a lighthouse", { buffer: Buffer.from("JPEG"), filename: "image.jpg", mimeType: "image/jpeg", id: "att_1" });
  assert.equal(oneChat.keepFiles("u1", "something else", conv, before), false, "another turn's files never");
  assert.equal(oneChat.keepFiles("u1", "draw a lighthouse", conv, before), true);
  assert.deepEqual(conv[2].files, [{ id: "att_1", name: "image.jpg", mime: "image/jpeg", size: 4 }]);
  const messaging = read("lib/messaging.js");
  assert.match(messaging, /id = require\("\.\/attachments"\)\.saveAttachment\(userId, \{ buffer, fileName: filename, mediaType: mimeType, ext, isImage: PICTURE\.test\(mimeType \|\| ""\), direction: "chat" \}, `Sent in the chat: \$\{filename\}`\);/, "kept as it is sent");
  assert.match(read("lib/engine.js"), /if \(oneChat\.keepFiles\(userId, userMessage, require\("\.\/conversation"\)\.getConversation\(userId\), before\)\) ctx\.activeUserStore\?\.markDirty\?\.\("conversations"\);/);
  const page = read("webapp/views/index.html");
  assert.match(page, /addFileMessage\(\{ filename: f\.name, mediaType: f\.mime, size: f\.size, url: '\/api\/files\/' \+ encodeURIComponent\(f\.id\) \+ '\/download' \}\);/);
  assert.match(page, /if \(conv && conv\.messages\) shownInThread\(conv\.messages\)\.forEach\(showStored\);/);
  assert.match(page, /earlier\.forEach\(showStored\);/);
});

