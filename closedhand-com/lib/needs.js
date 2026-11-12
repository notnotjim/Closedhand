// What needs the maintainer now, for the top of the insights page: each a
// plain sentence of what is wrong and one of what to do, worked out from the
// numbers the page already has. An empty list means nothing does. Something
// that can't be read is said too, as it might be wrong without anyone seeing.
const DAY = 86400000;

function needsOf({ now = Date.now(), managed = {}, near = null, bugs = {}, messages = 0, backup = null, crypto = null, cards = null, github = null, urls = {} } = {}) {
  const out = [];
  const say = (what, act) => out.push({ what, do: act });
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const days = ms => Math.max(0, Math.round(ms / DAY));

  // The uncensored LLM: the sign-in that makes keys and renews fair use, and
  // the credit every key draws on.
  if (near && (near.failedAt || !near.signedIn || (near.until && new Date(near.until).getTime() - now < 2 * DAY))) {
    say("closedhand.com's NEAR AI sign-in has stopped working, so nobody new can start the uncensored LLM and fair use can't renew.",
      'Sign in at cloud.near.ai in an Incognito window and hand the sign-in to closedhand.com.');
  }
  const c = managed.credit;
  if (managed.provider && !c) say(`closedhand.com can't read ${managed.provider}'s credit just now.`, 'If this stays, check the sign-in and closedhand.com\'s log on Railway.');
  else if (c && c.left <= 0) say(`${managed.provider || 'The provider'}'s credit is used up, so the uncensored LLM has stopped for everyone.`, 'Add credit at cloud.near.ai.');
  else if (c && c.days != null && c.days < 14) say(`${managed.provider || 'The provider'}'s credit lasts about ${count(c.days, 'more day', 'more days')}.`, 'Add credit at cloud.near.ai.');

  // People waiting on an answer.
  if (bugs.open) say(`${count(bugs.open, 'bug report is', 'bug reports are')} open.`, 'They are listed below.');
  if (messages) say(`${count(messages, 'message', 'messages')} from the site ${messages === 1 ? 'is' : 'are'} waiting.`, 'They are listed below.');

  // What keeps money coming in.
  if (crypto && crypto.error) say("closedhand.com can't reach BTCPay, so crypto payments aren't being confirmed.", 'Check BTCPay at pay.closedhand.com and its services on Railway.');
  else if (crypto && crypto.behind && crypto.behind.length) say(`BTCPay isn't keeping up with ${crypto.behind.join(' and ')}, so payments there aren't being confirmed.`, 'Check BTCPay at pay.closedhand.com.');
  if (cards && cards.error) say("closedhand.com can't reach Polar, so card payments can't be read.", 'Check the Polar token on Railway.');

  // Keeping what closedhand.com holds safe.
  if (backup && backup.error) say("closedhand.com can't list its backups.", "Check closedhand.com's log on Railway.");
  else if (backup && (!backup.newest || now - new Date(backup.newest).getTime() > 1.5 * DAY)) {
    say(backup.newest ? `The newest backup is ${count(days(now - new Date(backup.newest).getTime()), 'day', 'days')} old.` : 'There is no backup yet.', "Check closedhand.com's log on Railway.");
  }

  // The code everyone runs.
  const runs = (github && github.runs) || {};
  if (runs.checks && runs.checks.conclusion && runs.checks.conclusion !== 'success') say('The checks failed on the latest push.', 'See the run on GitHub.');
  if (runs.mac && runs.mac.conclusion && runs.mac.conclusion !== 'success' && runs.mac.conclusion !== 'skipped') say('The last Mac build did not finish, so the Mac download is older than the code.', 'See the run on GitHub.');

  // Room for more people.
  const taken = (urls.used || 0) + ((urls.you && urls.you.used) || 0);
  if (urls.limit > 0 && taken / urls.limit >= 0.8) say(`${Math.round(taken / urls.limit * 100)}% of personal URLs are taken.`, 'Raise ADDRESS_LIMIT on Railway.');
  return out;
}

module.exports = { needsOf };
