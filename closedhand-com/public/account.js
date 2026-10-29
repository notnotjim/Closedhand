// The Closedhand account page. The account's home is My Account in the
// person's dashboard, so signed in, with their Closedhand answering, this
// opens it there. Otherwise it shows what closedhand.com holds: which
// sign-in it is, the personal URL, Closedhand+ and deleting the account.
// Deleting here can't reach the computer running Closedhand, so it says
// plainly what stays there.
(() => {
  const $ = id => document.getElementById(id);
  const say = (text, warn) => { $('status').textContent = text || ''; $('status').classList.toggle('warn', !!warn); };
  const providerName = p => p === 'microsoft' ? 'Microsoft' : 'Google';
  const show = screen => {
    for (const id of ['signed-out', 'details', 'deleted']) $(id).hidden = id !== screen;
    $('plus').hidden = screen !== 'details' || !(data?.plus?.available || ['first-month', 'plus', 'ended'].includes(data?.plan?.name));
  };
  let data = null;
  async function load() {
    try {
      const response = await fetch('/api/account', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      data = await response.json();
    } catch (_) { show(null); say('Could not look up your account. Please try again.', true); return; }
    say(welcome);
    if (!data.signedIn) {
      // From a one-tap link (carry-on in Closedhand's chat, Closedhand+ in
      // My Account): signing in goes on to it.
      const then = new URLSearchParams(location.search).get('then');
      if (then === 'carry-on' || then === 'plus') {
        for (const a of document.querySelectorAll('#signed-out a[href^="/auth/"]')) a.href = a.getAttribute('href').replace('return_to=%2Faccount', 'return_to=%2F' + then);
      }
      // Signed in with a provider that has no Closedhand account (none=…).
      const none = new URLSearchParams(location.search).get('none');
      if (none === 'google' || none === 'microsoft') {
        const other = none === 'microsoft' ? 'Google' : 'Microsoft';
        $('none-note').textContent = 'No Closedhand account uses this ' + providerName(none) + ' sign-in. If you set up with ' + other + ', sign in with ' + other + ' instead.';
        $('none-note').hidden = false;
      }
      return show('signed-out');
    }
    if (await answers(data.url)) return location.replace(data.url + '/dashboard#account' + (back === 'welcome' || back === 'extended' ? '/' + back : ''));
    show('details');
    $('acct-address').textContent = data.address || 'No personal URL yet';
    $('acct-address-note').textContent = data.address ? 'Your personal URL' : 'Setup on your computer gives Closedhand one.';
    // Every account connected at setup signs in here, the first one first.
    const signIns = data.signIns && data.signIns.length ? data.signIns : [{ provider: data.provider, email: data.email }];
    $('acct-who').textContent = signIns.map(s => providerName(s.provider) + (s.email ? ': ' + s.email : '')).join(' · ');
    plus();
  }

  // Whether the person's Closedhand answers at its personal URL now, asked
  // with the one question it answers closedhand.com (its light or dark
  // pick), without a cookie. Offline, the edge answers instead, not with it.
  async function answers(url) {
    if (!/^https:\/\/[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/.test(url || '')) return false;
    try {
      const response = await fetch(url + '/api/theme-pick', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(4000) });
      return response.ok && typeof (await response.json())?.at === 'number';
    } catch (_) { return false; }
  }

  // Closedhand Managed Models: where the plan stands and how much of this
  // month's fair use is used, as a bar and never an amount; then Closedhand+,
  // what it is and the way in, or when it renews and the way to manage it.
  // Prices are in the person's currency, as Polar will charge. The first
  // month's end is said in its last week only.
  const day = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  function plus() {
    const p = data.plus || {}, prices = p.prices || {}, plan = data.plan || {};
    const state = [];
    if (plan.name === 'first-month') {
      const left = Date.parse(plan.ends_at) - Date.now();
      state.push(left > 0 && left <= 7 * 86400000 ? 'Your first month of Closedhand Managed Models stays on until ' + day(plan.ends_at) + '.' : 'Your first month of Closedhand Managed Models is running.');
    } else if (plan.name === 'ended') state.push('Closedhand Managed Models has ended.');
    const running = (plan.name === 'first-month' || plan.name === 'plus') && typeof data.used === 'number';
    $('fair-use').hidden = !running;
    if (running) {
      const share = Math.round(data.used * 100);
      // Never drawn empty: a little use still shows as a sliver, so the bar
      // doesn't look broken.
      $('fair-use-fill').style.width = Math.max(1, share) + '%';
      $('fair-use-track').setAttribute('aria-valuenow', String(share));
    }
    const showState = () => { $('plus-state').textContent = state.join(' '); $('plus-state').hidden = !state.length; };
    if (!p.available) { $('plus-about').hidden = true; $('plus-fine').hidden = true; return showState(); }
    const email = data.plan?.email;
    $('plus-about').hidden = !!p.active;
    $('plus-about').textContent = 'Closedhand Managed Models every month, so you need no LLM provider of your own'
      + (email ? ", and Closedhand's own email with no monthly limit" : '') + ". They run through OpenRouter, only on LLM providers that do not store or train on your data or conversations."
      // Never had Closedhand+: its first month is free (Polar's trial).
      + (p.free_month ? ' The first month is free, then ' + (prices.plus || 'a monthly price') + ' a month.' : '');
    $('plus-get').hidden = p.active;
    $('plus-get').textContent = p.free_month ? 'Get Closedhand+ · first month free' : 'Get Closedhand+' + (prices.plus ? ' · ' + prices.plus + ' a month' : '');
    $('plus-manage').hidden = !p.active;
    if (p.active && p.trial && p.ends_at) state.push('Your free month runs until ' + day(p.ends_at) + ', then Closedhand+ ends and nothing is charged.');
    else if (p.active && p.trial && p.renews_at) state.push('Your free month runs until ' + day(p.renews_at) + ', then Closedhand+ renews at ' + (prices.plus || 'its monthly price') + ' a month.');
    else if (p.active && p.ends_at) state.push('Ends on ' + day(p.ends_at) + '.');
    else if (p.active && p.renews_at) state.push('Renews on ' + day(p.renews_at) + '.');
    if (p.active && p.nearly) state.push(p.extended ? "You've used most of this month's fair use, carried on to the end of the month." : "You've used most of this month's fair use.");
    showState();
    $('plus-extend').hidden = !(p.active && p.nearly && !p.extended);
    $('plus-extend').textContent = 'Carry on to the end of the month' + (prices.extend ? ' · ' + prices.extend : '');
    $('plus-fine').textContent = p.active ? "Change your card, see your invoices or cancel on Polar's page." : 'Cancel any time.';
  }
  // Each button asks closedhand.com for Polar's page and goes there.
  async function goTo(path, button) {
    button.disabled = true; say('Opening…');
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.url) throw new Error(result.error || 'Could not reach the payment service just now. Please try again.');
      location.assign(result.url);
    } catch (e) { say(e.message, true); button.disabled = false; }
  }
  $('plus-get').addEventListener('click', () => goTo('/api/plus/checkout', $('plus-get')));
  $('plus-extend').addEventListener('click', () => goTo('/api/plus/extend', $('plus-extend')));
  $('plus-manage').addEventListener('click', () => goTo('/api/plus/manage', $('plus-manage')));
  // Back from Polar's checkout.
  const back = new URLSearchParams(location.search).get('plus');
  const welcome = back === 'welcome' ? 'Welcome to Closedhand+. Your Closedhand picks it up within the hour.'
    : back === 'extended' ? 'Done: you can carry on to the end of the month.' : '';
  $('delete').addEventListener('click', () => {
    const text = $('confirm-text');
    text.textContent = '';
    if (data.address) {
      const name = document.createElement('strong');
      name.className = 'nowrap'; name.textContent = data.address;
      text.append('This deletes your Closedhand account. ', name, ' stops working and closedhand.com forgets your sign-in. Nobody can take the name for six months, and nothing links it to you. Closedhand keeps everything on your computer; to delete that too, use Delete account in My Account on its dashboard.');
    } else text.textContent = 'This deletes your Closedhand account, and closedhand.com forgets your sign-in.';
    $('delete').hidden = true; $('confirm').hidden = false; $('delete-go').focus();
  });
  $('delete-cancel').addEventListener('click', () => { $('confirm').hidden = true; $('delete').hidden = false; $('delete').focus(); });
  $('delete-go').addEventListener('click', async () => {
    $('delete-go').disabled = true; say('Deleting…');
    try {
      const response = await fetch('/api/account/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not delete your account. Please try again.');
      show('deleted'); say('');
    } catch (e) { say(e.message, true); $('delete-go').disabled = false; }
  });
  // Signing out also forgets the address this browser keeps, so the homepage
  // shows what everyone sees. The account keeps its personal URL.
  document.querySelector('form[action^="/logout"]').addEventListener('submit', () => {
    try { localStorage.removeItem('closedhand-personal-url'); } catch (e) { /* nothing kept */ }
  });
  load();
})();
