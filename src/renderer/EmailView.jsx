import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';

// Outreach > Email: SMTP accounts and email campaigns to leads from the
// Leads database. Passwords are entered here and never shown again.

const api = window.leadFinder;

const STATUS = { draft: 'Draft', running: 'Running', paused: 'Paused', stopped: 'Stopped', completed: 'Completed' };
const STATE = { queued: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped', uncertain: 'Uncertain' };
const WAITING = { delay: 'waiting for the delay between emails', daily_limit: 'daily limit reached; continues tomorrow', retry_later: 'retrying failed emails later' };
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

function AccountForm({ account, onClose, onSaved }) {
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
      <div className="em-modal" role="dialog" aria-modal="true" aria-label="Import email accounts">
        <header className="em-modal-head">
          <span className="em-mark">
            <Icon name="download" size={16} />
          </span>
          <div>
            <h2>Import email accounts</h2>
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

function Accounts({ accounts, persistent, onChange, notify }) {
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
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setImporting(true)}>
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
  const [f, setF] = useState({ category: 'all', from: '', to: '', search: '' });
  const [leads, setLeads] = useState(null);
  const [pick, setPick] = useState(new Set());
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  useEsc(onClose);
  const filter = useMemo(() => ({ category: f.category, ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}), ...(f.search.trim() ? { search: f.search.trim() } : {}) }), [f]);

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
    const skipped = [r.noEmail && `${r.noEmail} without an email`, r.optedOut && `${r.optedOut} unsubscribed`, r.previous && `${r.previous} emailed before`, r.already && `${r.already} already in the campaign`].filter(Boolean);
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
        </div>
        {preview && (
          <p className="em-preview-line">
            <strong>{preview.ready}</strong> can be emailed
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

function Editor({ snap, accounts, categories, notify, reload }) {
  const [d, setD] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [picker, setPicker] = useState(false);
  const [preview, setPreview] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState('');
  const bodyRef = useRef(null);
  // Sending accounts: changed at once (also while running), shown before the save returns.
  const [senderIds, setSenderIds] = useState(snap.accountIds);
  const sendersKey = snap.accountIds.join(',');
  useEffect(() => setSenderIds(sendersKey ? sendersKey.split(',') : []), [sendersKey]);
  useEffect(() => {
    if (!dirty) setD({ name: snap.name, aiWrite: snap.aiWrite, delayMinutes: Math.round((snap.delaySeconds / 60) * 10) / 10, subject: snap.subject, body: snap.body, delaySeconds: snap.delaySeconds, dailyLimit: snap.dailyLimit, allowPrevious: snap.allowPrevious });
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
    const { delayMinutes, ...rest } = d;
    const r = await api.emailUpdate(snap.id, { ...rest, delaySeconds: Math.round(Number(delayMinutes) * 60), dailyLimit: Number(d.dailyLimit) });
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
          <div>
            <strong>{snap.sentToday}</strong>
            <span>Today / {snap.dailyLimit}</span>
          </div>
        </div>
        <div className="em-bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
        {(snap.pauseText || (running && snap.waiting)) && <p className="em-sub">{snap.status === 'paused' ? `Paused: ${snap.pauseText}` : `Running: ${WAITING[snap.waiting] || snap.waiting}`}</p>}
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
            <span>Daily limit{snap.accountIds.length > 1 ? ' per account' : ''}</span>
            <input type="number" min={1} max={2000} value={d.dailyLimit} disabled={running} onChange={(e) => set('dailyLimit', e.target.value)} />
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
          <input type="email" placeholder="Test address (default: the sending account)" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Test address" />
          <button type="button" className="btn btn-sm" disabled={busy === 'test'} onClick={sendTest}>
            <Icon name="send" size={13} /> {busy === 'test' ? 'Sending…' : 'Send test'}
          </button>
        </div>
      </section>

      <section className="panel em-recipients" aria-label="Recipients">
        <div className="or-card-head">
          <h3>
            <Icon name="users" size={14} /> Recipients <span className="or-count">{n.total}</span>
          </h3>
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
            <span className="muted small">New leads of this category with an email are added by themselves</span>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" disabled={running} onClick={() => setPicker(true)}>
              <Icon name="plus" size={13} /> Add recipients
            </button>
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
                {snap.recipients.map((r) => (
                  <tr key={r.email}>
                    <td className="mono">{r.email}</td>
                    <td>{r.name || '—'}</td>
                    <td>{r.business || '—'}</td>
                    <td>
                      <span className={`em-state s-${r.state}`} title={r.error || ''}>
                        {STATE[r.state]}
                      </span>
                      {r.error && <span className="em-err-text">{r.error}</span>}
                      {r.sentAt && <span className="muted small"> {when(r.sentAt)}</span>}
                      {r.repliedAt && <span className="em-state s-replied">Replied</span>}
                      {r.aiBody && (
                        <details className="em-ai-sent">
                          <summary>AI email</summary>
                          <strong>{r.aiSubject}</strong>
                          <pre>{r.aiBody}</pre>
                        </details>
                      )}
                    </td>
                    <td>
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
    </>
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
  const reload = (next) => {
    loadCampaigns();
    loadCats();
    if (next === null) setSelected(null);
    else loadSnap(selected);
    loadAccounts();
  };

  return (
    <section className="outreach or-grid em-view" hidden={hidden} aria-label="Email campaigns">
      <aside className="or-side">
        <Accounts accounts={accounts.accounts} persistent={accounts.persistent} onChange={loadAccounts} notify={notify} />
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
        ) : (
          <Editor key={snap.id} snap={snap} accounts={accounts.accounts} categories={cats} notify={notify} reload={reload} />
        )}
      </div>
    </section>
  );
}
