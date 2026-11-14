#!/usr/bin/env node
// The typefaces every page is set in, kept by Closedhand itself: closedhand.com
// and the app serve them from their own public/fonts, so opening a page never
// tells Google who is looking, and a page never waits on a second company.
// Run this only to change them: it fetches each family once from Google Fonts
// (every axis range any page uses, split by alphabet so a browser fetches only
// what a page shows), writes the files and fonts.css into both public folders,
// and keeps each family's licence beside them. Each address carries its file's
// stamp, so browsers keep the files for a year.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FAMILIES = [
  { name: "DM Sans", query: "DM+Sans:opsz,wght@9..40,300..700", licence: "dmsans" },
  { name: "Fraunces", query: "Fraunces:ital,opsz,wght,SOFT@0,9..144,300..900,0..100;1,9..144,300..900,0..100", licence: "fraunces" },
  { name: "IBM Plex Mono", query: "IBM+Plex+Mono:wght@400;500", licence: "ibmplexmono" },
];
// A current browser, so Google answers with woff2 and variable fonts.
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const root = path.join(__dirname, "..");
const PUBLIC = ["closedhand-com/public", "webapp/public"].map((p) => path.join(root, p));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function get(url, as) {
  const res = await fetch(url, { headers: { "User-Agent": BROWSER } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return as === "bytes" ? Buffer.from(await res.arrayBuffer()) : res.text();
}

async function main() {
  const files = new Map(), licences = new Map(), css = [
    "/* The typefaces Closedhand's pages are set in, served by Closedhand itself.",
    "   Written by scripts/fetch-fonts.js; the licences are in fonts/. */",
  ];
  for (const family of FAMILIES) {
    const sheet = await get(`https://fonts.googleapis.com/css2?family=${family.query}&display=swap`);
    for (const [, subset, block] of sheet.matchAll(/\/\* ([a-z-]+) \*\/\s*(@font-face \{[^}]*\})/g)) {
      const style = /font-style: (\w+)/.exec(block)[1], weight = /font-weight: ([\d ]+);/.exec(block)[1].trim();
      const url = /src: url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/.exec(block)[1];
      const name = [slug(family.name), style === "italic" ? "italic" : "", weight.includes(" ") ? "" : weight, subset].filter(Boolean).join("-") + ".woff2";
      const bytes = await get(url, "bytes");
      files.set(name, bytes);
      const stamp = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
      css.push(block.replace(url, `/fonts/${name}?v=${stamp}`).replace(/\n\s*/g, "\n  ").replace(/\n  \}$/, "\n}"));
    }
    licences.set(`LICENSE-${slug(family.name)}.txt`, await get(`https://raw.githubusercontent.com/google/fonts/main/ofl/${family.licence}/OFL.txt`));
  }
  for (const dir of PUBLIC) {
    const fonts = path.join(dir, "fonts");
    fs.rmSync(fonts, { recursive: true, force: true });
    fs.mkdirSync(fonts);
    for (const [name, bytes] of files) fs.writeFileSync(path.join(fonts, name), bytes);
    for (const [name, text] of licences) fs.writeFileSync(path.join(fonts, name), text);
    fs.writeFileSync(path.join(dir, "fonts.css"), css.join("\n") + "\n");
  }
  console.log(`${files.size} font files, ${[...files.values()].reduce((n, b) => n + b.length, 0)} bytes, in ${PUBLIC.length} places`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
