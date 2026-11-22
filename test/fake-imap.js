'use strict';
// A small IMAP server for tests (plain, no TLS): one read-only INBOX with
// the given messages; enough of IMAP4rev1 for imapflow to log in, examine
// the inbox, search by date and fetch envelopes and (partial) sources.
// messages: [{ from, subject, text, date }]. mode: 'accept' | 'auth-fail'.

const net = require('node:net');

const q = (s) => (s == null ? 'NIL' : `"${String(s).replace(/["\\]/g, '\\$&')}"`);
const addr = (email) => {
  const [mailbox, host] = String(email).split('@');
  return `((NIL NIL ${q(mailbox)} ${q(host)}))`;
};

function startImap({ messages = [], user = 'sender@example.com', pass = 'pw', mode = 'accept' } = {}) {
  const log = [];
  const server = net.createServer((sock) => {
    let buf = '';
    const w = (line) => sock.write(`${line}\r\n`);
    sock.on('error', () => {});
    w('* OK [CAPABILITY IMAP4rev1] fake ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        log.push(line.replace(/LOGIN .*/i, 'LOGIN ***'));
        const [tag, cmdRaw, ...rest] = line.split(' ');
        const cmd = (cmdRaw || '').toUpperCase();
        const args = rest.join(' ');
        if (cmd === 'CAPABILITY') w('* CAPABILITY IMAP4rev1'), w(`${tag} OK done`);
        else if (cmd === 'LOGIN') {
          const ok = mode === 'accept' && args.includes(user) && args.includes(pass);
          w(ok ? `${tag} OK [CAPABILITY IMAP4rev1] logged in` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        } else if (cmd === 'EXAMINE' || cmd === 'SELECT') {
          w(`* ${messages.length} EXISTS`);
          w('* 0 RECENT');
          w('* FLAGS (\\Seen \\Answered)');
          w('* OK [UIDVALIDITY 7] ok');
          w(`* OK [UIDNEXT ${messages.length + 1}] ok`);
          w(`${tag} OK [${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] done`);
        } else if (cmd === 'UID' && /^SEARCH/i.test(args)) {
          w(`* SEARCH ${messages.map((_, k) => k + 1).join(' ')}`.trim());
          w(`${tag} OK done`);
        } else if (cmd === 'UID' && /^FETCH/i.test(args)) {
          messages.forEach((m, k) => {
            const raw = `From: ${m.from}\r\nTo: ${user}\r\nSubject: ${m.subject}\r\nDate: ${new Date(m.date || Date.now()).toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.text || ''}\r\n`;
            const env = `(${q(new Date(m.date || Date.now()).toUTCString())} ${q(m.subject)} ${addr(m.from)} ${addr(m.from)} ${addr(m.from)} ${addr(user)} NIL NIL NIL ${q(`<m${k}@test>`)})`;
            sock.write(`* ${k + 1} FETCH (UID ${k + 1} ENVELOPE ${env} BODY[]<0> {${Buffer.byteLength(raw)}}\r\n${raw})\r\n`);
          });
          w(`${tag} OK done`);
        } else if (cmd === 'LOGOUT') w('* BYE bye'), w(`${tag} OK done`), sock.end();
        else w(`${tag} OK done`);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, log, close: () => new Promise((r) => server.close(r)) })),
  );
}

module.exports = { startImap };
