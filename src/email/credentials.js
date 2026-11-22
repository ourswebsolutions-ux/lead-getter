'use strict';

// Email accounts given as text: "you@gmail.com abcd efgh ijkl mnop", one per
// line for several ("email, app password[, sender name]"), or in a sentence
// ("mera gmail ali@gmail.com hai, app password abcd efgh ijkl mnop").
// The passwords are taken out of the text here, in the main process: what
// goes on (to the AI, the history, the logs) is the text without them.

const dns = require('node:dns').promises;

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
// Google's app passwords: 16 letters, often shown in four groups.
const APP_PASSWORD = /\b([a-z]{4})[ -]?([a-z]{4})[ -]?([a-z]{4})[ -]?([a-z]{4})\b/i;
const LABEL = /(?:\bapp[\s-]*password|\bpassword|\bpasswd|\bpass\b|\bpwd\b|پاس ?ورڈ)\s*(?:is\b|hai\b|he\b|:|=|-)?\s*/i;

const PROVIDERS = [
  { test: /^(gmail|googlemail)\.com$/i, mx: /google(mail)?\.com$|googlemail/i, name: 'Gmail', host: 'smtp.gmail.com', port: 465, encryption: 'ssl', imapHost: 'imap.gmail.com' },
  { test: /^(outlook|hotmail|live|msn)\.[a-z.]+$/i, mx: /outlook\.com$|protection\.outlook/i, name: 'Outlook', host: 'smtp.office365.com', port: 587, encryption: 'starttls', imapHost: 'outlook.office365.com' },
  { test: /^(yahoo|ymail)\.[a-z.]+$/i, mx: /yahoodns\.net$/i, name: 'Yahoo', host: 'smtp.mail.yahoo.com', port: 465, encryption: 'ssl', imapHost: 'imap.mail.yahoo.com' },
  { test: /^zoho(mail)?\.[a-z.]+$/i, mx: /zoho\.(com|eu|in)$/i, name: 'Zoho', host: 'smtp.zoho.com', port: 465, encryption: 'ssl', imapHost: 'imap.zoho.com' },
  { test: /^$/, mx: /hostinger\.(com|io)$/i, name: 'Hostinger', host: 'smtp.hostinger.com', port: 465, encryption: 'ssl', imapHost: 'imap.hostinger.com' },
];

// The provider's settings for an address: by its domain, else by where its
// mail goes (Google Workspace, Microsoft 365... on the company's own domain).
async function providerFor(email, { resolveMx = dns.resolveMx } = {}) {
  const domain = String(email).split('@')[1]?.toLowerCase() || '';
  const byName = PROVIDERS.find((p) => p.test.test(domain));
  if (byName) return byName;
  try {
    const mx = await Promise.race([resolveMx(domain), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 5000))]);
    for (const r of mx || []) {
      const hit = PROVIDERS.find((p) => p.mx.test(String(r.exchange).toLowerCase()));
      if (hit) return hit;
    }
  } catch {}
  return null;
}

// The password after an address on the same line: a labelled one, Google's
// 16-letter form, or the rest of an "email, password[, name]" line.
function passwordIn(line, email) {
  const at = line.indexOf(email);
  const after = line.slice(at + email.length);
  const before = line.slice(0, at);
  // A list line ("email, password[, sender name]"): the email first.
  if (!before.trim()) {
    const app0 = /^\s*[,;:\t|]?\s*([a-z]{4})[ -]?([a-z]{4})[ -]?([a-z]{4})[ -]?([a-z]{4})(?:\s*[,;\t|]\s*(.{1,80}))?\s*$/i.exec(after);
    if (app0) return { password: app0.slice(1, 5).join(''), raw: after.slice(after.search(/[a-z]/i)).replace(/\s*[,;\t|]\s*.{1,80}$/, '').replace(/\s+$/, ''), name: app0[5] ? app0[5].trim() : null };
    const row = /^\s*[,;:\t|]\s*([^\s,;|]{6,200})(?:\s*[,;\t|]\s*(.{1,80}))?\s*$/.exec(after);
    if (row && !EMAIL.test(row[1])) return { password: row[1], raw: row[1], name: row[2] ? row[2].trim() : null };
  }
  const la = LABEL.exec(after);
  const lb = la ? null : LABEL.exec(before);
  const zone = la ? after.slice(la.index + la[0].length) : lb ? before.slice(lb.index + lb[0].length) : after;
  const app = APP_PASSWORD.exec(zone);
  if (app && (la || lb || /^\s*[,;:\t|]?\s*$/.test(zone.slice(0, app.index)))) return { password: app.slice(1).join(''), raw: app[0], name: null };
  if (la || lb) {
    const tok = /^\s*["'“]?([^\s"'”,;]{6,200})/.exec(zone);
    return tok ? { password: tok[1], raw: tok[1], name: null } : null;
  }
  // "email, password[, sender name]" / "email:password" / "email password".
  const m = /^\s*[,;:\t|]?\s*([^\s,;|]{6,200})(?:\s*[,;\t|]\s*(.{1,80}))?\s*$/.exec(after);
  // Without a label or a separator only something that looks like a
  // password (letters with digits or symbols), never an ordinary word.
  if (m && !EMAIL.test(m[1]) && !/^https?:/i.test(m[1]) && /[A-Za-z]/.test(m[1]) && /[\d\W_]/.test(m[1])) return { password: m[1], raw: m[1], name: m[2] ? m[2].trim() : null };
  return null;
}

// { accounts: [{ email, password, name }], redacted } — redacted is the text
// with every password replaced.
function extractAccounts(text) {
  const accounts = [];
  let redacted = String(text || '');
  for (const line of redacted.split(/\r?\n/)) {
    const found = line.match(new RegExp(EMAIL.source, 'g')) || [];
    for (const email of found) {
      const p = passwordIn(line, email);
      if (!p) continue;
      if (accounts.some((a) => a.email === email.toLowerCase())) continue;
      accounts.push({ email: email.toLowerCase(), password: p.password, name: p.name, raw: p.raw });
    }
  }
  for (const a of accounts) redacted = redacted.split(a.raw).join('[password saved securely]');
  return { accounts: accounts.map(({ raw, ...a }) => a), redacted };
}

module.exports = { extractAccounts, providerFor, PROVIDERS };
