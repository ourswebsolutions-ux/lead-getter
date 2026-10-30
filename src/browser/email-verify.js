'use strict';

// Email verification without paid services: asks the domain's own mail
// server whether a mailbox exists (SMTP: EHLO, MAIL FROM, RCPT TO, QUIT; no
// message is ever sent), the way open-source verifiers do. Optionally, a
// self-hosted verifier (Reacher, https://reacher.email, open source) when
// this computer cannot reach mail servers on port 25.
//
// Results:
//   verified  the server accepted this mailbox and rejected a random one
//   invalid   the server said the mailbox does not exist, or the domain
//             has no mail server
//   catch_all the server accepts every address (nothing can be confirmed)
//   unknown   no clear answer (unreachable, greylisting, policy blocks)
// Only 'verified' means the address is confirmed. A server's refusal for
// reasons other than the mailbox (spam lists, policy) is 'unknown', never
// 'invalid'.

const net = require('node:net');
const dnsDefault = require('node:dns').promises;
const crypto = require('node:crypto');
const os = require('node:os');

const SYNTAX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
// Refusals that are about the sender or the connection, not the mailbox.
const POLICY = /block|spam|blacklist|black list|listed|policy|reputation|\bpbl\b|\bsbl\b|spamhaus|not allowed|denied|reverse dns|ptr|helo|client host|rejected due to|authentication|relay|try again later/i;

function validSyntax(email) {
  return SYNTAX.test(String(email || '')) && !/\.\./.test(email) && !/^\.|\.@/.test(email);
}

// One SMTP conversation: send(line) -> Promise<{ code, text }>.
function smtpSession(host, { port = 25, timeout = 12_000, connect = net.connect } = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    let buf = '';
    let lines = [];
    let waiting = null;
    let done = false;
    let greeted = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (waiting) waiting.reject(err);
      else reject(err);
    };
    sock.setTimeout(timeout, () => fail(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    sock.on('error', fail);
    sock.on('close', () => fail(Object.assign(new Error('connection closed'), { code: 'ECLOSED' })));
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        lines.push(line);
        // "250-..." continues, "250 ..." ends a reply.
        if (/^\d{3}( |$)/.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), text: lines.join('\n') };
          lines = [];
          const w = waiting;
          waiting = null;
          if (w) w.resolve(reply);
          else if (!greeted) {
            greeted = true;
            if (reply.code === 220) resolve(api);
            else fail(Object.assign(new Error(`greeting ${reply.code}`), { code: 'EGREETING', reply }));
          }
        }
      }
    });
    const api = {
      send(line) {
        return new Promise((res, rej) => {
          if (done) return rej(Object.assign(new Error('connection closed'), { code: 'ECLOSED' }));
          waiting = { resolve: res, reject: rej };
          sock.write(`${line}\r\n`);
        });
      },
      close() {
        if (done) return;
        done = true;
        try {
          sock.end('QUIT\r\n');
        } catch {}
        setTimeout(() => sock.destroy(), 500).unref?.();
      },
    };
  });
}

// The name this computer introduces itself with (a dotted name when it has
// one; servers rarely check it at the RCPT stage).
function defaultHelo() {
  const h = os.hostname();
  return /\.[a-z]{2,}$/i.test(h) ? h : 'localhost';
}

class EmailVerifier {
  // dns: { resolveMx, resolve4 }; connect: net.connect (tests: a local
  // server); port: 25; reacherUrl: a self-hosted Reacher (POST
  // /v0/check_email) used instead of direct SMTP.
  constructor({ dns = dnsDefault, connect, port = 25, timeout = 12_000, helo = defaultHelo(), reacherUrl = null, fetchImpl = globalThis.fetch, hostFor = null } = {}) {
    this.dns = dns;
    this.connect = connect;
    this.port = port;
    this.timeout = timeout;
    this.helo = helo;
    this.reacherUrl = reacherUrl ? String(reacherUrl).replace(/\/$/, '') : null;
    this.fetchImpl = fetchImpl;
    this.hostFor = hostFor; // tests: map an MX name to a local address
    this.domains = new Map(); // domain -> { mx, catchAll, error }
    this.results = new Map(); // email -> result
    this.unreachable = 0; // mail servers this computer could not reach in a row
  }

  // Port 25 looks blocked (several servers unreachable in a row): later
  // checks answer 'unknown' at once instead of waiting.
  get blocked() {
    return !this.reacherUrl && this.unreachable >= 3;
  }

  async mxOf(domain) {
    try {
      const mx = (await this.dns.resolveMx(domain)).filter((r) => r.exchange).sort((a, b) => a.priority - b.priority);
      if (mx.length) return { hosts: mx.map((r) => r.exchange), error: null };
      return { hosts: [], error: 'no_mail_server' };
    } catch (err) {
      if (['ENODATA', 'ENOTFOUND', 'ENOTIMP'].includes(err?.code)) {
        // No MX record: mail goes to the domain itself, when it exists.
        try {
          const a = await this.dns.resolve4(domain);
          if (a.length) return { hosts: [domain], error: null };
        } catch {}
        return { hosts: [], error: 'no_mail_server' };
      }
      return { hosts: [], error: 'dns_failed' };
    }
  }

