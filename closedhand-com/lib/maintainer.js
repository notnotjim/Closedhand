// The maintainer: whoever runs closedhand.com, by a sign-in email in
// OPERATOR_EMAILS that its provider verified, the same test as the
// maintainer's notices (operator-notices.js) and the insights page. Their
// account has Closedhand Managed Models for good, with no limit and no charge
// (included-ai.js, plan.js).
function operatorEmails(env = process.env) {
  return [...new Set(String(env.OPERATOR_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
}
async function isMaintainer(db, env, ownerId) {
  const emails = operatorEmails(env);
  if (!ownerId || !emails.length) return false;
  const row = (await db.query('SELECT email, email_verified FROM owners WHERE id = $1', [ownerId])).rows[0];
  return !!row && row.email_verified === true && emails.includes(String(row.email || '').toLowerCase());
}
module.exports = { operatorEmails, isMaintainer };
