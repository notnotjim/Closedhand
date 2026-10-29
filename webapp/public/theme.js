// Light or dark, as the person picked with the sun, moon or the two in one
// (matching the device) at the top of the web chat and the dashboard: the
// server puts the pick on <html data-theme-pick> when it serves a page
// (matching the device when there is none), and this, loaded first in every
// page's head, sets data-theme before anything is drawn. The colours themselves are
// in interface.css, by name, under :root and :root[data-theme="light"].
// Switching plays closedhand.com's transition (its theme.js): the other theme
// spreads from the control inside a glowing ember ring, stars come out on the
// way to dark and a warm glow comes up on the way to light.
(function () {
  var BAR = { dark: '#100E0D', light: '#EFE6D6' };
  var root = document.documentElement;
  var device = window.matchMedia('(prefers-color-scheme: light)');

  function pick() {
    var given = root.getAttribute('data-theme-pick');
    return given === 'light' || given === 'dark' ? given : 'device';
  }
  function current() {
    var p = pick();
    return p === 'device' ? (device.matches ? 'light' : 'dark') : p;
  }
  // Each tap: matching the device, then the other theme, then the device's
  // own, then matching it again, so the first two taps always change the page.
  function nextPick() {
    var own = device.matches ? 'light' : 'dark', other = own === 'light' ? 'dark' : 'light', p = pick();
    return p === 'device' ? other : p === other ? own : 'device';
  }
  // The button shows the pick (interface.css) and says it, and what a tap does.
  var SAYS = { light: 'Light', dark: 'Dark', device: 'Matches this device' };
  var NEXT = { light: 'Switch to light.', dark: 'Switch to dark.', device: 'Switch to match this device.' };
  function label() {
    var words = SAYS[pick()] + '. ' + NEXT[nextPick()];
    var buttons = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < buttons.length; i++) { buttons[i].title = words; buttons[i].setAttribute('aria-label', words); }
  }
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

  // The dashboard, in its frame over the web chat, takes the web chat's pick,
  // even one made a moment ago and not yet kept.
  try { if (window.parent !== window && window.parent.closedhandTheme) root.setAttribute('data-theme-pick', window.parent.closedhandTheme.pick()); } catch (e) { /* not the web chat's frame */ }

  // Light or dark travels with the links between closedhand.com and here, as
  // #theme=<pick>.<when it was picked>: after the #, so no server is ever sent
  // it, and taken off the address at once. The newer pick of the two wins and
  // is kept in the person's settings too.
  var SHARED = /(^#|&)theme=(light|dark|device)\.(\d{1,15})(?=&|$)/;
  function pickedAt() { return Number(root.getAttribute('data-theme-at')) || 0; }
  var brought = (location.hash || '').match(SHARED);
  if (brought) {
    try { history.replaceState(history.state, '', location.pathname + location.search + location.hash.replace(SHARED, '$1').replace(/^#&/, '#').replace(/&$/, '').replace(/^#$/, '')); } catch (e) { /* the address keeps it */ }
    var at = Number(brought[3]);
    if (at > pickedAt() && at <= Date.now() + 60000) {
      root.setAttribute('data-theme-pick', brought[2]);
      root.setAttribute('data-theme-at', String(at));
      fetch('/api/settings/appearance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pick: brought[2], at: at }) }).catch(function () {});
    }
  }
  // Out to closedhand.com's own pages (never a link that passes on to a
  // sign-in), a pick made here goes along.
  document.addEventListener('click', function (event) {
    var a = event.target.closest && event.target.closest('a[href]');
    if (!a || !pickedAt()) return;
    var url;
    try { url = new URL(a.href); } catch (e) { return; }
    if (url.hash || !/^(www\.)?closedhand\.com$/.test(url.hostname) || !/^\/(account|privacy|terms)?\/?$/.test(url.pathname)) return;
    a.href = url.href + '#theme=' + pick() + '.' + pickedAt();
  }, true);
  apply(current());
  // This runs before the rest of the head is read, so the bar's tag and the
  // buttons come later.
  document.addEventListener('DOMContentLoaded', function () { bar(current()); label(); });
  // Matching the device follows it when it changes, too. Either way the next
  // tap's theme may have changed with it.
  device.addEventListener('change', function () { if (pick() === 'device') apply(current()); else label(); });

  function sparkle(x, y, theme) {
    var layer = document.createElement('div');
    layer.className = 'theme-sparkle';
    layer.setAttribute('aria-hidden', 'true');
    if (theme === 'dark') {
      for (var i = 0; i < 7; i++) {
        var star = document.createElement('i');
        // Spread round the lower half, below the control.
        var angle = Math.PI * (i + 0.2 + 0.6 * Math.random()) / 7;
        var far = 24 + Math.random() * 48;
        star.style.left = Math.round(x + Math.cos(angle) * far) + 'px';
        star.style.top = Math.round(y + Math.sin(angle) * far * 0.8) + 'px';
        star.style.animationDelay = (320 + Math.random() * 420) + 'ms';
        star.style.setProperty('--size', (3 + Math.random() * 3).toFixed(1) + 'px');
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
  // the new page colour grows from the control on a layer behind everything,
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

  // A new pick, from the point on screen it was made at ({ x, y }, or the
  // top right): the page changes inside the ring, at once with reduced
  // motion, and drawn by hand without view transitions.
  function setPick(next, from) {
    var before = current();
    root.setAttribute('data-theme-pick', next);
    var after = current();
    if (after === before) { label(); return; }
    var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var x = from && isFinite(from.x) ? from.x : innerWidth - 40, y = from && isFinite(from.y) ? from.y : 40;
    if (still) { apply(after); return; }
    sparkle(x, y, after);
    var reach = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)));
    root.style.setProperty('--reveal-x', Math.round(x) + 'px');
    root.style.setProperty('--reveal-y', Math.round(y) + 'px');
    root.style.setProperty('--reveal-r', reach + 'px');
    var ring = document.createElement('div');
    ring.className = 'theme-ring';
    ring.setAttribute('aria-hidden', 'true');
    if (!document.startViewTransition) { spreadByHand(x, y, reach, ring, function () { apply(after); }); return; }
    var shift = document.startViewTransition(function () {
      apply(after);
      document.body.appendChild(ring);
    });
    shift.finished.finally(function () { ring.remove(); });
  }

  // The dashboard opens in a frame over the web chat: it follows a new pick
  // at once, without a switch of its own.
  function follow(next) {
    root.setAttribute('data-theme-pick', next);
    apply(current());
  }

  // The sun, moon and the two in one move to the next pick (nextPick) from
  // where they were pressed, and the pick is kept in the person's settings,
  // so every page and every device opens in it. The same control as
  // closedhand.com's.
  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('.theme-toggle');
    if (!button) return;
    var was = pick(), next = nextPick(), before = current();
    var box = button.getBoundingClientRect();
    var frames = function (to) {
      var frame = document.getElementById('dashIframe');
      try { if (frame && frame.contentWindow.closedhandTheme) frame.contentWindow.closedhandTheme.follow(to); } catch (e) { /* not loaded yet */ }
    };
    var wasAt = pickedAt(), at = Date.now();
    setPick(next, { x: box.left + box.width / 2, y: box.top + box.height / 2 });
    // Back to matching the device, which already looks this way: the icon
    // turns, and the stars or the glow come out without the page changing.
    if (current() === before && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) sparkle(box.left + box.width / 2, box.top + box.height / 2, before);
    root.setAttribute('data-theme-at', String(at));
    frames(next);
    fetch('/api/settings/appearance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pick: next, at: at }) })
      .then(function (r) { if (!r.ok) throw new Error('not saved'); })
      .catch(function () { setPick(was); root.setAttribute('data-theme-at', String(wasAt)); frames(was); });
  });

  window.closedhandTheme = { current: current, pick: pick, setPick: setPick, follow: follow };
})();
