import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';

// Outreach > Email: SMTP accounts and email campaigns to leads from the
// Leads database. Passwords are entered here and never shown again.

const api = window.leadFinder;

const STATUS = { draft: 'Draft', running: 'Running', paused: 'Paused', stopped: 'Stopped', completed: 'Completed' };
const STATE = { queued: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped', uncertain: 'Uncertain' };
const WAITING = { delay: 'waiting for the delay between emails', daily_limit: 'daily limit reached; continues tomorrow', retry_later: 'retrying failed emails later', verifying: 'verifying the next email addresses before sending', followups: 'waiting for the next follow-ups', schedule: 'outside its sending days and hours', accounts_off: 'its sending accounts are switched off', accounts_failing: 'its sending accounts are failing (test them)', new_leads: 'waiting for new leads in the category' };
// A lead's status in a campaign (from its records).
const LEAD_STATUS = {
  new: ['Verifying', 'checking'],
  ready: ['Ready', 'ready'],
  sending: ['Sending', 'sending'],
  sent: ['Sent', 'sent'],
  followup_scheduled: ['Follow-up scheduled', 'sched'],
  sequence_completed: ['Sequence completed', 'sent'],
  clicked: ['Clicked', 'clicked'],
  replied: ['Replied', 'replied'],
  interested: ['Interested', 'interested'],
  not_interested: ['Not interested', 'muted'],
  bounced: ['Bounced', 'failed'],
  invalid: ['Invalid email', 'failed'],
  unsubscribed: ['Unsubscribed', 'muted'],
  stopped: ['Stopped', 'muted'],
  failed: ['Failed', 'failed'],
  retrying: ['Retrying', 'sending'],
  uncertain: ['Uncertain', 'sending'],
  skipped: ['Skipped', 'muted'],
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (v) => {
  const [h, m] = String(v || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const zones = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Asia/Karachi', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'UTC'];
  }
})();

// The follow-ups of a campaign: steps after the first email, each sent only
// if the lead has not replied (saved on its own: also while it runs).
function FollowUps({ snap, notify, reload }) {
  const [f, setF] = useState(() => JSON.parse(JSON.stringify(snap.followups || { on: false, steps: [] })));
  const [dirty, setDirty] = useState(false);
  const key = JSON.stringify(snap.followups);
  useEffect(() => {
    if (!dirty) setF(JSON.parse(key || '{"on":false,"steps":[]}'));
  }, [key, dirty]);
  const edit = (fn) => {
    setF((x) => {
      const y = JSON.parse(JSON.stringify(x));
      fn(y);
      return y;
    });
    setDirty(true);
  };
  async function save() {
    const r = await api.emailUpdate(snap.id, { followups: { on: f.on, steps: f.steps.map((x) => ({ ...x, days: Number(x.days) })) } });
    if (!r.ok) return notify({ type: 'error', text: r.error });
    setDirty(false);
    notify({ type: 'ok', text: f.on ? `Follow-ups saved: ${f.steps.length} step${f.steps.length === 1 ? '' : 's'}.` : 'Follow-ups off.' });
    reload();
  }
  const c = snap.followupCounts || {};
  let day = 1;
  return (
    <section className="panel em-seq" aria-label="Follow-ups">
      <div className="or-card-head">
        <h3>
          <Icon name="repeat" size={14} /> Follow-ups
        </h3>
        {(c.sent > 0 || c.pending > 0) && (
          <span className="muted small">
            {c.sent} sent · {c.pending} scheduled{c.nextAt ? ` · next ${when(c.nextAt)}` : ''}
          </span>
        )}
        <button type="button" role="switch" aria-checked={f.on} aria-label="Send follow-ups" className={`switch ${f.on ? 'on' : ''}`} onClick={() => edit((x) => (x.on = !x.on))}>
          <span className="switch-knob" />
        </button>
      </div>
      <p className="muted small">Sent only to leads who have not replied. A reply, bounce, unsubscribe or stop ends a lead’s follow-ups. {snap.aiWrite ? 'With AI on, each step is a prompt: the AI writes it from the earlier email.' : 'An empty subject replies in the same thread (Re: …).'}</p>
      <ol className="em-steps-list">
        <li className="em-step first">
          <span className="em-step-day">Day 1</span>
          <span>First email (above)</span>
        </li>
        {f.steps.map((st, i) => {
          day += Number(st.days) || 0;
          return (
            <li key={i} className="em-step" aria-label={`Follow-up ${i + 1}`}>
              <div className="em-step-top">
                <span className="em-step-day">Day {Math.round(day * 10) / 10}</span>
                <strong>Follow-up {i + 1}</strong>
                <label className="em-step-wait">
                  wait
                  <input type="number" min={1} max={60} step={0.5} value={st.days} aria-label={`Follow-up ${i + 1}: days to wait`} onChange={(e) => edit((x) => (x.steps[i].days = e.target.value))} />
                  days after the previous email, if no reply
                </label>
                <button type="button" className="icon-btn" aria-label={`Remove follow-up ${i + 1}`} onClick={() => edit((x) => x.steps.splice(i, 1))}>
                  <Icon name="trash" size={12} />
                </button>
              </div>
              <input aria-label={`Follow-up ${i + 1} subject`} placeholder="Subject (empty: reply in the same thread)" value={st.subject} maxLength={200} onChange={(e) => edit((x) => (x.steps[i].subject = e.target.value))} />
              <textarea rows={4} aria-label={`Follow-up ${i + 1} email`} placeholder={snap.aiWrite ? 'Prompt, e.g. A friendly nudge: ask if they saw my email about a website; offer a quick call.' : 'Hello {name},\n\nJust following up on my email…'} value={st.body} onChange={(e) => edit((x) => (x.steps[i].body = e.target.value))} />
            </li>
          );
        })}
      </ol>
      <div className="em-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={f.steps.length >= 5} onClick={() => edit((x) => x.steps.push({ days: x.steps.length ? 3 : 2, subject: '', body: '' }))}>
          <Icon name="plus" size={13} /> Add follow-up
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty} onClick={save}>
          <Icon name="check" size={13} /> Save follow-ups
        </button>
      </div>
    </section>
  );
}

