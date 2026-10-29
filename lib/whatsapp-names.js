// lib/whatsapp-names.js: what each WhatsApp chat is called.
//
// From everything WhatsApp says about it: the contact book, chat and group
// updates, and in a one-to-one chat the name the other person or business
// gives themselves. Live messages used to be stored with no names at all, so
// most chats were filed under a number and recall lost the words that say who
// they are ("Dental Clinic"). A contact-book or group name wins; a self-given
// name (weak) only fills a gap. Numbers are never a name. Each says whether
// it changed anything, so what is new can be kept (migration 077).
const NUMBER_ONLY = /^[\d\s+()-]+$/;

function rememberName(names, jid, name, { weak = false } = {}) {
  const n = String(name || "").trim();
  if (!jid || !n || NUMBER_ONLY.test(n)) return false;
  if ((weak && names[jid]) || names[jid] === n) return false;
  names[jid] = n;
  return true;
}

// A contact as WhatsApp reports it: its saved name is strong; a business's
// verified name or a self-chosen one only fills a gap. It may arrive under its
// phone id, its private id (lid), or both. Returns the chats it named.
function learnContact(names, contact, bare = (j) => j) {
  const c = contact || {};
  const name = c.name || c.verifiedName || c.notify;
  const named = [];
  for (const id of [c.id, c.lid, c.jid, c.phoneNumber]) if (id && rememberName(names, bare(id), name, { weak: !c.name })) named.push(bare(id));
  return named;
}

module.exports = { rememberName, learnContact };
