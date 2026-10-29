// Owners are found by the permanent ID their sign-in provider gives them.
// Two sign-ins are the same owner only when they are the same provider
// account; an email address never joins accounts together, because a work
// account's email is whatever its organisation typed in.

// identity: { provider, subject, email, emailVerified, personal }. Only the
// email is kept about the person, and whether the provider vouches for it: no
// name, picture or anything else the sign-in gives. Google says when it
// verified the address; a personal Microsoft account's address is its own
// sign-in. Only a vouched-for address may receive the assistant's email.
// The owner a sign-in already is, or null: never makes one. Signing in only
// to find a Closedhand (My Closedhand, the account page) uses this, so the
// other provider's sign-in says plainly that it has no account rather than
// leaving an empty one behind.
async function findOwner(db, identity) {
  const { provider, subject, email = null } = identity;
  if (!['google', 'microsoft'].includes(provider) || typeof subject !== 'string' || !subject) throw new Error('Unknown identity');
  const verified = !!email && (identity.emailVerified === true || (provider === 'microsoft' && identity.personal === true));
  const known = await db.query(
    'UPDATE owners SET email = $3, email_verified = $4, updated_at = now() WHERE provider = $1 AND subject = $2 RETURNING id',
    [provider, subject, email, verified]);
  if (known.rows[0]) return known.rows[0].id;
  // Another account connected at setup on the computer holding the account's
  // personal URL (addSignIn).
  const added = await db.query('UPDATE owner_sign_ins SET email = $3 WHERE provider = $1 AND subject = $2 RETURNING owner_id', [provider, subject, email]);
  if (added.rows[0]) return added.rows[0].owner_id;
  // Owners carried over from the old service are known only by the Google
  // address they used there. A verified sign-in with that same Google address
  // claims the row once; after that the Google ID alone finds it.
  if (provider === 'google' && identity.emailVerified === true && email) {
    const claimed = await db.query(
      `UPDATE owners SET subject = $1, email_verified = true, updated_at = now()
       WHERE id = (SELECT id FROM owners WHERE provider = 'google' AND subject IS NULL AND lower(email) = lower($2)
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [subject, email]);
    if (claimed.rows[0]) return claimed.rows[0].id;
  }
  return null;
}

// The owner a sign-in is, made the first time: claiming a personal URL or
// confirming the assistant's email is where an account begins.
async function ownerFor(db, identity) {
  const found = await findOwner(db, identity);
  if (found) return found;
  const { provider, subject, email = null } = identity;
  const verified = !!email && (identity.emailVerified === true || (provider === 'microsoft' && identity.personal === true));
  const created = await db.query(
    `INSERT INTO owners (provider, subject, email, email_verified) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, subject) WHERE subject IS NOT NULL DO UPDATE SET updated_at = now()
     RETURNING id`,
    [provider, subject, email, verified]);
  return created.rows[0].id;
}

async function describe(db, ownerId) {
  if (!ownerId) return null;
  const { rows } = await db.query('SELECT id, provider, email FROM owners WHERE id = $1', [ownerId]);
  return rows[0] || null;
}

// One more sign-in for an account: a Google or Microsoft account connected
// through Closedhand's own app on the computer that holds the account's
// personal URL. "added", "already" (it is this account's), or "taken" (it is
// another account's, which is never moved or merged).
async function addSignIn(db, ownerId, identity) {
  const { provider, subject, email = null } = identity;
  const found = await findOwner(db, identity);
  if (found) return found === ownerId ? 'already' : 'taken';
  const added = await db.query(
    `INSERT INTO owner_sign_ins (provider, subject, owner_id, email) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, subject) DO NOTHING RETURNING owner_id`,
    [provider, subject, ownerId, email]);
  return added.rows[0] ? 'added' : 'taken';
}

// Every way into an account, its first sign-in first: provider and email.
async function signInsOf(db, ownerId) {
  const { rows } = await db.query(
    `SELECT provider, email FROM owners WHERE id = $1
     UNION ALL SELECT provider, email FROM (SELECT provider, email, created_at FROM owner_sign_ins WHERE owner_id = $1 ORDER BY created_at) s`,
    [ownerId]);
  return rows;
}

module.exports = { findOwner, ownerFor, addSignIn, signInsOf, describe };
