// The account number: the way into a Closedhand account made without an
// email. 20 characters from the letters and numbers that can't be mistaken
// for each other (about 99 bits), shown in five groups of four.
// closedhand.com keeps only its one-way fingerprint, keyed with
// TOKEN_ENCRYPTION_KEY like its other fingerprints, so the number can't be
// read back from the database.
const crypto = require('node:crypto');

const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 20;

function make() {
  return Array.from({ length: LENGTH }, () => LETTERS[crypto.randomInt(LETTERS.length)]).join('');
}
// As typed or pasted: any case, with or without spaces or hyphens. Null
// unless it has the shape of an account number.
function clean(text) {
  const value = String(text || '').toUpperCase().replace(/[\s-]/g, '');
  return value.length === LENGTH && [...value].every(c => LETTERS.includes(c)) ? value : null;
}
const grouped = number => number.match(/.{4}/g).join(' ');
const fingerprint = (number, pepper) => crypto.createHmac('sha256', pepper).update('account-number:' + number).digest('hex');

module.exports = { make, clean, grouped, fingerprint, LENGTH };
