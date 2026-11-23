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
// 'invalid'; so is a timeout or a connection this computer could not make.
// Each result also says why ({ reason, code, detail: the server's own
// words }) and whether asking again later may help ({ temporary }: a
// greylisting server, a timeout, a DNS failure); a full mailbox is
// { fullInbox: true }. The rules for reading a server's answer follow
// Reacher's (core/src/smtp/parser.rs).

const net = require('node:net');
const dnsDefault = require('node:dns').promises;
const crypto = require('node:crypto');
const os = require('node:os');

const SYNTAX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
// Refusals that are about the sender or the connection, not the mailbox.
const POLICY = /block|spam|blacklist|black list|listed|policy|reputation|\bpbl\b|\bsbl\b|spamhaus|abusix|dnsbl|proofpoint|banned|not allowed|denied|reverse dns|ptr|helo|client host|rejected due to|authentication|relay|not yet authorized|try again later/i;
// The mailbox does not exist (the server's words, or enhanced codes 5.1.x).
const NO_MAILBOX = /\b5\.1\.\d+\b|address rejected|unrouteable|does not exist|doesn'?t exist|dosn't exist|invalid (email )?address|invalid recipient|may not exist|recipient (invalid|rejected|unknown|not found|is not exist)|unknown (recipient|user|local part)|undeliverable|user unknown|no such (user|mailbox|recipient|person)|mailbox (not found|unavailable|is unavailable|unknown)|invalid mailbox|no mailbox|not a valid mailbox|not our customer|account closed|no longer available|could not be found|address error|address is not handled|verify address failed|unable to verify user|utilisateur inconnu|no mail-enabled subscriptions/i;
const FULL = /insufficient|mailbox (is )?full|quota exceeded|over quota|too many messages|out of storage space|exceeded storage allocation|\b5\.2\.2\b|\b4\.2\.2\b/i;
const DISABLED = /\b5\.2\.1\b|disabled|discontinued|inactive|suspended/i;
const short = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);

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
  // reacherSecret: its x-reacher-secret header (when the server has one); from: MAIL FROM ('' = <>).
  constructor({ dns = dnsDefault, connect, port = 25, timeout = 12_000, helo = defaultHelo(), from = '', reacherUrl = null, reacherSecret = null, fetchImpl = globalThis.fetch, hostFor = null } = {}) {
    this.dns = dns;
    this.connect = connect;
    this.port = port;
    this.timeout = timeout;
    this.helo = helo;
    this.from = from;
    this.reacherUrl = reacherUrl ? String(reacherUrl).replace(/\/$/, '') : null;
    this.reacherSecret = reacherSecret || null;
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

  // The answer to RCPT TO: { a: accepted | rejected | full | disabled | temporary | refused | unclear, code, detail }.
  static readRcpt(res) {
    const text = String(res.text || '');
    const out = (a) => ({ a, code: res.code, detail: short(text) });
    if (res.code === 250 || res.code === 251) return out('accepted');
    if (res.code >= 400 && res.code < 500) return out(FULL.test(text) && !/greylist|graylist|grey-list|gray-list|postgrey/i.test(text) ? 'full' : 'temporary');
    if (res.code >= 500 && res.code < 600) {
      if (POLICY.test(text) && !/\b5\.1\.\d+\b/.test(text)) return out('refused');
      if (FULL.test(text)) return out('full');
      if (DISABLED.test(text) && !NO_MAILBOX.test(text)) return out('disabled');
      if (NO_MAILBOX.test(text)) return out('rejected');
      // A bare "550" (no words) is how many servers say "no such user".
      if ([550, 551, 553].includes(res.code) && text.replace(/^\d{3}[ -]?/gm, '').trim().length < 4) return out('rejected');
      return out('unclear');
    }
    return out('unclear');
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
      if (info.error) this.domains.delete(domain); // a DNS failure: looked up again next time
      for (const e of pending) remember(e, { status: 'unknown', reason: this.blocked ? 'this computer cannot reach mail servers (port 25 is blocked on this network)' : 'the domain’s mail server could not be looked up (DNS)', temporary: true, blocked: this.blocked });
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
      const greeting = lastErr?.reply ? ` (it answered ${lastErr.reply.code})` : lastErr?.code === 'ETIMEDOUT' ? ' (timed out)' : '';
      for (const e of pending) remember(e, { status: 'unknown', reason: `the mail server could not be reached on port ${this.port}${greeting}`, detail: short(lastErr?.reply?.text), temporary: true });
      return out;
    }
    this.unreachable = 0;
    try {
      let r = await session.send(`EHLO ${this.helo}`);
      if (r.code !== 250) r = await session.send(`HELO ${this.helo}`);
      if (r.code !== 250) throw Object.assign(new Error('helo refused'), { reply: r });
      r = await session.send(`MAIL FROM:<${this.from || ''}>`);
      if (r.code !== 250) throw Object.assign(new Error('sender refused'), { reply: r });
      const rcpt = async (addr) => EmailVerifier.readRcpt(await session.send(`RCPT TO:<${addr}>`));
      if (info.catchAll === undefined || info.catchAll === null) {
        const probe = await rcpt(`lf-${crypto.randomBytes(6).toString('hex')}-nouser@${domain}`);
        info.catchAll = probe.a === 'accepted' ? true : probe.a === 'rejected' || probe.a === 'disabled' ? false : null;
      }
      for (const e of pending) {
        if (info.catchAll === true) {
          remember(e, { status: 'catch_all', reason: 'the mail server accepts every address, so this one cannot be confirmed' });
          continue;
        }
        const x = await rcpt(e);
        const said = { code: x.code, detail: x.detail };
        if (x.a === 'accepted' && info.catchAll === false) remember(e, { status: 'verified', reason: 'the mail server confirmed the mailbox', ...said });
        else if (x.a === 'accepted') remember(e, { status: 'unknown', reason: 'accepted, but the server did not say whether it accepts every address', ...said, temporary: true });
        else if (x.a === 'rejected') remember(e, { status: 'invalid', reason: 'the mail server says the mailbox does not exist', ...said });
        else if (x.a === 'disabled') remember(e, { status: 'invalid', reason: 'the mailbox is disabled', ...said });
        else if (x.a === 'full') remember(e, { status: 'unknown', reason: 'the mailbox is full', fullInbox: true, ...said });
        else if (x.a === 'temporary') remember(e, { status: 'unknown', reason: 'the mail server asked to try again later (greylisting or a temporary limit)', ...said, temporary: true });
        else if (x.a === 'refused') remember(e, { status: 'unknown', reason: 'the mail server refused to answer for this computer (spam list or policy), not for the mailbox', ...said, temporary: true });
        else remember(e, { status: 'unknown', reason: 'the mail server gave no clear answer', ...said });
      }
    } catch (err) {
      for (const e of pending) if (!out.has(e)) remember(e, { status: 'unknown', reason: err?.reply ? `the mail server refused the check (${err.reply.code})` : 'the conversation with the mail server failed', code: err?.reply?.code, detail: short(err?.reply?.text), temporary: true });
    } finally {
      session.close();
    }
    return out;
  }

  async verify(email) {
    const e = String(email || '').toLowerCase();
    return (await this.checkDomain(e.split('@')[1] || '', [e])).get(e);
  }

  // Reacher's answer (is_reachable safe | risky | invalid | unknown, and its
  // details): a "risky" address is read from the details, so a role or
  // disposable address that exists is { status: 'verified', role, disposable }
  // and the caller decides.
  async viaReacher(email) {
    try {
      const headers = { 'content-type': 'application/json' };
      if (this.reacherSecret) headers['x-reacher-secret'] = this.reacherSecret;
      const res = await this.fetchImpl(`${this.reacherUrl}/v0/check_email`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to_email: email, ...(this.from ? { from_email: this.from } : {}), ...(this.helo && this.helo !== 'localhost' ? { hello_name: this.helo } : {}) }),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 401 || res.status === 403) return { status: 'unknown', reason: 'the Reacher server refused the request: check its secret', temporary: true, engineError: true };
      if (!res.ok) return { status: 'unknown', reason: `the Reacher server answered HTTP ${res.status}`, temporary: true, engineError: true };
      const j = await res.json();
      const v = j?.is_reachable;
      const smtp = j?.smtp || {};
      const flags = { disposable: Boolean(j?.misc?.is_disposable), role: Boolean(j?.misc?.is_role_account), detail: short(j?.debug?.smtp?.error?.message || j?.smtp?.error?.message || '') };
      if (j?.syntax && j.syntax.is_valid_syntax === false) return { status: 'invalid', reason: 'not a valid address', ...flags };
      if (j?.mx && j.mx.accepts_mail === false) return { status: 'invalid', reason: 'the domain has no mail server', ...flags };
      if (v === 'invalid') return { status: 'invalid', reason: smtp.is_disabled ? 'the mailbox is disabled' : 'the mail server says the mailbox does not exist (Reacher)', ...flags };
      if (v === 'unknown' || !v) return { status: 'unknown', reason: smtp.can_connect_smtp === false ? 'Reacher could not reach the mail server' : 'Reacher could not get a clear answer', temporary: true, ...flags };
      if (smtp.is_catch_all) return { status: 'catch_all', reason: 'the mail server accepts every address, so this one cannot be confirmed', ...flags };
      if (smtp.has_full_inbox) return { status: 'unknown', reason: 'the mailbox is full', fullInbox: true, ...flags };
      if (smtp.is_disabled) return { status: 'invalid', reason: 'the mailbox is disabled', ...flags };
      if (v === 'safe' || smtp.is_deliverable) return { status: 'verified', reason: 'the mail server confirmed the mailbox (Reacher)', ...flags };
      return { status: 'unknown', reason: `Reacher said "${v}"`, ...flags };
    } catch (err) {
      return { status: 'unknown', reason: err?.name === 'TimeoutError' ? 'the Reacher server did not answer in time' : 'the Reacher server could not be reached', temporary: true, engineError: true };
    }
  }
}

module.exports = { EmailVerifier, validSyntax, smtpSession };
