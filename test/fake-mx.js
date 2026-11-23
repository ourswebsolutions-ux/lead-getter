'use strict';
// A domain's mail server for verification tests (plain SMTP, no TLS): it
// answers RCPT TO the way real servers do. Nothing is ever delivered.
//   exists:    addresses whose mailbox exists (or a function email -> bool)
//   catchAll:  domains that accept every address
//   policy:    domains that refuse this computer (spam list), not the mailbox
//   greylist:  { domain: n } the first n conversations get "451 try later"
//   full:      addresses whose mailbox is full
//   disabled:  addresses whose mailbox is disabled
// rcpts: every RCPT TO asked (to see that nothing is asked twice).

const net = require('node:net');

function startMx({ exists = [], catchAll = [], policy = [], greylist = {}, full = [], disabled = [] } = {}) {
  const has = typeof exists === 'function' ? exists : (e) => exists.includes(e);
  const rcpts = [];
  const sessions = { n: 0 };
  const greyLeft = { ...greylist };
  const socks = new Set();
  const server = net.createServer((sock) => {
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    sock.on('error', () => {});
    sessions.n++;
    let buf = '';
    let grey = false;
    const w = (l) => sock.write(`${l}\r\n`);
    w('220 mx.test ESMTP ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') w('250-mx.test hello'), w('250 SIZE 10000000');
        else if (cmd === 'HELO') w('250 mx.test');
        else if (cmd === 'MAIL') w('250 2.1.0 Ok');
        else if (cmd === 'RCPT') {
          const to = (/<([^>]*)>/.exec(line)?.[1] || '').toLowerCase();
          const domain = to.split('@')[1] || '';
          rcpts.push(to);
          if (policy.includes(domain)) w('554 5.7.1 Service unavailable; Client host [203.0.113.9] blocked using zen.spamhaus.org');
          else if (greyLeft[domain] > 0 || grey) {
            if (!grey) greyLeft[domain]--;
            grey = true;
            w('451 4.7.1 Greylisted, please try again later');
          } else if (catchAll.includes(domain)) w('250 2.1.5 Ok');
          else if (full.includes(to)) w('552 5.2.2 Mailbox full, quota exceeded');
          else if (disabled.includes(to)) w('550 5.2.1 The email account that you tried to reach is disabled');
          else if (has(to)) w('250 2.1.5 Ok');
          else w('550 5.1.1 <' + to + '>: Recipient address rejected: User unknown in virtual mailbox table');
        } else if (cmd === 'QUIT') w('221 2.0.0 Bye'), sock.end();
        else w('250 Ok');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        rcpts,
        sessions,
        close: () =>
          new Promise((r) => {
            for (const s of socks) s.destroy();
            server.close(r);
          }),
      }),
    ),
  );
}

// DNS for tests: every domain has the mail server "mx.<domain>", except
// those ending in .invalid (no such domain) and nomx.test (no mail server).
const fakeMxDns = {
  resolveMx: async (d) => {
    if (/\.invalid$/.test(d)) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    if (d === 'nomx.test') throw Object.assign(new Error('no data'), { code: 'ENODATA' });
    if (d === 'dnsfail.test') throw Object.assign(new Error('servfail'), { code: 'ESERVFAIL' });
    return [{ exchange: `mx.${d}`, priority: 10 }];
  },
  resolve4: async () => {
    throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  },
};

// The verification engine for tests: real EmailVerifier code, the fake DNS,
// and "mx.unreachable.*" on an address nothing listens on (refused).
function testEngine(mx, extra = {}) {
  const { EmailVerifier } = require('../src/browser/email-verify');
  return (o) => new EmailVerifier({ ...o, port: mx.port, timeout: 2_000, dns: fakeMxDns, hostFor: (h) => (/^mx\.unreachable\./.test(h) ? '127.0.0.2' : '127.0.0.1'), ...extra });
}

module.exports = { startMx, fakeMxDns, testEngine };
