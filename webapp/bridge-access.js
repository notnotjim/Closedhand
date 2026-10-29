// What a connected Mac lets Closedhand use, as the Mac app or Closedhand
// Bridge reports it: the Mac's name and each choice in its menu bar menu. The
// Mac sends it when it connects and whenever a choice or a macOS permission
// changes (BridgeManager.reportAccess); /api/bridge/status hands it to the
// web chat's computer icon. Nothing else is kept from the message, and the
// name is text the web chat only ever sets as text.
const KEYS = ["calendar", "reminders", "contacts", "notes", "screen", "appControl", "files", "browser", "terminal"];

function clean(msg) {
  const device = typeof msg?.device === "string" ? msg.device.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) : "";
  const allowed = {};
  for (const key of KEYS) if (typeof msg?.allowed?.[key] === "boolean") allowed[key] = msg.allowed[key];
  return { device: device || null, allowed: Object.keys(allowed).length ? allowed : null };
}

module.exports = { KEYS, clean };
