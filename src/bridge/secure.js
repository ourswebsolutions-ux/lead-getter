'use strict';

// The encrypted, authenticated link between Lead Finder (controller) and a
// bridge, over TCP on the local network.
//
// Each install has a long-term Ed25519 identity. A connection:
//   1. both send { id (Ed25519 public key), eph (fresh X25519 public key), nonce }
//   2. each signs the transcript (both ephemeral keys and nonces) with its
//      identity: a man in the middle cannot sign as either side
//   3. X25519 shared secret -> HKDF-SHA256 -> one AES-256-GCM key per direction
// Then every frame is encrypted and authenticated (counter nonces, so a
// replayed or reordered frame is refused).
//
// A peer seen for the first time is not trusted: both screens show the same
// 6-digit code (derived from the secret of this very connection) and the
// user confirms on both devices; the peer's identity is then remembered.
//
// Frame on the wire: u32 length | u8 type | ciphertext | 16-byte tag.
// Types: 1 = JSON message, 2 = audio (raw bytes).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const VERSION = 1;
const MAX_FRAME = 1 << 20;
const T_JSON = 1;
const T_AUDIO = 2;

const b64 = (buf) => Buffer.from(buf).toString('base64');
const rawPub = (key) => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const pubFromRaw = (raw, type) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from(type === 'ed25519' ? '302a300506032b6570032100' : '302a300506032b656e032100', 'hex'), raw]), format: 'der', type: 'spki' });

// Short, stable name of an identity (shown to users, used in beacons).
const fingerprint = (idB64) => crypto.createHash('sha256').update(Buffer.from(idB64, 'base64')).digest('hex').slice(0, 16);

// This install's identity and the peers it trusts, in a folder only the user can read.
class Identity {
  constructor(dir, name) {
    this.dir = dir;
    this.name = name;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'identity.json');
    this.trustFile = path.join(dir, 'trusted.json');
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    if (!data?.privateKey) {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      data = { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
      fs.writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 });
    }
    this.privateKey = crypto.createPrivateKey(data.privateKey);
    this.publicB64 = b64(rawPub(crypto.createPublicKey(this.privateKey)));
    this.fingerprint = fingerprint(this.publicB64);
  }

  trusted() {
    try {
      return JSON.parse(fs.readFileSync(this.trustFile, 'utf8'));
    } catch {
      return {};
    }
  }

  isTrusted(idB64) {
    return Boolean(this.trusted()[idB64]);
  }

  trust(idB64, info) {
    const all = this.trusted();
    all[idB64] = { ...info, fingerprint: fingerprint(idB64), at: Date.now() };
    fs.writeFileSync(this.trustFile, JSON.stringify(all, null, 1), { mode: 0o600 });
  }

  forget(idB64) {
    const all = this.trusted();
    delete all[idB64];
    fs.writeFileSync(this.trustFile, JSON.stringify(all, null, 1), { mode: 0o600 });
  }

  sign(data) {
    return crypto.sign(null, data, this.privateKey);
  }
}

function transcript(c, s) {
  return Buffer.concat([Buffer.from('LFB1'), Buffer.from(c.id, 'base64'), Buffer.from(c.eph, 'base64'), Buffer.from(c.nonce, 'base64'), Buffer.from(s.id, 'base64'), Buffer.from(s.eph, 'base64'), Buffer.from(s.nonce, 'base64')]);
}

// An authenticated, encrypted connection. Events: 'message' (object),
// 'audio' (Buffer), 'close' ({ reason }). Created by handshake().
class SecureChannel extends EventEmitter {
  constructor(socket, { sendKey, recvKey, peer, sas }) {
    super();
    this.socket = socket;
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendCount = 0n;
    this.recvCount = 0n;
    this.peer = peer; // { id, name, role, fingerprint }
    this.sas = sas; // the 6-digit pairing code of this connection
    this.closed = false;
    this.buf = Buffer.alloc(0);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.close('connection closed'));
    socket.on('error', (e) => this.close(e.message));
    socket.setNoDelay(true);
    socket.resume();
  }

  nonce(n) {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(n, 4);
    return iv;
  }

  write(type, payload) {
    if (this.closed) return false;
    const c = crypto.createCipheriv('aes-256-gcm', this.sendKey, this.nonce(this.sendCount++));
    c.setAAD(Buffer.from([type]));
    const body = Buffer.concat([c.update(payload), c.final(), c.getAuthTag()]);
    const head = Buffer.alloc(5);
    head.writeUInt32BE(body.length + 1, 0);
    head[4] = type;
    return this.socket.write(Buffer.concat([head, body]));
  }

  send(msg) {
    return this.write(T_JSON, Buffer.from(JSON.stringify(msg)));
  }

  sendAudio(buf) {
    return this.write(T_AUDIO, buf);
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < 17 || len > MAX_FRAME) return this.close('bad frame');
      if (this.buf.length < 4 + len) return;
      const type = this.buf[4];
      const body = this.buf.subarray(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let plain;
      try {
        const dc = crypto.createDecipheriv('aes-256-gcm', this.recvKey, this.nonce(this.recvCount++));
        dc.setAAD(Buffer.from([type]));
        dc.setAuthTag(body.subarray(-16));
        plain = Buffer.concat([dc.update(body.subarray(0, -16)), dc.final()]);
      } catch {
        return this.close('a frame failed authentication');
      }
      if (type === T_AUDIO) this.emit('audio', plain);
      else {
        let msg;
        try {
          msg = JSON.parse(plain);
        } catch {
          return this.close('bad message');
        }
        this.emit('message', msg);
      }
    }
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('close', { reason });
  }
}

