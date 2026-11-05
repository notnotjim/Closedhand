/* Using Closedhand anonymously, the same in setup and on the dashboard's
   later claim: a small "Use anonymously" below the main claim turns the
   claim (each [data-claim-way]) into a short panel in place, with "Back".
   The panel is paid for first: a choice of months in crypto, then "Pay and
   continue anonymously", which opens closedhand.com's payment page and waits
   with one live line, beside the fist with an ink arc going round it, until
   the payment is confirmed: the ring closes for a moment. Then the account
   number, large and grouped with Copy, shows until the person ticks that the
   number is saved (webapp/phone-registration.js claimAnonymous). The Terms
   box above applies to both ways: pressing either without it ticked draws
   the eye to it (nudge), never an error. The page holding the piece says
   whether the Terms are agreed and where its Terms row is, shows its
   errors, and hears when the account is made and when the number is saved. */
(function (root) {
  'use strict';
  // A row to tick first, shown gently: a short highlight, its quiet helper
  // line and the focus on its box, with no jump.
  function nudge(row) {
    if (!row) return;
    var helper = row.querySelector('.terms-nudge');
    if (helper) helper.hidden = false;
    try {
      row.classList.remove('is-nudged'); void row.offsetWidth; row.classList.add('is-nudged');
      row.querySelector('input[type=checkbox]').focus({ preventScroll: true });
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (_) {}
  }
  function mount(box, options) {
    var $ = function (id) { return box.querySelector('#' + id); };
    var number = null, busy = false, open = false, offer = null, months = null, waiting = null, polling = null, note = '', finished = false;
    function draw() {
      var panel = open && !number;
      $('url-anon-panel').hidden = !panel;
      box.querySelectorAll('[data-claim-way]').forEach(function (way) { way.hidden = panel; });
      var choices = (offer && offer.crypto) || [];
      $('url-anon-choice').hidden = !!waiting || !choices.length;
      $('url-anon-months').querySelectorAll('button').forEach(function (b) { b.ariaPressed = String(Number(b.value) === months); });
      $('url-anon-go').hidden = !!waiting;
      $('url-anon-go').disabled = busy || !choices.length;
      $('url-anon-go').textContent = busy ? 'Opening…' : 'Pay and continue anonymously';
      $('url-anon-pay').hidden = !waiting || finished;
      if (waiting) { $('url-anon-pay').href = waiting.url; $('url-anon-pay').textContent = 'Open the payment page for ' + waiting.months + ' months'; }
      $('url-anon-back').hidden = !!waiting;
      $('url-anon-wait').textContent = finished ? 'Payment confirmed.' : waiting ? 'Waiting for your payment to be confirmed, usually within the hour. You can leave this page open.'
        : offer && !choices.length ? 'Using Closedhand anonymously isn’t available just now. Please try again later.' : note;
      $('url-anon-wait').hidden = !$('url-anon-wait').textContent;
      // The fist and its ink arc while the payment is on its way; the ring
      // closes once it is confirmed, and is gone if the page expires.
      $('url-anon-progress').hidden = !waiting;
      $('url-anon-progress').classList.toggle('is-done', finished);
      $('url-anon-wait-row').classList.toggle('is-waiting', !!waiting);
      $('url-number').hidden = !number;
      $('url-number-value').textContent = number || '';
      $('url-number-continue').disabled = !$('url-number-saved').checked;
    }
    async function request(path, body) {
      var response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) } : { signal: AbortSignal.timeout(30000) });
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(result.error || 'Could not reach closedhand.com just now. Please try again.');
      return result;
    }
    // The months, as My Account offers paying ahead in crypto.
    async function loadOffer() {
      if (offer && offer.crypto.length) return;
      try { offer = await request('/api/phone/anonymous'); } catch (_) { offer = { crypto: [] }; }
      if (!Array.isArray(offer.crypto)) offer.crypto = [];
      $('url-anon-months').replaceChildren.apply($('url-anon-months'), offer.crypto.map(function (option) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'btn-quiet btn-small anon-month'; b.value = String(option.months);
        b.textContent = option.months + ' months · ' + option.price + (option.monthly ? ' (' + option.monthly + ' a month)' : '');
        b.addEventListener('click', function () { months = option.months; draw(); });
        return b;
      }));
      if (months === null && offer.crypto.length) months = offer.crypto[0].months;
      draw();
    }
    // Opened and closed in place, the focus kept where the eye is, so the
    // page never jumps.
    function show(next) {
      open = next; note = ''; options.say(null); draw(); options.changed();
      try { $(next ? 'url-anon-go' : 'url-anonymous').focus({ preventScroll: true }); } catch (_) {}
      if (next) loadOffer();
    }
    $('url-anonymous').addEventListener('click', function () { if (options.ready()) show(true); });
    $('url-anon-back').addEventListener('click', function () { if (!busy) show(false); });
    $('url-anon-agree-box').addEventListener('change', function () { if (this.checked) $('url-anon-agree').querySelector('.terms-nudge').hidden = true; });
    // Paid for first: the payment page, then waiting for it.
    $('url-anon-go').addEventListener('click', async function () {
      if (busy || !options.ready()) return;
      if (!options.agreed()) { nudge(options.terms()); return; }
      if (!$('url-anon-agree-box').checked) { nudge($('url-anon-agree')); return; }
      busy = true; note = ''; options.say(null); draw(); options.changed();
      try {
        var result = await request('/api/phone/claim-anonymous', { months: months });
        waiting = { url: result.url, months: result.months || months };
        poll();
      } catch (e) { note = e.message; }
      finally { busy = false; draw(); options.changed(); }
      try { $('url-anon-pay').focus({ preventScroll: true }); } catch (_) {}
    });
    // Asked every few seconds while it waits; closedhand.com reads the
    // payment back from its payment server itself.
    function poll() {
      clearTimeout(polling);
      polling = setTimeout(async function () {
        try {
          var state = await request('/api/phone/claim-anonymous');
          if (state.state === 'ready' && state.accountNumber) {
            // Paid: the ring closes for a moment, then the number.
            finished = true; draw();
            setTimeout(function () {
              waiting = null; finished = false; open = false; number = state.accountNumber;
              options.claimed(state);
              draw(); options.changed();
              try { $('url-number-copy').focus({ preventScroll: true }); } catch (_) {}
            }, 1100);
            return;
          }
          if (state.state !== 'waiting') {
            waiting = null; note = 'That payment page expired before a payment arrived. Choose again to start over.';
            draw(); options.changed();
            return;
          }
        } catch (_) {}
        poll();
      }, 4000);
    }
    $('url-number-saved').addEventListener('change', draw);
    $('url-number-copy').addEventListener('click', async function () {
      if (!number) return;
      var status = $('url-number-copy-status');
      try {
        if (!navigator.clipboard) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(number);
        status.textContent = 'Copied.';
      } catch (_) {
        var range = document.createRange();
        range.selectNodeContents($('url-number-value'));
        var selection = root.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        status.textContent = document.execCommand('copy') ? 'Copied.' : 'Select and copy your account number above.';
      }
      status.hidden = false;
    });
    $('url-number-continue').addEventListener('click', async function () {
      if (!$('url-number-saved').checked) return;
      var button = this;
      button.disabled = true;
      try {
        await request('/api/phone/account-number/saved', {});
        number = null;
        $('url-number-copy-status').hidden = true;
        options.saved();
      } catch (e) { options.say(e.message); }
      finally { draw(); options.changed(); }
    });
    draw();
    return {
      number: function () { return number; },
      busy: function () { return busy || !!waiting; },
      draw: draw,
      // Claimed but not yet saved, as when the page is opened again: the
      // number shows again until it is.
      waiting: async function () {
        if (number) return;
        var kept = await fetch('/api/phone/account-number', { signal: AbortSignal.timeout(20000) }).then(function (r) { return r.json(); }).catch(function () { return {}; });
        if (kept.accountNumber) { number = kept.accountNumber; draw(); }
      },
      // A payment already on its way when the page opens: waiting for it again.
      resume: function (pending) {
        if (!pending || waiting || number) return;
        open = true; waiting = { url: pending.url, months: pending.months };
        draw(); poll();
      },
      forget: function () { number = null; busy = false; open = false; waiting = null; finished = false; clearTimeout(polling); draw(); }
    };
  }
  root.ClosedHandAccountNumber = { mount: mount, nudge: nudge };
})(window);