  // Checks several addresses at one domain in one conversation (the first
  // a random address, to recognise servers that accept everything).
  // Returns Map(email -> { status, reason }).
  async checkDomain(domain, emails) {
    const out = new Map();
    const pending = [...new Set(emails.map((e) => e.toLowerCase()))].filter((e) => {
      if (this.results.has(e)) {
        out.set(e, this.results.get(e));
        return false;
      }
      if (!validSyntax(e)) {
        out.set(e, { status: 'invalid', reason: 'not a valid address' });
        return false;
      }
      return true;
    });
    if (!pending.length) return out;
    const remember = (e, r) => {
      out.set(e, r);
      if (r.status !== 'unknown') this.results.set(e, r);
    };
    if (this.reacherUrl) {
      for (const e of pending) remember(e, await this.viaReacher(e));
      return out;
    }
    let info = this.domains.get(domain);
    if (!info) {
      info = await this.mxOf(domain);
      this.domains.set(domain, info);
    }
    if (info.error === 'no_mail_server') {
      for (const e of pending) remember(e, { status: 'invalid', reason: 'the domain has no mail server' });
      return out;
    }
    if (info.error || this.blocked) {
      for (const e of pending) remember(e, { status: 'unknown', reason: this.blocked ? 'this computer cannot reach mail servers (port 25)' : 'the mail server could not be looked up' });
      return out;
    }
    if (info.catchAll === true) {
      for (const e of pending) remember(e, { status: 'catch_all', reason: 'the mail server accepts every address' });
      return out;
    }
    let session = null;
    let lastErr = null;
    for (const host of info.hosts.slice(0, 2)) {
      try {
        session = await smtpSession(this.hostFor ? this.hostFor(host) : host, { port: this.port, timeout: this.timeout, connect: this.connect });
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!session) {
      if (['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECLOSED'].includes(lastErr?.code)) this.unreachable++;
      for (const e of pending) remember(e, { status: 'unknown', reason: 'the mail server could not be reached' });
      return out;
    }
    this.unreachable = 0;
    try {
      let r = await session.send(`EHLO ${this.helo}`);
      if (r.code !== 250) r = await session.send(`HELO ${this.helo}`);
      if (r.code !== 250) throw Object.assign(new Error('helo refused'), { reply: r });
      r = await session.send('MAIL FROM:<>');
      if (r.code !== 250) throw Object.assign(new Error('sender refused'), { reply: r });
      const rcpt = async (addr) => {
        const res = await session.send(`RCPT TO:<${addr}>`);
        if (res.code === 250 || res.code === 251) return 'accepted';
        if ([550, 551, 553, 554].includes(res.code) && !POLICY.test(res.text)) return 'rejected';
        if (res.code === 552 && /mailbox|user|recipient/i.test(res.text) && !POLICY.test(res.text)) return 'rejected';
        return 'unknown';
      };
      if (info.catchAll === undefined) {
        const probe = await rcpt(`lf-${crypto.randomBytes(6).toString('hex')}-nouser@${domain}`);
        info.catchAll = probe === 'accepted' ? true : probe === 'rejected' ? false : null;
      }
      for (const e of pending) {
        if (info.catchAll === true) {
          remember(e, { status: 'catch_all', reason: 'the mail server accepts every address' });
          continue;
        }
        const a = await rcpt(e);
        if (a === 'accepted' && info.catchAll === false) remember(e, { status: 'verified', reason: 'the mail server confirmed the mailbox' });
        else if (a === 'accepted') remember(e, { status: 'unknown', reason: 'accepted, but the server did not say whether it accepts every address' });
        else if (a === 'rejected') remember(e, { status: 'invalid', reason: 'the mail server says the mailbox does not exist' });
        else remember(e, { status: 'unknown', reason: 'the mail server gave no clear answer' });
      }
    } catch (err) {
      for (const e of pending) if (!out.has(e)) remember(e, { status: 'unknown', reason: err?.reply ? `the mail server refused the check (${err.reply.code})` : 'the conversation with the mail server failed' });
    } finally {
      session.close();
    }
    return out;
  }

  async verify(email) {
    const e = String(email || '').toLowerCase();
    return (await this.checkDomain(e.split('@')[1] || '', [e])).get(e);
  }

  // Reacher's answer: is_reachable safe | risky | invalid | unknown.
  async viaReacher(email) {
    try {
      const res = await this.fetchImpl(`${this.reacherUrl}/v0/check_email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to_email: email }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return { status: 'unknown', reason: `the verifier answered HTTP ${res.status}` };
      const j = await res.json();
      const v = j?.is_reachable;
      if (v === 'safe') return { status: 'verified', reason: 'confirmed by the self-hosted verifier' };
      if (v === 'invalid') return { status: 'invalid', reason: 'the self-hosted verifier says it does not exist' };
      if (v === 'risky' && j?.smtp?.is_catch_all) return { status: 'catch_all', reason: 'the mail server accepts every address' };
      return { status: 'unknown', reason: `the self-hosted verifier said "${v || 'unknown'}"` };
    } catch {
      return { status: 'unknown', reason: 'the self-hosted verifier could not be reached' };
    }
  }
}

module.exports = { EmailVerifier, validSyntax, smtpSession };