// Reads the first plain-text JSON line of the handshake.
function readLine(socket, timeout) {
  return new Promise((resolve, reject) => {
    // Bytes, not text: what follows the line may be the first encrypted frame.
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('The other device did not answer.')), timeout);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(0x0a);
      if (i < 0) {
        if (buf.length > 8192) done(new Error('Not a Lead Finder device.'));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
      } catch {
        return done(new Error('Not a Lead Finder device.'));
      }
      done(null, msg, buf.subarray(i + 1));
    };
    const onEnd = () => done(new Error('The connection closed.'));
    function done(err, msg, rest) {
      clearTimeout(timer);
      socket.pause(); // nothing is read until the next step listens
      socket.off('data', onData);
      socket.off('close', onEnd);
      socket.off('error', onEnd);
      if (err) reject(err);
      else {
        if (rest?.length) socket.unshift(rest);
        resolve(msg);
      }
    }
    socket.on('data', onData);
    socket.on('close', onEnd);
    socket.on('error', onEnd);
    socket.resume();
  });
}

// The handshake on a connected socket. role: 'controller' (it connected) or 'bridge'.
async function handshake(socket, identity, role, { timeout = 10_000 } = {}) {
  const eph = crypto.generateKeyPairSync('x25519');
  const mine = { t: 'hello', v: VERSION, role, name: identity.name, id: identity.publicB64, eph: b64(rawPub(eph.publicKey)), nonce: b64(crypto.randomBytes(32)) };
  socket.write(`${JSON.stringify(mine)}\n`);
  const theirs = await readLine(socket, timeout);
  if (theirs?.t !== 'hello' || theirs.v !== VERSION || !theirs.id || !theirs.eph || !theirs.nonce) throw new Error('Not a compatible Lead Finder device.');
  if (theirs.role === role) throw new Error(`Both devices are a ${role}.`);
  if (theirs.id === identity.publicB64) throw new Error('That is this device.');
  const [c, s] = role === 'controller' ? [mine, theirs] : [theirs, mine];
  const t = transcript(c, s);
  // Proof of identity: a signature over this connection's transcript.
  socket.write(`${JSON.stringify({ t: 'auth', sig: b64(identity.sign(Buffer.concat([t, Buffer.from(role)]))) })}\n`);
  const auth = await readLine(socket, timeout);
  const ok = auth?.t === 'auth' && crypto.verify(null, Buffer.concat([t, Buffer.from(theirs.role)]), pubFromRaw(Buffer.from(theirs.id, 'base64'), 'ed25519'), Buffer.from(String(auth.sig || ''), 'base64'));
  if (!ok) throw new Error('The other device could not prove its identity.');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubFromRaw(Buffer.from(theirs.eph, 'base64'), 'x25519') });
  const keys = Buffer.from(crypto.hkdfSync('sha256', shared, t, 'LFB1 keys', 64));
  const sasBytes = Buffer.from(crypto.hkdfSync('sha256', shared, t, 'LFB1 pairing code', 4));
  const sas = String(sasBytes.readUInt32BE(0) % 1_000_000).padStart(6, '0');
  const [c2s, s2c] = [keys.subarray(0, 32), keys.subarray(32)];
  return new SecureChannel(socket, {
    sendKey: role === 'controller' ? c2s : s2c,
    recvKey: role === 'controller' ? s2c : c2s,
    peer: { id: theirs.id, name: String(theirs.name || 'Lead Finder').slice(0, 80), role: theirs.role, fingerprint: fingerprint(theirs.id) },
    sas,
  });
}

module.exports = { Identity, SecureChannel, handshake, fingerprint, VERSION };
