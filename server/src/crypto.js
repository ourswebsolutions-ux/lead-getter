'use strict';

const crypto = require('node:crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const randomToken = () => b64url(crypto.randomBytes(32));
const hashToken = (token) => sha256(String(token)).toString('hex');

// Device ID = hash of the device's Ed25519 public key (DER, base64).
function deviceIdFromKey(publicKeyB64) {
  return b64url(sha256(Buffer.from(publicKeyB64, 'base64'))).slice(0, 32);
}

function publicKeyFromB64(b64) {
  const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
  return key;
}

// What a device signs for each request (the nonce makes every request,
// and so every signature, unique).
function requestDigest(method, pathWithQuery, ts, nonce, body, machine = '') {
  return Buffer.from(`${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${nonce}\n${machine}\n${sha256(body || '').toString('hex')}`);
}

// Licence status token: base64url(JSON) "." base64url(Ed25519 signature).
function signToken(payload, privateKey) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(crypto.sign(null, Buffer.from(body), privateKey))}`;
}

function verifyToken(token, publicKey) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  if (!crypto.verify(null, Buffer.from(body), publicKey, Buffer.from(sig, 'base64url'))) return null;
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

module.exports = { b64url, sha256, randomToken, hashToken, deviceIdFromKey, publicKeyFromB64, requestDigest, signToken, verifyToken };
