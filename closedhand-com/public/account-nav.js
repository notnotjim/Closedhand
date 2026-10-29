// The header's sign-in, the same on every page: "Sign in" until this browser
// knows someone's Closedhand, then "Open dashboard" (straight to their
// personal URL) and "Sign out". Sign out signs out of the Closedhand account
// here and forgets the address this browser keeps, so every page shows what
// everyone sees; the account keeps its personal URL, and signing in again
// brings it back.
(function () {
  var KNOWN = 'closedhand-personal-url';
  var personal = /^https:\/\/[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/;
  var link = document.querySelector('a.nav-cta[data-account]');
  if (!link) return;
  var opens = false;
  function signOut() {
    if (document.getElementById('navSignOut')) return;
    var form = document.createElement('form');
    form.method = 'post'; form.action = '/logout'; form.className = 'nav-out'; form.id = 'navSignOut';
    var button = document.createElement('button');
    button.type = 'submit'; button.textContent = 'Sign out';
    form.append(button);
    form.addEventListener('submit', function () {
      try { localStorage.removeItem(KNOWN); } catch (e) { /* nothing kept */ }
    });
    link.after(form);
  }
  // Their Closedhand is known: the header opens its dashboard.
  function known(url) {
    if (!personal.test(url || '')) return;
    opens = true;
    link.href = url + '/dashboard';
    link.textContent = 'Open dashboard';
    link.removeAttribute('aria-current');
    link.hidden = false;
    signOut();
  }
  try { known(localStorage.getItem(KNOWN)); } catch (e) { /* not kept in this browser */ }
  fetch('/api/account', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (a) {
      if (!a || !a.signedIn) return;
      known(a.url);
      // Signed in, with no personal URL to open yet: only the way out.
      if (!opens) { link.hidden = true; signOut(); }
    })
    .catch(function () {});
})();
