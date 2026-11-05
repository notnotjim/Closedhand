// lib/picture-colours.js: the colours a picture really has, measured from its
// pixels, and a description's colour words held to them. Florence-2, the VLM
// (lib/local-models.js), often calls a white or pale background blue, so a
// search for "blue" found pictures with no blue in them. A colour said of the
// whole picture has to cover a good part of it, a background is given the
// colour round the picture's edge, and any other colour said has to be there
// at all; a sentence still saying one that isn't is left out.
const NAMES = ["black", "white", "grey", "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown"];
// Shares of the picture: a colour said at all, and one said of the whole
// picture or its background.
const SEEN = 0.01, WHOLE = 0.15;
// A colour counts with the ones it is easily taken for.
const NEAR = {
  black: ["black", "grey"], white: ["white", "grey"], grey: ["grey", "white", "black"],
  red: ["red", "pink", "orange"], orange: ["orange", "red", "yellow", "brown"], yellow: ["yellow", "orange", "green"],
  green: ["green", "yellow", "blue"], blue: ["blue", "purple"], purple: ["purple", "blue", "pink"],
  pink: ["pink", "red", "purple"], brown: ["brown", "orange", "red", "yellow"],
};
const SAID = { gray: "grey", navy: "blue", turquoise: "blue", teal: "green", violet: "purple", maroon: "red", tan: "brown", beige: "brown", gold: "yellow", silver: "grey" };
const PHRASE = `(?:(?:light|dark|pale|bright|deep)[ -])?(?:${[...NAMES, ...Object.keys(SAID)].join("|")})(?:ish)?`;
const ONE = new RegExp(`\\b${PHRASE}\\b`, "gi");
const PAIR = new RegExp(`(\\b(?:a|an)\\s+)?\\b(${PHRASE})\\s+and\\s+(${PHRASE})\\b`, "gi");
// "a" or "an", as the word after it needs, keeping its capital.
const article = (said, next) => !said ? "" : (/^A/.test(said) ? "A" : "a") + (/^[aeiou]/i.test(next) ? "n " : " ");
// A colour said of a thing, "a round black object": the word before the thing.
const BEFORE_THING = new RegExp(`(\\b(?:a|an)\\s+)?\\b(${PHRASE})\\s+(?=((?!(?:and|or|colou?r|in|on|with|of|background)\\b)[a-z]+))`, "gi");
// A colour said of the background, and one said of the whole picture.
const BACKGROUND = [
  new RegExp(`(\\b(?:a|an)\\s+)?\\b(${PHRASE})(\\s+(?:colou?red\\s+)?background)\\b`, "gi"),
  new RegExp(`(\\bbackground\\b[^.]{0,30}?\\b(?:is|was)\\s+)(\\b(?:a|an)\\s+)?((?:(?:solid|plain|very|all)\\s+)*)(${PHRASE})\\b`, "gi"),
];
const WHOLE_PICTURE = [
  new RegExp(`\\b(?:solid\\s+)+(${PHRASE})\\b`, "gi"),
  new RegExp(`\\b(?:image|picture|photo)\\s+is\\s+(?:a\\s+|an\\s+)?(?:(?:solid|plain|all)\\s+)*(${PHRASE})\\b`, "gi"),
];
// The colour a phrase names: "light blue" is blue, "navy" is blue.
const base = (phrase) => { const w = phrase.toLowerCase().replace(/^(?:light|dark|pale|bright|deep)[ -]/, "").replace(/ish$/, ""); return SAID[w] || w; };

