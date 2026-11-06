// Closedhand's additions to noVNC for the sandbox computer's screen
// (vnc_lite.html), kept apart from noVNC's own files.

// The server sends a frame when asked, and noVNC asks for the next one only
// once the last has arrived: one frame per round trip to the computer
// running Closedhand. Watched from a phone over the internet, that was 4 to 7
// frames a second while scrolling, 140 ms apart (2026-11-06). Asking ahead,
// two frames at most, lets it send each frame as soon as the screen changes.
// A frame that takes longer to arrive than frames come means the connection
// is what is slow, and asking ahead would only queue frames behind each
// other, so it asks ahead less, then not at all.
//
// Xvnc can send frames unasked instead (continuous updates), but it waits
// for each one's fence to come back before the next: one frame per round
// trip again. Over a 110 ms one that was 5 to 7 frames a second while
// scrolling, when the sandbox itself made 59; asked ahead, the same scroll
// came at 27 to 37 (2026-11-06). So neither is offered to it.
export const AHEAD_EVERY_MS = 33;
const FENCE = -312, CONTINUOUS_UPDATES = -313;

export function aheadFor(arrivalMs) {
    return arrivalMs > 120 ? 0 : arrivalMs > 40 ? 1 : 2;
}

// Base is noVNC's RFB; messages is RFB.messages; clock, visible and every
// stand in for the page's in the tests.
export function makeScreen(Base, messages, {
    clock = () => performance.now(),
    visible = () => !document.hidden,
    every = (fn, ms) => setInterval(fn, ms),
} = {}) {
    return class Screen extends Base {
        constructor(target, channel, options) {
            super(target, channel, options);
            this._ahead = 0;
            this._aheadMax = 2;
            this._arrival = 0;
            this._frameStart = null;
            // Told the screen's size (width, height, drawn) when it changes,
            // and again once a frame of that size is drawn.
            this.onScreenSize = null;
            this._sizeToTell = false;
            this._aheadTimer = every(() => this._askAhead(), AHEAD_EVERY_MS);
        }

        _askAhead() {
            if (this._rfbConnectionState === 'disconnected') { clearInterval(this._aheadTimer); return; }
            if (this._rfbConnectionState !== 'connected' || !visible() || this._ahead >= this._aheadMax) return;
            messages.fbUpdateRequest(this._sock, true, 0, 0, this._fbWidth, this._fbHeight);
            this._ahead++;
        }

        // noVNC's list without fences and continuous updates (above).
        _sendEncodings() {
            const send = messages.clientEncodings;
            messages.clientEncodings = (sock, encs) => send(sock, encs.filter((e) => e !== FENCE && e !== CONTINUOUS_UPDATES));
            try { super._sendEncodings(); } finally { messages.clientEncodings = send; }
        }

        _framebufferUpdate() {
            if (this._frameStart === null) this._frameStart = clock();
            const done = super._framebufferUpdate();
            if (!done) return false;
            const took = clock() - this._frameStart;
            this._frameStart = null;
            this._ahead = 0;
            this._arrival = this._arrival ? this._arrival * 0.7 + took * 0.3 : took;
            this._aheadMax = aheadFor(this._arrival);
            if (this._sizeToTell) {
                this._sizeToTell = false;
                if (this.onScreenSize) this.onScreenSize(this._fbWidth, this._fbHeight, true);
            }
            return true;
        }

        // A new size (the phone shape and back) is drawn whole. noVNC asks
        // only for what changes after it, so wherever a server sent nothing
        // the picture of the old shape stayed: half a phone-shaped page
        // beside the laptop-shaped one. Only a size that changed: a server
        // answers every whole-frame request with the size again, and asking
        // again on that sent whole frames for ever.
        _resize(width, height) {
            const changed = width !== this._fbWidth || height !== this._fbHeight;
            super._resize(width, height);
            if (!changed) return;
            this._sizeToTell = true;
            if (this.onScreenSize) this.onScreenSize(width, height, false);
            if (this._rfbConnectionState === 'connected') messages.fbUpdateRequest(this._sock, false, 0, 0, width, height);
        }
    };
}
