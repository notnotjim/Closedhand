// The header's sign-in, the same on every page: "Sign in" until this browser
// knows someone's Closedhand, then "Open dashboard" (straight to their
// personal URL). While someone is signed in, the account menu last in the
// header says who, by the email they signed in with (an account number has
// none), with My Account and Sign out, as the dashboard's account menu does.
// An address this browser keeps with nobody signed in offers "Sign in"
// beside it instead, so the header never shows a sign-in that isn't there.
// Sign out signs out of the Closedhand account here and forgets the address
// this browser keeps, so every page shows what everyone sees; the account
// keeps its personal URL, and signing in again brings it back.
(function () {
  var KNOWN = 'closedhand-personal-url';
  var personal = /^https:\/\/[a-z][a-z0-9-]{1,30}[a-z0-9]\.closedhand\.ai$/;
  var link = document.querySelector('a.nav-cta[data-account]');
  if (!link) return;
  var opens = false;
  var PERSON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5"/></svg>';
  function accountMenu(email) {
    if (document.getElementById('navAccount')) return;
    var menu = document.createElement('details');
    menu.className = 'nav-account'; menu.id = 'navAccount';
    var summary = document.createElement('summary');
    summary.setAttribute('aria-label', 'Your account'); summary.title = 'Your account';
    summary.innerHTML = PERSON;
    var list = document.createElement('div');
    list.className = 'nav-account-menu';
    if (email) {
      var who = document.createElement('p');
      who.className = 'nav-account-who'; who.textContent = email;
      list.append(who);
    }
    var mine = document.createElement('a');
    mine.href = '/account'; mine.textContent = 'My Account';
    var form = document.createElement('form');
    form.method = 'post'; form.action = '/logout';
    var button = document.createElement('button');
    button.type = 'submit'; button.textContent = 'Sign out';
    form.append(button);
    form.addEventListener('submit', function () {
      try { localStorage.removeItem(KNOWN); } catch (e) { /* nothing kept */ }
    });
    list.append(mine, form);
    menu.append(summary, list);
    link.parentNode.append(menu);
    document.addEventListener('click', function (e) { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  }
  function signIn() {
    if (document.getElementById('navSignIn')) return;
    var a = document.createElement('a');
    a.href = '/account'; a.id = 'navSignIn'; a.className = 'nav-in'; a.textContent = 'Sign in';
    link.after(a);
  }
  // Their Closedhand is known: the header opens its dashboard.
  function known(url) {
    if (!personal.test(url || '')) return;
    opens = true;
    link.href = url + '/dashboard';
    link.textContent = 'Open dashboard';
    link.removeAttribute('aria-current');
    link.hidden = false;
  }
  try { known(localStorage.getItem(KNOWN)); } catch (e) { /* not kept in this browser */ }
  fetch('/api/account', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (a) {
      if (a && a.signedIn) {
        known(a.url);
        // Signed in, with no personal URL to open yet: only the account menu.
        if (!opens) link.hidden = true;
        accountMenu(a.email);
      } else if (a && opens) signIn();
    })
    .catch(function () {});
})();
