'use strict';

// Email and admin page templates. Every value is HTML-escaped.

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const fmt = (iso) => (iso ? new Date(iso).toUTCString().replace(' GMT', ' UTC') : 'Never');

function currentText(cur) {
  const plan = cur?.plan ? ` (${cur.plan})` : '';
  if (!cur || cur.state === 'none') return 'No subscription';
  if (cur.state === 'expired') return `Expired ${fmt(cur.expiresAt)}${plan}`;
  if (cur.state === 'suspended') return 'Suspended on the subscription website';
  if (cur.state === 'inactive') return 'Registered on the subscription website, not activated';
  if (cur.state === 'unavailable') return 'Unknown (subscription website unreachable)';
  return cur.expiresAt ? `Active until ${fmt(cur.expiresAt)}${plan}` : `Active, lifetime`;
}

function rows(app) {
  return [
    ['Application ID', app.id],
    ['Plan', `${app.plan.name}: ${app.plan.priceLabel} (${app.plan.duration})`],
    ['Device ID', app.deviceId],
    ['Applicant email', app.email ? `${app.email} (not yet confirmed)` : 'Not provided'],
    ['Current subscription', currentText(app.current)],
    ...(app.website ? [['Subscription website', WEBSITE_TEXT[app.website] || app.website]] : []),
    ['Submitted', fmt(app.createdAt)],
  ];
}

const WEBSITE_TEXT = {
  registered: 'Device ID registered (new users stay inactive until you activate them)',
  email_in_use: 'Not registered: this email already belongs to another Device ID there (nothing was changed)',
  invalid: 'Not registered: the website rejected the Device ID or email',
  unavailable: 'Not reachable right now; registration is retried automatically',
};

function button(href, label, color) {
  return `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:${color};color:#fff;text-decoration:none;font-weight:600;font-family:Arial,sans-serif;font-size:15px">${esc(label)}</a>`;
}

function adminEmail(app, approveUrl, cancelUrl) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f1;padding:24px;font-family:Arial,sans-serif;color:#17181a">
  <table role="presentation" style="max-width:560px;margin:auto;background:#fff;border:1px solid #e4e3de;border-radius:12px;padding:24px" width="100%">
  <tr><td>
    <h1 style="font-size:20px;margin:0 0 4px">New subscription request</h1>
    <p style="color:#4b4d52;margin:0 0 16px">Lead Finder · ${esc(app.id)}</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
      ${rows(app).map(([k, v]) => `<tr><td style="padding:6px 0;color:#85868a;width:42%">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`).join('')}
    </table>
    <h2 style="font-size:15px;margin:18px 0 6px">Message from the applicant</h2>
    <p style="white-space:pre-wrap;background:#f9f9f7;border:1px solid #e4e3de;border-radius:8px;padding:12px;margin:0">${esc(app.message || '(no message)')}</p>
    <p style="color:#4b4d52;font-size:13px">The payment screenshot is attached.</p>
    <p style="margin:22px 0 8px">${button(approveUrl, 'Approve Subscription', '#165f4a')}&nbsp;&nbsp;${button(cancelUrl, 'Cancel Subscription', '#b4261b')}</p>
    <p style="color:#85868a;font-size:12px;margin:12px 0 0">Each button opens a confirmation page; nothing changes until you confirm there. The links work once and expire in 7 days.</p>
  </td></tr></table></body></html>`;
}

function adminEmailText(app, approveUrl, cancelUrl) {
  return `New Lead Finder subscription request\n\n${rows(app).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nMessage:\n${app.message || '(no message)'}\n\nApprove Subscription: ${approveUrl}\nCancel Subscription: ${cancelUrl}\n\nThe payment screenshot is attached. Links work once and expire in 7 days.`;
}

const PAGE_CSS = `body{margin:0;background:#f4f4f1;font:15px/1.5 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#17181a}
main{max-width:620px;margin:40px auto;background:#fff;border:1px solid #e4e3de;border-radius:12px;padding:28px}
h1{font-size:21px;margin:0 0 6px}p{color:#4b4d52}td{padding:6px 0;vertical-align:top}td:first-child{color:#85868a;width:40%}
.msg{white-space:pre-wrap;background:#f9f9f7;border:1px solid #e4e3de;border-radius:8px;padding:12px;color:#17181a}
img{max-width:100%;border:1px solid #e4e3de;border-radius:8px;margin-top:8px}
button{font:600 15px system-ui,Arial,sans-serif;color:#fff;border:0;border-radius:8px;padding:12px 22px;cursor:pointer}
.approve{background:#165f4a}.cancel{background:#b4261b}`;

function confirm(app, action, token) {
  const plan = app.planInfo;
  const verb = action === 'approve' ? 'Approve Subscription' : 'Cancel Subscription';
  // Relative URLs (from …/admin/applications/<id>/<action>) keep working when
  // the server is served under a path such as /lead-getter.
  const q = `?token=${encodeURIComponent(token)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(verb)} · ${esc(app.id)}</title><style>${PAGE_CSS}</style></head><body><main>
  <h1>${esc(verb)}?</h1><p>Application <b>${esc(app.id)}</b>. Nothing has changed yet. Confirm below.</p>
  <table>${[
    ['Plan', `${plan.name}: ${plan.priceLabel} (${plan.duration})`],
    ['Applicant email', app.email || 'Not provided'],
    ['Current subscription', currentText(app.current)],
    ['Submitted', fmt(app.created_at)],
  ]
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('')}</table>
  <p class="msg">${esc(app.message || '(no message)')}</p>
  <img src="screenshot${esc(q)}" alt="Payment screenshot">
  <form method="post" action="${action}" style="margin-top:20px">
    <input type="hidden" name="token" value="${esc(token)}">
    <button type="submit" class="${action}">${esc(verb)}</button>
  </form></main></body></html>`;
}

function result(title, text) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
}

function verifyEmail(url) {
  return `<p style="font-family:Arial,sans-serif">Please confirm this email address for Lead Finder subscription notices:</p><p>${button(url, 'Confirm email', '#165f4a')}</p><p style="font-family:Arial,sans-serif;color:#85868a;font-size:12px">If you did not apply for a Lead Finder subscription, ignore this email.</p>`;
}

function userNotice(subject, text) {
  return `<div style="font-family:Arial,sans-serif;max-width:520px"><h2 style="font-size:18px">${esc(subject)}</h2><p>${esc(text)}</p></div>`;
}

module.exports = { adminEmail, adminEmailText, confirm, result, verifyEmail, userNotice, esc };
