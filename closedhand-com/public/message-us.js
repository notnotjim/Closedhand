// "Send us a message", on every page people browse on closedhand.com: a
// small round button at the lower right that opens a short form, anchored
// to it on a computer and rising from the bottom on a phone. What is sent
// goes to closedhand.com (lib/messages.js) and from there to the maintainer.
// Our own piece, so no chat company's script runs on the site. The icons are
// the brush's (brand/icons).
(function () {
  if (document.getElementById('message-us')) return;
  var MESSAGE = '<svg data-icon="message" viewBox="0 0 480 480" aria-hidden="true"><path transform="translate(0.000000,480.000000) scale(0.100000,-0.100000)" fill="currentColor" d="M3035 3960 c-198 -4 -439 -15 -535 -24 -266 -25 -1187 -97 -1345 -106 -114 -6 -153 -13 -208 -33 -132 -51 -229 -151 -283 -293 -25 -66 -26 -82 -35 -369 -6 -165 -11 -516 -12 -780 -2 -478 -2 -480 21 -544 42 -117 66 -155 142 -233 111 -113 240 -169 420 -184 l77 -7 -48 -236 c-53 -256 -58 -324 -30 -386 22 -50 86 -109 136 -125 46 -15 118 -9 166 14 19 9 205 176 413 371 l379 354 701 3 701 3 88 31 c111 40 187 85 252 151 94 94 159 253 171 418 3 44 1 385 -5 758 -12 737 -15 773 -71 894 -73 159 -195 260 -373 310 -69 19 -278 22 -722 13z m-1159 -245 c249 -19 526 -42 616 -50 90 -9 363 -20 608 -25 470 -9 546 -16 619 -61 38 -23 66 -80 80 -164 12 -77 -5 -1324 -20 -1416 -18 -115 -53 -149 -170 -168 -40 -7 -326 -11 -753 -11 -506 0 -699 -3 -729 -12 -38 -12 -80 -46 -286 -236 l-79 -72 5 64 c7 80 -8 127 -59 182 -64 70 -99 78 -296 70 -327 -14 -386 18 -411 224 -12 101 -36 1326 -28 1433 3 41 12 88 20 103 23 44 76 90 130 114 59 26 197 58 256 59 24 1 248 -15 497 -34z"/></svg>';
  var CLOSE = '<svg data-icon="close" viewBox="0 0 480 480" aria-hidden="true"><path transform="translate(0.000000,480.000000) scale(0.100000,-0.100000)" fill="currentColor" d="M1481 3316 c-15 -17 -5 -138 15 -177 32 -63 367 -450 573 -661 l76 -78 -76 -77 c-205 -211 -503 -554 -536 -616 -16 -31 -53 -170 -53 -199 0 -10 7 -21 16 -25 20 -7 156 25 204 48 66 32 395 317 623 538 l77 76 78 -76 c227 -221 556 -506 622 -538 48 -23 184 -55 204 -48 9 4 16 15 16 25 0 29 -37 168 -53 199 -33 62 -331 405 -536 616 l-76 77 76 78 c206 211 541 598 573 661 7 14 16 57 20 95 9 92 3 99 -88 90 -39 -4 -83 -13 -97 -20 -64 -32 -450 -367 -661 -573 l-78 -76 -77 76 c-212 206 -598 541 -662 573 -14 7 -58 16 -97 20 -56 5 -73 4 -83 -8z"/></svg>';
  var root = document.createElement('div');
  root.className = 'mu';
  root.id = 'message-us';
  root.innerHTML =
    '<button type="button" class="mu-open" aria-expanded="false" aria-controls="mu-panel" aria-label="Send us a message">' +
      '<span class="mu-icon mu-icon-message">' + MESSAGE + '</span><span class="mu-icon mu-icon-close">' + CLOSE + '</span></button>' +
    '<div class="mu-scrim" hidden></div>' +
    '<section class="mu-panel" id="mu-panel" role="dialog" aria-labelledby="mu-title" hidden>' +
      '<div class="mu-head"><h2 id="mu-title">Send us a message</h2>' +
        '<button type="button" class="mu-close" aria-label="Close">' + CLOSE + '</button></div>' +
      '<form class="mu-form" novalidate>' +
        '<p class="mu-line">Questions, ideas or something not working: we read every message.</p>' +
        '<label class="mu-hide" for="mu-text">Your message</label>' +
        '<textarea id="mu-text" name="message" rows="4" maxlength="2000" placeholder="Your message"></textarea>' +
        '<label class="mu-hide" for="mu-email">Your email, if you’d like a reply</label>' +
        '<input id="mu-email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="Your email, if you’d like a reply">' +
        '<input class="mu-trap" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        '<p class="mu-error" role="alert" hidden></p>' +
        '<div class="mu-actions"><button type="submit" class="mu-send">Send</button></div>' +
      '</form>' +
      '<p class="mu-sent" role="status" hidden><span class="mu-thanks">Thanks.</span> If you left your email, we’ll reply there.</p>' +
    '</section>';
  document.body.appendChild(root);
  document.documentElement.classList.add('has-mu');

  var opener = root.querySelector('.mu-open'), panel = root.querySelector('.mu-panel'), scrim = root.querySelector('.mu-scrim');
  var form = root.querySelector('.mu-form'), text = root.querySelector('#mu-text'), email = root.querySelector('#mu-email');
  var trap = root.querySelector('.mu-trap'), error = root.querySelector('.mu-error'), send = root.querySelector('.mu-send');
  var sent = root.querySelector('.mu-sent');
  var sheet = window.matchMedia('(max-width: 560px)');
  var still = window.matchMedia('(prefers-reduced-motion: reduce)');
  var open = false, settle = null, after = null;

  function show() {
    if (open) return;
    open = true;
    clearTimeout(settle); clearTimeout(after);
    if (!sent.hidden) { sent.hidden = true; form.hidden = false; }
    panel.hidden = false;
    scrim.hidden = !sheet.matches;
    document.documentElement.classList.toggle('mu-sheet', sheet.matches);
    opener.setAttribute('aria-expanded', 'true');
    // The next frame, so the panel is drawn closed first and moves open.
    requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.add('is-open'); }); });
    text.focus({ preventScroll: true });
  }
  function hide(back) {
    if (!open) return;
    open = false;
    clearTimeout(after);
    root.classList.remove('is-open');
    opener.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('mu-sheet');
    if (back) opener.focus({ preventScroll: true });
    settle = setTimeout(function () { if (!open) { panel.hidden = true; scrim.hidden = true; } }, still.matches ? 0 : 260);
  }
  function say(words) { error.textContent = words; error.hidden = !words; }

  opener.addEventListener('click', function () { open ? hide(true) : show(); });
  root.querySelector('.mu-close').addEventListener('click', function () { hide(true); });
  scrim.addEventListener('click', function () { hide(true); });
  document.addEventListener('keydown', function (e) { if (open && e.key === 'Escape') hide(true); });
  document.addEventListener('pointerdown', function (e) { if (open && !root.contains(e.target)) hide(false); });
  text.addEventListener('input', function () { if (text.value.trim()) say(''); });
  email.addEventListener('input', function () { say(''); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var message = text.value.trim(), reply = email.value.trim();
    // What is still needed is said at its box (needs-field.js, the app's own piece).
    if (!message) return window.needsField(text, 'Write your message first.');
    if (reply && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(reply)) return window.needsField(email, 'That email doesn’t look right. Check it, or leave it empty.');
    say('');
    send.disabled = true;
    send.textContent = 'Sending…';
    fetch('/api/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message, email: reply, page: location.pathname, website: trap.value }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok) throw new Error(b.error || ''); });
    }).then(function () {
      form.reset();
      form.hidden = true;
      sent.hidden = false;
      // Thanked, then the panel goes by itself; focus inside goes back to
      // the button.
      after = setTimeout(function () { hide(root.contains(document.activeElement) && document.activeElement !== opener); }, 4500);
    }).catch(function (err) {
      say(err && err.message ? err.message : 'Couldn’t send just now. Please try again.');
    }).then(function () {
      send.disabled = false;
      send.textContent = 'Send';
    });
  });
  // Turning a phone round, or resizing a window across the line, moves an
  // open panel between its two shapes.
  sheet.addEventListener('change', function () {
    if (!open) return;
    scrim.hidden = !sheet.matches;
    document.documentElement.classList.toggle('mu-sheet', sheet.matches);
  });
})();
