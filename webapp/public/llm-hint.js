// A short explanation behind a small "i" beside a label, shown on hover,
// focus or tap, for text that would otherwise sit on the page as a
// paragraph. Every "i" in Closedhand is this one: made by infoHint(text,
// label), or written in a page as <span data-info="text"
// data-info-label="About …"></span>, which becomes one when it appears. The
// text is set as text, never markup; a blank line in it stays a blank line.
// The circle and its "i" are one drawing, so the i is in the middle of the
// circle by its geometry, whatever the font around it.
//
// The hint itself lives at the end of the page, placed on the screen beside
// the mark, so cards that clip or move their contents never cut it off.
(function () {
  var made = 0;
  var I = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.3" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="4.85" r="1.05" fill="currentColor"/><rect x="7.2" y="7" width="1.6" height="5" rx="0.8" fill="currentColor"/></svg>';
  window.infoHint = function (text, label) {
    var mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'info-hint-mark';
    mark.innerHTML = I;
    mark.setAttribute('aria-label', label || 'What this means');
    var tip = document.createElement('span');
    tip.textContent = text;
    return attach(mark, tip);
  };
  window.infoHintMark = I;
  // A page's own <span data-info="…">: made into one where it stands, keeping
  // its classes for where it sits.
  function upgrade(root) {
    var found = root.matches && root.matches('[data-info]') ? [root] : [];
    if (root.querySelectorAll) found = found.concat([].slice.call(root.querySelectorAll('[data-info]')));
    found.forEach(function (el) {
      if (!el.parentNode) return;
      var hint = window.infoHint(el.getAttribute('data-info'), el.getAttribute('data-info-label'));
      if (el.className) hint.className += ' ' + el.className;
      el.replaceWith(hint);
    });
  }
  function upgradeAll() { upgrade(document.body); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', upgradeAll); else upgradeAll();
  new MutationObserver(function (changes) {
    changes.forEach(function (c) { c.addedNodes.forEach(function (n) { if (n.nodeType === 1) upgrade(n); }); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  function attach(button, tip) {
    tidy();
    var hint = document.createElement('span');
    hint.className = 'llm-hint';
    tip.className = 'llm-hint-tip';
    tip.id = 'llm-hint-' + (++made);
    tip.setAttribute('role', 'tooltip');
    button.setAttribute('aria-describedby', tip.id);
    hint.append(button);
    hint.llmTip = tip;
    tip.llmHint = hint;
    document.body.append(tip);
    return hint;
  }
  // Hints whose name has left the page go too.
  function tidy() {
    document.querySelectorAll('body > .llm-hint-tip').forEach(function (tip) { if (tip.llmHint && !tip.llmHint.isConnected && tip.llmHint.dataset.made) tip.remove(); });
    document.querySelectorAll('.llm-hint').forEach(function (hint) { hint.dataset.made = '1'; });
  }
  // Under the name, or above it when the screen has no room below, and
  // never past either side.
  function place(hint) {
    var tip = hint.llmTip, at = hint.getBoundingClientRect();
    var left = Math.min(at.left - 4, window.innerWidth - tip.offsetWidth - 8);
    var below = at.bottom + 8, above = at.top - 8 - tip.offsetHeight;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = (below + tip.offsetHeight > window.innerHeight - 8 && above > 8 ? above : below) + 'px';
  }
  function show(hint) { place(hint); hint.llmTip.classList.add('shown'); }
  function hide(hint) { if (!hint.classList.contains('open') && !hint.contains(document.activeElement) && !hint.matches(':hover')) hint.llmTip.classList.remove('shown'); }
  function close(hint) { hint.classList.remove('open'); hint.llmTip.classList.remove('shown'); }
  var within = function (event) { return event.target.closest && event.target.closest('.llm-hint'); };
  document.addEventListener('mouseover', function (event) { var hint = within(event); if (hint && hint.llmTip) show(hint); });
  document.addEventListener('mouseout', function (event) { var hint = within(event); if (hint && hint.llmTip && !hint.contains(event.relatedTarget)) setTimeout(function () { hide(hint); }); });
  document.addEventListener('focusin', function (event) { var hint = within(event); if (hint && hint.llmTip && hint.querySelector(':focus-visible')) show(hint); });
  document.addEventListener('focusout', function (event) { var hint = within(event); if (hint && hint.llmTip) setTimeout(function () { hide(hint); }); });
  // A tap opens it on a phone; a tap anywhere else, or Escape, closes it.
  document.addEventListener('click', function (event) {
    var hit = within(event);
    document.querySelectorAll('.llm-hint.open').forEach(function (hint) { if (hint !== hit) close(hint); });
    if (!hit || !hit.llmTip) return;
    if (hit.classList.toggle('open')) show(hit); else close(hit);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') document.querySelectorAll('.llm-hint').forEach(function (hint) { if (hint.llmTip) close(hint); });
  });
  // A shown one follows its name as the page scrolls or resizes.
  function follow() { document.querySelectorAll('.llm-hint').forEach(function (hint) { if (hint.llmTip && hint.llmTip.classList.contains('shown')) place(hint); }); }
  window.addEventListener('scroll', follow, true);
  window.addEventListener('resize', follow);
})();
