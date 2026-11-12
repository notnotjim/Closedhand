// Confirming a Closedhand assistant's email address. The Closedhand that
// asked opened this page with a signed ticket after the #; the owner signs in
// with Google or a personal Microsoft account, then confirms. That account
// proves the address is theirs and is where the assistant writes when it
// emails them first, so only an address the provider has verified counts.
// An account made with an account number signs in with the number instead
// and has no email: the assistant answers mail sent to it, never writing
// first. The owner may email the assistant from any Google or Microsoft
// account connected to their Closedhand.
(() => {
  const $ = id => document.getElementById(id);
  const ticket = location.hash.slice(1);
  const here = '/assistant-email/confirm' + location.hash;
  const status = $('status');
  // The assistant's name travels in the signed link from its Closedhand.
  let name = '';
  try { name = String(JSON.parse(atob(ticket.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).name || '').slice(0, 60); } catch (_) {}
  if (name) {
    const whose = name + '’s';
    $('heading').textContent = 'Set up ' + whose + ' email address';
    $('lede').textContent = 'Email, forward or CC ' + name + ' into any conversation.';
    $('who-label').textContent = 'When ' + name + ' emails you first, it writes to';
    $('approve').textContent = 'Create ' + whose + ' email address';
    $('address-note').textContent = whose + ' email address';
  }
  $('login-google').href = '/auth/google?return_to=' + encodeURIComponent(here);
  $('login-microsoft').href = '/auth/microsoft?return_to=' + encodeURIComponent(here);
  async function request(path, body) {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not confirm this address. Please try again.');
    return data;
  }
  if (!ticket) { status.textContent = 'Turn on Closedhand’s email address in its Settings first.'; return; }
  // Signed in with a provider that has no Closedhand account (none=…):
  // nothing is made for it.
  const none = new URLSearchParams(location.search).get('none');
  if (none === 'google' || none === 'microsoft') {
    $('none-note').textContent = 'No Closedhand account uses this ' + (none === 'microsoft' ? 'Microsoft' : 'Google') + ' sign-in. Sign in with the account you set Closedhand up with.';
    $('none-note').hidden = false;
  }
  request('/api/account').then(account => {
    // Signed in, but with an address the provider has not vouched for here:
    // an older sign-in, or a work account. Sign in again, or with another.
    if (account.signedIn && !account.emailVerified && !account.anonymous) {
      $('signin-heading').textContent = 'Sign in again to confirm it';
      $('signin-note').textContent = account.provider === 'microsoft' ? 'Use Google or a personal Microsoft account.' : 'So Google can confirm the address is yours.';
    }
    if (!account.signedIn || !(account.emailVerified || account.anonymous)) {
      $('signin').hidden = false;
      status.textContent = '';
      return;
    }
    $('who').textContent = account.anonymous ? 'Signed in with your account number' : account.email || '';
    if (account.anonymous) $('who-label').textContent = (name || 'Closedhand') + ' can answer email you send, but can’t email you first: your Closedhand account has no email.';
    $('switch').href = '/auth/' + (account.provider === 'microsoft' ? 'microsoft' : 'google') + '?return_to=' + encodeURIComponent(here);
    $('confirm').hidden = false;
    status.textContent = '';
  }).catch(e => { status.textContent = e.message; });
  $('approve').onclick = async () => {
    $('approve').disabled = true;
    status.textContent = 'Confirming…';
    try {
      const data = await request('/api/assistant-mail-relay/approve', { ticket });
      $('heading').textContent = 'Email address confirmed';
      $('lede').hidden = true;
      $('address').textContent = data.address;
      $('address').hidden = $('address-note').hidden = false;
      $('confirm').hidden = true;
      $('done-note').textContent = (data.email ? 'When ' + (name || 'Closedhand') + ' emails you first, the email goes to ' + data.email + '.' : 'Email ' + (name || 'Closedhand') + ' from any account connected to your Closedhand.') + ' You can close this tab: your Closedhand updates by itself.';
      $('done').hidden = false;
      status.textContent = '';
    } catch (e) {
      status.textContent = e.message;
      $('approve').disabled = false;
    }
  };
})();
