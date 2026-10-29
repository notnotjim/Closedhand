// lib/clear-command.js: /clear, in the web chat or any chat app, asks first
// and then clears conversation history, the same as the dashboard's Clear
// conversation history (lib/clear-conversations.js) and in the same words.
// Decided in lib/engine.js before the model sees anything, as /bug is. Only a
// bare yes or no within a few minutes answers it; anything else means they
// moved on, and the question is dropped so a later "yes" to something else
// is never read as this one.

const ANSWER_MS = 15 * 60 * 1000;
const YES = /^(yes|y|yep|yeah|yup|sure|ok|okay|clear|clear it|go ahead|please do)[.! ]*$/;
const NO = /^(no|n|nope|nah|don'?t|not now|cancel|keep it)[.! ]*$/;
const ASK = "Clear your conversation history? This deletes your conversations everywhere Closedhand keeps them, with their Context Notes. Pinned Facts, schedules and connections stay. Reply yes to clear it.";

const waiting = new Map(); // userId -> when it was asked

function isClear(text) {
  return typeof text === "string" && /^\s*\/clear\s*$/i.test(text);
}

function ask(userId) {
  waiting.set(userId, Date.now());
  return ASK;
}

// A yes or no to the question, still in time: it waits its turn and is never
// taken into a reply already running (lib/fold-in.js).
function answersClearQuestion(userId, text) {
  const at = waiting.get(userId);
  if (at === undefined || Date.now() - at > ANSWER_MS) return false;
  const t = String(text || "").trim().toLowerCase();
  return YES.test(t) || NO.test(t);
}

// The answer to the question: null lets the message through, or a promise
// of the reply to send instead.
function handleClearReply(userId, text) {
  const at = waiting.get(userId);
  if (at === undefined) return null;
  waiting.delete(userId);
  const t = String(text || "").trim().toLowerCase();
  if (Date.now() - at > ANSWER_MS) return null;
  if (NO.test(t)) return Promise.resolve("Not cleared.");
  if (!YES.test(t)) return null;
  return clear(userId);
}

async function clear(userId) {
  try {
    await require("./conversation").clearHistory(userId);
  } catch (e) {
    console.error("[clear] failed:", e.message);
    return "Couldn't clear your conversation history just now. Try /clear again in a moment.";
  }
  require("./storage").saveStore();
  // An open web chat empties too, wherever the yes came from.
  require("./web-chat-ws").sendToUser(userId, { type: "cleared" });
  return "Conversation history cleared. Pinned Facts, schedules and connections stayed.";
}

module.exports = { isClear, ask, answersClearQuestion, handleClearReply, ASK, _waiting: waiting };
