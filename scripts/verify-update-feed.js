#!/usr/bin/env node
// Checks every file an update feed offers against the public key built into
// Closedhand for Mac (SUPublicEDKey in desktop/Info.plist), before a release
// publishes them. A feed signed with any other key is refused by every app
// that reads it, and nothing said so: 2.0.43 went out signed with a key
// GitHub held that was not the app's. The release stops here instead.
//
// node scripts/verify-update-feed.js <appcast.xml> <folder with its files> [Info.plist]
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function appKey(plist) {
  const key = (fs.readFileSync(plist, "utf8").match(/<key>SUPublicEDKey<\/key>\s*<string>([^<]+)<\/string>/) || [])[1];
  const raw = Buffer.from(key || "", "base64");
  if (raw.length !== 32) throw new Error(`no Ed25519 public key in ${plist}`);
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

// Every enclosure, the full app and any difference files (which sit inside
// sparkle:deltas as enclosures too), with its file name and signature.
function enclosures(xml) {
  return [...xml.matchAll(/<enclosure\b[^>]*>/g)].map(([tag]) => ({
    file: decodeURIComponent(((tag.match(/url="([^"]+)"/) || [])[1] || "").split("/").pop()),
    signature: (tag.match(/sparkle:edSignature="([^"]+)"/) || [])[1],
  })).filter((e) => e.file);
}

function verifyFeed(appcast, dir, plist) {
  const key = appKey(plist);
  const items = enclosures(fs.readFileSync(appcast, "utf8"));
  if (!items.length) throw new Error("the feed offers no files");
  return items.map(({ file, signature }) => ({
    file,
    ok: !!signature && crypto.verify(null, fs.readFileSync(path.join(dir, file)), key, Buffer.from(signature, "base64")),
  }));
}

if (require.main === module) {
  const [appcast, dir, plist = path.join(__dirname, "..", "desktop", "Info.plist")] = process.argv.slice(2);
  try {
    const results = verifyFeed(appcast, dir, plist);
    for (const r of results) console.log(`${r.ok ? "verifies" : "DOES NOT VERIFY"}: ${r.file}`);
    if (results.some((r) => !r.ok)) {
      console.error("The update feed is not signed with the key the app trusts. Nothing is released.");
      process.exit(1);
    }
  } catch (e) {
    console.error(`Could not check the update feed: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { verifyFeed, enclosures };
