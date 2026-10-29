// Polar's own form, to pay for Closedhand+ or change its card, over the
// whole window: a frame of Polar's page and nothing of Polar's code in
// Closedhand's, so the browser keeps it from seeing anything here. The web
// chat shows it for the dashboard (whose frame is too small for it), and the
// dashboard itself only when it is open on its own. Polar says when the form
// may close, is paying (no closing then) and is done, in the messages its own
// embed reads (POLAR_CHECKOUT, POLAR_PAYMENT_METHOD), heard only from Polar's
// addresses and from this frame. done("success") when it is done, else done(null).
(function () {
  var POLAR = ['https://polar.sh', 'https://sandbox.polar.sh'];
  window.showPolarForm = function (src, type, done) {
    var frame = document.createElement('iframe');
    frame.className = 'polar-frame';
    frame.title = 'Polar';
    frame.allow = "payment 'self' " + POLAR.join(' ') + "; publickey-credentials-get 'self' " + POLAR.join(' ');
    frame.src = src;
    var closable = true;
    function close(result) {
      window.removeEventListener('message', listen);
      frame.remove();
      document.body.classList.remove('polar-open');
      done(result);
    }
    function listen(e) {
      if (e.source !== frame.contentWindow || POLAR.indexOf(e.origin) === -1 || !e.data || e.data.type !== type) return;
      if (e.data.event === 'close' && closable) close(null);
      else if (e.data.event === 'confirmed') closable = false;
      else if (e.data.event === 'error') closable = true;
      else if (e.data.event === 'success') close('success');
    }
    window.addEventListener('message', listen);
    document.body.classList.add('polar-open');
    document.body.appendChild(frame);
  };
})();
