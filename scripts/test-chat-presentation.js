const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
function loadFunction(file, name, context) {
  const source = read(file).match(new RegExp(`async function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(source, name);
  return vm.runInNewContext(source + `\n${name}`, { Buffer, console, ...context });
}

test("generated WhatsApp previews use uploaded images, while original and unsupported files remain documents", async () => {
  const requests = [];
  const send = loadFunction("lib/messaging.js", "sendWhatsAppDocument", {
    WHATSAPP_ACCESS_TOKEN: "test", WHATSAPP_PHONE_NUMBER_ID: "test",
    https: { request(options, callback) {
      const req = new EventEmitter(); let body;
      req.write = value => { body = value; };
      req.end = () => {
        requests.push({ options, body });
        const response = new EventEmitter(); callback(response);
        response.emit("data", Buffer.from(JSON.stringify(options.path.endsWith("/media") ? { id: "uploaded" } : { messages: [{ id: "sent" }] })));
        response.emit("end");
      };
      return req;
    } },
  });
  for (const [mime, size, inline, expected] of [
    ["image/png", 12, true, "image"], ["image/jpeg", 12, true, "image"],
    ["image/png", 12, false, "document"], ["image/svg+xml", 12, true, "document"],
    ["text/html", 12, true, "document"], ["image/png", 5 * 1024 * 1024 + 1, true, "document"],
  ]) {
    await send("recipient", Buffer.alloc(size), "result", mime, inline);
    const payload = JSON.parse(requests.at(-1).body);
    assert.equal(payload.to, "recipient");
    assert.equal(payload.type, expected);
    assert.equal(payload[expected].id, "uploaded");
    assert.equal(requests.at(-2).options.path.endsWith("/media"), true);
  }
});

const linkedFile = "lib/platforms/whatsapp-linked.js";
if (fs.existsSync(path.join(root, linkedFile))) test("linked WhatsApp previews retain the self-chat gate and original-file delivery", async () => {
  const sent = [];
  const send = loadFunction(linkedFile, "sendLinkedDocument", {
    _sock: { sendMessage: async (jid, payload) => { sent.push({ jid, payload }); return { id: "sent" }; } },
    _open: true, notConnected: () => new Error("not connected"),
    _gateSelfChat: jid => { if (jid !== "self") throw Error("Wrong recipient"); return jid; },
    remember: value => value,
  });
  const bytes = Buffer.from("preview");
  await send("self", bytes, "chart.png", "image/png", true);
  assert.equal(sent[0].payload.image, bytes);
  assert.equal(sent[0].payload.document, undefined);
  await send("self", bytes, "original.png", "image/png");
  assert.equal(sent[1].payload.document, bytes);
  await send("self", bytes, "tool.html", "text/html", true);
  assert.equal(sent[2].payload.document, bytes);
  await assert.rejects(send("someone-else", bytes, "chart.png", "image/png", true), /Wrong recipient/);
  assert.equal(sent.length, 3);
});

test("a picture shows as a picture in every chat app, and anything else arrives as a file", async () => {
  const sent = [];
  const context = {
    PICTURE: /^image\/(png|jpeg|gif|webp)$/,
    ctx: { bot: { sendPhoto: async (...args) => sent.push(["photo", ...args]) } },
    sendTelegramDocument: async (...args) => sent.push(["document", ...args]),
    sendWhatsAppDocument: async (...args) => sent.push(["whatsapp", ...args]),
    require: (name) => {
      assert.equal(name, "./platforms/whatsapp-linked");
      return { sendLinkedDocument: async (...args) => sent.push(["linked", ...args]) };
    },
  };
  const send = loadFunction("lib/messaging.js", "sendDocumentToPlatform", context);
  for (const platform of ["whatsapp", "whatsapp_linked"]) {
    await send(platform, "self", Buffer.from("image"), "chart.png", "image/png");
    assert.equal(sent.at(-1)[5], true, "inline on WhatsApp");
    await send(platform, "self", Buffer.from("pdf"), "plan.pdf", "application/pdf");
    assert.equal(sent.at(-1)[5], false);
  }
  await send("telegram", "c1", Buffer.from("image"), "chart.png", "image/png");
  assert.equal(sent.at(-1)[0], "photo");
  await send("telegram", "c1", Buffer.from("pdf"), "plan.pdf", "application/pdf");
  assert.equal(sent.at(-1)[0], "document");
  assert.match(read("lib/messaging.js"), /async function sendDocument\(chatId, buffer, filename, mimeType\) \{\n\s*return sendDocumentToPlatform\(ctx\.activePlatform \|\| "telegram", chatId, buffer, filename, mimeType\);/, "one way to send a file, from any chat");
});

test("there is no canvas: a page is the one thing Closedhand makes", () => {
  for (const file of ["lib/dashboard-links.js", "lib/messaging.js", "lib/tools/handlers.js", "lib/page-links.js", "webapp/server.js"]) {
    assert.doesNotMatch(read(file), /canvasUrl|sendCanvasToChat|from\("canvases"\)|\/canvas\//, file);
  }
  assert.match(read("migrations/075_pages_only.sql"), /DROP TABLE IF EXISTS canvases;/);
});

test("a file from the sandbox computer is sent wherever the person is, and an interactive piece goes on a page", async () => {
  const source = read("lib/tools/handlers.js");
  const body = source.slice(source.indexOf('    case "sandbox_file_download": {'), source.indexOf('    case "sandbox_upload": {'));
  for (const [platform, mime, name] of [["whatsapp", "image/png", "chart.png"], ["web", "image/png", "chart.png"], ["telegram", "text/html", "calc.html"]]) {
    const deliveries = [];
    const context = {
      Buffer, console: { warn() {}, error() {} },
      ctx: { activeUserId: "owner", activeChatId: "self", activePlatform: platform },
      toolInput: { path: `/workspace/${name}` }, sendDocument: async (...args) => deliveries.push(args),
      require: (n) => {
        if (n === "../sandbox") return { ensureSandbox: async () => {}, sandboxFileDownload: async () => ({ filename: name, mime_type: mime, content: "YQ==", size: 1 }) };
        throw Error(n);
      },
    };
    const result = await vm.runInNewContext(`(async () => { switch ("sandbox_file_download") { ${body} } })()`, context);
    if (mime === "text/html") {
      assert.equal(deliveries.length, 0);
      assert.match(result.error, /^Not sent\. An interactive piece goes on a page: call save_report with files: \["\/workspace\/calc\.html"\] and share the page's link\.$/);
    } else {
      assert.equal(result.success, true);
      assert.deepEqual(deliveries.map((d) => [d[0], d[2], d[3]]), [["self", "chart.png", "image/png"]], `${platform}: sent as itself`);
    }
  }
});

test("WhatsApp prose converts Markdown while preserving code and native formatting", () => {
  const { formatWhatsApp } = require("../lib/chat-format");
  const input = "## Weather\n**Leeds**\n*Humidity now*: 86%\n\n[Open chart](https://phone.example.com/page/id)\n`**keep code**`\n```js\n# a comment\n**literal**\n```";
  const output = formatWhatsApp(input);
  assert.ok(output.startsWith("*Weather*\n*Leeds*\n*Humidity now*: 86%"));
  assert.ok(output.includes("Open chart: https://phone.example.com/page/id"));
  assert.ok(output.includes("`**keep code**`"));
  assert.ok(output.includes("```js\n# a comment\n**literal**\n```"));
  assert.equal(formatWhatsApp(output), output);
});

test("a message outside a reply is saved for the web chat and shown live when a tab is open", async () => {
  const src = read("lib/platforms/web.js");
  const start = src.indexOf("async function sendWebMessage");
  const inserted = [], pushed = [];
  let open = true;
  const box = {
    console: { error() {} },
    supabase: { from: (t) => ({ insert: async (row) => { inserted.push({ t, row }); return {}; } }) },
    require: (n) => { assert.equal(n, "../web-chat-ws"); return { hasWebChatConnection: () => open, sendWebChatMessage: (u, text) => pushed.push(text) }; },
  };
  vm.runInNewContext(src.slice(start, src.indexOf("\n}\n", start) + 2) + "\nthis.send = sendWebMessage;", box);
  await box.send("user-a", "Your hotel picks are ready.");
  assert.equal(inserted.length, 1, "saved, so a reload still shows it");
  assert.equal(inserted[0].row.direction, "outbound");
  assert.deepEqual(pushed, ["Your hotel picks are ready."], "and shown at once");
  open = false;
  await box.send("user-a", "Reminder: iCloud storage.");
  assert.equal(inserted.length, 2);
  assert.equal(pushed.length, 1, "no tab, nothing to push");

  const messaging = read("lib/messaging.js");
  assert.doesNotMatch(messaging, /sendWebChatMessage/, "nothing pushes to the web chat without saving");
  for (const f of ["lib/engine.js", "lib/resume.js"]) {
    assert.doesNotMatch(read(f), /from\("web_messages"\)\.insert/, `${f}: nothing is saved for the web chat without being shown`);
  }
  const status = messaging.slice(messaging.indexOf("async function sendStatusMessage"), messaging.indexOf('if (ctx.activePlatform === "telegram")', messaging.indexOf("async function sendStatusMessage")));
  assert.match(status, /if \(!hasWebChatConnection\(chatId\)\) return null;/, "a status with no one watching is dropped, not saved as a message");
  assert.doesNotMatch(status, /sendWebMessage/);
});

test("a long conversation carries on quietly: no note about its length", () => {
  const engine = read("lib/engine.js");
  assert.doesNotMatch(engine, /thread-size|Thread note|longThreadNotice/, "older history is condensed into memory without telling anyone");
});

test("a message sent just after a restart is not mistaken for one the restart interrupted", () => {
  const src = read("lib/resume.js");
  assert.match(src, /const processStartedAt = \(\) => Date\.now\(\) - process\.uptime\(\) \* 1000;/);
  assert.match(src, /if \(new Date\(info\.startedAt\)\.getTime\(\) >= processStartedAt\(\)\) continue;/, "skipped, and its marker left for the process answering it");
  assert.ok(src.indexOf("processStartedAt()) continue;") < src.indexOf("Heads up: a system update interrupted me"), "checked before telling anyone it was interrupted");
});

test("WhatsApp text goes without a link preview card, so no page is fetched from here to build one", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "platforms", "whatsapp-linked.js"), "utf8");
  assert.match(src, /const NO_PREVIEW = \{ linkPreview: null \};/);
  const textSends = src.match(/_sock\.sendMessage\([^;]*?, \{ text: [^;]*/g) || [];
  assert.ok(textSends.length >= 2);
  for (const send of textSends) assert.match(send, /\.\.\.NO_PREVIEW/, send.slice(0, 80));
});
