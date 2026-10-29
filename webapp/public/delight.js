/* ============================================================
   Closedhand Delight: small touches (toasts, confetti, copy
   feedback). Nothing here appears unasked: no milestones, no
   hidden modes.
   ============================================================ */

window.Delight = {
  // When the last notice shown leaves, so the next leaves after it.
  _leaveAt: 0,

  // -----------------------------------------------------------
  // Init
  // -----------------------------------------------------------
  init: function () {
    // Copy feedback (delegated)
    document.addEventListener("click", function (e) {
      var copyable = e.target.closest(".activation-code, [data-copy], .mcp-url-copy");
      if (!copyable) return;
      copyable.classList.add("copy-flash");
      copyable.style.position = "relative";
      var tooltip = document.createElement("span");
      tooltip.className = "copy-tooltip";
      tooltip.textContent = "Copied!";
      copyable.appendChild(tooltip);
      setTimeout(function () {
        tooltip.remove();
        copyable.classList.remove("copy-flash");
      }, 1200);
    });

    // Connection confetti on redirect
    var params = new URLSearchParams(location.search);
    if (params.get("connected") || params.get("mcp_connected")) {
      setTimeout(function () { Delight.confetti(); }, 400);
    }

    // Override showToast for backward compatibility
    window.showToast = function (msg, isError) {
      Delight.toast(msg, isError ? "error" : "success");
    };

    // Override miniCelebration for confetti
    window.miniCelebration = function () {
      Delight.confetti();
    };

    // Ensure toast container exists
    if (!document.getElementById("toast-container")) {
      var tc = document.createElement("div");
      tc.id = "toast-container";
      document.body.appendChild(tc);
    }

    // Observe grids for stagger on content changes
    var grids = document.querySelectorAll("[data-delight-stagger]");
    grids.forEach(function (grid) {
      var observer = new MutationObserver(function () {
        Delight.staggerChildren(grid);
      });
      observer.observe(grid, { childList: true });
    });

    // Destructive action input progress
    document.addEventListener("input", function (e) {
      if (!e.target.matches(".confirm-type-input, [data-confirm-target]")) return;
      var input = e.target;
      var target = (input.placeholder || "").replace(/^Type\s+/i, "");
      if (!target) return;
      var progress = Math.min(input.value.length / Math.max(target.length, 1), 1);
      var r = Math.round(51 + (248 - 51) * progress);
      var g = Math.round(51 + (113 - 51) * progress * 0.3);
      var b = Math.round(51 + (113 - 51) * progress * 0.3);
      input.style.borderColor = "rgb(" + r + "," + g + "," + b + ")";
    });
  },

  // -----------------------------------------------------------
  // Confetti
  // -----------------------------------------------------------
  // The colours are the app's names (interface.css); the confetti is drawn on
  // a canvas, which takes values, so each name is read in the theme in use.
  _named: function (colors) {
    var style = getComputedStyle(document.documentElement);
    return (colors || []).map(function (c) {
      return String(c).replace(/var\((--[\w-]+)\)/g, function (m, name) { return style.getPropertyValue(name).trim(); });
    });
  },

  // One burst, the same every time and every day of the year.
  confetti: function (opts) {
    if (typeof window.confetti !== "function") return;
    var config = Object.assign({
      particleCount: 90,
      angle: 90,
      spread: 65,
      origin: { x: 0.5, y: 0.7 },
      colors: ["var(--accent)", "var(--accent)", "var(--warn)", "var(--accent)", "var(--slate)", "var(--accent)"],
      disableForReducedMotion: true,
    }, opts || {});
    config.colors = Delight._named(config.colors);
    window.confetti(config);
  },

  // -----------------------------------------------------------
  // Toast System
  // -----------------------------------------------------------
  toast: function (msg, type) {
    type = type || "success";
    var container = document.getElementById("toast-container");
    if (!container) return;

    var icons = {
      success: '<svg class="toast-icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      error: '<svg class="toast-icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      info: '<svg class="toast-icon" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5.5v0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    };

    var toast = document.createElement("div");
    toast.className = "delight-toast " + type;
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    // The message is text, never markup: callers pass file names and words
    // taken from the address bar.
    toast.innerHTML = icons[type] || "";
    var text = document.createElement("span");
    text.textContent = String(msg);
    toast.appendChild(text);
    var close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.setAttribute("aria-label", "Dismiss");
    close.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    toast.appendChild(close);
    container.appendChild(toast);

    // Long enough to read, or until its x is clicked. Several at once stack
    // and leave one after another, the oldest first.
    var gone = false;
    function leave() {
      if (gone) return;
      gone = true;
      toast.classList.add("delight-toast-exit");
      setTimeout(function () { toast.remove(); }, 300);
    }
    close.addEventListener("click", leave);
    var at = Math.max(Date.now() + 8000, Delight._leaveAt + 700);
    Delight._leaveAt = at;
    setTimeout(leave, at - Date.now());
  },

  // -----------------------------------------------------------
  // Number Animation
  // -----------------------------------------------------------
  animateNumber: function (elementId, target) {
    var el = document.getElementById(elementId);
    if (!el) return;

    var targetNum = parseInt(target, 10);
    if (isNaN(targetNum) || targetNum === 0) {
      el.textContent = target;
      return;
    }

    var start = 0;
    var duration = 600;
    var startTime = null;

    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / duration, 1);
      // Ease-out cubic
      var eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(start + (targetNum - start) * eased);
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = target; // Ensure exact value (preserves "2/5" format etc.)
      }
    }

    requestAnimationFrame(step);
  },

  // -----------------------------------------------------------
  // Stagger Children
  // -----------------------------------------------------------
  staggerChildren: function (container) {
    if (!container) return;
    var children = container.querySelectorAll(":scope > *");
    children.forEach(function (child, i) {
      child.style.setProperty("--stagger-index", i);
      child.classList.remove("delight-stagger-item");
      // Force reflow
      void child.offsetWidth;
      child.classList.add("delight-stagger-item");
    });
  },

  // -----------------------------------------------------------
  // Skeleton Loading
  // -----------------------------------------------------------
  showSkeleton: function (containerId, count, height) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var html = "";
    for (var i = 0; i < count; i++) {
      html += '<div class="skeleton" style="height:' + (height || 48) / 16 + 'rem;margin-bottom:0.375rem;"></div>';
    }
    el.innerHTML = html;
  },
};

// Init on DOM ready
document.addEventListener("DOMContentLoaded", function () {
  Delight.init();
});
