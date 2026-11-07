// What a form still needs, said at the field: it takes focus with a small
// nudge, and a note under it, pointing up at it, says what it wants (.field-
// needs in interface.css). Typing in it, or choosing, takes the note away.
// Every form of the app uses this one piece, and closedhand.com keeps the
// same copy (closedhand-com/public/needs-field.js). A message at the foot of
// a form or in a toast sent people hunting for what it meant, and a button
// that did nothing left them guessing.
(function () {
  function needsField(field, text, focus) {
    if (!field) return;
    var note = field.nextElementSibling && field.nextElementSibling.classList.contains('field-needs') ? field.nextElementSibling : null;
    if (!note) {
      note = document.createElement('p'); note.className = 'field-needs'; note.setAttribute('role', 'alert');
      field.insertAdjacentElement('afterend', note);
      var gone = function () { note.remove(); field.removeEventListener('input', gone); field.removeEventListener('change', gone); };
      field.addEventListener('input', gone); field.addEventListener('change', gone);
    }
    note.textContent = text;
    field.classList.remove('needs-nudge'); void field.offsetWidth; field.classList.add('needs-nudge');
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // A row (a box and its button) takes the note under it, and its box, or
    // the one named, takes focus.
    var target = focus || (field.matches('input, select, textarea, button, [tabindex]') ? field : field.querySelector('input, select, textarea') || field);
    target.focus({ preventScroll: true });
  }
  function clearNeeds(root) { [].forEach.call((root || document).querySelectorAll('.field-needs'), function (n) { n.remove(); }); }
  window.needsField = needsField;
  window.clearNeeds = clearNeeds;
})();
