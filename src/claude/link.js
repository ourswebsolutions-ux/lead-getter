'use strict';

// The private line between Lead Finder's MCP server (bridge.js, started by
// Claude Desktop) and the running Lead Finder app (host.js).
//
// - A Unix socket in the app's data folder (macOS, Linux) or a named pipe
//   (Windows), so nothing listens on the network.
// - The app writes <data>/claude/link.json (readable by this user only)
//   with the pipe and a random key made at each start; the bridge must send
//   the key first, so other programs or users cannot use the line.
// - Messages are JSON, one per line.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = 'claude';
const LINK_FILE = 'link.json';
const TOOLS_FILE = 'tools.json';
const BRIDGE_FILE = 'lead-finder-mcp.cjs';
const MAX_LINE = 4 * 1024 * 1024;

const dirOf = (dataDir) => path.join(dataDir, DIR);

// Unix socket paths are limited (104 bytes on macOS): a long data folder
// uses the temporary folder, under a name made from the data folder.
function pipePath(dataDir, platform = process.platform) {
  const tag = crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\lead-finder-claude-${tag}`;
  const p = path.join(dirOf(dataDir), 'link.sock');
  return Buffer.byteLength(p) < 100 ? p : path.join(os.tmpdir(), `lead-finder-claude-${tag}.sock`);
}

function readLink(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dirOf(dataDir), LINK_FILE), 'utf8'));
    return v && typeof v.pipe === 'string' && typeof v.key === 'string' ? v : null;
  } catch {
    return null;
  }
}

// Written so only this user can read it (the key is in it).
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

// Splits a stream into JSON messages (one per line). Bad lines or a line
// over the limit end the connection.
function lines(socket, onMessage) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > MAX_LINE) {
      socket.destroy();
      return;
    }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (msg && typeof msg === 'object') onMessage(msg);
    }
  });
}

const sendLine = (socket, msg) => !socket.destroyed && socket.write(`${JSON.stringify(msg)}\n`);

function sameKey(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = { DIR, LINK_FILE, TOOLS_FILE, BRIDGE_FILE, dirOf, pipePath, readLink, writePrivate, lines, sendLine, sameKey };
