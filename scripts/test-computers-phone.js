// The Computers tab on a phone: one computer at a time, files that open on a
// tap, no terminal, and the sandbox computer's browser full screen with a
// keyboard that types into it. Checked in a phone-sized browser while built;
// these hold the pieces in place.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const page = read("webapp/views/index.html");
const phone = page.slice(page.indexOf("  /* === PHONES === */"), page.indexOf("  @media (max-width:768px) and (orientation:portrait)"));

test("a phone shows one computer at a time, picked with a switch", () => {
  assert.ok(page.indexOf('id="monSwitch"') < page.indexOf('id="monArea"'), "the switch sits above the computers");
  assert.match(page, /onclick="monShow\('cloud'\)">Sandbox computer<\/button>/);
  assert.match(page, /onclick="monShow\('local'\)">Local computer<\/button>/);
  assert.match(phone, /#monArea:not\(\[data-show="local"\]\) #monLocalWrap, #monArea\[data-show="local"\] #monCloudWrap \{ display:none; \}/);
  assert.match(phone, /\.mon-divider \{ display:none !important; \}/, "no drag handle between them");
  assert.match(page, /\.mon-switch, \.mon-storage-phone, \.mon-open-full, \.mon-full-bar \{ display:none; \}/, "computers keep their side-by-side layout");
  assert.match(page, /\.llm-hint\.mon-info-phone \{ display:none; \}/, "and one i each: the status's copy is a phone's, over the i's own display rule");
  assert.match(phone, /\.llm-hint\.mon-info-phone \{ display:inline-block; margin-left:0; \} \/\* the row's gap spaces it \*\//);
  assert.doesNotMatch(page, /monExpand|mon-ghost|Mobile divider drag/, "the old phone code that never dropped anything is gone");
});

test("the terminal stays off a phone, and its storage line moves beside the status", () => {
  assert.match(phone, /\.mon-term-bar, \.mon-term, #monSyncTip \{ display:none !important; \}/);
  assert.match(page, /storage\.textContent = online === null \? '' : ' \\u00b7 ' \+ \(data\.storage \|\| '0'\) \+ \(room \? ' of ' \+ room : ''\)/);
});

test("on a phone a tap opens a folder, or a file's actions as a sheet", () => {
  assert.match(page, /if \(item\.ondblclick\) item\.ondblclick\(e\);\n\s*else if \(item\.oncontextmenu\) item\.oncontextmenu\(e\);/);
  assert.match(phone, /\.mon-context-menu \{ left:0.5rem !important; right:0.5rem; top:auto !important; bottom:calc\(0.5rem \+ env\(safe-area-inset-bottom\)\);/);
  for (const draw of ["_monCloudView==='grid'&&!monPhone()", "_monLocalView==='grid'&&!monPhone()", "view === 'grid' && !monPhone()"]) assert.ok(page.includes(draw), draw);
});

test("the browser opens full screen without the Fullscreen API, with Keyboard and Close", () => {
  assert.match(page, /<button type="button" class="mon-open-full" id="monOpenFull" onclick="monFullOpen\(\)">Tap to open full screen<\/button>/);
  assert.match(page, /id="monKeysBtn" aria-pressed="false" aria-label="Keyboard" onclick="monKeyboard\(\)"/);
  assert.match(page, /onclick="monFullClose\(\)">[\s\S]{0,300}Close<\/button>/);
  assert.match(page, /body\.mon-full \.mon \{ container-type:normal; overflow:visible; \}/, "the pane no longer holds the fixed view");
  assert.match(page, /body\.mon-full \.mon-area \{ animation:none; opacity:1; transform:none; z-index:auto; \}/, "nothing on the page sits above it");
  assert.doesNotMatch(page, /body\.mon-full \{ overflow:hidden; \}/, "a body scroll lock made iPhone Safari clip it to the page's height");
  assert.match(page, /if \(!desktop\.requestFullscreen\) \{ monFullOpen\(\); return; \}/, "a computer without the API gets the same view");
  assert.match(page, /if \(r\.ok && monPhone\(\)\) monFullOpen\(\);/, "a sign-in shortcut opens it to sign in");
  for (const name of ["monShow", "monFullOpen", "monFullClose", "monKeyboard"]) assert.match(page, new RegExp(`window\\.${name} = ${name};`), name);
});

test("what is typed reaches the remote browser, from this page only", () => {
  assert.match(page, /frame\.contentWindow\.postMessage\(Object\.assign\(\{ type: 'closedhand-keys' \}, msg\), location\.origin\)/);
  const vnc = read("webapp/public/novnc/vnc_lite.html");
  assert.match(vnc, /if \(e\.origin !== window\.location\.origin \|\| !e\.data\) return;\n[^\n]*\n\s*if \(e\.data\.type !== 'closedhand-keys' \|\| !rfb\) return;/);
  assert.match(vnc, /rfb\.sendKey\(keysyms\.lookup\(ch\.codePointAt\(0\)\), null\)/);
  assert.match(vnc, /Backspace: \[KeyTable\.XK_BackSpace, 'Backspace'\], Enter: \[KeyTable\.XK_Return, 'Enter'\]/);
});

test("an i opens on a tap (Closedhand's one, llm-hint.js), and the sign-in marks are drawn into the page, not fetched", () => {
  assert.match(page, /<script src="\/llm-hint\.js"><\/script>/);
  assert.match(page, /<span data-info="Closedhand's sandbox computer keeps[^"]*" data-info-label="About the sandbox computer"><\/span>/);
  const marks = page.slice(page.indexOf("var MON_SIGNIN_LOGOS = {"), page.indexOf("};", page.indexOf("var MON_SIGNIN_LOGOS = {")));
  for (const site of ["google", "instagram", "tiktok", "x", "facebook"]) assert.match(marks, new RegExp(`\\n    ${site}: '<svg aria-hidden="true"`), site);
  assert.doesNotMatch(page, /'\/logos\/' \+ site\.id/, "a content blocker stopped the Facebook file on an iPhone");
});

test("full screen on a phone, the sandbox computer's screen takes the phone's shape, and the laptop shape after", () => {
  const entry = read("sandbox-image/entrypoint.sh");
  assert.match(entry, /gosu sandbox Xvnc :99 -geometry 1280x800 /, "laptop-shaped unless a phone asks");
  assert.match(entry, /rm -f \/home\/sandbox\/\.config\/openbox\/rc\.xml\nopenbox_supervisor\(\)/, "openbox runs on the image's own settings");
  assert.doesNotMatch(read("sandbox-image/openbox-config/rc.xml"), /<margins>/, "the screen is all shown: windows use all of it");
  const agent = read("sandbox-image/agent/server.js");
  assert.match(agent, /const LAPTOP = \{ width: 1280, height: 800 \}, NARROWEST = 508;/);
  assert.match(agent, /app\.post\("\/desktop\/shape", auth,/);
  assert.match(agent, /if \(phone && botBrowsing\(\)\) return res\.json\(\{ \.\.\.\(await queueShape\(LAPTOP\)\), busy: true \}\);/, "never reshaped under Closedhand's own browsing");
  assert.match(agent, /function botBrowsing\(\) \{\n\s*return browseBusy > 0 \|\| Date\.now\(\) - lastBrowseAt < 20000;/, "Closedhand is browsing while a step runs and just after, not whenever its lasting helper exists");
  assert.match(agent, /shapeTimer = setTimeout\(\(\) => queueShape\(LAPTOP\)/, "back to laptop by itself when the phone stops asking");
  assert.match(agent, /const run = shaping\.then\(\(\) => setShape\(next\)\);/, "one change of shape at a time");
  // The screen is resized by RandR, by a mode of that size: setting only
  // the screen's size left it with no screen showing.
  assert.match(agent, /await onScreen\("xrandr", \["--output", "VNC-0", "--mode", mode\]\);/);
  assert.match(agent, /const scale = Math\.max\(1, NARROWEST \/ phone\.width\);/, "at least Chrome's narrowest window, drawn larger");
  assert.match(agent, /await fitWindows\(\{ left: -frame, top: frame - bars, width: width \+ 2 \* frame, height: height \+ bars \}\);/, "the page fills the screen, Chrome's bars and frame outside it");
  assert.match(agent, /res\.json\(await queueShape\(phone \? \{ phone: \{ width, height \} \} : LAPTOP\)\);/, "the phone's own size in CSS pixels");
  const server = read("webapp/server.js");
  assert.match(server, /app\.post\("\/api\/sandbox\/screen",[\s\S]{0,600}sandboxFetch\(info, "POST", "\/desktop\/shape", phone \? \{ width, height \} : \{\}, 15000\)/);
  assert.match(page, /function monFullOpen\(\) \{[\s\S]{0,200}monPhoneShape\(true\);/);
  assert.match(page, /function monFullClose\(\) \{[\s\S]{0,400}monLaptopShape\(\);/);
  assert.match(page, /monShapeTimer = setTimeout\(monPhoneShape, 30000\);/);
  assert.match(page, /window\.addEventListener\('pagehide', function \(\) \{ monLaptopShape\(true\); \}\);/);
});

// Measured from a phone over the internet (2026-11-06): with noVNC asking
// for each frame only once the last had come, scrolling showed 4 to 7 frames
// a second; asking ahead, 11 to 14 from x11vnc and 27 to 37 from Xvnc, and
// nothing at all while the screen stood still. Xvnc's own way, frames sent
// unasked, each waiting for the last one's fence, gave 5 to 7.
test("the sandbox computer's screen comes as fast as it changes, and a new size is drawn whole", async () => {
  const { pathToFileURL } = require("node:url");
  const { makeScreen, aheadFor, AHEAD_EVERY_MS } = await import(pathToFileURL(path.join(__dirname, "..", "webapp/public/novnc/closedhand-screen.js")));
  const asked = [];
  const messages = { fbUpdateRequest: (sock, incremental, x, y, w, h) => asked.push({ incremental, w, h }) };
  let frameDone = false;
  class Base {
    constructor() { this._rfbConnectionState = "connecting"; this._fbWidth = 0; this._fbHeight = 0; this._sock = {}; }
    _sendEncodings() { messages.clientEncodings(this._sock, [7, -224, -312, -313, -223]); }
    _framebufferUpdate() { return frameDone; }
    _resize(w, h) { this._fbWidth = w; this._fbHeight = h; }
  }
  let now = 0, shown = true, tick = null;
  const Screen = makeScreen(Base, messages, { clock: () => now, visible: () => shown, every: (fn, ms) => { assert.equal(ms, AHEAD_EVERY_MS); tick = fn; } });
  const screen = new Screen();
  const sizes = [];
  screen.onScreenSize = (w, h, drawn) => sizes.push(`${w}x${h}${drawn ? " drawn" : ""}`);
  const frame = (took) => { frameDone = false; screen._framebufferUpdate(); now += took; frameDone = true; assert.equal(screen._framebufferUpdate(), true); };

  screen._resize(1280, 800);
  assert.deepEqual(asked, [], "connecting: noVNC asks for the first whole frame itself");
  screen._rfbConnectionState = "connected";
  tick(); tick(); tick();
  assert.deepEqual(asked.map((a) => a.incremental), [true, true], "two frames asked ahead at most");
  frame(10);
  assert.deepEqual(sizes, ["1280x800", "1280x800 drawn"], "the size is told, and again once a frame of it is drawn");
  tick(); tick(); tick();
  assert.equal(asked.length, 4, "a frame that came asks ahead again");

  // A slow connection: frames that take longer to arrive than frames come.
  for (let i = 0; i < 6; i++) frame(200);
  asked.length = 0;
  tick(); tick();
  assert.deepEqual(asked, [], "nothing asked ahead to queue up behind them");
  assert.equal(aheadFor(200), 0); assert.equal(aheadFor(60), 1); assert.equal(aheadFor(10), 2);

  for (let i = 0; i < 12; i++) frame(5);
  shown = false; tick();
  assert.deepEqual(asked, [], "nothing asked ahead while the page is out of sight");
  shown = true;
  // Fences and continuous updates are not offered: Xvnc then answers each
  // frame asked for, rather than one per round trip.
  const offered = [];
  messages.clientEncodings = (sock, encs) => offered.push(encs);
  screen._sendEncodings();
  assert.deepEqual(offered, [[7, -224, -223]]);
  screen._sendEncodings();
  assert.equal(offered.length, 2, "noVNC's own way of sending them is left as it was");

  // The phone shape: one whole frame of the new size, and only for a size
  // that changed (x11vnc answers each whole frame with the size again).
  asked.length = 0; sizes.length = 0;
  screen._resize(508, 834);
  assert.deepEqual(asked, [{ incremental: false, w: 508, h: 834 }]);
  screen._resize(508, 834);
  assert.equal(asked.length, 1, "the same size again asks for nothing");
  frame(5);
  assert.deepEqual(sizes, ["508x834", "508x834 drawn"]);

  screen._rfbConnectionState = "disconnected";
  let cleared = false; const clear = global.clearInterval; global.clearInterval = () => { cleared = true; };
  try { tick(); } finally { global.clearInterval = clear; }
  assert.ok(cleared, "stops with the connection");

  const vnc = read("webapp/public/novnc/vnc_lite.html");
  assert.match(vnc, /const Screen = makeScreen\(RFB, RFB\.messages\);/);
  assert.match(vnc, /rfb = new Screen\(document\.getElementById\('screen'\), url,/);
  assert.doesNotMatch(vnc, /resizeSession = true/, "x11vnc ignores a viewer asking for its own size");
});

test("full screen on a phone shows the picture once it has the phone's shape, fills the width, and keeps that shape", () => {
  const vnc = read("webapp/public/novnc/vnc_lite.html");
  assert.match(vnc, /if \(drawn && window\.parent !== window\) window\.parent\.postMessage\(\{ type: 'closedhand-screen', width, height \}, window\.location\.origin\);/);
  assert.match(vnc, /if \(e\.data\.type === 'closedhand-fit'\) \{ fit = e\.data\.fit === 'width' \? 'width' : 'contain'; fitScreen\(\); return; \}/);
  assert.match(vnc, /\(window\.innerWidth \* screenSize\.height \/ screenSize\.width\) \+ 'px'/, "the height follows the width, so the keyboard covers rather than shrinks it");
  assert.match(page, /if \(e\.origin !== location\.origin \|\| !frame \|\| e\.source !== frame\.contentWindow \|\| !e\.data \|\| e\.data\.type !== 'closedhand-screen'\) return;/);
  assert.match(page, /function monFullOpen\(\) \{[\s\S]{0,200}if \(monPhone\(\)\) monHideUntilDrawn\(\);/);
  assert.match(page, /monRevealTimer = setTimeout\(monRevealScreen, 5000\);/, "never left out of sight");
  assert.match(page, /#monDesktop\.mon-shaping #monVncFrame \{ opacity:0; transition:none; \}/);
  assert.match(page, /monSetFit\(own \? 'width' : 'contain'\);/);
  // Asking again every half minute keeps the size: taking it again each time
  // reshaped the screen whenever the keyboard happened to be up.
  assert.match(page, /if \(measure === true \|\| !monShapeSize\) \{ monShapeSize = \{ width: frame\.clientWidth, height: frame\.clientHeight \};/);
  assert.match(page, /body: JSON\.stringify\(monShapeSize\) \}\)/);
  assert.match(page, /if \(monShaped && height >= 200 && Math\.abs\(height - monShapeSize\.height\) > 100\) monPhoneShape\(true\);/, "the keyboard coming or going reshapes it, Safari's own bar does not");
  // A moment in another app leaves it as it was: going laptop-shaped and
  // back reloaded every open page, and what was typed in it.
  assert.match(page, /document\.addEventListener\('visibilitychange', function \(\) \{ if \(!document\.hidden\) monPhoneShape\(\); \}\);/);
  assert.doesNotMatch(page, /if \(document\.hidden\) monLaptopShape\(true\)/);
  const agent = read("sandbox-image/agent/server.js");
  assert.match(agent, /if \(phone\) lastPhoneAsk = Date\.now\(\);/);
  assert.match(agent, /if \(!DESKTOP && shape\.phone && Date\.now\(\) - lastPhoneAsk > 35000\) \{\n\s*await queueShape\(LAPTOP\)/, "with nobody watching any more, Closedhand browses laptop-shaped at once");
  assert.match(agent, /const shorter = !!shape\.phone && height < shape\.height;/, "a phone shape that got shorter");
  assert.match(agent, /if \(shorter\) await showTypingPlace\(\)/, "what is typed into is scrolled into the height left");
});

test("in the phone shape Chrome acts as the phone watching, so sites pick their phone versions at its text size", () => {
  const agent = read("sandbox-image/agent/server.js");
  assert.match(agent, /await phoneMode\(\{ width: phone\.width, height: phone\.height, scale \}\);/, "on with the phone shape");
  assert.match(agent, /await phoneMode\(null\);\n\s*await screenSize\(LAPTOP\);/, "off before the laptop shape");
  assert.match(agent, /Target\.setAutoAttach", \{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true \}/, "new pages wait for the phone settings");
  for (const call of ["Emulation.setDeviceMetricsOverride", "Emulation.setUserAgentOverride", "Emulation.setTouchEmulationEnabled", "Emulation.setEmitTouchEventsForMouse", "Page.addScriptToEvaluateOnNewDocument"]) assert.ok(agent.includes(`send("${call}"`), call);
  // Drawn scale times larger and shown that much larger in Chrome's own
  // view: with the size alone the page took the top left of the screen.
  assert.match(agent, /return \{ width, height, deviceScaleFactor: scale, scale, dontSetVisibleSize: true, mobile: true, screenWidth: width, screenHeight: height \};/, "the phone's CSS width at its text size, filling the screen");
  assert.match(agent, /send\("Page\.enable", \{\}, sessionId\);\n\s*send\("Page\.addScriptToEvaluateOnNewDocument"/, "the page agent on, or the default viewport is never added");
  assert.match(agent, /Mobile Safari\/537\.36/);
  assert.match(agent, /if \(targetInfo\.type === "page" && \/\^https\?:\/\.test\(targetInfo\.url\)\) send\("Page\.reload", \{\}, sessionId\);/, "a page already loading loads again as its phone version");
});

// A phone's own fallback for a page that names no viewport is a 980-wide
// layout shrunk to the screen: with nothing to pinch, pages made only for
// computers were unreadable (2026-10-20). Such a page gets the phone's width;
// a page's own viewport, later in its <head>, still wins.
test("a page that names no viewport of its own gets the phone's width, not a shrunk 980-wide layout", () => {
  const agent = read("sandbox-image/agent/server.js");
  const source = agent.match(/const PHONE_VIEWPORT = `([\s\S]*?)`;/)[1];
  const run = (doc) => {
    const observers = [];
    class MutationObserver { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.off = true; } }
    new Function("document", "MutationObserver", source)(doc, MutationObserver);
    return observers;
  };
  const element = () => ({ name: "", content: "" });
  const headOf = (metas) => ({ children: metas, prepend(m) { metas.unshift(m); } });
  const doc = (metas, head = headOf(metas)) => ({ head, createElement: element, querySelector: () => metas.find((m) => m.name === "viewport") || null });

  const none = []; run(doc(none));
  assert.deepEqual(none.map((m) => m.content), ["width=device-width, initial-scale=1"], "no viewport: the phone's width");
  const own = [{ name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" }]; run(doc(own));
  assert.equal(own.length, 1, "a page's own viewport is left alone");
  const later = []; const early = doc(later, null);
  const [watch] = run(early);
  assert.equal(later.length, 0, "no <head> yet");
  early.head = headOf(later); watch.fn([], watch);
  assert.equal(later[0].content, "width=device-width, initial-scale=1", "added first in <head> once it exists");
  assert.ok(watch.off);
});

test("the sandbox browser starts on Google, which a person can still change", () => {
  const policy = JSON.parse(read("sandbox-image/chrome-policies.json"));
  assert.equal(policy.DefaultSearchProviderName, "Google");
  assert.equal(policy.DefaultSearchProviderSearchURL, "https://www.google.com/search?q={searchTerms}");
  const docker = read("sandbox-image/Dockerfile");
  assert.match(docker, /COPY chrome-policies\.json \/etc\/opt\/chrome\/policies\/recommended\/closedhand\.json/, "Google Chrome, on amd64");
  assert.match(docker, /COPY chrome-policies\.json \/etc\/chromium\/policies\/recommended\/closedhand\.json/, "Debian's Chromium, on arm64, which starts on DuckDuckGo");
  assert.doesNotMatch(docker, /COPY chrome-policies\.json \/etc\/[^ ]*managed/, "the search engine recommended, never enforced");
  assert.match(page, /var MON_SIGNIN_INTRO = 'Sign in to any website you want it to have persistent access to\.';/);
});

test("full screen on a phone has a phone browser's bar at the bottom, standing in for Chrome's", () => {
  const agent = read("sandbox-image/agent/server.js");
  assert.match(agent, /app\.post\("\/desktop\/phone-browser", auth,/);
  assert.match(agent, /"\[document\.visibilityState, outerHeight - innerHeight, outerWidth - innerWidth\]\.join\(' '\)"/, "Chrome's bars and frame, asked of the page");
  const goAddress = new Function(agent.slice(agent.indexOf("function goAddress"), agent.indexOf("async function browserState")) + "return goAddress;")();
  assert.equal(goAddress("kestrel.example"), "https://kestrel.example");
  assert.equal(goAddress("harbour ferry times"), "https://www.google.com/search?q=harbour%20ferry%20times");
  assert.equal(goAddress("javascript:alert(1)"), "https://www.google.com/search?q=javascript%3Aalert(1)", "only web addresses open");
  const server = read("webapp/server.js");
  assert.match(server, /app\.post\("\/api\/sandbox\/phone-browser",[\s\S]{0,700}"\/desktop\/phone-browser"/);
  assert.equal((server.match(/app\.post\("\/api\/sandbox\/browser"/g) || []).length, 1, "the route that opens the browser keeps its own name");
  assert.match(page, /fetch\('\/api\/sandbox\/phone-browser'/);
  assert.match(page, /body\.mon-full \.mon-full-bar \{ display:flex; order:2;/, "at the bottom, as on a phone");
  assert.match(page, /<input type="text" id="monAddress" placeholder="Search or type an address"/);
  for (const action of ["back", "forward", "reload"]) assert.match(page, new RegExp(`onclick="monBrowser\\('${action}'\\)"`), action);
  assert.match(page, /id="monTabsBtn" aria-label="Tabs"/);
  assert.match(page, /document\.getElementById\('monFullBar'\)\.classList\.add\('mon-own-bar'\);\n\s*var frame = document\.getElementById\('monVncFrame'\);/, "the bar's full height is known before the size is sent");
});

test("the sandbox browser shows every script and keeps to what Closedhand uses it for", () => {
  const docker = read("sandbox-image/Dockerfile");
  assert.match(docker, /fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji/, "Japanese, Chinese, Korean, the other scripts and emoji");
  assert.match(docker, /COPY chrome-policies-managed\.json \/etc\/opt\/chrome\/policies\/managed\/closedhand\.json/);
  assert.match(docker, /COPY chrome-policies-managed\.json \/etc\/chromium\/policies\/managed\/closedhand\.json/);
  const policy = JSON.parse(read("sandbox-image/chrome-policies-managed.json"));
  for (const kept of ["passwords", "payments", "autofill", "bookmarks"]) assert.ok(!policy.SyncTypesListDisabled.includes(kept), kept + " still come with a Google sign-in: they let Closedhand do more");
  for (const left of ["extensions", "typedUrls", "tabs", "preferences"]) assert.ok(policy.SyncTypesListDisabled.includes(left), left + " do not");
  assert.equal(policy.ExtensionInstallBlocklist, undefined, "an extension added here by hand still works");
  assert.equal(policy.AutofillCreditCardEnabled, undefined, "saved cards fill in");
  assert.equal(policy.MetricsReportingEnabled, false);
  assert.match(read("desktop/workspace/guest/Dockerfile"), /FROM \$\{WORKSPACE_IMAGE\}/, "the Mac's Workspace is built on the same image");
  for (const launcher of ["sandbox-image/chromium-launcher.sh", "desktop/workspace/guest/browser.sh"]) assert.match(read(launcher), /--no-default-browser-check --disable-default-apps/, launcher + ": none of Chrome's own add-ons");
});

test("full screen on a computer has a way back beside Esc, and its hint shows inside the full-screen view", () => {
  const page = read("webapp/views/index.html");
  assert.match(page, /<button type="button" class="mon-exit-full" id="monExitFull" onclick="document\.exitFullscreen\(\)" title="Exit full screen \(Esc\)" aria-label="Exit full screen">/);
  assert.match(page, /#monDesktop:fullscreen \.mon-exit-full \{ display:inline-flex; \}/, "only while the view fills the screen");
  assert.match(page, /hint\.textContent = 'Press Esc to exit full screen';\n\s*desktop\.appendChild\(hint\);/, "outside the full-screen view it was never seen");
});
