(function () {
  'use strict';
  var context = null;
  var current = null;
  var sequence = 0;
  var speaker = '<svg width="1rem" height="1rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>';
  var stopIcon = '<svg width="1rem" height="1rem" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

  function reset(item, message) {
    if (!item) return;
    item.button.innerHTML = speaker;
    item.button.title = 'Read aloud';
    item.button.setAttribute('aria-label', 'Read aloud');
    item.button.setAttribute('aria-pressed', 'false');
    item.status.textContent = message || '';
    item.button.classList.remove('done');
  }
  function stop(message) {
    var item = current;
    if (!item) return;
    current = null;
    clearTimeout(item.timer);
    item.send({ type: 'speech_cancel', id: item.id });
    item.nodes.forEach(function (node) { try { node.stop(); } catch (_) {} });
    reset(item, message);
  }
  function deadline(item) {
    clearTimeout(item.timer);
    item.timer = setTimeout(function () {
      if (current === item) stop('Reading aloud took too long. Try again.');
    }, 130000);
  }
  function complete(item) {
    if (current === item && item.finished && item.nodes.size === 0 && item.decoding === 0) {
      current = null;
      clearTimeout(item.timer);
      reset(item);
    }
  }
  // On an iPhone, page audio is "ambient" unless told otherwise, and the
  // silent switch mutes ambient sound: Read aloud played to nobody on a phone
  // set to silent. As playback, it plays like a video does.
  function asPlayback() {
    try { if ("audioSession" in navigator) navigator.audioSession.type = "playback"; } catch (_) {}
  }
  function addControl(tools, text, send) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'msg-tool';
    var status = document.createElement('span');
    status.className = 'voice-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    var control = { button: button, status: status };
    reset(control);
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      if (current && current.button === button) { stop(); return; }
      stop();
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) { status.textContent = 'This browser cannot play the voice.'; return; }
      try {
        // Resume during the tap, so delayed audio also works on mobile browsers.
        asPlayback();
        context = context || new AudioContext();
        var resumed = context.resume();
        var item = { button: button, status: status, send: send, id: 'voice-' + (++sequence),
          nodes: new Set(), next: 0, finished: false, decoding: 0, chain: Promise.resolve() };
        current = item;
        button.innerHTML = stopIcon;
        button.title = 'Stop reading';
        button.setAttribute('aria-label', 'Stop reading');
        button.setAttribute('aria-pressed', 'true');
        button.classList.add('done');
        status.textContent = 'Preparing voice…';
        resumed.catch(function () { if (current === item) stop('Couldn’t play audio. Tap to try again.'); });
        if (!send({ type: 'speech', id: item.id, text: text })) {
          stop('Connecting. Try again in a moment.');
          return;
        }
        deadline(item);
      } catch (_) { stop('Couldn’t start audio. Tap to try again.'); }
    });
    tools.appendChild(button);
    tools.appendChild(status);
    return button;
  }
  // Inside a tap: makes the sound ready, so a reply that arrives later can be
  // read aloud without a tap of its own (phones only start sound from one).
  // recording: in a conversation, where the microphone stays open while it
  // speaks (conversation.js sets that kind of audio session itself).
  function prime(recording) {
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!recording) asPlayback();
    try { context = context || new AudioContext(); context.resume().catch(function () {}); } catch (_) {}
  }

  // A reply in a conversation, spoken as it is written: each sentence goes to
  // the voice as soon as it is complete, the next once the voice has finished
  // making the one before (it makes one at a time), and all of it plays on one
  // timeline. events: onStart when the first sound plays, onDone when the
  // whole reply has been said. add(text) as it streams, end() when it is all
  // written, stop() to cut it short.
  var talking = null;
  function talk(send, events) {
    if (talking) talking.stop();
    var t = { id: 'talk-' + (++sequence), part: 0, waiting: null, queue: [], text: '', ended: false, stopped: false, started: false,
      nodes: new Set(), next: 0, decoding: 0, chain: Promise.resolve() };
    talking = t;
    function finished() {
      if (t.stopped || !t.ended || t.waiting || t.queue.length || t.text.trim() || t.nodes.size || t.decoding) return;
      t.stopped = true;
      if (talking === t) talking = null;
      if (events.onDone) events.onDone();
    }
    function pump() {
      if (t.stopped || t.waiting || !t.queue.length) return finished();
      var id = t.id + '-' + (++t.part);
      t.waiting = id;
      if (!send({ type: 'speech', id: id, text: t.queue.shift() })) { t.waiting = null; pump(); }
    }
    // Complete sentences out of what has been written so far; with end, the rest too.
    function cut(all) {
      var clean = t.text.replace(/^[ \t]*\[\[next\]\][ \t]*$/gm, ' ');
      var at = all ? clean.length : -1;
      if (!all) {
        var re = /[.!?…:;](?:["'”’)\]]*)(?=\s)|\n\s*\n/g, m;
        while ((m = re.exec(clean))) at = m.index + m[0].length;
        // The first words go at their first comma: a short clause is ready to
        // hear well before a whole sentence would be.
        if (at < 0 && t.part === 0 && !t.queue.length) { var first = clean.search(/,\s/); if (first >= 20) at = first + 1; }
        // A long run with no sentence end yet goes at its last comma.
        if (at < 0 && clean.length > 220) { var comma = clean.lastIndexOf(', '); if (comma > 60) at = comma + 1; }
      }
      if (at <= 0) return;
      var said = clean.slice(0, at).trim();
      t.text = clean.slice(at);
      if (/[\p{L}\p{N}]/u.test(said)) t.queue.push(said);
      pump();
    }
    t.add = function (text) { if (t.stopped) return; t.text += String(text || ''); if (!/\[\[[a-z]*\]?$/.test(t.text)) cut(false); };
    t.end = function () { if (t.stopped) return; t.ended = true; cut(true); finished(); };
    t.stop = function () {
      if (t.stopped) return;
      t.stopped = true;
      if (t.waiting) send({ type: 'speech_cancel', id: t.waiting });
      t.queue = [];
      t.nodes.forEach(function (node) { try { node.stop(); } catch (_) {} });
      if (talking === t) talking = null;
    };
    t.receive = function (message) {
      if (t.stopped || message.id !== t.waiting) return;
      if (message.type === 'speech_end' || message.type === 'speech_error') { t.waiting = null; pump(); return; }
      if (!context) return;
      t.decoding++;
      t.chain = t.chain.then(async function () {
        if (t.stopped) return;
        var bytes = Uint8Array.from(atob(message.audio), function (c) { return c.charCodeAt(0); });
        var buffer = await context.decodeAudioData(bytes.buffer);
        if (t.stopped) return;
        var source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        t.nodes.add(source);
        source.onended = function () { source.disconnect(); t.nodes.delete(source); finished(); };
        var start = Math.max(context.currentTime + 0.03, t.next);
        source.start(start);
        t.next = start + buffer.duration;
        if (!t.started) { t.started = true; if (events.onStart) events.onStart(); }
      }).catch(function () {}).finally(function () { t.decoding--; finished(); });
    };
    return t;
  }

  function receive(message) {
    if (!/^speech_(chunk|end|error)$/.test(message.type || '')) return false;
    if (talking && /^talk-/.test(message.id || '')) { talking.receive(message); return true; }
    var item = current;
    if (!item || item.id !== message.id) return true;
    if (message.type === 'speech_error') { stop(message.message || 'Couldn’t read this reply aloud. Try again.'); return true; }
    if (message.type === 'speech_end') {
      item.finished = true;
      clearTimeout(item.timer);
      complete(item);
      return true;
    }
    deadline(item);
    item.decoding++;
    // Decodes may finish out of order. Preserve the order of spoken sentences.
    item.chain = item.chain.then(async function () {
      if (current !== item) return;
      var bytes = Uint8Array.from(atob(message.audio), function (c) { return c.charCodeAt(0); });
      var buffer = await context.decodeAudioData(bytes.buffer);
      if (current !== item) return;
      var source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      item.nodes.add(source);
      source.onended = function () {
        source.disconnect();
        item.nodes.delete(source);
        complete(item);
      };
      var start = Math.max(context.currentTime + 0.03, item.next);
      source.start(start);
      item.next = start + buffer.duration;
      item.status.textContent = '';
    }).catch(function () {
      if (current === item) stop('Couldn’t play this reply. Tap to try again.');
    }).finally(function () { item.decoding--; complete(item); });
    return true;
  }
  window.addEventListener('pagehide', function () { stop(); });
  window.ClosedHandSpeech = { addControl: addControl, receive: receive, stop: stop, prime: prime, talk: talk };
}());
