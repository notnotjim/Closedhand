// The Pricing page as it is for this person: the price where they are,
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
      // The other ways to pay: each length with its price and what that
      // comes to a month, one to a line; crypto only once asked for.
      var longer = d.longer || [], coins = d.crypto || [], lines = function (list, label) {
        var box = document.createDocumentFragment();
        list.forEach(function (o, i) {
          if (i) box.appendChild(document.createElement('br'));
          box.appendChild(document.createTextNode(label(o.months) + ' for ' + o.price + (o.monthly ? ' (' + o.monthly + ' a month)' : '')));
        });
        return box;
      };
      if (longer.length) {
        $$('[data-longer-list]').forEach(function (n) { n.replaceChildren(lines(longer, function (m) { return 'Every ' + m + ' months'; })); });
        $$('[data-longer]').forEach(function (n) { n.hidden = false; });
      }
      if (coins.length) {
        $$('[data-crypto-months]').forEach(function (n) { n.replaceChildren(lines(coins, function (m) { return m + ' months'; })); });
        $$('[data-crypto]').forEach(function (n) { n.hidden = false; });
      }
      if (longer.length || coins.length) $$('[data-ways-note]').forEach(function (n) { n.hidden = false; });
      if (d.subscribed || d.subscribe) $$('[data-download]').forEach(function (n) { n.hidden = true; });
      if (d.subscribe) $$('[data-subscribe]').forEach(function (n) {
        // Never had the free days: the subscription's first ones are them.
        if (d.freeDays) n.textContent = 'Subscribe · ' + (d.days || 14) + ' days free';
        n.hidden = false;
      });
    })
    .catch(function () { /* The page as written still reads right. */ });
  $$('[data-crypto-show]').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('[data-crypto-list]').forEach(function (n) { n.hidden = false; });
      $$('[data-crypto]').forEach(function (n) { n.hidden = true; });
    });
  });
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
