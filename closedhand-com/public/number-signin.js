// Signing in with an account number, the same wherever Google and
// Microsoft sign in (the open, account and claim pages): a quiet link opens
// the box, and once signed in the page carries on where its Google button
// would have come back to.
(() => {
  for (const form of document.querySelectorAll('[data-number-signin]')) {
    const card = form.parentElement, show = card.querySelector('[data-number-show]');
    const input = form.querySelector('input'), error = form.querySelector('.error'), go = form.querySelector('button');
    show.addEventListener('click', () => { show.hidden = true; form.hidden = false; input.focus(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      error.hidden = true; go.disabled = true;
      try {
        const response = await fetch('/auth/number', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: input.value }), signal: AbortSignal.timeout(20000) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Could not sign you in just now. Please try again.');
        let back = '/open';
        try {
          const to = new URL(card.querySelector('a[href^="/auth/google"]').href).searchParams.get('return_to') || '';
          if (/^\/(?![/\\])/.test(to)) back = to;
        } catch (_) {}
        const target = new URL(back, location.origin);
        // Back to this same page: only the part after the # differs, which
        // alone would not load it again.
        if (target.pathname + target.search === location.pathname + location.search) { location.hash = target.hash; location.reload(); }
        else location.assign(target.href);
      } catch (e) {
        error.textContent = e.message; error.hidden = false; go.disabled = false;
      }
    });
  }
})();
