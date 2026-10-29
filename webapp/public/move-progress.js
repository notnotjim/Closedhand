// A move between computers, drawn the same wherever one shows (My Account on
// the computer it leaves, setup on the one it goes to): where it starts and
// where it goes, the fist carrying Closedhand across as the parts arrive, the
// steps named and ticked, and the end in plain words. Drawn once, then only
// changed, so the motion carries on smoothly between updates.
//
//   MoveProgress.show(box, {
//     from: "This computer", to: "Railway", toKind: "server",
//     steps: ["Setting up on Railway", "Moving everything", "Handing over"],
//     at: 1,            // the step under way; steps.length when done
//     percent: 62,      // or null while it can't be told
//     moved: "403 MB moved",
//     said: "Closedhand pauses here while it moves.",
//     done: false, failed: false,
//   });
(function () {
  var COMPUTER = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M2 19h20"/></svg>';
  var SERVER = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3.5" width="16" height="7" rx="1.5"/><rect x="4" y="13.5" width="16" height="7" rx="1.5"/><path d="M8 7h.01M8 17h.01"/></svg>';
  var DESKTOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="6" width="14" height="10" rx="2"/><path d="M9 20h6M12 16v4"/></svg>';
  var ICON = { computer: COMPUTER, server: SERVER, desktop: DESKTOP };

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

  function build(box, s) {
    box.innerHTML = '';
    var root = el('div', 'move-progress');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Moving Closedhand');
    var route = el('div', 'mp-route');
    var from = el('div', 'mp-end mp-from');
    from.append(el('span', 'mp-icon', ICON[s.fromKind || 'computer']), el('span', 'mp-label'));
    var track = el('div', 'mp-track');
    track.append(el('span', 'mp-rail'), el('span', 'mp-fill'));
    var fist = el('img', 'mp-fist');
    fist.src = '/fist.png'; fist.alt = '';
    track.append(fist);
    var to = el('div', 'mp-end mp-to');
    to.append(el('span', 'mp-icon', ICON[s.toKind || 'server']), el('span', 'mp-label'));
    route.append(from, track, to);
    var bar = el('div', 'mp-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    var figures = el('div', 'mp-figures');
    figures.append(el('span', 'mp-percent'), el('span', 'mp-moved'));
    var steps = el('ol', 'mp-steps');
    var said = el('p', 'mp-said');
    said.setAttribute('aria-live', 'polite');
    root.append(route, figures, bar, steps, said);
    box.append(root);
    box._mp = { root: root, from: from, to: to, fist: fist, fill: track.querySelector('.mp-fill'), bar: bar, figures: figures, steps: steps, said: said, kinds: (s.fromKind || 'computer') + '>' + (s.toKind || 'server') };
  }

  function show(box, s) {
    if (!box._mp || box._mp.kinds !== (s.fromKind || 'computer') + '>' + (s.toKind || 'server')) build(box, s);
    var m = box._mp;
    m.from.querySelector('.mp-label').textContent = s.from;
    m.to.querySelector('.mp-label').textContent = s.to;
    var known = typeof s.percent === 'number' && isFinite(s.percent);
    var pct = s.done ? 100 : known ? Math.max(0, Math.min(100, s.percent)) : 0;
    m.root.classList.toggle('is-done', !!s.done);
    m.root.classList.toggle('is-failed', !!s.failed);
    m.root.classList.toggle('is-waiting', !s.done && !s.failed && !known);
    m.fill.style.width = pct + '%';
    m.fist.style.left = pct + '%';
    m.bar.setAttribute('aria-valuenow', String(pct));
    m.bar.style.setProperty('--mp', pct + '%');
    m.figures.querySelector('.mp-percent').textContent = s.failed ? '' : s.done ? 'Done' : known ? pct + '%' : '';
    m.figures.querySelector('.mp-moved').textContent = s.moved || '';
    // The steps, each ticked once passed; the one under way picked out.
    var names = s.steps || [];
    if (m.steps.childElementCount !== names.length) { m.steps.innerHTML = ''; names.forEach(function () { m.steps.append(el('li')); }); }
    names.forEach(function (name, i) {
      var li = m.steps.children[i];
      li.textContent = name;
      li.className = s.failed && i === s.at ? 'is-stopped' : i < s.at || s.done ? 'is-done' : i === s.at ? 'is-now' : '';
    });
    m.said.textContent = s.said || '';
    // The arrival, once: the same confetti as everywhere else.
    if (s.done && !box._mpCelebrated) {
      box._mpCelebrated = true;
      if (window.Delight && typeof window.Delight.confetti === 'function') window.Delight.confetti();
    }
    if (!s.done) box._mpCelebrated = false;
  }

  window.MoveProgress = { show: show };
})();
