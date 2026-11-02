// lib/paying-for-piece.js: the interactive top of the What you pay for page
// (lib/paying-for.js), a piece the page shows in a sandboxed frame of its own
// (webapp/page-media.js). Three views: what it all costs a month, with one bar
// of where it goes; what is coming up (charges, trial ends, deadlines to
// cancel by); and what if, where ticking what they might drop counts up what
// they would keep in a year. Drawn in the app's own way: Fraunces for the
// numbers, the chart colours for the parts, the brush stroke under what is
// chosen. Self-contained: its data goes in with it, it fetches nothing but
// the fonts the page itself uses.
const fs = require("fs");
const path = require("path");

const NAME = "what-you-pay-for.html";

// The fist's brush stroke (webapp/public/brush-underline.svg), carried inside
// the piece: a sandboxed frame has no origin of its own to fetch it from.
let brush = null;
function brushUri() {
  if (brush) return brush;
  for (const file of [path.join(__dirname, "..", "webapp", "public", "brush-underline.svg"), path.join(__dirname, "..", "public", "brush-underline.svg")]) {
    try { brush = "data:image/svg+xml;base64," + fs.readFileSync(file).toString("base64"); return brush; } catch { /* the next place */ }
  }
  return (brush = "");
}

// Data for the piece, everything already worked out and worded.
function pieceData({ picture, today, money, dayText, monthlyOf, everyWords }) {
  const active = picture.filter((e) => e.status === "active");
  const totals = new Map();
  for (const e of active) { const m = monthlyOf(e); if (m != null) totals.set(e.currency || "GBP", (totals.get(e.currency || "GBP") || 0) + m); }
  const order = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const main = order[0]?.[0] || "GBP";
  const soon = [];
  const horizon = 45;
  const days = (iso) => Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);
  for (const e of active) {
    const cost = e.amount != null ? money(e.amount, e.currency) : "";
    if (e.next && days(e.next) >= 0 && days(e.next) <= horizon) soon.push({ day: days(e.next), when: dayText(e.next, today), name: e.name, what: "Charge" + (cost ? " of " + cost : ""), kind: "charge", estimate: !!e.next_estimate });
    if (e.trial_ends && days(e.trial_ends) <= horizon) soon.push({ day: days(e.trial_ends), when: dayText(e.trial_ends, today), name: e.name, what: "Trial ends" + (cost ? ", then " + cost : ""), kind: "trial" });
    if (e.cancel_by && days(e.cancel_by) <= horizon) soon.push({ day: days(e.cancel_by), when: dayText(e.cancel_by, today), name: e.name, what: "Last day to cancel", kind: "cancel" });
  }
  soon.sort((a, b) => a.day - b.day);
  const tags = (e) => [e.price_change ? "Price rose" : "", e.looks_unused ? "Seems unused" : "", e.overlap ? "May overlap" : "",
    e.trial_ends ? "Trial ends " + dayText(e.trial_ends, today) : "", e.cancel_by ? "Cancel by " + dayText(e.cancel_by, today) : ""].filter(Boolean);
  const items = active.map((e) => ({ name: e.name, what: e.what || "", currency: e.currency || "GBP", monthly: monthlyOf(e), cost: e.amount != null ? money(e.amount, e.currency) + " " + (everyWords[e.every] || "").toLowerCase() : "No cost found", tags: tags(e) }))
    .sort((a, b) => (b.tags.length > 0) - (a.tags.length > 0) || (b.monthly || 0) - (a.monthly || 0));
  return {
    main, symbol: money(0, main).replace(/[\d.,\s]/g, "") || main + " ",
    monthly: Math.round(order[0]?.[1] || 0), others: order.slice(1).map(([c, n]) => money(Math.round(n), c)),
    count: active.length, items, soon, horizon,
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function pieceHtml(data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>What you pay for</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400..600&family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap">
<style>
:root { --bg: #f7f3ee; --fg: #241c18; --muted: #75685f; --line: #e3dbd2; --accent: #b9452f; --head: #efe7de; --c1: #4F72B8; --c2: #7A5CB0; --c3: #3F8C84; --c4: #6B7078; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #141010; --fg: #efe6d6; --muted: #a2968b; --line: #2f2724; --accent: #d8624b; --head: #1f1917; --c1: #7C9CD4; --c2: #A68BD0; --c3: #6FB0A8; --c4: #8A8F98; color-scheme: dark; } }
html { font-size: 100%; background: var(--bg); }
@media (hover: hover) and (pointer: fine) { html { font-size: 90%; } }
* { box-sizing: border-box; }
body { margin: 0; color: var(--fg); font: 0.9375rem/1.5 "DM Sans", system-ui, -apple-system, sans-serif; padding: 1.125rem 1.25rem 1.5rem; }
.views { display: flex; gap: 1.5rem; margin: 0 0 1.375rem; border-bottom: 1px solid var(--line); }
.views button { position: relative; padding: 0.375rem 0 0.75rem; border: 0; background: none; color: var(--muted); font: 500 0.9375rem/1.3 "DM Sans", system-ui, sans-serif; cursor: pointer; }
.views button[aria-selected="true"] { color: var(--fg); }
.views button::after { content: ""; position: absolute; left: -0.25rem; right: -0.25rem; bottom: -0.3125rem; height: 0.625rem; background: var(--accent); -webkit-mask: url("${brushUri()}") center / 100% 100% no-repeat; mask: url("${brushUri()}") center / 100% 100% no-repeat; clip-path: inset(0 100% 0 0); transition: clip-path .5s cubic-bezier(.65, 0, .35, 1); }
.views button[aria-selected="true"]::after { clip-path: inset(0 0 0 0); }
.views button:focus-visible { outline: 2px solid var(--accent); outline-offset: 0.25rem; border-radius: 0.25rem; }
section[hidden] { display: none; }
section { animation: rise .45s cubic-bezier(.2, .8, .2, 1) both; }
@keyframes rise { from { opacity: 0; transform: translateY(0.375rem); } to { opacity: 1; transform: none; } }
.big { margin: 0; font-family: Fraunces, Georgia, serif; font-weight: 600; font-size: clamp(2.4rem, 9vw, 3.4rem); line-height: 1.05; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.big small { font: 500 1rem "DM Sans", system-ui, sans-serif; color: var(--muted); letter-spacing: 0; margin-left: 0.375rem; }
.sub { margin: 0.5rem 0 1.375rem; color: var(--muted); }
.bar { display: flex; gap: 2px; height: 2.25rem; border-radius: 0.625rem; overflow: hidden; }
.bar span { flex: var(--w) 1 0; min-width: 0.375rem; background: var(--c); opacity: .9; cursor: pointer; transform-origin: left; animation: grow .8s cubic-bezier(.2, .8, .2, 1) both; animation-delay: calc(var(--i) * 40ms); transition: opacity .2s, filter .2s; }
.bar span:hover, .bar span.on { opacity: 1; filter: brightness(1.12); }
.bar:hover span:not(:hover):not(.on) { opacity: .55; }
@keyframes grow { from { transform: scaleX(0); } to { transform: none; } }
.focus { min-height: 1.5rem; margin: 0.75rem 0 1rem; color: var(--muted); font-size: 0.875rem; }
.focus b { color: var(--fg); font-weight: 600; }
.legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.375rem; }
.legend li { display: grid; grid-template-columns: 0.75rem 1fr auto; align-items: center; gap: 0.625rem; padding: 0.375rem 0.5rem; margin: 0 -0.5rem; border-radius: 0.5rem; cursor: pointer; }
.legend li:hover, .legend li.on { background: var(--head); }
.legend i { width: 0.75rem; height: 0.75rem; border-radius: 0.25rem; background: var(--c); }
.legend em { font-style: normal; color: var(--muted); font-variant-numeric: tabular-nums; }
.track { position: relative; height: 4.5rem; margin: 0.5rem 0.5rem 1.25rem; }
.track::before { content: ""; position: absolute; left: 0; right: 0; top: 2.25rem; border-top: 1px dashed var(--line); }
.track .tick { position: absolute; top: 2.25rem; transform: translateX(-50%); font-size: 0.75rem; color: var(--muted); padding-top: 0.875rem; white-space: nowrap; }
.track .mark { position: absolute; top: 2.25rem; width: 0.875rem; height: 0.875rem; margin: -0.4375rem 0 0 -0.4375rem; border-radius: 50%; border: 2px solid var(--bg); background: var(--c1); cursor: pointer; animation: pop .5s cubic-bezier(.2, .8, .2, 1.4) both; animation-delay: calc(var(--i) * 60ms); }
.track .mark.trial { background: var(--bg); border: 2px solid var(--fg); }
.track .mark.cancel { background: var(--fg); border-radius: 0.1875rem; transform: rotate(45deg); }
.track .mark:hover, .track .mark.on { box-shadow: 0 0 0 0.25rem var(--head); }
@keyframes pop { from { transform: scale(0); } to { transform: none; } }
.track .mark.cancel { animation-name: pop45; }
@keyframes pop45 { from { transform: rotate(45deg) scale(0); } to { transform: rotate(45deg); } }
.soon { list-style: none; margin: 0; padding: 0; }
.soon li { display: grid; grid-template-columns: 4.25rem 1fr; gap: 0.75rem; padding: 0.625rem 0; border-top: 1px solid var(--line); }
.soon li.on { background: var(--head); margin: 0 -0.5rem; padding: 0.625rem 0.5rem; border-radius: 0.5rem; }
.soon time { font-weight: 600; font-variant-numeric: tabular-nums; }
.soon span { color: var(--muted); }
.empty { color: var(--muted); }
.keep { position: sticky; top: -1.125rem; z-index: 1; margin: -1.125rem -1.25rem 0.75rem; padding: 1.125rem 1.25rem 0.875rem; background: var(--bg); border-bottom: 1px solid var(--line); }
.keep p { margin: 0; color: var(--muted); }
.keep .save { position: relative; display: inline-block; font-family: Fraunces, Georgia, serif; font-weight: 600; font-size: 2rem; line-height: 1.2; color: var(--fg); font-variant-numeric: tabular-nums; }
.keep .save::after { content: ""; position: absolute; left: -0.25rem; right: -0.375rem; bottom: 0.0625rem; height: 0.6875rem; z-index: -1; background: var(--accent); opacity: .85; -webkit-mask: url("${brushUri()}") center / 100% 100% no-repeat; mask: url("${brushUri()}") center / 100% 100% no-repeat; clip-path: inset(0 100% 0 0); transition: clip-path .6s cubic-bezier(.65, 0, .35, 1); }
.keep.some .save::after { clip-path: inset(0 0 0 0); }
.pick { list-style: none; margin: 0; padding: 0; }
.pick label { display: grid; grid-template-columns: 1.375rem 1fr auto; gap: 0.75rem; align-items: start; padding: 0.75rem 0.5rem; margin: 0 -0.5rem; border-radius: 0.625rem; cursor: pointer; transition: background .2s; }
.pick label:hover { background: var(--head); }
.pick input { appearance: none; width: 1.25rem; height: 1.25rem; margin: 0.0625rem 0 0; border: 1.5px solid var(--muted); border-radius: 0.375rem; display: grid; place-items: center; cursor: pointer; transition: border-color .2s, background .2s; }
.pick input::after { content: ""; width: 0.625rem; height: 0.375rem; border-left: 2px solid var(--bg); border-bottom: 2px solid var(--bg); transform: rotate(-45deg) scale(0); margin-top: -0.125rem; transition: transform .25s cubic-bezier(.2, .8, .2, 1.5); }
.pick input:checked { background: var(--fg); border-color: var(--fg); }
.pick input:checked::after { transform: rotate(-45deg) scale(1); }
.pick input:focus-visible { outline: 2px solid var(--accent); outline-offset: 0.1875rem; }
.pick .name { font-weight: 500; }
.pick input:checked ~ div .name { text-decoration: line-through; text-decoration-color: var(--muted); }
.pick .what { color: var(--muted); font-size: 0.8125rem; }
.pick .cost { color: var(--muted); font-size: 0.875rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
.tags { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; margin-top: 0.25rem; }
.tags span { font-size: 0.75rem; color: var(--fg); }
.tags span::before { content: "\\2022"; color: var(--muted); margin-right: 0.375rem; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style></head><body>
<div class="views" role="tablist" aria-label="What you pay for">
<button role="tab" id="t-all" aria-controls="all" aria-selected="true">Overview</button>
<button role="tab" id="t-soon" aria-controls="soon" aria-selected="false" tabindex="-1">Coming up</button>
<button role="tab" id="t-if" aria-controls="if" aria-selected="false" tabindex="-1">What if</button>
</div>
<section id="all" role="tabpanel" aria-labelledby="t-all">
<p class="big"><span id="total"></span><small>a month</small></p>
<p class="sub" id="sub"></p>
<div class="bar" id="bar" role="img"></div>
<p class="focus" id="focus" aria-live="polite"></p>
<ul class="legend" id="legend"></ul>
</section>
<section id="soon" role="tabpanel" aria-labelledby="t-soon" hidden>
<div class="track" id="track" aria-hidden="true"></div>
<ol class="soon" id="soonList"></ol>
</section>
<section id="if" role="tabpanel" aria-labelledby="t-if" hidden>
<div class="keep" id="keep"><p>Drop the ones you tick and you would keep</p><span class="save" id="save"></span> <span class="sub">a year</span></div>
<ul class="pick" id="pick"></ul>
</section>
<script>
const D = ${json};
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmt = (n) => D.symbol + Math.round(n).toLocaleString("en-GB");
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function count(node, to, from = 0) {
  if (still) { node.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 900;
  const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); node.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const colours = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)"];
// Overview: the month's total, one bar of where it goes, the biggest few named.
const paid = D.items.filter((x) => x.monthly && x.currency === D.main).sort((a, b) => b.monthly - a.monthly);
count(document.getElementById("total"), D.monthly);
document.getElementById("sub").textContent = "About " + fmt(D.monthly * 12) + " a year, across " + D.count + " thing" + (D.count === 1 ? "" : "s") + "." + (D.others.length ? " Also " + D.others.join(" and ") + " a month." : "");
const bar = document.getElementById("bar"), focus = document.getElementById("focus"), legend = document.getElementById("legend");
bar.setAttribute("aria-label", paid.slice(0, 6).map((x) => x.name + " " + fmt(x.monthly)).join(", "));
const parts = [];
function show(i) {
  parts.forEach((p, j) => p.forEach((n) => n.classList.toggle("on", j === i)));
  const x = paid[i];
  focus.innerHTML = "";
  if (!x) { focus.textContent = paid.length ? "Tap a part of the bar to see what it is." : ""; return; }
  const b = el("b", "", x.name); focus.append(b, document.createTextNode(", about " + fmt(x.monthly) + " a month, " + Math.round(x.monthly / D.monthly * 100) + "% of it"));
}
paid.forEach((x, i) => {
  const s = el("span"); s.style.setProperty("--w", x.monthly); s.style.setProperty("--c", colours[i % 4]); s.style.setProperty("--i", i); s.title = x.name;
  s.addEventListener("mouseenter", () => show(i)); s.addEventListener("click", () => show(i));
  bar.append(s);
  const row = [s];
  if (i < 6) {
    const li = el("li"); const dot = el("i"); dot.style.setProperty("--c", colours[i % 4]);
    li.append(dot, el("span", "", x.name), el("em", "", fmt(x.monthly)));
    li.addEventListener("mouseenter", () => show(i)); li.addEventListener("click", () => show(i));
    legend.append(li); row.push(li);
  }
  parts.push(row);
});
if (paid.length > 6) legend.append(el("li", "", "and " + (paid.length - 6) + " more, in the table below"));
bar.addEventListener("mouseleave", () => show(-1));
show(-1);
// Coming up: the next weeks on one line, then each in turn.
const track = document.getElementById("track"), soonList = document.getElementById("soonList");
const rows = [];
function pick(i) { rows.forEach((r, j) => r.forEach((n) => n.classList.toggle("on", j === i))); }
[0, 15, 30, 45].forEach((d) => { const t = el("span", "tick", d === 0 ? "Today" : "In " + d + " days"); t.style.left = (d / D.horizon * 100) + "%"; track.append(t); });
D.soon.forEach((x, i) => {
  const m = el("span", "mark " + x.kind); m.style.left = (Math.max(0, x.day) / D.horizon * 100) + "%"; m.style.setProperty("--i", i); m.title = x.when + ": " + x.name;
  const li = el("li"); li.append(el("time", "", x.when)); const t = el("div"); t.append(document.createTextNode(x.name + " "), el("span", "", x.what + (x.estimate ? ", about then" : ""))); li.append(t);
  m.addEventListener("mouseenter", () => pick(i)); m.addEventListener("click", () => { pick(i); li.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" }); });
  li.addEventListener("mouseenter", () => pick(i));
  track.append(m); soonList.append(li); rows.push([m, li]);
});
if (!D.soon.length) soonList.append(el("li", "empty", "Nothing due in the next " + D.horizon + " days."));
// What if: tick what you might drop; what you would keep in a year counts up.
const pickList = document.getElementById("pick"), saveNode = document.getElementById("save"), keep = document.getElementById("keep");
let kept = 0;
saveNode.textContent = fmt(0);
D.items.forEach((x) => {
  const li = el("li"), label = el("label"), box = el("input"); box.type = "checkbox";
  const mid = el("div"); mid.append(el("div", "name", x.name)); if (x.what) mid.append(el("div", "what", x.what));
  if (x.tags.length) { const tg = el("div", "tags"); x.tags.forEach((t) => tg.append(el("span", "", t))); mid.append(tg); }
  label.append(box, mid, el("div", "cost", x.cost)); li.append(label); pickList.append(li);
  box.addEventListener("change", () => {
    const yearly = x.currency === D.main && x.monthly ? x.monthly * 12 : 0;
    const from = kept; kept += box.checked ? yearly : -yearly;
    count(saveNode, kept, from); keep.classList.toggle("some", kept > 0.5);
  });
});
// The views, by tap or by arrow keys.
const tabs = [...document.querySelectorAll('[role="tab"]')];
function open(tab) {
  tabs.forEach((t) => { const on = t === tab; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; document.getElementById(t.getAttribute("aria-controls")).hidden = !on; });
  if (tab.id === "t-all") count(document.getElementById("total"), D.monthly);
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => open(t));
  t.addEventListener("keydown", (e) => { const k = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!k) return; const n = tabs[(i + k + tabs.length) % tabs.length]; n.focus(); open(n); });
});
</script>
</body></html>`;
}

module.exports = { pieceData, pieceHtml, NAME, esc };
