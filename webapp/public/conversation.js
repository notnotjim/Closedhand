// Talking with Closedhand on a phone: one tap starts a conversation and one
// ends it, with no tap for each turn. The microphone stays open; a turn ends
// when the person has stopped talking for a moment, and is written out by
// Closedhand's own speech to text on the computer running it, as dictation
// is (/dictation.js). The reply is spoken as it is written
// (speech-playback.js talk), and talking over it stops it and starts the
// next turn. The fist on the phone's home and the mic in a conversation are
// bound to the same conversation, so it carries on when the chat view opens.
(function (root) {
  'use strict';
  var TURN_END_MS = 800;      // quiet after speech that ends a turn
  var START_MS = 120;         // voice needed to begin a turn
  var BARGE_MS = 250;         // voice needed to talk over a reply
  var MIN_VOICED_MS = 300;    // a turn with less voice than this was a noise
  var PRE_MS = 300;           // kept from just before the voice began
  var MAX_TURN_MS = 60000;
  var QUIET_HINT_MS = 4000;   // listening and nothing said: how to end
  var QUIET_END_MS = 30000;   // listening and nothing said: it ends itself
  var HEARD = 0.004;          // as dictation: below this nothing reached the mic

  function rms(chunk) {
    var sum = 0;
    for (var i = 0; i < chunk.length; i += 4) sum += chunk[i] * chunk[i];
    return Math.sqrt(sum / Math.max(1, chunk.length / 4));
  }

  // opts: words(text) sends what was said; interrupt() stops the reply being
  // spoken; prime() readies sound inside the tap that starts; onEnd() when the
  // conversation ends. Returns { bind, start, end, replyStarted, replyDone, state }.
  function create(opts) {
    var Context = root.AudioContext || root.webkitAudioContext;
    var media = root.navigator && root.navigator.mediaDevices;
    var bound = [];
    var state = 'off', mic = null, wake = null, quietHinted = false, heard = false;
    var vad = null;

    function show(text) {
      bound.forEach(function (b) {
        if (!b.note) return;
        var shown = text || (state === 'off' && b.hints ? b.hints.idle : '');
        b.note.textContent = shown;
        b.note.hidden = !shown;
      });
    }
    function hintFor(s) {
      var h = (bound[0] && bound[0].hints) || {};
      return s === 'listening' ? h.listening : s === 'thinking' ? h.thinking : s === 'speaking' ? h.speaking : '';
    }
    function set(next) {
      state = next;
      quietHinted = false;
      bound.forEach(function (b) {
        b.button.classList.toggle('recording', next === 'listening');
        b.button.classList.toggle('busy', next === 'thinking');
        b.button.classList.toggle('speaking', next === 'speaking');
        b.button.setAttribute('aria-pressed', next === 'off' ? 'false' : 'true');
        var label = next === 'off' ? b.labels.idle : b.labels.on;
        b.button.title = label;
        b.button.setAttribute('aria-label', label);
        if (b.onState) b.onState(next);
        if (b.onLevel && next !== 'listening') b.onLevel(0);
      });
      show(hintFor(next));
    }
    function level(value) { bound.forEach(function (b) { if (b.onLevel) b.onLevel(value); }); }

    function fresh() { return { floor: 0.003, inTurn: false, pending: 0, voiced: 0, quiet: 0, total: 0, idle: 0, parts: [], pre: [], preMs: 0 }; }

    // One chunk of microphone sound: is someone talking, has a turn begun or
    // ended, has the person talked over the reply.
    function hear(chunk, rate) {
      if (state === 'off') return;
      var ms = chunk.length / rate * 1000, r = rms(chunk);
      var speaking = state === 'speaking';
      // Over the reply only a clearly louder voice counts: the echo
      // cancelled microphone still hears a little of the speaker.
      var loud = r > Math.max(vad.floor * (speaking ? 4 : 2.5), speaking ? 0.02 : 0.01);
      if (!vad.inTurn) {
        vad.pre.push(chunk); vad.preMs += ms;
        while (vad.pre.length > 1 && vad.preMs - vad.pre[0].length / rate * 1000 >= PRE_MS) { vad.preMs -= vad.pre[0].length / rate * 1000; vad.pre.shift(); }
        if (loud) {
          vad.pending += ms;
          if (vad.pending >= (speaking ? BARGE_MS : START_MS)) {
            vad.inTurn = true;
            vad.parts = vad.pre.slice(); vad.voiced = vad.pending; vad.quiet = 0; vad.total = vad.preMs;
            vad.pre = []; vad.preMs = 0; vad.idle = 0;
            if (speaking) { opts.interrupt(); set('listening'); }
            else if (state === 'listening' && quietHinted) show(hintFor('listening'));
          }
        } else {
          vad.pending = 0;
          if (!speaking) vad.floor = vad.floor * 0.9 + r * 0.1;
          if (state === 'listening') {
            vad.idle += ms;
            if (!quietHinted && vad.idle >= QUIET_HINT_MS) { quietHinted = true; show((bound[0] && bound[0].hints && bound[0].hints.quiet) || ''); }
            if (vad.idle >= QUIET_END_MS) { end(); return; }
          }
        }
        if (state === 'listening') level(0);
        return;
      }
      vad.parts.push(chunk); vad.total += ms;
      if (loud) { vad.voiced += ms; vad.quiet = 0; } else vad.quiet += ms;
      level(Math.min(1, r * 8));
      if (vad.quiet >= TURN_END_MS || vad.total >= MAX_TURN_MS) {
        var parts = vad.parts, voiced = vad.voiced;
        vad.inTurn = false; vad.parts = []; vad.pending = 0; vad.idle = 0;
        level(0);
        if (voiced >= MIN_VOICED_MS) send(parts, rate);
      }
    }

    // A finished turn, written out and sent.
    function send(parts, rate) {
      var peak = 0, length = 0;
      parts.forEach(function (p) { length += p.length; for (var i = 0; i < p.length; i++) { var v = p[i] < 0 ? -p[i] : p[i]; if (v > peak) peak = v; } });
      if (peak < HEARD) return;
      var all = new Float32Array(length), at = 0;
      parts.forEach(function (p) { all.set(p, at); at += p.length; });
      var D = root.ClosedhandDictation;
      var before = state;
      if (state === 'listening') set('thinking');
      root.fetch('/api/dictation', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: D.encodeWav(D.downsample(all, rate)) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ''); return j; }); })
        .then(function (j) {
          var words = String(j.text || '').trim();
          if (state === 'off') return;
          if (!words) { if (state === 'thinking' && before === 'listening') set('listening'); return; }
          heard = true;
          opts.words(words);
          if (state === 'listening') set('thinking');
        })
        .catch(function () { if (state === 'thinking' && before === 'listening') set('listening'); });
    }

    function start() {
      if (state !== 'off' || !Context || !media || !media.getUserMedia) return;
      // Inside the tap: sound for the replies, the voice and speech to text
      // loading while the person starts talking, and the screen kept on.
      if (opts.prime) opts.prime();
      root.fetch('/api/dictation/warm?voice=1', { method: 'POST' }).catch(function () {});
      try { if (root.navigator && 'audioSession' in root.navigator) root.navigator.audioSession.type = 'play-and-record'; } catch (_) {}
      try { if (root.navigator && root.navigator.wakeLock) root.navigator.wakeLock.request('screen').then(function (w) { if (state === 'off') w.release(); else wake = w; }).catch(function () {}); } catch (_) {}
      var context = new Context();
      vad = fresh();
      set('listening');
      media.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
        if (state === 'off') { stream.getTracks().forEach(function (t) { t.stop(); }); context.close(); return; }
        var source = context.createMediaStreamSource(stream);
        var processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = function (e) { hear(new Float32Array(e.inputBuffer.getChannelData(0)), context.sampleRate); };
        source.connect(processor);
        processor.connect(context.destination);
        if (context.state === 'suspended') context.resume();
        mic = { context: context, stream: stream, source: source, processor: processor };
      }).catch(function () {
        context.close();
        end();
        show("Closedhand can't hear you yet. Allow the microphone for this page, then tap again.");
      });
    }

    function end() {
      if (state === 'off') return;
      var m = mic;
      mic = null;
      if (m) {
        m.processor.onaudioprocess = null;
        m.processor.disconnect();
        m.source.disconnect();
        m.stream.getTracks().forEach(function (t) { t.stop(); });
        m.context.close();
      }
      if (wake) { try { wake.release(); } catch (_) {} wake = null; }
      try { if (root.navigator && 'audioSession' in root.navigator) root.navigator.audioSession.type = 'auto'; } catch (_) {}
      set('off');
      if (opts.onEnd) opts.onEnd();
      // Safari on an iPhone asks for the microphone each time unless allowed
      // for the site: said once, after a conversation that worked.
      if (heard && root.ClosedhandDictation && root.ClosedhandDictation.allowTip) root.ClosedhandDictation.allowTip(function (message) { show(message); });
      heard = false;
    }

    // Each button that starts and ends it. b: { button, note, labels { idle,
    // on }, hints { idle, listening, thinking, speaking, quiet }, onLevel,
    // onState, when() } where when says whether this button talks right now.
    function bind(button, note, b) {
      b = b || {};
      var entry = { button: button, note: note, labels: b.labels || { idle: button.getAttribute('aria-label') || '', on: '' }, hints: b.hints || null, onLevel: b.onLevel, onState: b.onState };
      bound.push(entry);
      button.addEventListener('click', function () {
        if (b.when && !b.when()) return;
        if (state === 'off') start(); else end();
      });
      set(state);
      return true;
    }

    if (root.document) root.document.addEventListener('visibilitychange', function () { if (root.document.hidden) end(); });

    return {
      bind: bind, start: start, end: end,
      // The reply is being heard: the first of it is playing.
      replyStarted: function () { if (state === 'thinking' || state === 'listening') set('speaking'); },
      // The reply has been said in full, or there was nothing to say.
      replyDone: function () { if (state === 'speaking' || state === 'thinking') { set('listening'); if (vad) vad.idle = 0; } },
      state: function () { return state; },
      _hear: hear,
    };
  }

  var api = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClosedhandConversation = api;
})(typeof window !== 'undefined' ? window : this);
