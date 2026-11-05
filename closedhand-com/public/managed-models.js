// The Managed Models page as it is for this person: the price where they are,
// the LLM Closedhand picks now, and the main button. Someone new downloads
// Closedhand (the free days start in its setup); someone signed in with a
// Closedhand of their own subscribes; someone who has them sees no button.
(function () {
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  fetch('/api/managed-models', { cache: 'no-store', credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      if (d.price) $$('[data-price]').forEach(function (n) { n.textContent = d.price; });
      if (d.model) $$('[data-model]').forEach(function (n) { n.textContent = d.model; });
      if (d.days) $$('[data-days]').forEach(function (n) { n.textContent = d.days; });
      if (d.subscribed || d.subscribe) $$('[data-download]').forEach(function (n) { n.hidden = true; });
      if (d.subscribe) $$('[data-subscribe]').forEach(function (n) {
        // Never had the free days: the subscription's first ones are them.
        if (d.freeDays) n.textContent = 'Subscribe · ' + (d.days || 14) + ' days free';
        n.hidden = false;
      });
    })
    .catch(function () { /* The page as written still reads right. */ });
  // The download itself, as on the home page: the newest Mac app, Apple
  // Silicon first; the release page stays the link if GitHub can't be read.
  fetch('https://api.github.com/repos/notnotjim/Closedhand/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (rel) {
      var assets = rel && rel.assets ? rel.assets : [];
      var pick = assets.find(function (a) { return /arm64\.dmg$/i.test(a.name); }) || assets.find(function (a) { return /x86_64\.dmg$/i.test(a.name); });
      if (pick) $$('[data-download]').forEach(function (n) { n.href = pick.browser_download_url; });
    })
    .catch(function () { /* The release-page link remains usable. */ });
})();
