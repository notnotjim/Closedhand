// Light or dark. The site matches the device until the person taps the sun,
// moon or the two in one in the header; then their pick (light, dark, or
// matching the device again) is remembered in this browser, and travels with
// the links to and from their own Closedhand, so the newer pick of the two is
// the one both show.
// Loaded in <head>, before anything is drawn, so a page never shows the other
// theme first. The colours themselves are in interface.css, by name, under
// :root and :root[data-theme="light"].
(function () {
  var KEY = 'closedhand-theme', AT = 'closedhand-theme-at';
  var BAR = { dark: '#100E0D', light: '#EFE6D6' };
  var root = document.documentElement;
  var device = window.matchMedia('(prefers-color-scheme: light)');

  var held = null; // the pick, where this browser keeps none
  function picked() {
    try { var theme = localStorage.getItem(KEY); return theme === 'light' || theme === 'dark' ? theme : null; } catch (e) { return held; }
  }
  function current() { return picked() || (device.matches ? 'light' : 'dark'); }
  function pickedAt() { try { return Number(localStorage.getItem(AT)) || 0; } catch (e) { return 0; } }
  function pickNow() { return picked() || 'device'; }
  // Each tap: matching the device, then the other theme, then the device's
  // own, then matching it again, so the first two taps always change the page.
  function nextPick() {
    var own = device.matches ? 'light' : 'dark', other = own === 'light' ? 'dark' : 'light', p = pickNow();
    return p === 'device' ? other : p === other ? own : 'device';
  }
  // The button shows the pick (interface.css) and says it, and what a tap does.
  var SAYS = { light: 'Light', dark: 'Dark', device: 'Matches this device' };
  var NEXT = { light: 'Switch to light.', dark: 'Switch to dark.', device: 'Switch to match this device.' };
  function label() {
    root.setAttribute('data-theme-pick', pickNow());
    var words = SAYS[pickNow()] + '. ' + NEXT[nextPick()];
    var buttons = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < buttons.length; i++) { buttons[i].title = words; buttons[i].setAttribute('aria-label', words); }
  }

  // A pick from the person's Closedhand arrives as #theme=<pick>.<when it was
  // picked>: after the #, so no server is ever sent it, and taken off the
  // address at once. It is kept here if it is the newer.
  var SHARED = /(^#|&)theme=(light|dark|device)\.(\d{1,15})(?=&|$)/;
  var brought = (location.hash || '').match(SHARED);
  if (brought) {
    try { history.replaceState(history.state, '', location.pathname + location.search + location.hash.replace(SHARED, '$1').replace(/^#&/, '#').replace(/&$/, '').replace(/^#$/, '')); } catch (e) { /* the address keeps it */ }
    var at = Number(brought[3]);
    if (at > pickedAt() && at <= Date.now() + 60000) {
      try {
        if (brought[2] === 'device') localStorage.removeItem(KEY); else localStorage.setItem(KEY, brought[2]);
        localStorage.setItem(AT, String(at));
      } catch (e) { /* this page only */ }
    }
  }
  // Out to the person's own Closedhand (its personal URL, or this computer's),
  // a pick made here goes along.
  document.addEventListener('click', function (event) {
    var a = event.target.closest && event.target.closest('a[href]');
    if (!a || !pickedAt()) return;
    var url;
    try { url = new URL(a.href); } catch (e) { return; }
    if (url.hash || !(/\.closedhand\.ai$/.test(url.hostname) || /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) || !/^\/(dashboard)?\/?$/.test(url.pathname)) return;
    a.href = url.href + '#theme=' + (picked() || 'device') + '.' + pickedAt();
  }, true);

  // The browser bar takes the page's colour: one theme-color, the one in use.
  function bar(theme) {
    var bars = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < bars.length; i++) {
      if (i) { bars[i].remove(); continue; }
      bars[i].removeAttribute('media');
      bars[i].setAttribute('content', BAR[theme]);
    }
  }
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    bar(theme);
    label();
    root.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }

  apply(current());

  // Going straight to closedhand.com carries no link, so the person's own
  // Closedhand, when this browser knows its personal URL (account-nav.js), is
  // asked for its pick each time; the newer pick wins, as with links. Their
  // Closedhand answers only the pick and when it was made.
  try {
    var mine = localStorage.getItem('closedhand-personal-url');
    if (/^https:\/\/[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(mine || '')) {
      fetch(mine + '/api/theme-pick', { cache: 'no-store', credentials: 'omit' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (t) {
          var at = Number(t && t.at);
          if (!t || !/^(light|dark|device)$/.test(t.pick) || !(at > pickedAt()) || at > Date.now() + 60000) return;
          if (t.pick === 'device') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t.pick);
          localStorage.setItem(AT, String(at));
          apply(current());
        })
        .catch(function () { /* its computer is off, or it is an older Closedhand */ });
    }
  } catch (e) { /* nothing kept in this browser */ }
  // This runs before the rest of the head is read, so the bar's tags and the
  // buttons come later.
  document.addEventListener('DOMContentLoaded', function () { bar(current()); label(); });
  // Matching the device: follow it when it changes, too. Either way the next
  // tap's theme may have changed with it.
  device.addEventListener('change', function () { if (!picked()) apply(current()); else label(); });

  window.closedhandTheme = {
    current: current,
    // 'light', 'dark' or 'device' (matching the device).
    set: function (pick) {
      held = pick === 'device' ? null : pick;
      try {
        if (pick === 'device') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pick);
        localStorage.setItem(AT, String(Date.now()));
      } catch (e) { /* remembered for this page only */ }
      apply(current());
    },
  };

  // The sun and moon: the other theme spreads from the button inside a
  // glowing ember ring, the home page's smoke ring, while in the button the
  // sun sets and the moon rises (interface.css). Stars come out on the way
  // to dark; a warm glow comes up on the way to light.
  function sparkle(box, theme) {
    var x = box.left + box.width / 2, y = box.top + box.height / 2;
    var layer = document.createElement('div');
    layer.className = 'theme-sparkle';
    layer.setAttribute('aria-hidden', 'true');
    if (theme === 'dark') {
      for (var i = 0; i < 7; i++) {
        var star = document.createElement('i');
        // Spread round the lower half, where the page is: the header is above.
        var angle = Math.PI * (i + 0.2 + 0.6 * Math.random()) / 7;
        var far = 24 + Math.random() * 48;
        star.style.left = Math.round(x + Math.cos(angle) * far) + 'px';
        star.style.top = Math.round(y + Math.sin(angle) * far * 0.8) + 'px';
        star.style.animationDelay = (320 + Math.random() * 420) + 'ms';
        star.style.setProperty('--size', (0.19 + Math.random() * 0.19).toFixed(2) + 'rem');
        layer.appendChild(star);
      }
    } else {
      var glow = document.createElement('b');
      glow.style.left = Math.round(x) + 'px';
      glow.style.top = Math.round(y) + 'px';
      layer.appendChild(glow);
    }
    document.body.appendChild(layer);
    setTimeout(function () { layer.remove(); }, 1900);
  }
  // Without view transitions (Safari before 18) the spread is drawn by hand:
  // the new page colour grows from the button on a layer behind everything,
  // over a layer of the old one, and every other colour on the page changes
  // as the ring's edge reaches it. Timed like the view transition
  // (interface.css: 1.15s, cubic-bezier(.6, .04, .3, 1)).
  var SPREAD_MS = 1150;
  function spreadDelay(share) {
    for (var i = 0; i <= 200; i++) {
      var s = i / 200, u = 1 - s;
      if (3 * u * u * s * 0.04 + 3 * u * s * s + s * s * s >= share) return 3 * u * u * s * 0.6 + 3 * u * s * s * 0.3 + s * s * s;
    }
    return 1;
  }
  var SPREAD_PAINT = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'fill', 'stroke'];
  function spreadPaint(el) {
    var style = getComputedStyle(el);
    return SPREAD_PAINT.map(function (p) { return style[p]; });
  }
  function spreadByHand(x, y, reach, ring, change) {
    if (root.classList.contains('theme-spreading')) { change(); return; }
    var page = getComputedStyle(document.body).backgroundColor;
    // Only what is on screen is drawn changing; the rest simply changes.
    var timed = [];
    Array.prototype.forEach.call(document.body.querySelectorAll('*'), function (el) {
      var box = el.getBoundingClientRect();
      if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth || !(box.width + box.height)) return;
      var far = Math.hypot(box.left + box.width / 2 - x, box.top + box.height / 2 - y);
      var was = spreadPaint(el);
      timed.push({ el: el, delay: Math.round(spreadDelay(Math.min(1, far / reach)) * SPREAD_MS), was: was, clear: was[1] === page });
    });
    var under = document.createElement('div'), over = document.createElement('div');
    under.className = over.className = 'theme-spread';
    under.style.background = page;
    over.classList.add('is-new');
    timed.forEach(function (t) { if (t.clear) t.el.setAttribute('data-spread-clear', ''); });
    // A page drawn on a ground of its own (the smoke canvas) keeps it in the
    // old look outside the ring, the new colour growing just above it; the
    // ground changes after, under the colour as it fades.
    var ground = document.querySelector('[data-theme-ground]');
    if (ground && ground.getClientRects().length) {
      over.style.zIndex = getComputedStyle(ground).zIndex;
      ground.after(over);
    } else {
      document.body.prepend(under, over);
    }
    ring.classList.add('by-hand');
    document.body.appendChild(ring);
    root.classList.add('theme-spreading');
    change();
    // Each colour holds its old value until the ring reaches it, then turns.
    // Animations, not transitions: a transition starts again whenever the
    // colour it inherits changes, so it would turn late.
    var turning = [];
    timed.forEach(function (t) {
      var now = spreadPaint(t.el), frames = {}, any = false;
      SPREAD_PAINT.forEach(function (p, i) {
        if (t.was[i] === now[i] || (t.clear && p === 'backgroundColor')) return;
        frames[p] = [t.was[i], now[i]];
        any = true;
      });
      if (any && t.el.animate) turning.push(t.el.animate(frames, { duration: 300, delay: t.delay, easing: 'ease', fill: 'backwards' }));
    });
    setTimeout(function () {
      root.classList.remove('theme-spreading');
      turning.forEach(function (a) { a.cancel(); });
      timed.forEach(function (t) { if (t.clear) t.el.removeAttribute('data-spread-clear'); });
      root.dispatchEvent(new CustomEvent('themechange', { detail: root.getAttribute('data-theme') }));
      under.remove(); ring.remove();
      over.classList.add('is-done');
      setTimeout(function () { over.remove(); }, 500);
    }, SPREAD_MS + 400);
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('.theme-toggle');
    if (!button) return;
    var next = nextPick(), before = current();
    var after = next === 'device' ? (device.matches ? 'light' : 'dark') : next;
    var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var box = button.getBoundingClientRect();
    if (still) { window.closedhandTheme.set(next); return; }
    // Back to matching the device, which already looks this way: the icon
    // turns, and the stars or the glow come out without the page changing.
    if (after === before) { window.closedhandTheme.set(next); sparkle(box, after); return; }
    sparkle(box, after);
    var x = box.left + box.width / 2, y = box.top + box.height / 2;
    var reach = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)));
    root.style.setProperty('--reveal-x', Math.round(x) + 'px');
    root.style.setProperty('--reveal-y', Math.round(y) + 'px');
    root.style.setProperty('--reveal-r', reach + 'px');
    var ring = document.createElement('div');
    ring.className = 'theme-ring';
    ring.setAttribute('aria-hidden', 'true');
    if (!document.startViewTransition) { spreadByHand(x, y, reach, ring, function () { window.closedhandTheme.set(next); }); return; }
    var shift = document.startViewTransition(function () {
      window.closedhandTheme.set(next);
      document.body.appendChild(ring);
    });
    shift.finished.finally(function () { ring.remove(); });
  });
})();
