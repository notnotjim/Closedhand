// Closedhand writes without emdashes. Where a dash reads best it writes a
// hyphen with a space each side, and otherwise a comma, colon or full stop.
// The model is asked to (response-presentation.js); this makes it so for
// every chat reply, background answer, report and message Closedhand sends,
// whatever the model did. A dash the model wrote stays a dash, as a spaced
// hyphen, since that is where it judged one reads best. Code, and number
// ranges such as 10–12, are left as they are.
function noEmDashes(text) {
  if (typeof text !== "string" || !/\u2014|[ \t]\u2013[ \t]/.test(text)) return text;
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => i % 2 ? part : part
    .replace(/^([ \t]*)[\u2014\u2013][ \t]+/gm, "$1- ")      // used as a bullet
    .replace(/[ \t]*\u2014[ \t]*$/gm, ":")               // ending a line that leads into the next
    .replace(/[ \t]*\u2014[ \t]*/g, " - ")               // anywhere else
    .replace(/[ \t]+\u2013[ \t]+/g, " - ")               // a spaced en dash standing in for one
    .replace(/ - ([.,;:!?)])/g, "$1")               // a dash left before other punctuation
  ).join("");
}

module.exports = { noEmDashes };
