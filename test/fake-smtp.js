'use strict';
// A local SMTP server for tests (plain, no TLS): records the messages it
// accepts. mode: 'accept' | 'auth-fail' (login refused).

const net = require('node:net');

function startSmtp({ mode = 'accept', port = 0, unref = false } = {}) {
  const messages = [];
  const server = net.createServer((sock) => {
    let data = false;
    let buf = '';
    let msg = { from: null, to: [], raw: '' };
    const w = (line) => sock.write(`${line}\r\n`);
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') {
            data = false;
            // Undo quoted-printable soft breaks and dot-stuffing for easy reading.
            msg.text = msg.raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
            messages.push(msg);
            msg = { from: null, to: [], raw: '' };
            w('250 OK queued');
          } else msg.raw += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }
        const c = line.toUpperCase();
        if (c.startsWith('EHLO') || c.startsWith('HELO')) sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (c.startsWith('AUTH')) w(server.mode === 'auth-fail' ? '535 5.7.8 Authentication failed' : '235 2.7.0 OK');
        else if (c.startsWith('MAIL FROM')) (msg.from = line.slice(10).trim()), w('250 OK');
        else if (c.startsWith('RCPT TO')) msg.to.push(line.slice(8).trim().replace(/[<>]/g, '')), w('250 OK');
        else if (c === 'DATA') (data = true), w('354 go');
        else if (c === 'QUIT') w('221 bye'), sock.end();
        else w('250 OK');
      }
    });
    w('220 fake ESMTP');
  });
  server.mode = mode;
  if (unref) server.unref();
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        messages,
        setMode: (m) => (server.mode = m),
        close: () => new Promise((r) => server.close(r)),
        smtp: () => ({ host: '127.0.0.1', port: server.address().port, user: 'sender@example.com', pass: 'test-pass', from: 'Lead Finder <sender@example.com>', insecure: true }),
      }),
    ),
  );
}

module.exports = { startSmtp };