function named(r, g, b) {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, c = max - min;
  if (max < 0.25) return "black";
  const s = max ? c / max : 0;
  if (s < 0.15 || c < 0.06) return max > 0.82 ? "white" : "grey";
  let h = max === r / 255 ? ((g - b) / 255 / c) % 6 : max === g / 255 ? (b - r) / 255 / c + 2 : (r - g) / 255 / c + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 340) return s < 0.5 && max > 0.8 ? "pink" : "red";
  if (h < 40) return max < 0.6 ? "brown" : "orange";
  if (h < 70) return max < 0.5 ? "brown" : "yellow";
  if (h < 170) return "green";
  if (h < 255) return "blue";
  if (h < 290) return "purple";
  return max < 0.5 ? "purple" : "pink";
}

// The share of the picture each colour covers, from a smaller copy of it
// (transparency counted as white, as a picture is usually shown), and the
// share of its edge, where a background shows.
async function measure(bytes) {
  const SIZE = 160, RIM = 16;
  const { data, info } = await require("sharp")(bytes, { failOn: "none", limitInputPixels: false }).flatten({ background: "#ffffff" }).resize(SIZE, SIZE, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const whole = Object.fromEntries(NAMES.map((n) => [n, 0])), edge = { ...whole };
  let rim = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * info.channels, name = named(data[i], data[i + 1], data[i + 2]);
    whole[name]++;
    if (x < RIM || y < RIM || x >= SIZE - RIM || y >= SIZE - RIM) { edge[name]++; rim++; }
  }
  for (const n of NAMES) { whole[n] /= SIZE * SIZE; edge[n] /= rim; }
  return { whole, edge };
}

const cover = (phrase, share) => (NEAR[base(phrase)] || []).reduce((t, k) => t + (share[k] || 0), 0);
// The colour round most of the edge, when one does.
const edgeColour = (edge) => { const [name, part] = Object.entries(edge).sort((a, b) => b[1] - a[1])[0]; return part >= 0.6 ? name : null; };

// The description without what it says of colours the picture doesn't have:
// "a blue and white object" becomes "a white object" in a white picture, "a
// blue background" becomes "a white background" when white is round the
// edge, "a round black object" in a picture with no black "a round object",
// and a sentence still saying a colour that isn't there is left out.
function keepSeenColours(text, { whole, edge }) {
  const kept = [];
  const behind = edgeColour(edge);
  for (let s of String(text || "").split(/(?<=[.!?])\s+/)) {
    s = s.replace(PAIR, (all, art, a, b) => {
      const ok = (p) => cover(p, whole) >= SEEN;
      const keep = ok(a) && !ok(b) ? a : !ok(a) && ok(b) ? b : null;
      return keep ? article(art, keep) + keep : all;
    });
    const fix = (p) => (cover(p, edge) >= 0.3 || !behind ? p : behind);
    s = s.replace(BACKGROUND[0], (all, art, p, rest) => article(art, fix(p)) + fix(p) + rest)
      .replace(BACKGROUND[1], (all, lead, art, how, p) => lead + article(art, how || fix(p)) + how + fix(p));
    const wide = WHOLE_PICTURE.flatMap((re) => [...s.matchAll(re)].map((m) => m[1]));
    if (wide.some((p) => cover(p, whole) < WHOLE)) continue;
    s = s.replace(BEFORE_THING, (all, art, p, next) => (cover(p, whole) >= SEEN ? all : article(art, next)));
    if ((s.match(ONE) || []).some((p) => cover(p, whole) < SEEN)) continue;
    kept.push(s);
  }
  return kept.join(" ").trim();
}

// Whether a text names a colour at all: a picture described before its
// colours were checked is described again only then.
const namesColour = (text) => new RegExp(ONE.source, "i").test(String(text || ""));

// What a picture shows, held to the colours it has. The description as it
// came when the picture can't be measured.
async function checkColours(text, bytes) {
  if (!text || !namesColour(text)) return text;
  try { return keepSeenColours(text, await measure(bytes)); }
  catch (e) { console.log(`[picture-colours] not measured: ${String(e.message).slice(0, 120)}`); return text; }
}

module.exports = { measure, keepSeenColours, checkColours, namesColour, named, SEEN, WHOLE };
