// lib/shortcuts.js: the one message Closedhand pins at the top of each chat
// app's chat with it: where the dashboard is, what a project is, and how to
// report a problem from any chat app. WhatsApp shows the link as text (lib/platforms/whatsapp-linked.js);
// Telegram turns it into an "Open dashboard" button that opens the dashboard
// inside Telegram (lib/telegram-in-app.js, lib/platforms/telegram.js).

function shortcutsText(url) {
  return ["I’m pinning this so your dashboard is easy to find.", "", url ? `Your dashboard: ${url}` : "Your dashboard opens on the computer running Closedhand.", "",
    "A project can be created for any topic that is likely to run for a while. I’ll offer to set one up when one comes up. You can also view and create projects from your Closedhand dashboard.", "",
    "If something goes wrong, send /bug and say what happened."].join("\n");
}

module.exports = { shortcutsText };