// The days and hours a campaign may send, in a time zone (saved on its own).
function Schedule({ snap, notify, reload }) {
  const init = () => ({ ...(snap.schedule || {}), tz: snap.schedule?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || '' });
  const [sc, setSc] = useState(init);
  const [dirty, setDirty] = useState(false);
  const key = JSON.stringify(snap.schedule);
  useEffect(() => {
    if (!dirty) setSc(init());
  }, [key, dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = (patch) => {
    setSc((x) => ({ ...x, ...patch }));
    setDirty(true);
  };
  async function save() {
    const r = await api.emailUpdate(snap.id, { schedule: sc });
    if (!r.ok) return notify({ type: 'error', text: r.error });
    setDirty(false);
    notify({ type: 'ok', text: sc.on ? 'Sending schedule saved.' : 'Sends at any time.' });
    reload();
  }
  return (
    <section className="panel em-seq" aria-label="Sending schedule">
      <div className="or-card-head">
        <h3>
          <Icon name="calendar" size={14} /> Sending schedule
        </h3>
        {snap.windowOpensAt && <span className="muted small">Starts again {when(snap.windowOpensAt)}</span>}
        <button type="button" role="switch" aria-checked={Boolean(sc.on)} aria-label="Only on these days and hours" className={`switch ${sc.on ? 'on' : ''}`} onClick={() => edit({ on: !sc.on })}>
          <span className="switch-knob" />
        </button>
      </div>
      {!sc.on ? (
        <p className="muted small">Off: sends at any time. Turn on to send only on chosen days and hours; outside them the campaign waits and goes on by itself.</p>
      ) : (
        <div className="em-sched">
          <div className="em-days" role="group" aria-label="Sending days">
            {DAYS.map((name, i) => (
              <button key={name} type="button" className={`em-day ${sc.days.includes(i) ? 'on' : ''}`} aria-pressed={sc.days.includes(i)} onClick={() => edit({ days: sc.days.includes(i) ? sc.days.filter((x) => x !== i) : [...sc.days, i].sort() })}>
                {name}
              </button>
            ))}
          </div>
          <label>
            From <input type="time" aria-label="Sending from" value={hhmm(sc.start)} onChange={(e) => edit({ start: toMin(e.target.value) })} />
          </label>
          <label>
            to <input type="time" aria-label="Sending until" value={hhmm(sc.end)} onChange={(e) => edit({ end: toMin(e.target.value) })} />
          </label>
          <label>
            Time zone{' '}
            <select aria-label="Time zone" value={sc.tz} onChange={(e) => edit({ tz: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="em-actions">
        <span className="grow" />
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty} onClick={save}>
          <Icon name="check" size={13} /> Save schedule
        </button>
      </div>
    </section>
  );
}

// Everything that happened with one lead in a campaign.
const EVENT = { added: 'Added', email: 'First email', followup: 'Follow-up', click: 'Clicked a link', reply: 'Replied', reply_text: 'Their reply', answer: 'Your answer', auto_reply: 'Automatic reply', bounce: 'Bounced', stopped: 'Stopped' };
function LeadTimeline({ campaignId, email, onClose }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState('');
  useEsc(onClose);
  useEffect(() => {
    api.emailTimeline(campaignId, email).then((r) => (r.ok ? setEvents(r.events) : setError(r.error)));
  }, [campaignId, email]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="em-modal wide" role="dialog" aria-modal="true" aria-label="Email history">
        <header className="em-modal-head">
          <span className="em-mark">
            <Icon name="mail" size={16} />
          </span>
          <div>
            <h2>{email}</h2>
            <p>Every email, follow-up, reply and event, oldest first</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        {error && <p className="em-error">{error}</p>}
        {!events ? (
          <p className="muted small">Loading…</p>
        ) : (
          <ol className="em-timeline">
            {events.map((e, i) => (
              <li key={i} className={`ev-${e.kind}`}>
                <div className="em-tl-head">
                  <strong>
                    {EVENT[e.kind] || e.kind}
                    {e.kind === 'followup' ? ` ${e.step}` : ''}
                  </strong>
                  <span className="muted small">
                    {e.dueAt ? `scheduled for ${when(e.dueAt)}` : when(e.at)}
                    {e.state && e.state !== 'sent' && !e.dueAt ? ` · ${STATE[e.state] || e.state}` : ''}
                    {e.account ? ` · from ${e.account}` : ''}
                  </span>
                </div>
                {e.subject && <div className="em-tl-subject">{e.subject}</div>}
                {e.error && <div className="em-err-text">{e.error}</div>}
                {e.text && <pre>{e.text}</pre>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// The whole email activity (from the records).
function EmailDashboard() {
  const [d, setD] = useState(null);
  useEffect(() => {
    const load = () => api.emailDashboard().then((r) => r.ok && setD(r.dashboard));
    load();
    return api.onEmail(load);
  }, []);
  if (!d) return null;
  const tiles = [
    ['Active campaigns', d.campaigns.running],
    ['Paused', d.campaigns.paused],
    ['Completed', d.campaigns.completed],
    ['Leads emailed', d.leads],
    ['Sent today', d.sentToday],
    ['Waiting to send', d.scheduled],
    ['Follow-ups scheduled', d.followupsPending],
    ['Follow-ups sent', d.followupsSent],
    ['Replies', `${d.replies} (${d.replyRate}%)`],
    ['Interested', d.interested],
    ['Failed', d.failed],
    ['Bounced', `${d.bounced} (${d.bounceRate}%)`],
    ['Unsubscribed', `${d.unsubscribed} (${d.unsubscribeRate}%)`],
  ];
  return (
    <section className="panel em-dash" aria-label="Email dashboard">
      <h3>
        <Icon name="grid" size={14} /> Email activity
      </h3>
      <div className="em-dash-grid">
        {tiles.map(([label, v]) => (
          <div key={label}>
            <strong>{v}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <p className="muted small">Sent means accepted by the receiving mail server; inbox delivery itself cannot be confirmed. Rates are of first emails sent.</p>
    </section>
  );
}
const PRESETS = [
  ['Gmail', { host: 'smtp.gmail.com', port: 465, encryption: 'ssl' }],
  ['Outlook', { host: 'smtp.office365.com', port: 587, encryption: 'starttls' }],
  ['Zoho', { host: 'smtp.zoho.com', port: 465, encryption: 'ssl' }],
  ['Hostinger', { host: 'smtp.hostinger.com', port: 465, encryption: 'ssl' }],
];
const VARS = ['{name}', '{business}', '{email}'];
const IMAP = { 'smtp.gmail.com': 'imap.gmail.com', 'smtp.office365.com': 'outlook.office365.com', 'smtp.zoho.com': 'imap.zoho.com', 'smtp.hostinger.com': 'imap.hostinger.com' };
const imapGuess = (h) => IMAP[String(h || '').toLowerCase()] || (/^smtp\./i.test(h || '') ? `imap.${h.slice(5)}` : '');
const when = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function useEsc(fn) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && fn();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [fn]);
}

function AccountForm({ account, onClose, onSaved, onSeveral }) {
  const [f, setF] = useState(() => ({ name: account?.name || '', senderName: account?.senderName || '', email: account?.email || '', host: account?.host || '', port: account?.port || 465, username: account?.username || '', password: '', encryption: account?.encryption || 'ssl', imapOn: account ? account.imapOn !== false : true, imapHost: account?.imapHost || '' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(null);
  useEsc(onClose);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save(e, andTest = false) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    const input = { ...f, port: Number(f.port), username: f.username || f.email };
    const r = account ? await api.emailAccountUpdate(account.id, input) : await api.emailAccountAdd(input);
    if (!r.ok) {
      setBusy(false);
      return setError(r.error);
    }
    if (andTest) {
      setTesting('testing');
      const t = await api.emailAccountTest(r.account.id);
      setTesting(t.ok ? 'ok' : t.error);
      setBusy(false);
      onSaved(t.account || r.account, !t.ok);
      return;
    }
    setBusy(false);
    onSaved(r.account);
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="em-modal" role="dialog" aria-modal="true" aria-label={account ? 'Edit email account' : 'Add email account'} onSubmit={save}>
        <header className="em-modal-head">
          <span className="em-mark">
            <Icon name="mail" size={16} />
          </span>
          <div>
            <h2>{account ? 'Edit email account' : 'Add email account'}</h2>
            <p>SMTP details from your email provider</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="em-presets" role="group" aria-label="Presets">
          {PRESETS.map(([label, p]) => (
            <button key={label} type="button" className={`em-chip ${f.host === p.host ? 'on' : ''}`} onClick={() => setF((x) => ({ ...x, ...p, imapHost: '' }))}>
              {label}
            </button>
          ))}
        </div>
        <div className="em-form-grid">
          <label>
            <span>Account name</span>
            <input value={f.name} onChange={set('name')} placeholder="Company Gmail" maxLength={60} required autoFocus />
          </label>
          <label>
            <span>Sender name</span>
            <input value={f.senderName} onChange={set('senderName')} placeholder="Ali from Axora" maxLength={80} />
          </label>
          <label className="span2">
            <span>Email address</span>
            <input type="email" value={f.email} onChange={set('email')} placeholder="you@company.com" maxLength={254} required />
          </label>
          <label>
            <span>SMTP host</span>
            <input value={f.host} onChange={set('host')} placeholder="smtp.gmail.com" maxLength={253} required />
          </label>
          <label>
            <span>Port</span>
            <input type="number" min={1} max={65535} value={f.port} onChange={set('port')} required />
          </label>
          <label>
            <span>SMTP username</span>
            <input value={f.username} onChange={set('username')} placeholder={f.email || 'Usually the email address'} maxLength={254} />
          </label>
          <label>
            <span>Encryption</span>
            <select value={f.encryption} onChange={(e) => setF((x) => ({ ...x, encryption: e.target.value, port: e.target.value === 'ssl' ? 465 : 587 }))}>
              <option value="ssl">SSL/TLS (port 465)</option>
              <option value="starttls">STARTTLS (port 587)</option>
            </select>
          </label>
          <label className="span2">
            <span>SMTP password {account?.hasPassword && <em>(saved; leave empty to keep it)</em>}</span>
            <input type="password" value={f.password} onChange={set('password')} placeholder={account?.hasPassword ? '••••••••' : 'For Gmail: an app password'} autoComplete="new-password" maxLength={500} required={!account} />
          </label>
        </div>
        <div className="em-imap">
          <label className="check-wrap">
            <input type="checkbox" checked={f.imapOn} onChange={(e) => setF((x) => ({ ...x, imapOn: e.target.checked }))} />
            <span>Read replies for unsubscribes (IMAP, same login)</span>
          </label>
          {f.imapOn && <input aria-label="IMAP server" value={f.imapHost} onChange={set('imapHost')} placeholder={imapGuess(f.host) || 'imap.example.com'} maxLength={253} />}
        </div>
        <p className="em-note">
          <Icon name="lock" size={12} /> The password is encrypted with this computer’s keychain and never shown again.
        </p>
        {error && (
          <p className="em-error" role="alert">
            <Icon name="alert" size={13} /> {error}
          </p>
        )}
        {testing && testing !== 'testing' && testing !== 'ok' && (
          <p className="em-error" role="alert">
            <Icon name="alert" size={13} /> {testing}
          </p>
        )}
        <footer className="em-modal-foot">
          {!account && onSeveral && (
            <button type="button" className="btn btn-ghost" onClick={onSeveral}>
              <Icon name="users" size={13} /> Add several accounts
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={busy} onClick={(e) => save(e, true)}>
            <Icon name="refresh" size={13} /> {testing === 'testing' ? 'Testing…' : 'Save and test'}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <Icon name="check" size={13} /> Save
          </button>
        </footer>
      </form>
    </div>
  );
}

function ImportAccounts({ onClose, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  useEsc(onClose);
  async function run() {
    setBusy(true);
    setError('');
    const r = await api.emailImport(text);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setResults(r.results);
    setText('');
    onDone();
  }
  function openFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1_000_000) return setError('That file is too large.');
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ''));
    reader.readAsText(file);
    e.target.value = '';
  }
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="em-modal" role="dialog" aria-modal="true" aria-label="Add several sending accounts">
        <header className="em-modal-head">
          <span className="em-mark">
            <Icon name="download" size={16} />
          </span>
          <div>
            <h2>Add several sending accounts</h2>
            <p>One per line: email, app password, sender name (optional)</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <textarea className="em-import" rows={8} spellCheck={false} aria-label="Accounts to import" placeholder={'ali@gmail.com, abcd efgh ijkl mnop, Ali Sales\nteam@company.com, app-password'} value={text} onChange={(e) => setText(e.target.value)} />
        <p className="em-note">
          <Icon name="lock" size={12} /> Gmail, Outlook, Yahoo, Zoho and Google Workspace / Microsoft 365 domains are set up automatically. Each login is tested; passwords are encrypted.
        </p>
        {error && (
          <p className="em-error" role="alert">
            <Icon name="alert" size={13} /> {error}
          </p>
        )}
        {results && (
          <ul className="em-import-results" aria-label="Import results">
            {results.map((r) => (
              <li key={r.email} className={r.ok ? 'ok' : 'bad'}>
                <Icon name={r.ok ? 'check' : 'alert'} size={12} /> <strong>{r.email}</strong> {r.ok ? (r.created ? 'added and connected' : 'password updated, connected') : r.error}
              </li>
            ))}
          </ul>
        )}
        <footer className="em-modal-foot">
          <label className="btn btn-ghost em-file-btn">
            <Icon name="file" size={13} /> Open CSV / TXT
            <input type="file" accept=".csv,.txt,text/plain,text/csv" onChange={openFile} hidden />
          </label>
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {results ? 'Done' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={run}>
            <Icon name="check" size={13} /> {busy ? 'Adding and testing…' : 'Import'}
          </button>
        </footer>
      </div>
    </div>
  );
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// People to email (one or many), in Lead Finder or not: typed, pasted or
// from a CSV / Excel file, into one of the user's campaigns or a new one.
function ImportRecipients({ campaigns, defaultId, onClose, onDone, notify }) {
  // Every campaign (category ones too); the one open, else the one with the
  // longest waiting list.
  const own = [...campaigns].sort((a, b) => (b.counts?.queued || 0) - (a.counts?.queued || 0));
  const start = own.find((c) => c.id === defaultId) || own[0];
  const [text, setText] = useState('');
  const [target, setTarget] = useState(start ? String(start.id) : '__new');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  useEsc(onClose);
  const count = useMemo(() => new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase())).size, [text]);
  async function openFile() {
    setError('');
    const r = await api.emailRecipientsFile();
    if (r.canceled) return;
    if (!r.ok) return setError(r.error);
    setText((t) => (t.trim() ? `${t.trim()}\n${r.text}` : r.text));
    notify({ type: 'ok', text: `${r.count} address${r.count === 1 ? '' : 'es'} read from ${r.file}.` });
  }
  async function run() {
    setBusy(true);
    setError('');
    const r = await api.emailImportRecipients(text, target === '__new' ? { name } : { id: Number(target) });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setResult(r);
    onDone(r.campaignId);
  }
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="em-modal" role="dialog" aria-modal="true" aria-label="Import people to email">
        <header className="em-modal-head">
          <span className="em-mark">
            <Icon name="users" size={16} />
          </span>
          <div>
            <h2>Import people to email</h2>
            <p>Added to the top of the waiting list: sent before the others</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        {result ? (
          <div className="li-result" role="status">
            <p>
              <strong>{result.added}</strong> {result.added === 1 ? 'person' : 'people'} added to “{result.campaign.name}”, at the top of the waiting list: they are emailed first.
            </p>
            {result.movedUp > 0 && <p className="muted">{result.movedUp} already waiting in this campaign: moved to the top.</p>}
            {result.newLeads > 0 && <p className="muted">{result.newLeads} new {result.newLeads === 1 ? 'contact was' : 'contacts were'} saved in Leads (Imported).</p>}
            {result.already > 0 && <p className="muted">{result.already} already in this campaign.</p>}
            {result.previous > 0 && <p className="muted">{result.previous} already emailed by another campaign (allow it with “Also people emailed by other campaigns”, then import again).</p>}
            {result.optedOut > 0 && <p className="muted">{result.optedOut} unsubscribed: never emailed.</p>}
            {result.unverified > 0 && <p className="muted">{result.unverified} failed email verification: never emailed.</p>}
            {result.added > 0 && <p className="muted">Each address is verified before its email is sent; only Valid ones are emailed.</p>}
            {result.invalid > 0 && <p className="muted">{result.invalid} address{result.invalid === 1 ? '' : 'es'} not valid.</p>}
          </div>
        ) : (
          <>
            <textarea className="em-import" rows={8} spellCheck={false} aria-label="People to email" placeholder={'client@company.com\nahmed@gmail.com, Ahmed Khan, Khan Traders\nSara <sara@brighthomes.pk>'} value={text} onChange={(e) => setText(e.target.value)} />
            <p className="em-note">
              <Icon name="mail" size={12} /> One per line: email, name, business (name and business are optional). {count > 0 && <strong>{count} address{count === 1 ? '' : 'es'} found.</strong>}
            </p>
            <div className="li-cat" role="group" aria-label="Add them to">
              <span>Add to</span>
              <select aria-label="Campaign" value={target} onChange={(e) => setTarget(e.target.value)}>
                {own.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name}
                    {c.counts?.queued ? ` · ${c.counts.queued} waiting` : ''}
                  </option>
                ))}
                <option value="__new">New campaign…</option>
              </select>
              {target === '__new' && <input aria-label="New campaign name" placeholder="e.g. My clients" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}
            </div>
          </>
        )}
        {error && (
          <p className="em-error" role="alert">
            <Icon name="alert" size={13} /> {error}
          </p>
        )}
        <footer className="em-modal-foot">
          {!result && (
            <button type="button" className="btn btn-ghost" onClick={openFile}>
              <Icon name="file" size={13} /> Open CSV / Excel
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button type="button" className="btn btn-primary" disabled={busy || !count || (target === '__new' && name.trim().length < 2)} onClick={run}>
              <Icon name="check" size={13} /> {busy ? 'Adding…' : `Add ${count || ''} ${count === 1 ? 'person' : 'people'}`.replace('  ', ' ')}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function Accounts({ accounts, persistent, onChange, notify, onImportPeople }) {
  const [form, setForm] = useState(null); // null | 'new' | account
  const [importing, setImporting] = useState(false);
  const [testing, setTesting] = useState(null);
  async function test(a) {
    setTesting(a.id);
    const r = await api.emailAccountTest(a.id);
    setTesting(null);
    notify({ type: r.ok ? 'ok' : 'error', text: r.ok ? `${a.name}: connected.` : `${a.name}: ${r.error}` });
    onChange();
  }
  async function checkReplies(a) {
    setTesting(`r${a.id}`);
    const r = await api.emailCheckReplies(a.id);
    setTesting(null);
    notify({ type: r.ok ? 'ok' : 'error', text: r.ok ? `${a.name}: ${r.replies} new repl${r.replies === 1 ? 'y' : 'ies'}, ${r.unsubscribed} unsubscribed.` : r.error });
    onChange();
  }
  async function remove(a) {
    if (!window.confirm(`Delete the email account “${a.name}”? Its saved password is deleted too.`)) return;
    const r = await api.emailAccountRemove(a.id);
    if (!r.ok) notify({ type: 'error', text: r.error });
    onChange();
  }
  return (
    <section className="panel em-card" aria-label="Email accounts">
      <div className="or-card-head">
        <h3>
          <Icon name="mail" size={14} /> Email accounts <span className="or-count">{accounts.length}</span>
        </h3>
        <button type="button" className="btn btn-ghost btn-sm" title="Import people to email (one or many)" onClick={onImportPeople}>
          <Icon name="download" size={13} /> Import
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setForm('new')}>
          <Icon name="plus" size={13} /> Add
        </button>
      </div>
      {!persistent && <p className="em-warn small">No keychain on this computer: passwords are kept until Lead Finder closes.</p>}
      {!accounts.length ? (
        <p className="muted small">Add your SMTP account to send campaigns.</p>
      ) : (
        <ul className="em-accounts">
          {accounts.map((a) => (
            <li key={a.id}>
              <span className={`em-dot ${a.status}`} title={a.status === 'ok' ? 'Connected' : a.status === 'failed' ? a.statusDetail : 'Not tested'} />
              <div className="em-acc-text">
                <strong>{a.name}</strong>
                <span>{a.email}</span>
                {a.status === 'failed' && <span className="em-acc-error">{a.statusDetail}</span>}
                {a.imapOn && a.imapStatus === 'failed' && <span className="em-acc-error">Replies: {a.imapDetail}</span>}
                {a.imapOn && a.imapStatus === 'ok' && <span className="em-acc-ok">Replies checked {when(a.imapCheckedAt)}</span>}
                <span className="em-acc-limits">
                  <label className="check-wrap small" title="Off: never used to send">
                    <input type="checkbox" checked={a.enabled !== false} aria-label={`Use ${a.name} for sending`} onChange={async (e) => {
                      const r = await api.emailAccountLimits(a.id, { enabled: e.target.checked, dailyLimit: a.dailyLimit });
                      if (!r.ok) notify({ type: 'error', text: r.error });
                      onChange();
                    }} />
                    <span>{a.enabled !== false ? 'On' : 'Off'}</span>
                  </label>
                  <label className="small muted" title="Emails a day from this account, all campaigns together (empty: no limit)">
                    max/day{' '}
                    <input type="number" min={1} max={5000} placeholder="—" defaultValue={a.dailyLimit || ''} aria-label={`Daily limit of ${a.name}`} onBlur={async (e) => {
                      const v = e.target.value === '' ? null : Number(e.target.value);
                      if (v === (a.dailyLimit || null)) return;
                      const r = await api.emailAccountLimits(a.id, { enabled: a.enabled !== false, dailyLimit: v });
                      notify(r.ok ? { type: 'ok', text: `${a.name}: ${v ? `at most ${v} emails a day` : 'no daily limit'}.` } : { type: 'error', text: r.error });
                      onChange();
                    }} />
                  </label>
                </span>
              </div>
              <div className="em-acc-actions">
                <button type="button" className="icon-btn" title="Test connection" aria-label={`Test ${a.name}`} disabled={testing === a.id} onClick={() => test(a)}>
                  <Icon name="refresh" size={13} />
                </button>
                {a.imapOn && (
                  <button type="button" className="icon-btn" title="Check replies now" aria-label={`Check replies of ${a.name}`} disabled={testing === `r${a.id}`} onClick={() => checkReplies(a)}>
                    <Icon name="inbox" size={13} />
                  </button>
                )}
                <button type="button" className="icon-btn" title="Edit" aria-label={`Edit ${a.name}`} onClick={() => setForm(a)}>
                  <Icon name="edit" size={13} />
                </button>
                <button type="button" className="icon-btn" title="Delete" aria-label={`Delete ${a.name}`} onClick={() => remove(a)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {importing && <ImportAccounts onClose={() => setImporting(false)} onDone={onChange} />}
      {form && (
        <AccountForm
          account={form === 'new' ? null : form}
          onClose={() => setForm(null)}
          onSeveral={() => {
            setForm(null);
            setImporting(true);
          }}
          onSaved={(acc, keepOpen) => {
            onChange();
            if (!keepOpen) {
              setForm(null);
              notify({ type: 'ok', text: `${acc.name} saved.` });
            }
          }}
        />
      )}
    </section>
  );
}

function RecipientPicker({ campaign, categories, onClose, onAdded, notify }) {
  const [f, setF] = useState({ category: 'all', from: '', to: '', search: '', verify: '' });
  const [leads, setLeads] = useState(null);
  const [pick, setPick] = useState(new Set());
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  useEsc(onClose);
  const filter = useMemo(() => ({ category: f.category, ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}), ...(f.search.trim() ? { search: f.search.trim() } : {}), ...(f.verify ? { verify: f.verify } : {}) }), [f]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const [list, p] = await Promise.all([api.listLeads(filter), api.emailPreview(campaign.id, filter)]);
      if (!live) return;
      setLeads((Array.isArray(list) ? list : []).filter((l) => l.email || (l.emails || []).length).slice(0, 500));
      setPreview(p.ok ? p : null);
      setPick(new Set());
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [filter, campaign.id]);

  async function add(all) {
    setBusy(true);
    const r = await api.emailAddLeads(campaign.id, all ? filter : { ids: [...pick] });
    setBusy(false);
    if (!r.ok) return notify({ type: 'error', text: r.error });
    const skipped = [r.noEmail && `${r.noEmail} without an email`, r.unverified && `${r.unverified} whose email did not pass verification`, r.optedOut && `${r.optedOut} unsubscribed`, r.previous && `${r.previous} emailed before`, r.already && `${r.already} already in the campaign`].filter(Boolean);
    notify({ type: 'ok', text: `${r.added} recipient${r.added === 1 ? '' : 's'} added${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}.` });
    onAdded();
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="em-modal wide" role="dialog" aria-modal="true" aria-label="Add recipients">
        <header className="em-modal-head">
          <span className="em-mark">
            <Icon name="users" size={16} />
          </span>
          <div>
            <h2>Add recipients</h2>
            <p>Leads with a valid email address</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="em-filters">
          <select aria-label="Category" value={f.category} onChange={(e) => setF((x) => ({ ...x, category: e.target.value }))}>
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
            <option value="none">Uncategorized</option>
          </select>
          <input type="date" aria-label="From" value={f.from} onChange={(e) => setF((x) => ({ ...x, from: e.target.value }))} />
          <input type="date" aria-label="To" value={f.to} onChange={(e) => setF((x) => ({ ...x, to: e.target.value }))} />
          <input aria-label="Search leads" placeholder="Search name or email" value={f.search} onChange={(e) => setF((x) => ({ ...x, search: e.target.value }))} />
          <select aria-label="Email verification" value={f.verify} onChange={(e) => setF((x) => ({ ...x, verify: e.target.value }))}>
            <option value="">Any verification</option>
            <option value="valid">Valid only</option>
            <option value="checking">Not checked yet</option>
          </select>
        </div>
        {preview && (
          <p className="em-preview-line">
            <strong>{preview.ready}</strong> can be added{preview.ready ? ` (${preview.verified} verified, ${preview.ready - preview.verified} verified before sending)` : ''}
            {preview.unverified ? ` · ${preview.unverified} failed verification (never sent)` : ''}
            {preview.noEmail ? ` · ${preview.noEmail} without email` : ''}
            {preview.optedOut ? ` · ${preview.optedOut} unsubscribed` : ''}
            {preview.previous ? ` · ${preview.previous} emailed before` : ''}
            {preview.already ? ` · ${preview.already} already added` : ''}
          </p>
        )}
        <div className="em-lead-list">
          {!leads ? (
            <p className="muted small">Loading…</p>
          ) : !leads.length ? (
            <p className="muted small">No leads with an email match.</p>
          ) : (
            leads.map((l) => (
              <label key={l.id} className="em-lead">
                <input
                  type="checkbox"
                  checked={pick.has(l.id)}
                  onChange={(e) =>
                    setPick((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(l.id);
                      else n.delete(l.id);
                      return n;
                    })
                  }
                />
                <span className="em-lead-name">{l.name}</span>
                <span className="em-lead-mail">{l.email || l.emails?.[0]?.email || l.emails?.[0]}</span>
                {l.emailVerify ? <VerifyBadge status={l.emailVerify.state === 'done' || l.emailVerify.status ? l.emailVerify.status : null} reason={l.emailVerify.reason} state={l.emailVerify.state} role={l.emailVerify.role} /> : <VerifyBadge status={null} />}
                <span className="em-lead-cat">{l.category}</span>
              </label>
            ))
          )}
        </div>
        <footer className="em-modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn" disabled={busy || !pick.size} onClick={() => add(false)}>
            Add selected ({pick.size})
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !preview?.ready} onClick={() => add(true)}>
            <Icon name="plus" size={13} /> Add all {preview?.ready ?? ''}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Editor({ snap, accounts, categories, notify, reload, onImportPeople }) {
  const [d, setD] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [picker, setPicker] = useState(false);
  const [rFilter, setRFilter] = useState('all'); // recipients shown: all | ready | checking | excluded
  const [history, setHistory] = useState(null); // the lead whose email history is open
  const [preview, setPreview] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState('');
  const bodyRef = useRef(null);
  // Sending accounts: changed at once (also while running), shown before the save returns.
  const [senderIds, setSenderIds] = useState(snap.accountIds);
  const sendersKey = snap.accountIds.join(',');
  useEffect(() => setSenderIds(sendersKey ? sendersKey.split(',') : []), [sendersKey]);
  useEffect(() => {
    if (!dirty) setD({ name: snap.name, aiWrite: snap.aiWrite, trackClicks: snap.trackClicks, delayMinutes: Math.round((snap.delaySeconds / 60) * 10) / 10, delayMaxMinutes: snap.delayMaxSeconds ? Math.round((snap.delayMaxSeconds / 60) * 10) / 10 : '', maxPerDay: snap.maxPerDay || '', signature: snap.signature || '', subject: snap.subject, body: snap.body, delaySeconds: snap.delaySeconds, dailyLimit: snap.dailyLimit, allowPrevious: snap.allowPrevious });
  }, [snap, dirty]);
  if (!d) return null;
  const running = snap.status === 'running';
  const set = (k, v) => {
    setD((x) => ({ ...x, [k]: v }));
    setDirty(true);
  };
  const n = snap.counts;
  const pct = n.total ? Math.round(((n.sent + n.failed + n.skipped + n.uncertain) / n.total) * 100) : 0;

  async function save() {
    const { delayMinutes, delayMaxMinutes, ...rest } = d;
    const r = await api.emailUpdate(snap.id, { ...rest, delaySeconds: Math.round(Number(delayMinutes) * 60), delayMaxSeconds: delayMaxMinutes === '' || delayMaxMinutes == null ? null : Math.round(Number(delayMaxMinutes) * 60), maxPerDay: d.maxPerDay === '' ? null : Number(d.maxPerDay), dailyLimit: Number(d.dailyLimit) });
    if (!r.ok) {
      notify({ type: 'error', text: r.error });
      return false;
    }
    setDirty(false);
    reload();
    return true;
  }
  async function act(kind) {
    if (dirty && !(await save())) return;
    setBusy(kind);
    const fn = { start: api.emailStart, pause: api.emailPause, resume: api.emailResume, stop: api.emailStop }[kind];
    if (kind === 'start' && !window.confirm(`Start sending “${snap.name}” to ${n.remaining} recipient${n.remaining === 1 ? '' : 's'} from ${snap.senders.map((x) => x.email).join(', ') || 'the chosen account'}?`)) return setBusy('');
    const r = await fn(snap.id);
    setBusy('');
    if (!r.ok) notify({ type: 'error', text: r.error });
    reload();
  }
  async function attach() {
    const r = await api.emailAttach();
    if (r.canceled) return;
    if (r.error) notify({ type: 'error', text: r.error });
    if (!r.files?.length) return;
    const u = await api.emailUpdate(snap.id, { attachments: [...snap.attachments.map((a) => a.id), ...r.files.map((f) => f.id)] });
    if (!u.ok) notify({ type: 'error', text: u.error });
    reload();
  }
  async function detach(id) {
    const u = await api.emailUpdate(snap.id, { attachments: snap.attachments.filter((a) => a.id !== id).map((a) => a.id) });
    if (!u.ok) notify({ type: 'error', text: u.error });
    reload();
  }
  function insertVar(v) {
    const el = bodyRef.current;
    const at = el ? el.selectionStart : d.body.length;
    set('body', `${d.body.slice(0, at)}${v}${d.body.slice(el ? el.selectionEnd : at)}`);
    requestAnimationFrame(() => el?.focus());
  }
  async function showPreview() {
    setBusy('preview');
    if (dirty && d.aiWrite !== snap.aiWrite) await save();
    const r = await api.emailRender(snap.id, d.subject, d.body);
    setBusy('');
    if (r.ok) setPreview(r);
    else notify({ type: 'error', text: r.error });
  }
  async function sendTest() {
    if (dirty && !(await save())) return;
    setBusy('test');
    const r = await api.emailTest(snap.id, testTo);
    setBusy('');
    notify({ type: r.ok ? 'ok' : 'error', text: r.ok ? `Test email sent to ${r.to}.` : r.error });
    reload();
  }
  // Test run: each sending account emails itself what a lead would get.
  async function testRun() {
    if (dirty && !(await save())) return;
    setBusy('testRun');
    const r = await api.emailTestRun(snap.id);
    setBusy('');
    if (!r.ok) notify({ type: 'error', text: r.error });
    else {
      const bad = r.results.filter((x) => !x.ok);
      notify({ type: bad.length ? 'error' : 'ok', text: `Test run: ${r.results.length - bad.length} of ${r.results.length} sending account${r.results.length === 1 ? '' : 's'} emailed ${r.results.length === 1 ? 'itself' : 'themselves'} (${r.results.filter((x) => x.ok).map((x) => x.to).join(', ')}).${bad.length ? ` Failed: ${bad.map((x) => `${x.account}: ${x.error}`).join('; ')}` : ' Check those inboxes.'}` });
    }
    reload();
  }
  async function duplicate() {
    const r = await api.emailDuplicate(snap.id);
    if (!r.ok) return notify({ type: 'error', text: r.error });
    notify({ type: 'ok', text: `“${r.campaign.name}” created (a draft).` });
    reload(r.id);
  }
  async function remove() {
    if (!window.confirm(`Delete “${snap.name}” and its history?`)) return;
    const r = await api.emailDelete(snap.id);
    if (!r.ok) notify({ type: 'error', text: r.error });
    reload(null);
  }

  return (
    <>
      <header className="panel em-head">
        <div className="em-head-top">
          <div className="em-head-title">
            <input className="em-title-input" aria-label="Campaign name" value={d.name} disabled={running} onChange={(e) => set('name', e.target.value)} onBlur={() => dirty && save()} />
            <span className={`em-status s-${snap.status}`}>
              <span className="or-dot" /> {STATUS[snap.status]}
            </span>
          </div>
          <div className="em-controls">
            {['draft', 'stopped', 'completed'].includes(snap.status) && (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'start' || (!n.remaining && !snap.category)} onClick={() => act('start')}>
                <Icon name="play" size={13} /> Start
              </button>
            )}
            {running && (
              <button type="button" className="btn btn-sm" onClick={() => act('pause')}>
                <Icon name="pause" size={13} /> Pause
              </button>
            )}
            {snap.status === 'paused' && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => act('resume')}>
                <Icon name="play" size={13} /> Resume
              </button>
            )}
            {['running', 'paused'].includes(snap.status) && (
              <button type="button" className="btn btn-sm" onClick={() => act('stop')}>
                <Icon name="stop" size={13} /> Stop
              </button>
            )}
            <button type="button" className="icon-btn" title="Duplicate campaign (its emails, follow-ups and settings)" aria-label="Duplicate campaign" onClick={duplicate}>
              <Icon name="copy" size={14} />
            </button>
            {!running && (
              <button type="button" className="icon-btn" title="Delete campaign" aria-label="Delete campaign" onClick={remove}>
                <Icon name="trash" size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="em-stats" role="group" aria-label="Progress">
          <div>
            <strong>{n.total}</strong>
            <span>Recipients</span>
          </div>
          <div className="ok">
            <strong>{n.sent}</strong>
            <span>Sent</span>
          </div>
          <div className={n.failed ? 'bad' : ''}>
            <strong>{n.failed}</strong>
            <span>Failed</span>
          </div>
          <div>
            <strong>{n.remaining}</strong>
            <span>Remaining</span>
          </div>
          <div>
            <strong>{snap.replies}</strong>
            <span>Replies</span>
          </div>
          <div className={snap.clicks ? 'ok' : ''} title={snap.tracking ? 'People who clicked a link' : 'Click tracking is off'}>
            <strong>{snap.tracking || snap.clicks ? snap.clicks : '—'}</strong>
            <span>Clicked</span>
          </div>
          <div title="Follow-ups sent · scheduled">
            <strong>{snap.followupCounts?.sent || 0}</strong>
            <span>Follow-ups · {snap.followupCounts?.pending || 0} next</span>
          </div>
          <div className={snap.bounced ? 'bad' : ''}>
            <strong>{snap.bounced}</strong>
            <span>Bounced</span>
          </div>
          <div>
            <strong>{snap.sentToday}</strong>
            <span>Today / {snap.dailyLimit}</span>
          </div>
        </div>
        <div className="em-bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
        {(snap.pauseText || (running && snap.waiting)) && (
          <p className="em-sub">
            {snap.status === 'paused' ? `Paused: ${snap.pauseText}` : `Running: ${WAITING[snap.waiting] || snap.waiting}`}
            {running && snap.waiting === 'followups' && snap.followupCounts?.nextAt ? ` (next ${when(snap.followupCounts.nextAt)})` : ''}
            {running && snap.waiting === 'schedule' && snap.windowOpensAt ? ` (starts again ${when(snap.windowOpensAt)})` : ''}
          </p>
        )}
      </header>

      <section className="panel em-compose" aria-label="Email">
        <div className="em-senders" role="group" aria-label="Send from">
          <span className="em-field-head">
            Send from <em className="muted">one or more accounts, in turn{running ? ' · can be changed while running' : ''}</em>
          </span>
          {!accounts.length ? (
            <p className="muted small">Add an email account first.</p>
          ) : (
            <div className="em-sender-list">
              {accounts.map((a) => {
                const on = senderIds.includes(a.id);
                const st = snap.senders.find((x) => x.id === a.id);
                return (
                  <label key={a.id} className={`em-sender ${on ? 'on' : ''} ${st?.down ? 'down' : ''}`} title={st?.down || a.email}>
                    <input
                      type="checkbox"
                      checked={on}
                      aria-label={`Send from ${a.name}`}
                      onChange={async (e) => {
                        const before = senderIds;
                        const ids = e.target.checked ? [...senderIds, a.id] : senderIds.filter((x) => x !== a.id);
                        setSenderIds(ids);
                        const r = await api.emailUpdate(snap.id, { accountIds: ids });
                        if (!r.ok) {
                          setSenderIds(before);
                          notify({ type: 'error', text: r.error });
                        }
                        reload();
                      }}
                    />
                    <span className={`em-dot ${a.status}`} />
                    <span className="em-sender-text">
                      <strong>{a.email}</strong>
                      {on && <span>{st?.down ? `Not sending: ${st.down}` : `${st?.sentToday ?? 0} today`}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div className="em-row3">
          <label>
            <span>Minutes between emails</span>
            <input type="number" min={0.5} max={60} step={0.5} value={d.delayMinutes} disabled={running} onChange={(e) => set('delayMinutes', e.target.value)} />
          </label>
          <label>
            <span>Up to (random, optional)</span>
            <input type="number" min={0} max={60} step={0.5} placeholder="—" value={d.delayMaxMinutes} disabled={running} aria-label="Random pause up to (minutes)" onChange={(e) => set('delayMaxMinutes', e.target.value)} />
          </label>
          <label>
            <span>Daily limit{snap.accountIds.length > 1 ? ' per account' : ''}</span>
            <input type="number" min={1} max={2000} value={d.dailyLimit} disabled={running} onChange={(e) => set('dailyLimit', e.target.value)} />
          </label>
          <label>
            <span>Campaign max a day</span>
            <input type="number" min={0} max={20000} placeholder="no max" value={d.maxPerDay} disabled={running} aria-label="Campaign maximum a day" onChange={(e) => set('maxPerDay', e.target.value)} />
          </label>
        </div>
        <div className={`em-ai ${d.aiWrite ? 'on' : ''}`}>
          <span className="em-ai-icon">
            <Icon name="sparkle" size={15} />
          </span>
          <span className="em-ai-text">
            <strong>Write each email with AI</strong>
            <span>The AI gets each business’s details and writes a personal email from your prompt.</span>
          </span>
          <button type="button" role="switch" aria-checked={Boolean(d.aiWrite)} aria-label="Write each email with AI" className={`switch ${d.aiWrite ? 'on' : ''}`} disabled={running} onClick={() => set('aiWrite', !d.aiWrite)}>
            <span className="switch-knob" />
          </button>
        </div>
        {!d.aiWrite && (
          <label className="em-field">
            <span>Subject</span>
            <input value={d.subject} disabled={running} maxLength={250} placeholder="Websites for {business}" onChange={(e) => set('subject', e.target.value)} />
          </label>
        )}
        <label className="em-field">
          <span className="em-field-head">
            {d.aiWrite ? 'Your prompt for the AI (it writes the subject and the email)' : 'Email'}
            <span className="em-vars" hidden={d.aiWrite}>
              {VARS.map((v) => (
                <button key={v} type="button" className="em-chip" disabled={running} onClick={() => insertVar(v)}>
                  {v}
                </button>
              ))}
            </span>
          </span>
          <textarea
            ref={bodyRef}
            rows={9}
            value={d.body}
            disabled={running}
            placeholder={d.aiWrite ? 'e.g. We are Axora Web, we build fast websites and online stores. Offer a free homepage design. Friendly, short, English. Mention it if they have no website. Sign as Ali.' : 'Hello {name},\n\nWe help businesses like {business} with…'}
            onChange={(e) => set('body', e.target.value)}
          />
          <small className="muted">{d.aiWrite ? 'Each business’s name, category, area, website, phone and description go to the AI with this prompt. Every written email is kept and shown with its recipient.' : 'Plain text or HTML. An unsubscribe line is added to every email.'}</small>
        </label>
        <label className="em-field">
          <span>Signature (every email and follow-up ends with it; the AI never changes it)</span>
          <textarea rows={2} value={d.signature} disabled={running} maxLength={500} placeholder={'Best,\nAli'} aria-label="Signature" onChange={(e) => set('signature', e.target.value)} />
        </label>
        <div className="em-attach">
          {snap.attachments.map((a) => (
            <span key={a.id} className="em-file">
              <Icon name={a.kind === 'image' ? 'image' : 'file'} size={12} /> {a.name}
              {!running && (
                <button type="button" aria-label={`Remove ${a.name}`} onClick={() => detach(a.id)}>
                  <Icon name="x" size={11} />
                </button>
              )}
            </span>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" disabled={running} onClick={attach}>
            <Icon name="clip" size={13} /> Attach
          </button>
        </div>
        <div className="em-actions">
          <label className="check-wrap small">
            <input type="checkbox" checked={Boolean(d.allowPrevious)} disabled={running} onChange={(e) => set('allowPrevious', e.target.checked)} />
            <span>Also people emailed by other campaigns</span>
          </label>
          <label className="check-wrap small" title={snap.tracking || !d.trackClicks ? '' : 'Set up Click tracking (left) to track the links'}>
            <input type="checkbox" checked={d.trackClicks !== false} disabled={running} onChange={(e) => set('trackClicks', e.target.checked)} />
            <span>Track link clicks{d.trackClicks !== false && !snap.tracking ? ' (set up Click tracking first)' : ''}</span>
          </label>
          <span className="grow" />
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy === 'preview'} onClick={showPreview}>
            <Icon name={d.aiWrite ? 'sparkle' : 'eye'} size={13} /> {busy === 'preview' ? 'Writing…' : d.aiWrite ? 'Preview AI email' : 'Preview'}
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || running} onClick={save}>
            <Icon name="check" size={13} /> Save
          </button>
        </div>
        {preview && (
          <div className="em-preview">
            <div className="em-preview-head">
              <span>To: {preview.to || 'first recipient'}</span>
              <strong>{preview.subject}</strong>
              <button type="button" className="icon-btn" aria-label="Close preview" onClick={() => setPreview(null)}>
                <Icon name="x" size={12} />
              </button>
            </div>
            <pre>{preview.text}</pre>
          </div>
        )}
        <div className="em-test">
          <button type="button" className="btn btn-sm btn-primary" disabled={busy === 'testRun'} onClick={testRun} title="Each sending account emails itself the email a lead would get (AI-written when AI is on). No lead is emailed.">
            <Icon name="play" size={13} /> {busy === 'testRun' ? 'Test run…' : 'Test run'}
          </button>
          <input type="email" placeholder="Or a test to this address" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Test address" />
          <button type="button" className="btn btn-sm" disabled={busy === 'test'} onClick={sendTest}>
            <Icon name="send" size={13} /> {busy === 'test' ? 'Sending…' : 'Send test'}
          </button>
        </div>
        <p className="muted small">Test run: each sending account emails itself the email the next lead would get. Nothing is counted and no lead is emailed.</p>
      </section>

      <FollowUps key={`f${snap.id}`} snap={snap} notify={notify} reload={reload} />
      <Schedule key={`s${snap.id}`} snap={snap} notify={notify} reload={reload} />

      <section className="panel em-recipients" aria-label="Recipients">
        <div className="or-card-head">
          <h3>
            <Icon name="users" size={14} /> Recipients <span className="or-count">{n.total}</span>
          </h3>
          {snap.verify && (
            <span className="em-vsum" aria-label="Recipients by verification">
              <span className="v-valid">{snap.verify.ready} ready</span>
              {snap.verify.checking > 0 && <span className="v-checking">{snap.verify.checking} verifying</span>}
              {snap.verify.excluded > 0 && <span className="v-invalid">{snap.verify.excluded} not verified</span>}
            </span>
          )}
          <select className="em-vfilter" aria-label="Show recipients" value={rFilter} onChange={(e) => setRFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="ready">Ready for outreach</option>
            <option value="checking">Verifying</option>
            <option value="excluded">Not verified</option>
          </select>
          {n.failed + n.uncertain > 0 && (
            <button type="button" className="btn btn-sm" onClick={async () => {
              const r = await api.emailRetry(snap.id, false);
              notify({ type: r.ok ? 'ok' : 'error', text: r.ok ? `${r.requeued} queued again.` : r.error });
              reload();
            }}>
              <Icon name="refresh" size={13} /> Retry failed
            </button>
          )}
          {snap.category ? (
            <>
              <span className="muted small">New leads of this category are added by themselves</span>
              <button type="button" className="btn btn-sm" onClick={onImportPeople}>
                <Icon name="download" size={13} /> Import emails
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-sm" onClick={onImportPeople}>
                <Icon name="download" size={13} /> Import emails
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={running} onClick={() => setPicker(true)}>
                <Icon name="plus" size={13} /> Add recipients
              </button>
            </>
          )}
        </div>
        {!snap.recipients.length ? (
          <p className="muted small">No recipients yet. Add leads with an email address.</p>
        ) : (
          <div className="em-table-wrap">
            <table className="em-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Business</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {snap.recipients.filter((r) => rFilter === 'all' || (rFilter === 'excluded' ? r.verify === 'excluded' || /^Not sent: email/.test(r.error || '') : ['queued', 'failed'].includes(r.state) && (r.verify === rFilter || (rFilter === 'checking' && r.verify === 'expired')))).map((r) => (
                  <tr key={r.email}>
                    <td className="mono">{r.email}</td>
                    <td>{r.name || '—'}</td>
                    <td>{r.business || '—'}</td>
                    <td>
                      <span className={`em-state ls-${(LEAD_STATUS[r.status] || [])[1] || r.state}`} title={r.error || r.bounceReason || ''}>
                        {r.status === 'clicked' && r.clicks > 1 ? `Clicked ×${r.clicks}` : (LEAD_STATUS[r.status] || [])[0] || STATE[r.state]}
                      </span>
                      {(r.nextFollowupAt || r.followupsSent > 0) && (
                        <span className="em-st-note">
                          {r.nextFollowupAt ? `Next: follow-up ${r.nextFollowupStep}, ${when(r.nextFollowupAt)}` : ''}
                          {r.nextFollowupAt && r.followupsSent > 0 ? ' · ' : ''}
                          {r.followupsSent > 0 ? `${r.followupsSent} follow-up${r.followupsSent === 1 ? '' : 's'} sent` : ''}
                        </span>
                      )}
                      {['queued', 'failed', 'sending'].includes(r.state) && r.verify && r.verify !== 'expired' && <VerifyBadge status={r.verifyState === 'done' ? r.verifyStatus : null} reason={r.verifyReason} state={r.verifyState} role={r.verifyRole} />}
                      {r.state === 'queued' && r.priority > 0 && (
                        <span className="em-state s-first" title="Imported: emailed before the rest of the waiting list">
                          Sent first
                        </span>
                      )}
                      {r.error && <span className="em-err-text">{r.error}</span>}
                      {r.sentAt && <span className="em-st-note">Sent {when(r.sentAt)}</span>}
                      {r.repliedAt && <span className="em-state s-replied">Replied</span>}
                      {r.clickedAt && r.status !== 'clicked' && (
                        <span className="em-state s-clicked" title={`First click ${when(r.clickedAt)}`}>
                          Clicked{r.clicks > 1 ? ` ×${r.clicks}` : ''}
                        </span>
                      )}
                      {r.aiBody && (
                        <details className="em-ai-sent">
                          <summary>AI email</summary>
                          <strong>{r.aiSubject}</strong>
                          <pre>{r.aiBody}</pre>
                        </details>
                      )}
                    </td>
                    <td className="em-row-actions">
                      <button type="button" className="icon-btn" title="Email history" aria-label={`History of ${r.email}`} onClick={() => setHistory(r.email)}>
                        <Icon name="inbox" size={12} />
                      </button>
                      {!['bounced', 'unsubscribed', 'invalid'].includes(r.status) && (
                        <button type="button" className="icon-btn" title={r.stoppedAt ? 'Resume this lead’s emails' : 'Stop all further emails to this lead'} aria-label={`${r.stoppedAt ? 'Resume' : 'Stop'} ${r.email}`} onClick={async () => {
                          const x = await api.emailStopLead(snap.id, r.email, !r.stoppedAt);
                          if (!x.ok) notify({ type: 'error', text: x.error });
                          reload();
                        }}>
                          <Icon name={r.stoppedAt ? 'play' : 'stop'} size={12} />
                        </button>
                      )}
                      {r.state === 'sent' && (
                        <select className="em-interest" aria-label={`Interest of ${r.email}`} value={r.interest || ''} onChange={async (e) => {
                          await api.emailInterest(snap.id, r.email, e.target.value || null);
                          reload();
                        }}>
                          <option value="">Mark…</option>
                          <option value="interested">Interested</option>
                          <option value="not_interested">Not interested</option>
                        </select>
                      )}
                      {['queued', 'failed', 'skipped'].includes(r.state) && !running && (
                        <button type="button" className="icon-btn" aria-label={`Remove ${r.email}`} onClick={async () => {
                          await api.emailRemoveRecipient(snap.id, r.email);
                          reload();
                        }}>
                          <Icon name="x" size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel em-log" aria-label="Campaign history">
        <div className="or-card-head">
          <h3>
            <Icon name="calendar" size={14} /> History
          </h3>
        </div>
        <ul>
          {snap.log.slice(0, 30).map((l, i) => (
            <li key={i} className={`lv-${l.level}`}>
              <span className="mono">{when(l.at)}</span> {l.text}
            </li>
          ))}
        </ul>
      </section>
      {picker && <RecipientPicker campaign={snap} categories={categories} notify={notify} onClose={() => setPicker(false)} onAdded={() => { setPicker(false); reload(); }} />}
      {history && <LeadTimeline campaignId={snap.id} email={history} onClose={() => setHistory(null)} />}
    </>
  );
}

// Click tracking: the user's own tracking address (a PHP file on their
// website, or a Cloudflare Worker). Links in campaign emails go through it.
function TrackingSetup({ status, onClose, notify }) {
  const [base, setBase] = useState(status.base || '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [worker, setWorker] = useState(null);
  useEsc(onClose);
  async function connect(e) {
    e?.preventDefault();
    setBusy('connect');
    setError('');
    const r = await api.emailTrackingConnect(base);
    setBusy('');
    if (!r.ok) return setError(r.error);
    notify({ type: 'ok', text: 'Click tracking connected. Links in new campaign emails are tracked.' });
    onClose();
  }
  async function savePhp() {
    const r = await api.emailTrackingFile('php');
    if (r.ok) notify({ type: 'ok', text: `Saved: ${r.filePath}` });
    else if (!r.canceled) setError(r.error);
  }
  async function showWorker() {
    const r = await api.emailTrackingFile('worker');
    if (r.ok) setWorker(r.code);
  }
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="em-modal wide" role="dialog" aria-modal="true" aria-label="Click tracking">
        <header className="em-modal-head">
          <span className="em-mark">
            <Icon name="link" size={16} />
          </span>
          <div>
            <h2>Click tracking</h2>
            <p>See who clicked the links in your emails</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <ol className="em-steps">
          <li>
            <strong>Website with PHP (cPanel, Hostinger…):</strong> save the tracking file and upload it to a new folder of your website, e.g. <code>public_html/t/index.php</code>.{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={savePhp}>
              <Icon name="download" size={12} /> Save index.php
            </button>
          </li>
          <li>
            <strong>No PHP?</strong> Use a free Cloudflare Worker (steps are at the top of its code).{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={showWorker}>
              <Icon name="file" size={12} /> Show Worker code
            </button>
          </li>
          <li>
            Enter its address below and press Connect. Lead Finder checks it with a test click, then fetches new clicks every 3 minutes.
          </li>
        </ol>
        {worker && (
          <div className="em-worker">
            <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard.writeText(worker).then(() => notify({ type: 'ok', text: 'Worker code copied.' }))}>
              <Icon name="copy" size={12} /> Copy
            </button>
            <pre aria-label="Worker code">{worker}</pre>
          </div>
        )}
        <form className="em-track-form" onSubmit={connect}>
          <input aria-label="Tracking address" placeholder="https://yourdomain.com/t/" value={base} onChange={(e) => setBase(e.target.value)} spellCheck={false} />
          <button type="submit" className="btn btn-primary" disabled={busy === 'connect' || !base.trim()}>
            <Icon name="check" size={13} /> {busy === 'connect' ? 'Testing…' : 'Connect'}
          </button>
        </form>
        <p className="em-note">
          <Icon name="shield" size={12} /> Use your own domain: links on shared tracking domains are often sent to spam. Every link is signed, so the address only ever opens your own links. No IP addresses or cookies are kept.
        </p>
        {error && (
          <p className="em-error" role="alert">
            <Icon name="alert" size={13} /> {error}
          </p>
        )}
      </div>
    </div>
  );
}

function ClickTracking({ notify }) {
  const [st, setSt] = useState(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    api.emailTracking().then((r) => r.ok && setSt(r.status));
    return api.onEmailTracking((s) => setSt(s));
  }, []);
  if (!st) return null;
  async function check() {
    setChecking(true);
    const r = await api.emailTrackingCheck();
    setChecking(false);
    notify({ type: r.ok ? 'ok' : 'error', text: r.ok ? `${r.clicks} new click${r.clicks === 1 ? '' : 's'}.` : r.error });
  }
  async function off() {
    if (!window.confirm('Turn click tracking off? New emails are sent with their links as they are; links already sent keep working.')) return;
    await api.emailTrackingDisconnect();
  }
  let host = st.base;
  try {
    host = new URL(st.base).host + new URL(st.base).pathname.replace(/\/$/, '');
  } catch {}
  return (
    <section className="panel em-card" aria-label="Click tracking">
      <div className="or-card-head">
        <h3>
          <Icon name="link" size={14} /> Click tracking
        </h3>
        {st.connected ? (
          <>
            <button type="button" className="icon-btn" title="Check clicks now" aria-label="Check clicks now" disabled={checking} onClick={check}>
              <Icon name="refresh" size={13} />
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={off}>
              Turn off
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
            <Icon name="plus" size={13} /> Set up
          </button>
        )}
      </div>
      {st.connected ? (
        <div className="em-track-status">
          <span className="em-acc-ok">
            <Icon name="check" size={11} /> On · {host}
          </span>
          <span className="muted small">{st.lastPollAt ? `Checked ${when(st.lastPollAt)}` : 'Clicks are checked every 3 minutes'}</span>
          {st.lastError && <span className="em-acc-error">{st.lastError}</span>}
        </div>
      ) : (
        <p className="muted small">Know which leads clicked a link in your email (needs a small file on your website, or a free Cloudflare Worker).</p>
      )}
      {open && <TrackingSetup status={st} onClose={() => setOpen(false)} notify={notify} />}
    </section>
  );
}

// Email verification: every address is checked before a campaign email can go to it.
const VERIFY = { valid: 'Valid', invalid: 'Invalid', risky: 'Risky', unknown: 'Unknown', catch_all: 'Catch-all' };
const VERIFY_HELP = {
  valid: 'The mail server confirmed the mailbox. Sent to.',
  invalid: 'The mailbox or domain does not exist. Never sent to.',
  risky: 'Disposable, full mailbox, or a role address you marked risky. Not sent to unless you allow it.',
  unknown: 'No clear answer (timeouts, blocked connections, servers that refuse to say). Not sent to unless you allow it.',
  catch_all: 'The server accepts every address, so this one cannot be confirmed. Not sent to unless you allow it.',
};

function VerifyBadge({ status, reason, state, role }) {
  if (!status) return <span className="em-vbadge v-checking" title={reason || 'Being verified'}>{state === 'queued' && reason ? 'Checking again later' : 'Verifying…'}</span>;
  return (
    <span className={`em-vbadge v-${status}`} title={[reason, role ? 'Role address (info@, sales@…)' : ''].filter(Boolean).join(' · ')}>
      {VERIFY[status] || status}
      {role ? ' · role' : ''}
    </span>
  );
}

function EmailVerification({ notify }) {
  const [st, setSt] = useState(null);
  const [log, setLog] = useState([]);
  const [open, setOpen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const load = useCallback(() => api.emailVerifyStatus().then((r) => r.ok && (setSt(r.status), setLog(r.log || []))), []);
  useEffect(() => {
    load();
    return api.onEmailVerify((s) => {
      setSt(s);
      if (showLog) load();
    });
  }, [load, showLog]);
  if (!st) return null;
  const c = st.counts;
  const p = st.progress;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
  async function recheck(statuses, what) {
    const r = await api.emailVerifyRecheck(statuses);
    notify({ type: 'ok', text: r.queued ? `${r.queued} ${what} being checked again.` : `No ${what} to check again.` });
  }
  const allowedExtra = Object.entries(st.settings.allow).filter(([, on]) => on).map(([k]) => VERIFY[k]);
  return (
    <section className="panel em-card" aria-label="Email verification">
      <div className="or-card-head">
        <h3>
          <Icon name="shield" size={14} /> Email verification
        </h3>
        <button type="button" className="icon-btn" title="Verification settings" aria-label="Verification settings" onClick={() => setOpen(true)}>
          <Icon name="sliders" size={13} />
        </button>
      </div>
      <p className="muted small">
        Every email is verified before outreach. Only <strong>Valid</strong> addresses are sent to{allowedExtra.length ? <> (you also allow {allowedExtra.join(', ')})</> : null}.
      </p>
      <div className="em-vcounts" role="group" aria-label="Verification counts">
        {Object.keys(VERIFY).map((k) => (
          <div key={k} className={`em-vcount v-${k}`} title={VERIFY_HELP[k]}>
            <strong>{c[k]}</strong>
            <span>{VERIFY[k]}</span>
          </div>
        ))}
      </div>
      {p.pending > 0 ? (
        <div className="em-vprogress" role="progressbar" aria-label="Verification progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="em-vbar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <span className="muted small">
            Verifying… {p.done} of {p.total} ({p.pending} left)
          </span>
        </div>
      ) : (
        <span className="muted small">{c.total ? 'All addresses checked.' : 'New lead emails are checked automatically.'}</span>
      )}
      <div className="em-vengine">
        {st.settings.engine === 'reacher' ? (
          <span className="em-acc-ok">
            <Icon name="check" size={11} /> Reacher server · {hostOf(st.settings.reacherUrl)}
          </span>
        ) : st.port25 === 'blocked' ? (
          <span className="em-acc-error" role="alert">
            This network blocks mail servers (port 25): addresses cannot be confirmed from this computer, so they stay Unknown and are not sent to. Use a Reacher server in the settings.
          </span>
        ) : (
          <span className="muted small">Checked from this computer{st.port25 === 'ok' ? ' · mail servers reachable' : ''}</span>
        )}
      </div>
      <div className="em-vactions">
        {c.unknown > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => recheck(['unknown'], 'Unknown addresses')}>
            <Icon name="refresh" size={12} /> Recheck Unknown
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setShowLog((v) => !v), load())}>
          {showLog ? 'Hide log' : 'Log'}
        </button>
      </div>
      {showLog && (
        <ul className="em-vlog" aria-label="Verification log">
          {!log.length && <li className="muted small">Nothing checked yet.</li>}
          {log.map((l, i) => (
            <li key={i}>
              <span className="mono">{l.email}</span> {l.status === 'retry' ? <span className="em-vbadge v-checking">Asked again later</span> : <VerifyBadge status={l.status} />}
              <span className="muted small">
                {' '}
                {when(l.at)} · {l.reason}
                {l.detail ? ` · server: “${l.detail}”` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && <VerifySettings status={st} onClose={() => setOpen(false)} notify={notify} />}
    </section>
  );
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function VerifySettings({ status, onClose, notify }) {
  const s = status.settings;
  const [engine, setEngine] = useState(s.engine);
  const [url, setUrl] = useState(s.reacherUrl);
  const [secret, setSecret] = useState('');
  const [allow, setAllow] = useState(s.allow);
  const [roleRisky, setRoleRisky] = useState(s.roleRisky);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [testAddr, setTestAddr] = useState('');
  const [tested, setTested] = useState(null);
  useEsc(onClose);
  async function save(e) {
    e?.preventDefault();
    setBusy('save');
    setError('');
    const r = await api.emailVerifySave({ engine, reacherUrl: url, allow, roleRisky, ...(secret ? { secret } : {}) });
    setBusy('');
    if (!r.ok) return setError(r.error);
    notify({ type: 'ok', text: 'Verification settings saved.' });
    onClose();
  }
  async function test() {
    setBusy('test');
    setTested(null);
    setError('');
    const r = await api.emailVerifyCheck(testAddr);
    setBusy('');
    if (!r.ok) return setError(r.error);
    setTested(r);
  }
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="em-modal wide" role="dialog" aria-modal="true" aria-label="Verification settings" onSubmit={save}>
        <header className="em-modal-head">
          <span className="em-mark">
            <Icon name="shield" size={16} />
          </span>
          <div>
            <h2>Email verification</h2>
            <p>Checked before any campaign email is sent</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <fieldset className="em-vfield">
          <legend>Verify with</legend>
          <label className="check-wrap">
            <input type="radio" name="engine" checked={engine === 'local'} onChange={() => setEngine('local')} /> This computer: asks each domain’s mail server directly (needs port 25, often blocked by home internet)
          </label>
          <label className="check-wrap">
            <input type="radio" name="engine" checked={engine === 'reacher'} onChange={() => setEngine('reacher')} /> My Reacher server (open source: <code>github.com/reacherhq/check-if-email-exists</code>) on a server with port 25 open
          </label>
          {engine === 'reacher' && (
            <div className="em-vreacher">
              <input aria-label="Reacher address" placeholder="https://verify.yourdomain.com" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
              <input aria-label="Reacher secret" type="password" autoComplete="off" placeholder={s.hasSecret ? 'Secret saved (type to replace)' : 'Secret (RCH__HEADER_SECRET), if set'} value={secret} onChange={(e) => setSecret(e.target.value)} />
              <p className="em-note">
                <Icon name="file" size={12} /> On your server: <code>docker run -d -p 8080:8080 -e RCH__HEADER_SECRET=yoursecret reacherhq/backend:latest</code>. The secret is kept encrypted on this computer.
              </p>
            </div>
          )}
        </fieldset>
        <fieldset className="em-vfield">
          <legend>Also send to (not recommended)</legend>
          {['catch_all', 'unknown', 'risky'].map((k) => (
            <label key={k} className="check-wrap" title={VERIFY_HELP[k]}>
              <input type="checkbox" checked={allow[k]} onChange={(e) => setAllow((a) => ({ ...a, [k]: e.target.checked }))} /> {VERIFY[k]} addresses
            </label>
          ))}
          <p className="em-note">
            <Icon name="alert" size={12} /> Invalid addresses are never sent to. Sending to unconfirmed addresses brings bounces, which hurt your sending accounts.
          </p>
          <label className="check-wrap">
            <input type="checkbox" checked={roleRisky} onChange={(e) => setRoleRisky(e.target.checked)} /> Count role addresses (info@, sales@, support@…) as Risky
          </label>
        </fieldset>
        <div className="em-track-form">
          <input aria-label="Test an address" placeholder="Test an address: name@company.com" value={testAddr} onChange={(e) => setTestAddr(e.target.value)} spellCheck={false} />
          <button type="button" className="btn" disabled={busy === 'test' || !testAddr.includes('@')} onClick={test}>
            {busy === 'test' ? 'Checking…' : 'Check'}
          </button>
        </div>
        {tested && (
          <p className="em-vtested" role="status">
            <span className="mono">{tested.email}</span>: {tested.result?.status ? <VerifyBadge status={tested.result.status} reason={tested.result.reason} role={tested.result.role} /> : <VerifyBadge state="queued" reason={tested.result?.reason} />} {tested.result?.reason}
            {tested.result?.detail ? ` (server: “${tested.result.detail}”)` : ''}
            {tested.allowed ? ' · would be sent to' : ' · would not be sent to'}
          </p>
        )}
        {error && (
          <p className="em-error" role="alert">
            <Icon name="alert" size={13} /> {error}
          </p>
        )}
        <footer className="em-modal-foot">
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy === 'save'}>
            <Icon name="check" size={13} /> Save
          </button>
        </footer>
      </form>
    </div>
  );
}

function OptOuts({ notify }) {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const load = useCallback(() => api.emailOptOuts().then((r) => setList(r.optOuts || [])), []);
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  return (
    <section className="panel em-card" aria-label="Unsubscribed">
      <div className="or-card-head">
        <h3>
          <Icon name="shield" size={14} /> Unsubscribed
        </h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <>
          <form
            className="em-optout-add"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await api.emailOptOut(value);
              if (!r.ok) return notify({ type: 'error', text: r.error });
              setValue('');
              load();
            }}
          >
            <input type="email" placeholder="email@example.com" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Unsubscribe address" />
            <button type="submit" className="btn btn-sm">
              Add
            </button>
          </form>
          {!list.length ? (
            <p className="muted small">Nobody has unsubscribed.</p>
          ) : (
            <ul className="em-optouts">
              {list.map((o) => (
                <li key={o.email}>
                  <span className="mono">{o.email}</span>
                  <button type="button" className="icon-btn" aria-label={`Allow ${o.email} again`} title="Remove from the list" onClick={async () => {
                    await api.emailRemoveOptOut(o.email);
                    load();
                  }}>
                    <Icon name="x" size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// Every lead category with emails is a campaign, like WhatsApp's: choose
// its sending accounts, subject and email (or the AI prompt), then ON.
function CategoryCampaigns({ list, selected, onOpen, onToggle, toggling }) {
  if (!list.length) return null;
  return (
    <section className="panel em-card" aria-label="Category campaigns">
      <div className="or-card-head">
        <h3>
          <Icon name="tag" size={14} /> Categories <span className="or-count">{list.length}</span>
        </h3>
      </div>
      <ul className="em-cats">
        {list.map((c) => {
          const on = ['running', 'paused'].includes(c.campaign?.status);
          return (
            <li key={c.key} className={selected && c.campaign?.id === selected ? 'on' : ''}>
              <button type="button" className="em-cat-main" onClick={() => onOpen(c)}>
                <span className="em-c-name">{c.name}</span>
                <span className="em-c-meta">
                  {c.withEmail} with email · {c.notEmailed} not emailed{c.campaign?.counts.sent ? ` · ${c.campaign.counts.sent} sent` : ''}
                  {c.campaign?.aiWrite ? ' · AI' : ''}
                </span>
              </button>
              <button type="button" role="switch" aria-checked={on} aria-label={`${c.name} email campaign`} className={`switch ${on ? 'on' : ''}`} disabled={toggling === c.key} onClick={() => onToggle(c, !on)}>
                <span className="switch-knob" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function EmailView({ notify, hidden }) {
  const [accounts, setAccounts] = useState({ accounts: [], persistent: true });
  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [snap, setSnap] = useState(null);
  const [cats, setCats] = useState([]);
  const [catList, setCatList] = useState([]);
  const [toggling, setToggling] = useState(null);
  const [importPeople, setImportPeople] = useState(false);
  const loadCats = useCallback(() => api.emailCategories().then((r) => r.ok && setCatList(r.categories)).catch(() => {}), []);

  const loadAccounts = useCallback(() => api.emailAccounts().then((r) => r.ok && setAccounts(r)), []);
  const loadCampaigns = useCallback(() => api.emailCampaigns().then((r) => r.ok && setCampaigns(r.campaigns)), []);
  const loadSnap = useCallback((id) => {
    if (!id) return setSnap(null);
    api.emailCampaign(id).then((r) => setSnap(r.ok ? r.campaign : null));
  }, []);

  useEffect(() => {
    if (hidden) return;
    loadAccounts();
    loadCampaigns();
    loadCats();
    api.listCategories().then((c) => setCats(c.categories || [])).catch(() => {});
  }, [hidden, loadAccounts, loadCampaigns, loadCats]);
  useEffect(() => {
    loadSnap(selected);
  }, [selected, loadSnap]);
  useEffect(
    () =>
      api.onEmail((e) => {
        if (e.accounts) return loadAccounts();
        loadCampaigns();
        loadCats();
        if (selected && (e.id == null || e.id === selected)) loadSnap(selected);
      }),
    [selected, loadCampaigns, loadSnap, loadAccounts, loadCats],
  );
  useEffect(() => {
    if (!selected && campaigns.length) setSelected(campaigns[0].id);
  }, [campaigns, selected]);

  async function create() {
    const r = await api.emailCreate('');
    if (!r.ok) return notify({ type: 'error', text: r.error });
    await loadCampaigns();
    setSelected(r.id);
  }
  async function openCategory(c) {
    const r = await api.emailCategoryCampaign(c.key);
    if (!r.ok) return notify({ type: 'error', text: r.error });
    await loadCampaigns();
    loadCats();
    setSelected(r.id);
  }
  async function toggleCategory(c, on) {
    setToggling(c.key);
    const r = await api.emailSetCategory(c.key, on);
    setToggling(null);
    loadCats();
    loadCampaigns();
    if (!r.ok) {
      // Not ready yet: its campaign opens to be completed.
      await openCategory(c);
      notify({ type: 'error', text: r.error });
    } else if (on && r.campaign) setSelected(r.campaign.id);
  }
  // next: null (none selected), a campaign id (open it), else the open one again.
  const reload = (next) => {
    loadCampaigns();
    loadCats();
    if (next === null) setSelected(null);
    else if (typeof next === 'number') {
      setSelected(next);
      loadSnap(next);
    } else loadSnap(selected);
    loadAccounts();
  };

  return (
    <section className="outreach or-grid em-view" hidden={hidden} aria-label="Email campaigns">
      <aside className="or-side">
        <Accounts accounts={accounts.accounts} persistent={accounts.persistent} onChange={loadAccounts} notify={notify} onImportPeople={() => setImportPeople(true)} />
        <ClickTracking notify={notify} />
        <EmailVerification notify={notify} />
        <CategoryCampaigns list={catList} selected={selected} onOpen={openCategory} onToggle={toggleCategory} toggling={toggling} />
        <section className="panel em-card" aria-label="Campaign list">
          <div className="or-card-head">
            <h3>
              <Icon name="send" size={14} /> Campaigns <span className="or-count">{campaigns.filter((c) => !c.category).length}</span>
            </h3>
            <button type="button" className="btn btn-sm btn-primary" onClick={create}>
              <Icon name="plus" size={13} /> New
            </button>
          </div>
          {!campaigns.filter((c) => !c.category).length ? (
            <p className="muted small">Your own campaigns (any leads you choose).</p>
          ) : (
            <ul className="em-campaigns">
              {campaigns.filter((c) => !c.category).map((c) => (
                <li key={c.id}>
                  <button type="button" className={selected === c.id ? 'on' : ''} onClick={() => setSelected(c.id)}>
                    <span className="em-c-name">{c.name}</span>
                    <span className={`em-status s-${c.status}`}>
                      <span className="or-dot" /> {STATUS[c.status]}
                    </span>
                    <span className="em-c-meta">
                      {c.counts.sent}/{c.counts.total} sent{c.counts.failed ? ` · ${c.counts.failed} failed` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <OptOuts notify={notify} />
      </aside>
      <div className="or-main">
        {!snap ? (
          <div className="panel or-blank">
            <Icon name="mail" size={28} />
            <p>{campaigns.length ? 'Choose a campaign' : 'Create your first email campaign'}</p>
            {!campaigns.length && (
              <button type="button" className="btn btn-primary btn-sm" onClick={create}>
                <Icon name="plus" size={13} /> New campaign
              </button>
            )}
          </div>
        ) : null}
        {!snap ? (
          <EmailDashboard />
        ) : (
          <Editor key={snap.id} snap={snap} accounts={accounts.accounts} categories={cats} notify={notify} reload={reload} onImportPeople={() => setImportPeople(true)} />
        )}
      </div>
      {importPeople && (
        <ImportRecipients
          campaigns={campaigns}
          defaultId={snap ? snap.id : null}
          notify={notify}
          onClose={() => setImportPeople(false)}
          onDone={async (id) => {
            await loadCampaigns();
            loadCats();
            setSelected(id);
            loadSnap(id);
          }}
        />
      )}
    </section>
  );
}
