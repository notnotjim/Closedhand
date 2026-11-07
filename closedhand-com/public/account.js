// The Closedhand account page. The account's home is My Account in the
// person's dashboard, so signed in, with their Closedhand answering, this
// opens it there. Otherwise it shows what closedhand.com holds: which
// sign-in it is, the personal URL, the subscription and deleting the account.
// Deleting here can't reach the computer running Closedhand, so it says
// plainly what stays there.
(() => {
  const $ = id => document.getElementById(id);
  const say = (text, warn) => { $('status').textContent = text || ''; $('status').classList.toggle('warn', !!warn); };
  const providerName = p => p === 'microsoft' ? 'Microsoft' : 'Google';
  const show = screen => {
    for (const id of ['signed-out', 'details', 'deleted']) $(id).hidden = id !== screen;
    $('plus').hidden = screen !== 'details' || !(data?.plus?.available || ['first-month', 'plus', 'ended', 'maintainer', 'ahead'].includes(data?.plan?.name));
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
      // From the one-tap link in Closedhand's chat to subscribe: signing in
      // goes on to it.
      const then = new URLSearchParams(location.search).get('then');
      if (then === 'subscribe') {
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
    if (await answers(data.url)) return location.replace(data.url + '/dashboard#account' + (['welcome', 'extended', 'ahead', 'carrying'].includes(back) ? '/' + back : ''));
    show('details');
    $('acct-address').textContent = data.address || 'No personal URL yet';
    $('acct-address-note').textContent = data.address ? 'Your personal URL' : 'Setup on your computer gives Closedhand one.';
    // Every account connected at setup signs in here, the first one first.
    const signIns = data.signIns && data.signIns.length ? data.signIns : [{ provider: data.provider, email: data.email }];
    $('acct-who').textContent = data.anonymous ? 'Signed in with your account number' : signIns.map(s => providerName(s.provider) + (s.email ? ': ' + s.email : '')).join(' · ');
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
  // month's fair use is used, as a bar and never an amount, with when it
  // renews once most is used; then the ways to pay, or when the subscription
  // renews and the way to manage it. Prices are in the person's currency, as
  // Polar will charge, and crypto's in US dollars. The first month's end is
  // said in its last week only.
  const day = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  const longDay = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  // "renews in 12 days (6 December)", the same for every plan.
  const renewsIn = iso => {
    const days = Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 86400000));
    return "This month's fair use renews in " + days + (days === 1 ? ' day' : ' days') + ' (' + day(iso) + ').';
  };
  function bar(plan) {
    const shown = typeof data.used === 'number';
    $('fair-use').hidden = !shown;
    if (!shown) return;
    const share = Math.round(data.used * 100);
    // Never drawn empty: a little use still shows as a sliver, so the bar
    // doesn't look broken.
    $('fair-use-fill').style.width = Math.max(1, share) + '%';
    $('fair-use-track').setAttribute('aria-valuenow', String(share));
    const most = data.used >= 0.8 && !!plan.fair_use_renews_at;
    $('fair-use-renews').textContent = most ? renewsIn(plan.fair_use_renews_at) : '';
    $('fair-use-renews').hidden = !most;
  }
  function plus() {
    const p = data.plus || {}, prices = p.prices || {}, plan = data.plan || {};
    // The uncensored LLM Closedhand provides, by the name closedhand.com gives it.
    const model = data.model || 'DeepSeek V4.1 Flash Abliterated';
    const state = [];
    $('ahead').hidden = true; $('agree').hidden = true;
    // The maintainer's own account: the subscription with no charge and this
    // month's fair use, with nothing to buy, cancel or carry on.
    if (plan.name === 'maintainer') {
      for (const id of ['plus-about', 'plus-get', 'plus-extend', 'plus-manage', 'plus-fine']) $(id).hidden = true;
      // Its state says when the fair use renews, always.
      if (typeof data.used === 'number') bar({}); else $('fair-use').hidden = true;
      $('plus-state').textContent = model + ' is on for your account as the maintainer, with no charge.' + (plan.renews_at ? " This month's fair use renews on " + day(plan.renews_at) + '.' : '');
      $('plus-state').hidden = false;
      return;
    }
    const crypto = !!p.ahead_until;
    if (plan.name === 'ahead') state.push(model + ' is paid until ' + longDay(plan.ends_at) + '.');
    else if (plan.name === 'first-month') {
      const left = Date.parse(plan.ends_at) - Date.now();
      state.push(left > 0 && left <= 3 * 86400000 ? 'Your free 14 days of ' + model + ' run until ' + day(plan.ends_at) + '.' : 'Your free 14 days of ' + model + ' are running.');
    } else if (plan.name === 'ended') state.push('You no longer have ' + model + '.');
    if (['first-month', 'plus', 'ahead'].includes(plan.name)) bar(plan); else $('fair-use').hidden = true;
    const showState = () => { $('plus-state').textContent = state.join(' '); $('plus-state').hidden = !state.length; };
    if (!p.available) { $('plus-about').hidden = true; $('plus-fine').hidden = true; return showState(); }
    const email = data.plan?.email;
    $('plus-about').hidden = p.active || crypto;
    // The LLM's name links to what the subscription is (closedhand.com/pricing).
    const about = document.createElement('a');
    about.href = '/pricing'; about.textContent = model;
    // An account made with an account number pays in crypto only.
    if (data.anonymous) $('plus-about').replaceChildren('Pay ahead for ', about, ' in crypto, so you need no LLM provider of your own. With an account number, you pay in crypto only, never by card, so nothing ties your account to your name.');
    else $('plus-about').replaceChildren('Subscribe to keep ', about, ' every month, so you need no LLM provider of your own'
      + (email ? ", and for Closedhand's own email address" : '') + '. ' + model + ' runs in a TEE, so nobody but you can read anything that goes in or comes out.'
      // Never had the free days: the subscription's first 14 days are them (Polar's trial).
      + (p.free_month ? ' The first 14 days are free, then ' + (prices.plus || 'a monthly price') + ' a month.' : ''));
    $('plus-get').hidden = p.active || crypto || !!data.anonymous;
    $('plus-get').textContent = p.free_month ? 'Subscribe · 14 days free' : 'Subscribe' + (prices.plus ? ' · ' + prices.plus + ' a month' : '');
    $('plus-manage').hidden = !p.active;
    // A date months away says its year.
    const when = iso => (p.every ? longDay : day)(iso);
    if (p.active && p.trial && p.ends_at) state.push('Your free 14 days run until ' + day(p.ends_at) + ', then your subscription ends and nothing is charged.');
    else if (p.active && p.trial && p.renews_at) state.push('Your free 14 days run until ' + day(p.renews_at) + ', then your subscription renews at ' + (prices.plus || 'its monthly price') + ' a month.');
    else if (p.active && p.ends_at) state.push('Ends on ' + when(p.ends_at) + '.');
    else if (p.active && p.renews_at) state.push((p.every ? 'Renews every ' + p.every + ' months, next on ' : 'Renews on ') + when(p.renews_at) + '.');
    if ((p.active || crypto) && p.nearly) state.push(p.extended ? "You've used most of this month's fair use, carried on to the end of the month." : "You've used most of this month's fair use.");
    showState();
    // Carrying on, the way the plan is paid: by card, or in crypto.
    const extendPrice = crypto ? p.crypto_extend : prices.extend;
    $('plus-extend').hidden = !((p.active || (crypto && extendPrice)) && p.nearly && !p.extended);
    $('plus-extend').textContent = 'Carry on to the end of the month' + (extendPrice ? ' · ' + extendPrice : '');
    $('plus-fine').textContent = p.active ? "Change your card, see your invoices or cancel on Polar's page." : crypto || data.anonymous ? '' : 'Cancel any time.';
    $('plus-fine').hidden = !$('plus-fine').textContent;
    ways(p, crypto);
    // The box shows above any button that charges at once.
    $('agree').hidden = $('plus-extend').hidden && !(!$('plus-get').hidden && !p.free_month) && $('ahead').hidden;
  }
  // The other ways to pay: the subscription every 6 or 12 months, each a
  // button with its price and what that comes to a month, and paying ahead in
  // crypto behind a quiet link, or straight there while a plan paid in crypto
  // runs.
  function ways(p, crypto) {
    const longer = p.longer || [], coins = p.crypto || [];
    $('ahead').hidden = !longer.length && !coins.length;
    if ($('ahead').hidden) return;
    const button = (option, label, go) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn';
      b.textContent = label + ' · ' + option.price + (option.monthly ? ' (' + option.monthly + ' a month)' : '');
      b.addEventListener('click', () => go(b));
      return b;
    };
    $('ahead-about').textContent = crypto ? 'Pay ahead again in crypto to move the end on, priced in US dollars.' : longer.length ? 'Or subscribe every 6 or 12 months, for less a month.' : '';
    $('ahead-about').hidden = !$('ahead-about').textContent;
    $('plus-longer').replaceChildren(...longer.map(o => button(o, 'Every ' + o.months + ' months', b => pay('/api/plus/checkout', { months: o.months }, b))));
    $('plus-longer').hidden = !longer.length;
    $('ahead-crypto').replaceChildren(...coins.map(o => button(o, o.months + ' months', b => pay('/api/ahead/checkout', { months: o.months }, b))));
    $('ahead-crypto-label').textContent = 'In crypto, paid once and never renewed, priced in US dollars:';
    // Crypto is the only way for an account made with an account number, so
    // it is shown straight away.
    const open = crypto || !!data.anonymous;
    $('ahead-crypto').hidden = !open;
    $('ahead-crypto-show').hidden = open || !coins.length;
    $('ahead-crypto-label').hidden = !data.anonymous || crypto;
  }
  // A payment that charges at once, once the box is ticked: Polar's page, or
  // closedhand.com's own crypto payment page.
  async function pay(path, body, button) {
    if (!$('agree-box').checked) { say('Tick the box first: this payment starts straight away.', true); $('agree-box').focus(); return; }
    button.disabled = true; say('Opening…');
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, agreed: true }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.url) throw new Error(result.error || 'Could not reach the payment service just now. Please try again.');
      location.assign(result.url);
    } catch (e) { say(e.message, true); button.disabled = false; }
  }
  $('ahead-crypto-show').addEventListener('click', () => { $('ahead-crypto').hidden = false; $('ahead-crypto-label').hidden = false; $('ahead-crypto-show').hidden = true; });
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
  // Subscribing monthly with the free days first charges nothing now; else
  // the box comes first.
  $('plus-get').addEventListener('click', () => data.plus?.free_month ? goTo('/api/plus/checkout', $('plus-get')) : pay('/api/plus/checkout', { months: 1 }, $('plus-get')));
  $('plus-extend').addEventListener('click', () => data.plus?.ahead_until ? pay('/api/ahead/checkout', { extend: true }, $('plus-extend')) : pay('/api/plus/extend', {}, $('plus-extend')));
  $('plus-manage').addEventListener('click', () => goTo('/api/plus/manage', $('plus-manage')));
  // Back from Polar's checkout.
  const back = new URLSearchParams(location.search).get('plus');
  const welcome = back === 'welcome' ? 'Your Closedhand subscription has started. Your Closedhand moves onto ' + (data?.model || 'DeepSeek V4.1 Flash Abliterated') + ' within the hour.'
    : back === 'extended' ? 'Done: you can carry on to the end of the month.'
    : back === 'ahead' ? 'Thank you. Your account is paid ahead once the payment is confirmed, usually within the hour.'
    : back === 'carrying' ? 'Thank you. You can carry on to the end of the month once the payment is confirmed, usually within the hour.' : '';
  $('delete').addEventListener('click', () => {
    const text = $('confirm-text');
    text.textContent = '';
    if (data.address) {
      const name = document.createElement('strong');
      name.className = 'nowrap'; name.textContent = data.address;
      text.append('This deletes your Closedhand account. ', name, ' stops working and closedhand.com forgets your ' + (data.anonymous ? 'account number' : 'sign-in') + '. Nobody can take the name for six months, and nothing links it to you. Closedhand keeps everything on your computer; to delete that too, use Delete account in My Account on its dashboard.');
    } else text.textContent = 'This deletes your Closedhand account, and closedhand.com forgets your ' + (data.anonymous ? 'account number' : 'sign-in') + '.';
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
