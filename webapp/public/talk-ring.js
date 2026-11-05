// The ring round the fist while talking (conversation.js), drawn live. At
// rest the filmed smoke ring shows and nothing is drawn. Listening, the ring
// becomes the voice: thin strands of light, each bent by the bands of the
// sound, so it swells and ripples as the person speaks and settles as they
// pause. While what was said is written out and answered it gathers in, and
// a light runs round it. Speaking, it moves with Closedhand's voice. Each
// state is a handful of shape numbers the drawing eases toward from wherever
// it is, so one state flows into the next and a tap mid-change just turns it.
// The same ring, smaller, sits in the mic once the chat is open.
(function (root) {
  'use strict';
  // r: radius as a share of half the box (the film's ring is about 0.9);
  // wob: drift; voice: how much the sound bends it; gather: the light
  // running round; spin: how fast it runs (turns a second).
  var LOOKS = {
    off: { show: 0, r: 0.9, wob: 0.012, voice: 0, gather: 0, spin: 0.02 },
    listening: { show: 1, r: 0.8, wob: 0.018, voice: 1, gather: 0, spin: 0.035 },
    thinking: { show: 1, r: 0.6, wob: 0.007, voice: 0, gather: 1, spin: 0.32 },
    speaking: { show: 1, r: 0.76, wob: 0.014, voice: 0.85, gather: 0, spin: 0.05 },
    settle: { show: 0, r: 0.98, wob: 0.01, voice: 0, gather: 0, spin: 0.03 },
  };
  var KEYS = ['show', 'r', 'wob', 'voice', 'gather', 'spin'];
  // Frequency bins (of 128, about 190 Hz each at 48 kHz) for eight bands
  // across a speaking voice, low to high.
  var EDGES = [1, 2, 3, 4, 6, 8, 11, 15, 22];
  var TAU = 2 * Math.PI;

  function mount(host, opts) {
    opts = opts || {};
    var doc = host.ownerDocument, win = doc.defaultView;
    var canvas = doc.createElement('canvas');
    canvas.className = 'talk-ring';
    canvas.setAttribute('aria-hidden', 'true');
    host.insertBefore(canvas, opts.before || host.firstChild);
    var ctx = canvas.getContext('2d');
    var strands = opts.strands || 7, points = opts.points || 120;
    var still = win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)');
    var cur = {}, want = LOOKS.off, state = 'off';
    KEYS.forEach(function (k) { cur[k] = LOOKS.off[k]; });
    var bands = new Float32Array(EDGES.length - 1), level = 0, turn = 0, drift = 0;
    var data = null, raf = 0, nap = 0, last = 0, paint = null;

    function colours() {
      var css = win.getComputedStyle(doc.documentElement);
      var rgb = function (name, fallback) { return (css.getPropertyValue(name) || fallback).trim(); };
      var light = doc.documentElement.getAttribute('data-theme') === 'light';
      paint = { light: light, line: rgb(light ? '--accent-rgb' : '--accent-soft-rgb', '216,98,75'), hot: rgb(light ? '--accent-live-rgb' : '--accent-warm-rgb', '227,179,148') };
    }
    doc.documentElement.addEventListener('themechange', function () { paint = null; });

    function set(next) {
      if (!LOOKS[next]) next = 'off';
      // Starting: the strands come out of the film's ring, a touch wide,
      // and draw in to listen.
      if (next !== 'off' && next !== 'settle' && cur.show < 0.05) cur.r = 0.95;
      state = next;
      want = LOOKS[next];
      wake();
    }
    function wake() {
      win.clearTimeout(nap); nap = 0;
      if (!raf) { last = 0; raf = win.requestAnimationFrame(frame); }
    }
    function visible() { return host.isConnected && host.getClientRects().length > 0 && !doc.hidden; }

    function frame(now) {
      raf = 0;
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      if (!visible()) {
        // Off screen (the chat view, another tab): nothing to draw. Snap to
        // where it is going and look again in a moment.
        KEYS.forEach(function (k) { cur[k] = want[k]; });
        if (want.show > 0) nap = win.setTimeout(wake, 400);
        else ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      ease(dt);
      listen(dt);
      draw(dt);
      if (cur.show < 0.004 && want.show === 0) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
      raf = win.requestAnimationFrame(frame);
    }

    function ease(dt) {
      // About 0.45 s to arrive; showing a little quicker than hiding.
      KEYS.forEach(function (k) {
        var tau = k === 'show' ? (want.show > cur.show ? 0.12 : 0.18) : k === 'spin' ? 0.3 : 0.15;
        cur[k] += (want[k] - cur[k]) * (1 - Math.exp(-dt / tau));
      });
    }

    // The sound this state follows, as eight bands and one level, quick to
    // rise and slower to fall, so the ring follows a voice without jitter.
    function listen(dt) {
      var analyser = opts.sound ? opts.sound(state) : null;
      if (analyser && analyser.frequencyBinCount) {
        if (!data || data.length !== analyser.frequencyBinCount) data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
      }
      var up = 1 - Math.exp(-dt / 0.05), down = 1 - Math.exp(-dt / 0.22), sum = 0;
      for (var b = 0; b < bands.length; b++) {
        var v = 0;
        if (analyser && data) {
          for (var i = EDGES[b]; i < EDGES[b + 1]; i++) v += data[i];
          v = v / (EDGES[b + 1] - EDGES[b]) / 255;
          // The room's own hum sits low on this scale: only a voice counts.
          v = Math.max(0, Math.min(1, (v - 0.32) / 0.5));
        }
        bands[b] += (v - bands[b]) * (v > bands[b] ? up : down);
        sum += bands[b] * (b < 5 ? 1.2 : 0.7);
      }
      level = Math.min(1, sum / 6.5);
      low = (bands[0] + bands[1] + bands[2]) / 3;
    }

    // The low of the voice swells the ring and leans it gently; its higher
    // bands ripple all the way round, each strand a little out of step with
    // the next, so the ring reads as one ribbon of smoke carrying the sound.
    var low = 0;
    function radius(theta, s, R) {
      var calm = still && still.matches;
      var w = calm ? 0 : cur.wob * (Math.sin(3 * theta + drift * 0.6 + s * 1.3) + 0.6 * Math.sin(5 * theta - drift * 0.8 + s * 0.7) + 0.35 * Math.sin(2 * theta + drift * 0.35 + s * 2.1));
      var v = 0;
      if (cur.voice > 0.01 && !calm) {
        v = 0.045 * low * Math.sin(2 * theta + drift * 0.7 + s * 0.3);
        for (var b = 2; b < bands.length; b++) v += bands[b] * 0.05 / (1 + b * 0.1) * Math.sin((b + 4) * theta + drift * (2.2 + 0.3 * b) * (b % 2 ? 1 : -1) + s * 0.9 + b);
        v *= cur.voice;
      }
      // Waiting for the voice, the ring breathes slowly.
      var breath = calm ? 0 : cur.voice * (1 - level) * 0.014 * Math.sin(drift * 1.6);
      return R * (1 + w + v + breath + cur.voice * (low * 0.09 + level * 0.04));
    }

    function trace(s, R, from, span, step) {
      ctx.beginPath();
      for (var a = 0; a <= span + 1e-6; a += step) {
        var theta = from + a, r = radius(theta, s, R);
        var x = canvas.width / 2 + Math.cos(theta) * r, y = canvas.height / 2 + Math.sin(theta) * r;
        if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }

    function draw(dt) {
      var calm = still && still.matches;
      var dpr = Math.min(2, win.devicePixelRatio || 1);
      var size = Math.round(host.clientWidth * dpr);
      if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
      if (!paint) colours();
      if (!calm) { drift += dt; turn += dt * cur.spin * TAU; }
      ctx.clearRect(0, 0, size, size);
      if (cur.show < 0.004) return;
      ctx.globalCompositeOperation = paint.light ? 'source-over' : 'lighter';
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      var half = size / 2, step = TAU / points;
      var lift = 1 + level * 0.8;
      for (var s = 0; s < strands; s++) {
        var spread = (s - (strands - 1) / 2) / strands;
        var R = half * cur.r * (1 + spread * (0.06 + cur.voice * level * 0.05) * (1 - cur.gather * 0.6));
        // Without motion, thinking is the ring held brighter, not a light running round.
        var a = cur.show * (paint.light ? 0.2 : 0.13) * (opts.small ? 2.2 : 1) * (1 - Math.abs(spread) * 0.8) * (calm ? 1 + cur.gather * 0.8 : 1 - cur.gather * 0.45);
        // A soft wide pass, then the thin line: a glow without a blur filter.
        trace(s, R, 0, TAU, step);
        ctx.strokeStyle = 'rgba(' + paint.line + ',' + (a * 0.28 * lift).toFixed(3) + ')';
        ctx.lineWidth = 5 * dpr * (opts.small ? 0.5 : 1);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(' + paint.line + ',' + Math.min(1, a * lift).toFixed(3) + ')';
        ctx.lineWidth = (opts.small ? 0.9 : 1.3) * dpr;
        ctx.stroke();
        // Thinking: a light runs round on the strands, its tail fading.
        if (cur.gather > 0.02 && !calm) {
          var tails = [[0.3, 0.9], [0.75, 0.42], [1.4, 0.16]];
          for (var c = 0; c < 2; c++) {
            var head = turn + c * Math.PI + s * 0.05, strength = c ? 0.4 : 1;
            for (var t = 0; t < tails.length; t++) {
              var glow = cur.gather * cur.show * tails[t][1] * strength * (1 - Math.abs(spread));
              trace(s, R, head - tails[t][0], tails[t][0], step / 2);
              ctx.strokeStyle = 'rgba(' + paint.hot + ',' + (glow * 0.22).toFixed(3) + ')';
              ctx.lineWidth = (opts.small ? 3 : 7) * dpr;
              ctx.stroke();
              ctx.strokeStyle = 'rgba(' + paint.hot + ',' + (glow * 0.7).toFixed(3) + ')';
              ctx.lineWidth = (opts.small ? 1 : 1.5) * dpr;
              ctx.stroke();
            }
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    return { set: set, state: function () { return state; } };
  }

  var api = { mount: mount, LOOKS: LOOKS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClosedhandTalkRing = api;
})(typeof window !== 'undefined' ? window : this);
