// Whether a name is one of the person's own: the same, or the same first name
// with the same surname or its initials ("Sam F-K" and "Sam Fox-Kerr"). A
// fact whose subject is the person is About you, whatever group it was given.
// Vendored: lib/own-name.js (pin_fact) and webapp/own-name.js (the dashboard's
// pinning); the dashboard's isAboutSelf reads names the same way.
function isOwnName(subject, names) {
  const words = (x) => String(x || "").toLowerCase().split(/[\s-]+/).map((w) => w.replace(/[^\p{L}]/gu, "")).filter(Boolean);
  const said = words(subject);
  if (!said.length) return false;
  return names.some((name) => {
    const own = words(name);
    if (!own.length || own[0] !== said[0]) return false;
    if (own.length === 1 || said.length === 1) return own.length === said.length;
    const initials = (w) => w.slice(1).map((x) => x[0]).join("");
    return initials(own) === initials(said);
  });
}

module.exports = { isOwnName };
