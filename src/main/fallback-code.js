'use strict';

// Activation codes for when the activation email cannot be sent. Main
// process only; never loaded by the window.
//
// The code's form is not in this file: it comes from the build's private
// settings (fallbackPattern, from tools/activation/.env, git-ignored). It is
// six characters: a digit stays as it is; each "x" becomes a digit derived
// from the build's secret and this request (Activation ID, plan and a random
// reference). The administrator works out the same code with
// tools/activation ("npm run fallback-code") from the reference the customer
// sends; without the secret it cannot be worked out, so knowing the form
// alone is worth nothing.

const crypto = require('node:crypto');

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U

// At least three derived digits, so a form leaves 1000+ possible codes.
function validPattern(pattern) {
  return typeof pattern === 'string' && /^[0-9x]{6}$/.test(pattern) && pattern.split('x').length - 1 >= 3;
}

// secret: Buffer; request: { activationId, plan, reference }.
function fallbackCode(secret, pattern, { activationId, plan, reference }) {
  if (!validPattern(pattern)) throw new Error('The fallback code form is not valid.');
  if (!Buffer.isBuffer(secret) || secret.length < 16) throw new Error('No activation secret.');
  const free = pattern.split('x').length - 1;
  const mac = crypto.createHmac('sha256', secret).update(['lead-finder-fallback-code', activationId, plan, normalizeReference(reference)].join('\n')).digest();
  const digits = (mac.readBigUInt64BE(0) % 10n ** BigInt(free)).toString().padStart(free, '0');
  let i = 0;
  return pattern.replace(/x/g, () => digits[i++]);
}

// A request reference the customer sends to the administrator: XXXX-XXXX
// (40 random bits).
function newReference(randomBytes = crypto.randomBytes) {
  let bits = BigInt(`0x${randomBytes(5).toString('hex')}`);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s = B32[Number(bits & 31n)] + s;
    bits >>= 5n;
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// A reference as typed by someone: case, spaces and look-alike letters.
function normalizeReference(ref) {
  const s = String(ref || '')
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

module.exports = { fallbackCode, newReference, normalizeReference, validPattern };
