// Linked WhatsApp answers only in the person's own chat, and now writes in
// another of their chats when they ask, as them, after their yes, like an
// email. Files sent in any chat are recorded and opened when a question needs
// them, the way email attachments are, and what WhatsApp needs to fetch one
// again never sits where search or the LLM can read it. Chats, names and
// numbers are invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

const fake = (rel, exports) => { const file = require.resolve(path.join(__dirname, "..", "lib", rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
fake("platforms/whatsapp-linked.js", { isOwnChat: (jid) => jid === "447700900001@s.whatsapp.net" });
const wa = require("../lib/whatsapp-send");
const files = require("../lib/whatsapp-files");

// Recall's rows, newest first, as lib/platforms/whatsapp-linked.js writes them.
const ROWS = [
  { data: { id: "wa-A3", chat: "555@lid", chat_name: "555", sender: "me", text: "Thanks, see you then" } },
  { data: { id: "wa-A2", chat: "555@lid", chat_name: "555", sender: "555", text: "Hello. Here is your estimate for the\n treatment, valid for 30 days." } },
  { data: { id: "wa-B1", chat: "447700900123@s.whatsapp.net", chat_name: "Mara Okafor", sender: "Mara Okafor", text: "Are we still on for Friday?" } },
  { data: { id: "wa-C1", chat: "120363000000000001@g.us", chat_name: "Tennis Tuesdays", sender: "Ines", text: "Court 3 booked" } },
  { data: { id: "wa-D1", chat: "447700900124@s.whatsapp.net", chat_name: "Mara (work)", sender: "me", text: "Sent the deck" } },
];

test("a chat is found by its name, a message in it or a number, and named the way the person knows it", async () => {
  const chats = wa.chatsFrom(ROWS);
  assert.equal(chats.length, 4);
  assert.deepEqual(wa.pickChat("Tennis Tuesdays", chats).chat.jid, "120363000000000001@g.us");
  assert.equal(wa.pickChat("mara okafor", chats).chat.jid, "447700900123@s.whatsapp.net", "a whole name wins over a part");
  assert.match(wa.pickChat("Mara", chats).error, /^More than one WhatsApp chat matches "Mara": Mara Okafor, Mara \(work\)\./);
  assert.match(wa.pickChat("Dr Lee", chats).error, /^No WhatsApp chat called "Dr Lee"\. Find it with search_cache/);
  assert.equal(wa.pickChat("+44 7700 900125", chats).chat.jid, "447700900125@s.whatsapp.net", "a number never chatted with");
  assert.match(wa.pickChat("", chats).error, /^Say which chat/);

  assert.equal(wa.labelFor(wa.pickChat("Tennis Tuesdays", chats).chat), "Tennis Tuesdays");
  assert.equal(wa.labelFor(wa.pickChat("555@lid", chats).chat), 'the chat where they last wrote "Hello. Here is your estimate for the treatment, valid for 30 days."', "no name: the other side's last words, never a bare id");
  assert.equal(wa.labelFor({ jid: "447700900125@s.whatsapp.net" }), "+447700900125");
  assert.equal(wa.labelFor({ jid: "999@lid" }), "a chat with no name");

  // Through the database, as the gate and the send use it.
  const db = { from: () => {
    const q = { filters: {}, select() { return q; }, eq(k, v) { q.filters[k] = v; return q; }, order() { return q; },
      limit() { return Promise.resolve({ data: q.filters.external_id ? ROWS.filter((r) => r.data.id === q.filters.external_id) : ROWS }); } };
    return q;
  } };
  assert.deepEqual(await wa.resolve("u1", "wa-A2", db), { jid: "555@lid", label: 'the chat where they last wrote "Hello. Here is your estimate for the treatment, valid for 30 days."' });
  assert.match((await wa.resolve("u1", "wa-ZZ", db)).error, /^No WhatsApp message wa-ZZ in recall/);
  assert.match((await wa.resolve("u1", "+44 7700 900001", db)).error, /^That is the person's own chat with Closedhand/, "never their own chat");
});

test("a message goes only after the yes, as the person's own, and the box covers it", () => {
  const engine = read("lib/engine.js");
  assert.match(read("lib/confirmation.js"), /"outlook_reply",\n\s*"whatsapp_send",/);
  assert.match(engine, /if \(block\.name === "whatsapp_send"\) \{\n\s*waChat = await require\("\.\/whatsapp-send"\)\.resolve\(userId, block\.input\.to\);\n\s*if \(waChat\.error\) \{/, "a chat that cannot be found goes back to the LLM");
  assert.match(engine, /\} else if \(block\.name === "whatsapp_send"\) \{\n\s*confirmSummary = require\("\.\/send-gate"\)\.whatsappSendQuestion\(block\.input, waChat && waChat\.label\);/);
  assert.match(engine, /require\("\.\/send-gate"\)\.SEND_TOOLS\.has\(block\.name\)\n\s*&& ctx\.activeUserStore\?\.profile\?\.settings\?\.require_send_confirmation === false/, "unticked, it goes like an email");
  assert.match(engine, /if \(g === "whatsapp" && !hasWhatsApp\) return false;/, "offered only with WhatsApp linked");
  assert.match(engine, /search them and open their files \(search_cache and fetch_attachment, source 'whatsapp'\), and write in their other chats only when they ask, as them \(whatsapp_send\);/);
  assert.doesNotMatch(engine, /can send only into their chat with themselves/);
  const agents = read("lib/agents.js");
  assert.match(agents, /if \(block\.name === "whatsapp_send"\) \{\n\s*const chat = await require\("\.\/whatsapp-send"\)\.resolve\(userId, block\.input\.to\);/);
  assert.match(agents, /!sendGate\.SEND_TOOLS\.has\(tool\.name\)\)/, "a step of a bigger task never sends");
  const adapter = read("lib/platforms/whatsapp-linked.js");
  assert.match(adapter, /async function sendAsPerson\(jid, text\) \{\n\s*if \(!_sock \|\| !_open\) throw notConnected\(\);\n\s*if \(isOwnChat\(jid\)\) throw new Error/);
  assert.match(adapter, /const out = await _sock\.sendMessage\(jid, \{ text: require\("\.\.\/chat-format"\)\.formatWhatsApp\(text\), \.\.\.NO_PREVIEW \}\);/, "no fist or name in front: it is their message");
  assert.match(adapter, /if \(out\) await ingestMessages\(_ownerUserId, \[out\]\)/, "and recall keeps what was sent");
  assert.match(read("webapp/views/setup.html"), /Closedhand lives in your “Message Yourself” chat and doesn’t message anyone else unless you ask it to\./);
  const dash = read("webapp/views/dashboard.html");
  assert.match(dash, /Ask before sending messages to other people\n/);
  assert.match(dash, /"Closedhand will ask before sending messages to other people\." : "Closedhand will send messages to other people without asking first\."/);
});

test("a file in any chat is recorded, and what fetches it again is kept out of recall", () => {
  assert.deepEqual(files.fileOf({ documentMessage: { fileName: "Estimate No.12.pdf", mimetype: "application/pdf", fileLength: 48213 } }),
    { field: "documentMessage", kind: "document", name: "Estimate No.12.pdf", mime: "application/pdf", size: 48213 });
  assert.equal(files.fileOf({ imageMessage: { mimetype: "image/jpeg" } }).name, "image.jpg");
  assert.equal(files.fileOf({ audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } }).name, "voice note.ogg");
  assert.equal(files.fileOf({ conversation: "hi" }), null);
  assert.equal(files.refName("wa-3EB0/../x"), "whatsapp-files/wa-3EB0x.json", "never a path out of the folder");

  const adapter = read("lib/platforms/whatsapp-linked.js");
  assert.match(adapter, /const said = \[file \? `\[file: \$\{file\.name\}\]` : "", caption \|\| ""\]\.filter\(Boolean\)\.join\(" "\);/, "recall knows a file came, even with no caption");
  assert.match(adapter, /\.\.\.\(file \? \{ file: \{ name: file\.name, kind: file\.kind, mime: file\.mime, size: file\.size \} \} : \{\}\),/, "only its name, kind and size go in the row");
  assert.match(adapter, /if \(file\) await files\.keep\(userId, msg, inner, file\)/);
  assert.match(adapter, /if \(text \|\| media \|\| m\.videoMessage\) await ingestMessages/);
  assert.match(read("lib/whatsapp-files.js"), /const \{ uploadFile \} = require\("\.\.\/user-store"\);\n\s*await uploadFile\(userId, refName\(`wa-\$\{msg\.key\.id\}`\)/, "kept in the person's own file store");
  const access = read("lib/services/data-access.js");
  assert.match(access, /case "whatsapp": \{[\s\S]*?require\("\.\.\/whatsapp-files"\)\.open\(userId, message_id,/, "opened the way an email's attachment is");
  assert.match(read("lib/tools/definitions.js"), /Open an attachment from an email, calendar event or WhatsApp message \(\[file: name\] in WhatsApp results\)\./);
});

test("the reference survives the trip through the file store", (t) => {
  let baileys;
  try { baileys = require("@whiskeysockets/baileys"); } catch { return t.skip("Baileys is not installed here"); }
  const key = { remoteJid: "555@lid", fromMe: false, id: "3EB0C0FFEE", participant: undefined };
  const media = { url: "https://mmg.whatsapp.net/x", mimetype: "application/pdf", fileName: "Estimate.pdf", fileLength: 48213,
    mediaKey: Buffer.from("a".repeat(32)), fileSha256: Buffer.from("b".repeat(32)), fileEncSha256: Buffer.from("c".repeat(32)),
    directPath: "/v/t62/x", jpegThumbnail: Buffer.alloc(4000) };
  const json = files.encodeRef(key, "documentMessage", media);
  assert.ok(json.length < 1000, "small, without the preview picture");
  const back = files.decodeRef(json);
  assert.equal(back.key.id, "3EB0C0FFEE");
  assert.equal(back.message.documentMessage.fileName, "Estimate.pdf");
  assert.equal(Buffer.from(back.message.documentMessage.mediaKey).toString(), "a".repeat(32));
  assert.ok(!back.message.documentMessage.jpegThumbnail || !back.message.documentMessage.jpegThumbnail.length);
  assert.ok(baileys.proto);
});
