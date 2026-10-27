'use strict';

// Email and admin page templates. Every value is HTML-escaped.

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const fmt = (iso) => (iso ? new Date(iso).toUTCString().replace(' GMT', ' UTC') : 'Never');

function currentText(cur, plans) {
  const name = plans?.[cur?.plan]?.name || cur?.plan || '';
  if (!cur || cur.state === 'none' || cur.state === 'inactive') return 'Free';
  if (cur.state === 'expired') return `${name}, expired ${fmt(cur.expiresAt)}`;
  if (cur.state === 'suspended') return `${name}, suspended`;
  return cur.expiresAt ? `${name}, active until ${fmt(cur.expiresAt)}` : `${name}, never expires`;
}

function mail(title, body) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f1;padding:24px;font-family:Arial,sans-serif;color:#17181a">
  <table role="presentation" style="max-width:520px;margin:auto;background:#fff;border:1px solid #e4e3de;border-radius:12px;padding:24px" width="100%"><tr><td>
  <h1 style="font-size:19px;margin:0 0 12px">${esc(title)}</h1>${body}</td></tr></table></body></html>`;
}

function dailyText(p) {
  return !p.daily ? 'unlimited leads' : p.daily.total !== undefined ? `${p.daily.total} leads a day` : `${p.daily.maps} + ${p.daily.facebook} leads a day`;
}

function codeRows(r, plans) {
  const p = plans[r.plan];
  return [
    ['Activation ID', r.id],
    ['Plan', `${p.name}: ${p.priceLabel}, ${dailyText(p)}`],
    ['Current plan', currentText(r.current, plans)],
    ['Device ID', r.device_id],
    ['Code expires', fmt(r.otp_expires_at)],
  ];
}

// To the administrator (the only recipient): the request and its code, to
// give the customer once they have paid.
function adminCodeEmail(r, plans, code) {
  return mail(
    `Activation ${r.id}`,
    `<p style="color:#4b4d52;margin:0 0 6px">Activation code</p>
    <p style="font:700 34px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:10px;margin:0 0 18px">${esc(code)}</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">${codeRows(r, plans)
      .map(([k, v]) => `<tr><td style="padding:6px 0;color:#85868a;width:38%">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`)
      .join('')}</table>
    <p style="color:#85868a;font-size:12px;margin:16px 0 0">Give this code to the customer once the payment has arrived. Entering it in Lead Finder activates the plan above. It works once.</p>`,
  );
}

function adminCodeText(r, plans, code) {
  return `Activation code: ${code}\n\n${codeRows(r, plans)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n\nGive this code to the customer once the payment has arrived. Entering it in Lead Finder activates the plan above. It works once.`;
}

const PAGE_CSS = `body{margin:0;background:#f4f4f1;font:15px/1.5 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#17181a}
main{max-width:560px;margin:40px auto;background:#fff;border:1px solid #e4e3de;border-radius:12px;padding:28px}
h1{font-size:21px;margin:0 0 6px}p{color:#4b4d52}td{padding:6px 0;vertical-align:top}td:first-child{color:#85868a;width:38%}
fieldset{border:1px solid #e4e3de;border-radius:10px;padding:10px 14px;margin:18px 0}label{display:block;padding:4px 0}
button{font:600 15px system-ui,Arial,sans-serif;color:#fff;border:0;border-radius:8px;padding:12px 22px;cursor:pointer}
`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;
}

function result(title, text) {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);
}

module.exports = { esc, fmt, adminCodeEmail, adminCodeText, result };
