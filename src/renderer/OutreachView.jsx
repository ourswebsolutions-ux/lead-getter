import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { planNeeded } from './Activation.jsx';

const api = window.leadFinder;

const STATE_LABEL = {
  queued: 'Pending',
  active: 'In sequence',
  replied: 'Replied',
  opted_out: 'Opted out',
  excluded: 'Excluded',
  skipped: 'Contacted before',
  done: 'Done',
  failed: 'Failed',
  uncertain: 'Check chat',
};
// Message states, as WhatsApp reports them. "Delivered" only after
// WhatsApp's delivery receipt.
const SEND_LABEL = { pending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', unknown: 'Unknown: check chat' };
const WAITING = {
  interval: 'Waiting for the interval before the next contact',
  next_message: 'Next message to the same contact in 30–60 seconds',
  whatsapp: 'Waiting for WhatsApp to connect',
  subscription: 'Waiting for an active plan (Activate at the top)',
  daily_cap: 'Daily limit reached: continues tomorrow',
  quiet_hours: 'Outside sending hours for the remaining contacts',
  not_started: 'Waiting for the start date',
  nothing_due: 'Nothing due right now',
  other_campaign: 'Waiting: another campaign is messaging a lead',
  completed: 'Completed: new leads are added automatically',
  retry_later: 'Waiting to retry failed messages',
};
const DISPLAY = { off: 'OFF', running: 'Running', paused: 'Paused', completed: 'Completed' };
const PAUSED = {
  user: 'Paused',
  restricted: 'Paused: WhatsApp refused messages (possible restriction). Check your account before resuming.',
  errors: 'Paused after repeated sending errors',
  finished: 'Finished: every contact has received the sequence or left it',
  ended: 'Ended: past the campaign’s end date',
};

const hours = Array.from({ length: 24 }, (_, h) => h);
const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');

function Stage({ n, of = 3 }) {
  return (
    <span className="stage-dots" aria-label={`${n} of ${of} messages sent`} title={`${n} of ${of} messages sent`}>
      {Array.from({ length: of }, (_, k) => k + 1).map((i) => (
        <span key={i} className={i <= n ? 'on' : ''} />
      ))}
    </span>
  );
}

function Confirm({ title, text, action, danger, onCancel, onConfirm }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onCancel();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onCancel]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="ack" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{text}</p>
        <footer className="composer-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
            {action}
          </button>
        </footer>
      </div>
    </div>
  );
}

function LeadPicker({ campaign, onClose, onAdded, notify }) {
  const saved = campaign.config.filters || {};
  const [cats, setCats] = useState(null);
  const [filters, setFilters] = useState({ categories: saved.categories || [], from: saved.from || '', to: saved.to || '', search: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [showPrev, setShowPrev] = useState(false);

  useEffect(() => {
    api.listCategories().then(setCats).catch(() => setCats({ categories: [], uncategorized: 0 }));
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  useEffect(() => {
    const t = setTimeout(() => {
      api.outreachEligible(campaign.id, { ...filters, from: filters.from || null, to: filters.to || null }).then((r) => {
        if (r.ok) {
          setData(r);
          setError('');
          // Keep only selections that are still eligible under the filters.
          const ok = new Set([...r.eligible, ...(r.allowPrevious ? r.previous : [])].filter((l) => !l.inCampaign).map((l) => l.id));
          setPick((s) => new Set([...s].filter((id) => ok.has(id))));
        } else setError(r.error);
      });
    }, 150);
    return () => clearTimeout(t);
  }, [campaign.id, filters]);

  const toggleCat = (key) => setFilters((f) => ({ ...f, categories: f.categories.includes(key) ? f.categories.filter((k) => k !== key) : [...f.categories, key] }));
  const selectable = (data?.eligible || []).filter((l) => !l.inCampaign);
  const toggle = (id, on) =>
    setPick((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  async function add() {
    setBusy(true);
    try {
      const r = await api.outreachAddLeads(campaign.id, [...pick]);
      if (r.ok) {
        const d = r.skippedDetail || {};
        const why = [d.previous && `${d.previous} contacted before`, d.optedOut && `${d.optedOut} opted out`, d.duplicate && `${d.duplicate} already added`].filter(Boolean).join(', ');
        notify({ type: 'ok', text: `${r.added} contact${r.added === 1 ? '' : 's'} added to ${campaign.name}${why ? ` (skipped: ${why})` : ''}.` });
        if (campaign.status !== 'running') api.outreachConfigure(campaign.id, { filters: { categories: filters.categories, from: filters.from || null, to: filters.to || null } });
        onAdded();
        onClose();
      } else setError(r.error);
    } finally {
      setBusy(false);
    }
  }

  const c = data?.counts;
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lead-picker wide" role="dialog" aria-modal="true" aria-label="Add verified leads">
        <header className="plans-head">
          <div>
            <h2>Add verified leads to {campaign.name}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="picker-filters">
          <div className="cat-chips" role="group" aria-label="Categories">
            <span className="field-label">Categories</span>
            <button type="button" className={`chip-toggle ${filters.categories.length === 0 ? 'on' : ''}`} aria-pressed={filters.categories.length === 0} onClick={() => setFilters((f) => ({ ...f, categories: [] }))}>
              All
            </button>
            {(cats?.categories || []).map((cat) => (
              <button key={cat.id} type="button" className={`chip-toggle ${filters.categories.includes(String(cat.id)) ? 'on' : ''}`} aria-pressed={filters.categories.includes(String(cat.id))} onClick={() => toggleCat(String(cat.id))}>
                {cat.name}
              </button>
            ))}
            {cats?.uncategorized > 0 && (
              <button type="button" className={`chip-toggle ${filters.categories.includes('none') ? 'on' : ''}`} aria-pressed={filters.categories.includes('none')} onClick={() => toggleCat('none')}>
                Uncategorized
              </button>
            )}
          </div>
          <div className="picker-tools">
            <label className="date-filter">
              <span className="field-label">Collected from</span>
              <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} aria-label="Collected from" />
            </label>
            <label className="date-filter">
              <span className="field-label">to</span>
              <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} aria-label="Collected to" />
            </label>
            <label className="date-filter grow">
              <span className="field-label">Search</span>
              <input type="search" placeholder="Name, number or area" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} aria-label="Search leads" />
            </label>
          </div>
        </div>
        {c && (
          <p className="picker-count" aria-live="polite">
            <b>{c.eligible}</b> verified contact{c.eligible === 1 ? '' : 's'} eligible
            <span className="muted">
              {' '}
              · {c.matching} lead{c.matching === 1 ? '' : 's'} match the filters · {c.notVerified} not verified (can’t be selected) · {c.previous} contacted before · {c.optedOut} opted out
            </span>
          </p>
        )}
        <div className="picker-tools">
          <button type="button" className="btn btn-ghost" disabled={!selectable.length} onClick={() => setPick(new Set(selectable.map((l) => l.id)))}>
            Select all ({selectable.length})
          </button>
          <button type="button" className="btn btn-ghost" disabled={!pick.size} onClick={() => setPick(new Set())}>
            Clear
          </button>
        </div>
        {error && <p className="composer-error">{error}</p>}
        <ul className="picker-list" aria-label="Eligible contacts">
          {!data && !error && <li className="muted">Loading leads…</li>}
          {data && !data.eligible.length && <li className="muted">No verified, not yet contacted numbers match these filters.</li>}
          {(data?.eligible || []).map((l) => (
            <li key={l.id}>
              <label className={l.inCampaign ? 'disabled' : ''}>
                <input type="checkbox" disabled={l.inCampaign} checked={pick.has(l.id)} onChange={(e) => toggle(l.id, e.target.checked)} />
                <span className="wa-dot" title="Confirmed on WhatsApp" aria-label="Confirmed on WhatsApp" />
                <span className="picker-name">{l.name}</span>
                <span className="mono picker-phone">{l.phone}</span>
                <span className="muted picker-meta">
                  {l.category || 'Uncategorized'} · {l.date || '–'}
                </span>
                {l.inCampaign && <span className="chip chip-soft">In campaign</span>}
                {l.previous && <span className="chip">Contacted before</span>}
              </label>
            </li>
          ))}
        </ul>
        {data?.previous?.length > 0 && (
          <div className="picker-prev">
            <button type="button" className="btn btn-ghost" aria-expanded={showPrev} onClick={() => setShowPrev((v) => !v)}>
              <Icon name="chevron" size={12} /> Previously contacted ({data.previous.length}) {data.allowPrevious ? '' : '· excluded'}
            </button>
            {showPrev && (
              <ul className="picker-list" aria-label="Previously contacted">
                {data.previous.map((l) => (
                  <li key={l.id}>
                    <label className={data.allowPrevious && !l.inCampaign ? '' : 'disabled'}>
                      <input type="checkbox" disabled={!data.allowPrevious || l.inCampaign} checked={pick.has(l.id)} onChange={(e) => toggle(l.id, e.target.checked)} />
                      <span className="picker-name">{l.name}</span>
                      <span className="mono picker-phone">{l.phone}</span>
                      <span className={`chip send-${l.history.status}`}>{SEND_LABEL[l.history.status] || l.history.status}</span>
                      <span className="muted picker-meta">
                        {l.history.campaign || 'Deleted campaign'} · {when(l.history.lastAt)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <footer className="composer-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!pick.size || busy} onClick={add}>
            Add {pick.size || ''} contact{pick.size === 1 ? '' : 's'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Acknowledge({ onCancel, onConfirm }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="ack" role="dialog" aria-modal="true" aria-label="Start live outreach">
        <h2>Send automatically from your WhatsApp?</h2>
        <p>
          WhatsApp’s terms don’t allow automated messaging from unofficial apps, and numbers that send unexpected messages can be restricted or banned. Lead Finder sends one contact at a time, at the interval and daily limit you set, stops messaging anyone who opts out, and pauses if WhatsApp refuses messages. The risk to your
          number remains yours.
        </p>
        <label className="ack-check">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I understand and want to send real messages from my WhatsApp account.
        </label>
        <footer className="composer-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!ok} onClick={onConfirm}>
            Start sending
          </button>
        </footer>
      </div>
    </div>
  );
}

// One card per lead category with its ON/OFF switch; campaigns made before
// category campaigns existed are listed below as "Other campaigns".
function CategoryCampaigns({ overview, cats, selected, onSelect, onToggle, toggling, checked, setChecked, onBulk, accountName }) {
  const rows = [...(cats?.categories || []).map((c) => ({ key: String(c.id), name: c.name })), ...(cats?.uncategorized > 0 ? [{ key: 'none', name: 'Uncategorized' }] : [])];
  const byCategory = new Map(overview.campaigns.filter((c) => c.category).map((c) => [c.category, c]));
  const others = overview.campaigns.filter((c) => !c.category);
  const all = overview.campaigns;
  const allOn = all.length > 0 && all.every((c) => checked.has(c.id));
  const check = (id) => (
    <input
      type="checkbox"
      className="or-check"
      checked={checked.has(id)}
      aria-label={`Select ${all.find((c) => c.id === id)?.name}`}
      onChange={(e) =>
        setChecked((s) => {
          const n = new Set(s);
          if (e.target.checked) n.add(id);
          else n.delete(id);
          return n;
        })
      }
    />
  );
  const badge = (c, on) => c && <span className={`or-badge ${c.test ? '' : 'live'}`}>{c.test ? 'Test' : on ? accountName(c.accountId) : 'Live'}</span>;
  return (
    <div className="panel or-campaigns campaign-list">
      <div className="or-card-head">
        <h3>Campaigns</h3>
        {all.length > 0 && (
          <label className="or-select-all">
            <input type="checkbox" checked={allOn} onChange={(e) => setChecked(e.target.checked ? new Set(all.map((c) => c.id)) : new Set())} aria-label="Select all campaigns" /> All
          </label>
        )}
      </div>
      {checked.size > 0 && (
        <div className="or-bulk">
          <span>{checked.size} selected</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onBulk('reset')}>
            Reset selected
          </button>
          <button type="button" className="btn btn-sm btn-ghost btn-danger-text" onClick={() => onBulk('delete')}>
            <Icon name="trash" size={13} /> Delete selected
          </button>
        </div>
      )}
      <div className="or-campaigns-scroll">
      {!rows.length && <p className="or-empty">No lead categories yet.</p>}
      <ul className="or-list" aria-label="Category campaigns">
        {rows.map((r) => {
          const c = byCategory.get(r.key);
          const st = overview.categories?.[r.key] || { seen: 0, unseenVerified: 0, unseenNotVerified: 0 };
          const on = Boolean(c && c.status !== 'stopped');
          const display = c ? c.display : 'off';
          return (
            <li key={r.key} className={`or-item ${c && selected === c.id ? 'on' : ''}`}>
              {c ? check(c.id) : <span className="or-check" />}
              <button type="button" className="or-item-main campaign-item" onClick={() => onSelect(r.key, c)} aria-current={Boolean(c && selected === c.id)}>
                <span className="or-item-top">
                  <strong className="campaign-item-name">{r.name}</strong>
                  <span className={`or-status st-${display}`}>
                    <span className="or-dot" />
                    {DISPLAY[display]}
                  </span>
                </span>
                <span className="or-item-meta">
                  <span title="Confirmed on WhatsApp, not messaged yet">{st.unseenVerified} ready</span>
                  <span title="Messaged by a campaign">{st.seen} seen</span>
                  {st.unseenNotVerified > 0 && <span title="Not on WhatsApp, or not checked yet">{st.unseenNotVerified} not on WhatsApp</span>}
                  {badge(c, on)}
                </span>
              </button>
              <button type="button" role="switch" aria-checked={on} aria-label={`${r.name} campaign`} className={`switch ${on ? 'on' : ''}`} disabled={toggling === r.key} onClick={() => onToggle(r.key, !on)}>
                <span className="switch-knob" />
              </button>
            </li>
          );
        })}
      </ul>
      {others.length > 0 && (
        <>
          <h4 className="or-sub">Other campaigns</h4>
          <ul className="or-list" aria-label="Other campaigns">
            {others.map((c) => (
              <li key={c.id} className={`or-item ${selected === c.id ? 'on' : ''}`}>
                {check(c.id)}
                <button type="button" className="or-item-main campaign-item" onClick={() => onSelect(null, c)} aria-current={selected === c.id}>
                  <span className="or-item-top">
                    <strong className="campaign-item-name">{c.name}</strong>
                    <span className={`or-status st-${c.display}`}>
                      <span className="or-dot" />
                      {DISPLAY[c.display]}
                    </span>
                  </span>
                  <span className="or-item-meta">
                    <span>{c.contacts} contacts</span>
                    {badge(c, c.status !== 'stopped')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      </div>
    </div>
  );
}
function History({ history }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="panel campaign-history">
      <div className="templates-head">
        <h3>Previously contacted</h3>
        <span className="muted small">
          {history.length} number{history.length === 1 ? '' : 's'} · all campaigns · excluded from new campaigns by default
        </span>
      </div>
      {!history.length ? (
        <p className="muted">Nobody has been messaged by a campaign yet.</p>
      ) : (
        <>
          <div className="table-scroll">
            <table className="mini-table" aria-label="Previously contacted">
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Campaign</th>
                  <th>Messages</th>
                  <th>Status</th>
                  <th>Last sent</th>
                </tr>
              </thead>
              <tbody>
                {(open ? history : history.slice(0, 8)).map((h) => (
                  <tr key={h.phone}>
                    <td>
                      <div className="contact-cell">
                        <span>{h.leadName || 'Not a lead'}</span>
                        <span className="mono muted contact-phone">{h.phone}</span>
                      </div>
                    </td>
                    <td>{h.campaign || 'Deleted campaign'}</td>
                    <td>{h.messages}</td>
                    <td>
                      <span className={`chip send-${h.status}`}>{SEND_LABEL[h.status] || h.status}</span>
                      {h.optedOut && <span className="chip st-chip st-opted_out">Opted out</span>}
                    </td>
                    <td>{when(h.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {history.length > 8 && (
            <button type="button" className="btn btn-ghost" onClick={() => setOpen((v) => !v)}>
              {open ? 'Show fewer' : `Show all ${history.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

const ACCOUNT_STATE = {
  open: ['Connected', 'ok'],
  connecting: ['Connecting…', 'soft'],
  reconnecting: ['Reconnecting…', 'soft'],
  qr: ['Scan the QR code', 'warn'],
  qr_expired: ['QR expired', 'warn'],
  disconnected: ['Disconnected', 'soft'],
  logged_out: ['Unlinked', 'bad'],
  error: ['Error', 'bad'],
};

// The WhatsApp accounts campaigns send from: compact rows; a click opens the details.
function WaAccounts({ accounts, usedBy, defaultInterval, notify, onOpen }) {
  const [adding, setAdding] = useState(false);
  const [interval, setIntervalValue] = useState(defaultInterval);
  useEffect(() => setIntervalValue(defaultInterval), [defaultInterval]);
  const add = async () => {
    setAdding(true);
    try {
      const r = await api.waAddAccount();
      if (r?.ok) onOpen(r.id);
      else if (r && !r.canceled && !planNeeded(r)) notify({ type: 'error', text: r.error });
    } finally {
      setAdding(false);
    }
  };
  const saveInterval = async () => {
    if (Number(interval) === defaultInterval) return;
    const r = await api.outreachDefaultInterval(Number(interval));
    if (!r.ok) {
      notify({ type: 'error', text: r.error });
      setIntervalValue(defaultInterval);
    } else notify({ type: 'ok', text: `New campaigns: ${r.interval} minutes between contacts.` });
  };
  const live = accounts.filter((a) => a.state === 'open').length;
  return (
    <div className="panel or-accounts wa-accounts" aria-label="WhatsApp accounts">
      <div className="or-card-head">
        <h3>
          WhatsApp <span className="or-count">{live}/{accounts.length}</span>
        </h3>
        <button type="button" className="btn btn-sm" disabled={adding} onClick={add}>
          <Icon name="plus" size={13} /> Add account
        </button>
      </div>
      <ul className="or-acc-list wa-account-list">
        {accounts.map((a) => {
          const [label, tone] = ACCOUNT_STATE[a.state] || ACCOUNT_STATE.disconnected;
          const user = usedBy(a.id);
          return (
            <li key={a.id} className="wa-account">
              <button type="button" className="or-acc" onClick={() => onOpen(a.id)} aria-label={`${a.label} details`}>
                <span className={`wa-dot tone-${tone}`} aria-hidden="true" />
                <span className="or-acc-main">
                  <strong>{a.label}</strong>
                  <span>
                    {a.number || label}
                    {a.number && a.state !== 'open' ? ` · ${label}` : ''}
                  </span>
                </span>
                {user && <span className="or-badge live" title={`used by ${user}`}>{user}</span>}
                {a.state === 'qr' && <span className="or-badge warn">QR</span>}
                {a.error && <Icon name="alert" size={14} className="or-acc-err" />}
              </button>
            </li>
          );
        })}
      </ul>
      <label className="or-default wa-default-interval">
        <span>Default interval</span>
        <input type="number" min="1" max="1440" value={interval} onChange={(e) => setIntervalValue(e.target.value)} onBlur={saveInterval} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} aria-label="Default interval (minutes)" />
        <span>min</span>
      </label>
    </div>
  );
}

// One account in full: state, number, QR code, the campaign using it, actions.
function AccountDetails({ account: a, usedBy, notify, onClose }) {
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState(a?.label || '');
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  if (!a) return null;
  const [stateLabel, tone] = ACCOUNT_STATE[a.state] || ACCOUNT_STATE.disconnected;
  const run = async (fn, close = false) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && !r.ok && !r.canceled && !planNeeded(r)) notify({ type: 'error', text: r.error });
      if (r?.ok && close) onClose();
    } finally {
      setBusy(false);
    }
  };
  const user = usedBy(a.id);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="composer or-acc-detail" role="dialog" aria-modal="true" aria-label={`WhatsApp account ${a.label}`}>
        <header className="composer-head">
          <span className="composer-icon">
            <Icon name="chat" />
          </span>
          <div>
            <strong>{a.label}</strong>
            <span className={`or-status tone-${tone}`}>
              <span className="or-dot" />
              {stateLabel}
            </span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        {a.state === 'qr' && a.qr && (
          <div className="or-qr">
            <img src={a.qr} alt={`QR code for ${a.label}`} />
            <span>WhatsApp → Linked devices → Link a device</span>
          </div>
        )}
        <dl className="or-facts">
          <div>
            <dt>Number</dt>
            <dd className="mono">{a.number || '—'}</dd>
          </div>
          <div>
            <dt>WhatsApp name</dt>
            <dd>{a.name || '—'}</dd>
          </div>
          <div>
            <dt>Campaign</dt>
            <dd>{user ? user.replace(/^used by /, '') : 'Free'}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{a.primary ? 'First account (number checks)' : 'Added account'}</dd>
          </div>
        </dl>
        {a.error && <p className="composer-error">{a.error}</p>}
        <label className="or-field">
          <span>Label</span>
          <input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} onBlur={() => label.trim() !== a.label && run(() => api.waAccountRename(a.id, label))} aria-label="Account label" />
        </label>
        <footer className="composer-actions">
          {!a.primary && (
            <button type="button" className="btn btn-ghost btn-danger-text" disabled={busy} onClick={() => run(() => api.waAccountRemove(a.id), true)}>
              <Icon name="trash" size={13} /> Remove
            </button>
          )}
          <span className="spacer" />
          {a.state === 'open' ? (
            <button type="button" className="btn" disabled={busy} onClick={() => run(() => api.waAccountDisconnect(a.id))}>
              Disconnect
            </button>
          ) : ['connecting', 'reconnecting', 'qr'].includes(a.state) ? null : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => api.waAccountConnect(a.id))}>
              {a.number ? 'Reconnect' : 'Connect'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
// Which WhatsApp account a campaign sends from: asked before it starts.
function AccountPicker({ campaignName, accounts, usedBy, current, onCancel, onChoose, onAdd }) {
  const connected = accounts.filter((a) => a.state === 'open');
  const free = connected.filter((a) => !usedBy(a.id, true));
  const [choice, setChoice] = useState(() => (free.find((a) => a.id === current) || free[0])?.id || null);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="composer account-picker" role="dialog" aria-modal="true" aria-label="Choose WhatsApp account">
        <header className="composer-head">
          <span className="composer-icon neutral"><Icon name="chat" /></span>
          <div>
            <strong>Send “{campaignName}” from</strong>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onCancel}><Icon name="x" /></button>
        </header>
        {!connected.length ? (
          <div className="account-empty">
            <p>Connect a WhatsApp account first.</p>
            <button type="button" className="btn btn-primary" onClick={onAdd}>+ Connect an account</button>
          </div>
        ) : (
          <div className="account-options" role="radiogroup" aria-label="WhatsApp account">
            {connected.map((a) => {
              const user = usedBy(a.id, true);
              return (
                <label key={a.id} className={`account-option ${choice === a.id ? 'on' : ''} ${user ? 'taken' : ''}`}>
                  <input type="radio" name="wa-account" value={a.id} checked={choice === a.id} disabled={Boolean(user)} onChange={() => setChoice(a.id)} />
                  <span>
                    <strong>{a.label}</strong>
                    <span className="muted small">{a.number}{user ? ` · ${user}` : ''}</span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <div className="dl-pair-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!choice} onClick={() => onChoose(choice)}>
            <Icon name="play" /> Start
          </button>
        </div>
      </div>
    </div>
  );
}

const TABS = [
  ['overview', 'Overview', 'grid'],
  ['messages', 'Messages', 'message'],
  ['settings', 'Settings', 'sliders'],
  ['contacts', 'Contacts', 'users'],
];
const LETTER = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtOf = (v) => (/ogg/.test(v.mime) ? 'OPUS' : /mpeg/.test(v.mime) ? 'MP3' : /mp4/.test(v.mime) ? 'M4A' : /aac/.test(v.mime) ? 'AAC' : /amr/.test(v.mime) ? 'AMR' : 'AUDIO');
const placeholders = (t) => /\{\s*(name|business([ _]name)?)\s*\}/i.test(t || '');
const relTime = (ms, now) => {
  if (!ms) return '';
  const d = Math.round((ms - now) / 60_000);
  if (d <= 0) return 'now';
  if (d < 60) return `in ${d} min`;
  return `in ${Math.floor(d / 60)} h ${d % 60} min`;
};
// The same check the main process makes before saving.
function urlProblem(raw) {
  let s = String(raw || '').trim();
  if (!s) return 'Enter a web address';
  if (/\s/.test(s)) return 'No spaces in a web address';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol) || !/^[^.]+(\.[^.]+)+$/.test(u.hostname)) return 'Not a valid web address';
  } catch {
    return 'Not a valid web address';
  }
  return null;
}

function Disclosure({ total, shown, open, onToggle, label = 'See more' }) {
  if (total <= shown) return null;
  return (
    <button type="button" className="or-more" aria-expanded={open} onClick={onToggle}>
      {open ? 'Show less' : `${label} (${total - shown} more)`}
      <Icon name="chevron" size={12} className={open ? 'or-up' : ''} />
    </button>
  );
}

// Who is being messaged now, the next two, and the rest on request.
function LiveQueue({ snap, contacts, now, statusText }) {
  const [open, setOpen] = useState(false);
  const byPhone = new Map(contacts.map((c) => [c.phone, c]));
  const current = snap.current ? byPhone.get(snap.current) : null;
  const next = (snap.upcoming || []).map((p) => byPhone.get(p)).filter(Boolean);
  const running = snap.status === 'running';
  const row = (c, tag) => (
    <li key={c.phone} className={`or-q-row ${tag}`}>
      <span className="or-avatar">{(c.name || '#').slice(0, 1).toUpperCase()}</span>
      <span className="or-q-main">
        <strong>{c.name || 'No name'}</strong>
        <span className="mono">{c.phone}</span>
      </span>
      <span className="or-q-cat">{snap.name}</span>
      {tag === 'now' ? <span className="or-chip sending">Sending · {c.stage}/{snap.config.templates.length}</span> : c.state === 'failed' ? <span className="or-chip failed">Retry</span> : c.stage > 0 ? <span className="or-chip pending">{c.stage}/{snap.config.templates.length} sent</span> : <span className="or-chip pending">Pending</span>}
    </li>
  );
  return (
    <section className="panel or-live" aria-label="Live progress">
      <div className="or-card-head">
        <h3>Live progress</h3>
        <span className={`or-status st-${snap.display}`}>
          <span className="or-dot" />
          {running && snap.nextDueAt && snap.nextDueAt > now ? `Next ${relTime(snap.nextDueAt, now)}` : DISPLAY[snap.display]}
        </span>
      </div>
      <p className="or-live-note campaign-status">{statusText}</p>
      <h4 className="or-label">Currently sending</h4>
      <ul className="or-q" aria-label="Currently sending">
        {current ? row(current, 'now') : <li className="or-q-empty">{running ? 'Nobody right now' : 'Not running'}</li>}
      </ul>
      <h4 className="or-label">
        Next <span className="or-count">{next.length}</span>
      </h4>
      <ul className="or-q" aria-label="Next recipients">
        {next.length ? (open ? next : next.slice(0, 2)).map((c) => row(c, 'next')) : <li className="or-q-empty">Queue empty</li>}
      </ul>
      <Disclosure total={next.length} shown={2} open={open} onToggle={() => setOpen((v) => !v)} label="See more" />
    </section>
  );
}

// The latest sent messages (two, then all on request); a click shows the whole message.
function SentList({ snap, onOpen }) {
  const [open, setOpen] = useState(false);
  const sends = snap.sends || [];
  return (
    <section className="panel or-sent campaign-sent" aria-label="Sent messages">
      <div className="or-card-head">
        <h3>
          Sent <span className="or-count">{sends.filter((s) => s.status !== 'failed').length}</span>
        </h3>
        {snap.config.test && <span className="or-badge">Test run</span>}
      </div>
      {!sends.length ? (
        <p className="or-empty">Nothing sent yet.</p>
      ) : (
        <div className="or-table-scroll">
        <table className="or-table">
          <tbody>
            {(open ? sends : sends.slice(0, 2)).map((s) => (
              <tr key={s.id} onClick={() => onOpen(s)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(s)} className="or-click">
                <td className="or-kind">
                  <Icon name={s.kind === 'audio' ? 'audio' : 'message'} size={14} />
                </td>
                <td>
                  <strong>{s.name || 'No name'}</strong> <span className="mono muted">{s.phone}</span>
                  <span className="or-snippet">{s.kind === 'audio' ? s.body : s.body ? s.body.split('\n')[0] : `Message ${s.stage}`}</span>
                </td>
                <td className="or-step">{s.stage} of {snap.config.templates.length}</td>
                <td>
                  <span className={`or-chip ${s.status}`} title={s.error || ''}>
                    {SEND_LABEL[s.status] || s.status}
                  </span>
                </td>
                <td className="or-time">{when(s.sentAt || s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <Disclosure total={sends.length} shown={2} open={open} onToggle={() => setOpen((v) => !v)} />
    </section>
  );
}

// Each variation as it would be sent (two, then all on request); a click opens the full conversation.
function Previews({ preview, draft, contactName, onOpen }) {
  const [open, setOpen] = useState(false);
  const items = [];
  (preview?.messages || []).forEach((vars, i) => vars.forEach((text, j) => items.push({ step: i + 1, variant: j, text, count: vars.length })));
  return (
    <section className="panel or-previews" aria-label="Message previews">
      <div className="or-card-head">
        <h3>
          Preview <span className="or-count">{items.length}</span>
        </h3>
        <span className="muted small">{contactName}</span>
      </div>
      <ul className="or-prev-list">
        {(open ? items : items.slice(0, 2)).map((it) => (
          <li key={`${it.step}-${it.variant}`}>
            <button type="button" className="or-prev template-preview" onClick={() => onOpen(it)} aria-label={`Preview message ${it.step}${it.count > 1 ? LETTER(it.variant) : ''}`}>
              <span className="or-prev-tag">
                {it.step}
                {it.count > 1 ? LETTER(it.variant) : ''}
              </span>
              <span className="or-prev-text" dir="auto">
                {it.text}
              </span>
              {it.step === draft.attachStep && (draft.links.length > 0 || draft.voices.length > 0) && (
                <span className="or-prev-att">
                  {draft.links.length > 0 && (
                    <span>
                      <Icon name="link" size={12} /> {draft.links.length}
                    </span>
                  )}
                  {draft.voices.length > 0 && (
                    <span>
                      <Icon name="audio" size={12} /> {draft.voices.length}
                    </span>
                  )}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <Disclosure total={items.length} shown={2} open={open} onToggle={() => setOpen((v) => !v)} />
    </section>
  );
}

// A voice file's player: the file is read only when asked for.
function VoicePlayer({ voice }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState('');
  if (/amr/.test(voice.mime)) return <span className="muted small">No preview for AMR</span>;
  if (url) return <audio className="or-audio" src={url} controls autoPlay aria-label={`Play ${voice.name}`} />;
  return (
    <>
      <button
        type="button"
        className="icon-btn or-play"
        aria-label={`Play ${voice.name}`}
        onClick={async () => {
          const r = await api.outreachAudioData(voice.id);
          if (r.ok) setUrl(r.url);
          else setError(r.error);
        }}
      >
        <Icon name="play" size={13} />
      </button>
      {error && <span className="composer-error">{error}</span>}
    </>
  );
}

// The whole conversation a contact gets with one variation (or one sent message).
function PreviewModal({ item, preview, draft, contactName, onClose }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const sent = item.sent;
  const steps = sent ? [] : (preview?.messages || []).map((vars, i) => ({ step: i + 1, text: i + 1 === item.step ? vars[item.variant] : vars[0], variant: i + 1 === item.step ? item.variant : 0, count: vars.length }));
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="composer or-preview-modal" role="dialog" aria-modal="true" aria-label="Message preview">
        <header className="composer-head">
          <span className="composer-icon">
            <Icon name={sent?.kind === 'audio' ? 'audio' : 'message'} />
          </span>
          <div>
            <strong>{sent ? `${sent.name || 'No name'} · message ${sent.stage} of ${draft.templates.length}` : `Message ${item.step}${item.count > 1 ? ` · variation ${LETTER(item.variant)}` : ''}`}</strong>
            <span className="muted small">{sent ? `${sent.phone} · ${SEND_LABEL[sent.status] || sent.status} · ${when(sent.sentAt || sent.createdAt)}` : contactName}</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="or-thread">
          {sent ? (
            <div className="ms-bubble out or-bubble">
              {sent.kind === 'audio' ? (
                <p>
                  <Icon name="audio" size={13} /> {sent.body}
                </p>
              ) : (
                <p dir="auto">{sent.body || 'The text of this message was not recorded (sent by an earlier version).'}</p>
              )}
              {sent.error && <span>{sent.error}</span>}
            </div>
          ) : (
            steps.map((s) => (
              <div key={s.step} className={`or-thread-step ${s.step === item.step ? 'on' : ''}`}>
                <span className="or-thread-tag">
                  {s.step}
                  {s.count > 1 ? LETTER(s.variant) : ''}
                </span>
                <div className="ms-bubble out or-bubble">
                  <p dir="auto">{s.text}</p>
                </div>
                {s.step === draft.attachStep &&
                  draft.voices.map((v) => (
                    <div key={v.id} className="ms-bubble out or-bubble or-voice-bubble">
                      <Icon name="audio" size={13} />
                      <span className="or-voice-name">{v.name}</span>
                      <VoicePlayer voice={v} />
                    </div>
                  ))}
              </div>
            ))
          )}
        </div>
        {!sent && draft.links.length > 0 && (
          <ul className="or-link-sum">
            {draft.links.map((l, i) => (
              <li key={i}>
                <Icon name="link" size={12} /> {l.title || l.url} {l.title && <span className="mono muted">{l.url}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// One message of the sequence and its variations (rotated between contacts).
// Message 1 is required; the others can be removed.
function StepEditor({ index, step, disabled, onChange, onRemove, preview }) {
  const refs = useRef([]);
  const vars = step.variations;
  const n = index + 1;
  const set = (j, patch) => onChange({ variations: vars.map((v, k) => (k === j ? { ...v, ...patch } : v)) });
  const insert = (j, token) => {
    const el = refs.current[j];
    const v = vars[j].text;
    const a = el ? el.selectionStart : v.length;
    const b = el ? el.selectionEnd : v.length;
    set(j, { text: v.slice(0, a) + token + v.slice(b) });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(a + token.length, a + token.length);
    });
  };
  return (
    <section className="panel or-step" aria-label={`Message ${n}`}>
      <div className="or-card-head">
        <h3>
          <span className="or-step-num">{n}</span> Message {n}
        </h3>
        {vars.length > 1 && <span className="or-badge">Rotates · {vars.length}</span>}
        <button type="button" className="btn btn-sm btn-ghost" disabled={disabled || vars.length >= 20} onClick={() => onChange({ variations: [...vars, { text: '', fallback: '' }] })} aria-label={`Add variation to message ${n}`} title="Another version, rotated between contacts">
          <Icon name="plus" size={13} /> Variation
        </button>
        {onRemove && (
          <button type="button" className="icon-btn danger" disabled={disabled} aria-label={`Remove message ${n}`} title="Remove message" onClick={onRemove}>
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
      <div className="or-vars">
        {vars.map((v, j) => (
          <div key={j} className="or-var template">
            <div className="or-var-head">
              {vars.length > 1 && <span className="or-var-tag">{LETTER(j)}</span>}
              <span className="or-tokens">
                <button type="button" className="chip-toggle" disabled={disabled} onClick={() => insert(j, '{name}')}>
                  {'{name}'}
                </button>
                <button type="button" className="chip-toggle" disabled={disabled} onClick={() => insert(j, '{business name}')}>
                  {'{business name}'}
                </button>
              </span>
              {vars.length > 1 && (
                <button type="button" className="icon-btn danger" disabled={disabled} title="Delete variation" aria-label={`Delete message ${n}${LETTER(j)}`} onClick={() => onChange({ variations: vars.filter((_, k) => k !== j) })}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
            <textarea
              ref={(el) => (refs.current[j] = el)}
              rows={3}
              dir="auto"
              disabled={disabled}
              value={v.text}
              onChange={(e) => set(j, { text: e.target.value })}
              aria-label={vars.length > 1 ? `Message ${n}${LETTER(j)}` : `Message ${n}`}
              aria-required={index === 0}
              placeholder="Write the message…"
            />
            {(placeholders(v.text) || v.fallback) && (
              <textarea
                className="or-fallback"
                rows={2}
                dir="auto"
                disabled={disabled}
                value={v.fallback}
                placeholder="When the name or business isn’t known"
                onChange={(e) => set(j, { fallback: e.target.value })}
                aria-label={vars.length > 1 ? `Message ${n}${LETTER(j)} without a name` : `Message ${n} without a name`}
              />
            )}
            {preview?.[j] && (
              <p className="or-var-preview" dir="auto">
                {preview[j]}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// Which message the links and voice files go with (only when there is a choice).
function SendWith({ draft, disabled, edit }) {
  const n = draft.templates.length;
  if (n < 2) return null;
  return (
    <label className="or-with">
      <span>With</span>
      <select disabled={disabled} value={Math.min(draft.attachStep || n, n)} onChange={(e) => edit({ attachStep: Number(e.target.value) })} aria-label="Attachments go with">
        {draft.templates.map((_, i) => (
          <option key={i} value={i + 1}>
            Message {i + 1}
          </option>
        ))}
      </select>
    </label>
  );
}

// Links: shown only when there is at least one.
function LinksSection({ draft, disabled, edit }) {
  const links = draft.links;
  if (!links.length) return null;
  const setLink = (i, patch) => edit({ links: links.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
  return (
    <section className="panel or-links" aria-label="Links">
      <div className="or-card-head">
        <h3>
          <Icon name="link" size={15} /> Links <span className="or-count">{links.length}</span>
        </h3>
        <SendWith draft={draft} disabled={disabled} edit={edit} />
      </div>
      <ul className="or-link-list">
        {links.map((l, i) => {
          const problem = l.url || l.title ? urlProblem(l.url) : null;
          return (
            <li key={i} className={problem ? 'bad' : ''}>
              <span className="or-link-icon">
                <Icon name="link" size={14} />
              </span>
              <input className="or-link-title" disabled={disabled} value={l.title} maxLength={60} placeholder="Title (optional)" onChange={(e) => setLink(i, { title: e.target.value })} aria-label={`Link ${i + 1} title`} />
              <input className="or-link-url mono" disabled={disabled} value={l.url} placeholder="https://" autoFocus={!l.url && !l.title && i === links.length - 1} onChange={(e) => setLink(i, { url: e.target.value })} aria-label={`Link ${i + 1} address`} aria-invalid={Boolean(problem)} />
              <button type="button" className="icon-btn danger" disabled={disabled} aria-label={`Remove link ${i + 1}`} onClick={() => edit({ links: links.filter((_, k) => k !== i) })}>
                <Icon name="x" size={14} />
              </button>
              {problem && <span className="or-link-err">{problem}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Voice files: shown only when there is at least one (or a file was refused).
function VoicesSection({ draft, disabled, edit, errors }) {
  if (!draft.voices.length && !errors.length) return null;
  return (
    <section className="panel or-voices" aria-label="Voice files">
      <div className="or-card-head">
        <h3>
          <Icon name="audio" size={15} /> Voice files <span className="or-count">{draft.voices.length}</span>
        </h3>
        {draft.voices.length > 0 && <SendWith draft={draft} disabled={disabled} edit={edit} />}
      </div>
      <ul className="or-voice-list">
        {draft.voices.map((v, i) => (
          <li key={v.id}>
            <span className="or-voice-icon">
              <Icon name="audio" size={15} />
            </span>
            <span className="or-voice-main">
              <strong title={v.name}>{v.name}</strong>
              <span>
                <span className="or-badge">{fmtOf(v)}</span> {kb(v.size)} {v.ptt ? '· voice note' : '· audio file'}
              </span>
            </span>
            <VoicePlayer voice={v} />
            <button type="button" className="icon-btn" disabled={disabled || i === 0} aria-label={`Move ${v.name} up`} title="Send earlier" onClick={() => edit({ voices: draft.voices.map((x, k, a) => (k === i - 1 ? a[i] : k === i ? a[i - 1] : x)) })}>
              <Icon name="chevron" size={13} className="or-up" />
            </button>
            <button type="button" className="icon-btn danger" disabled={disabled} aria-label={`Remove ${v.name}`} onClick={() => edit({ voices: draft.voices.filter((x) => x.id !== v.id) })}>
              <Icon name="x" size={14} />
            </button>
          </li>
        ))}
      </ul>
      {errors.map((e) => (
        <p key={e} className="composer-error" role="alert">
          {e}
        </p>
      ))}
    </section>
  );
}

// The campaign's content: message 1 (required), then only what the user adds.
function Composer({ draft, disabled, edit, notify, preview }) {
  const [adding, setAdding] = useState(false);
  const [errors, setErrors] = useState([]);
  const steps = draft.templates;
  const setStep = (i, step) => edit({ templates: steps.map((t, j) => (j === i ? step : t)) });
  const removeStep = (i) => {
    const templates = steps.filter((_, j) => j !== i);
    const at = draft.attachStep || steps.length;
    edit({ templates, attachStep: at === i + 1 ? templates.length : at > i + 1 ? at - 1 : Math.min(at, templates.length) });
  };
  const addVoice = async () => {
    setAdding(true);
    try {
      const r = await api.outreachAudioPick();
      if (r.canceled) return;
      const errs = [...(r.errors || [])];
      if (r.voices?.length) {
        const room = 10 - draft.voices.length;
        edit({ voices: [...draft.voices, ...r.voices.slice(0, room)] });
        if (r.voices.length > room) errs.push('Up to 10 voice files per campaign.');
      } else if (!r.ok && !r.errors?.length && !planNeeded(r)) notify({ type: 'error', text: r.error });
      setErrors(errs);
    } finally {
      setAdding(false);
    }
  };
  return (
    <div className="or-messages campaign-templates">
      {steps.map((step, i) => (
        <StepEditor key={i} index={i} step={step} disabled={disabled} onChange={(s) => setStep(i, s)} onRemove={i > 0 ? () => removeStep(i) : null} preview={preview?.messages?.[i]} />
      ))}
      <LinksSection draft={draft} disabled={disabled} edit={edit} />
      <VoicesSection draft={draft} disabled={disabled} edit={edit} errors={errors} />
      <div className="or-add-row" role="group" aria-label="Add to the campaign">
        <button type="button" className="btn" disabled={disabled || steps.length >= 10} onClick={() => edit({ templates: [...steps, { variations: [{ text: '', fallback: '' }] }] })}>
          <Icon name="plus" size={14} /> Add Message
        </button>
        <button type="button" className="btn" disabled={disabled || draft.links.length >= 10} onClick={() => edit({ links: [...draft.links, { title: '', url: '' }] })}>
          <Icon name="link" size={14} /> Add Link
        </button>
        <button type="button" className="btn" disabled={disabled || adding || draft.voices.length >= 10} onClick={addVoice}>
          <Icon name="audio" size={14} /> {adding ? 'Adding…' : 'Add Voice'}
        </button>
      </div>
    </div>
  );
}

export default function OutreachView({ notify, hidden }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [snap, setSnap] = useState(null);
  const [history, setHistory] = useState([]);
  const [draft, setDraft] = useState(null); // editable settings, messages and attachments
  const [dirty, setDirty] = useState(false);
  const [previewPhone, setPreviewPhone] = useState('');
  const [preview, setPreview] = useState(null);
  const [picker, setPicker] = useState(false);
  const [ack, setAck] = useState(null); // null | { category } | { campaign: true }
  const [cats, setCats] = useState(null);
  const [toggling, setToggling] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind, ids }
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [picker2, setPicker2] = useState(null); // { campaign, name, category?, current }: choosing the account
  const [tab, setTab] = useState('overview');
  const [detail, setDetail] = useState(null); // an account id
  const [modal, setModal] = useState(null); // a preview or a sent message
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const loadOverview = useCallback(async () => {
    const r = await api.outreachOverview();
    if (!r.ok) return setError(r.error);
    setError('');
    setOverview(r);
    setChecked((s) => new Set([...s].filter((id) => r.campaigns.some((c) => c.id === id))));
    setSelected((cur) => (r.campaigns.some((c) => c.id === cur) ? cur : r.campaigns[0]?.id ?? null));
    api.outreachHistory().then((h) => h.ok && setHistory(h.history));
    api.listCategories().then(setCats).catch(() => {});
  }, []);

  const loadSnap = useCallback(async (id) => {
    if (!id) return setSnap(null);
    const r = await api.outreachState(id);
    if (r.ok) {
      setSnap(r);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    loadOverview();
    api.waAccounts().then((l) => setAccounts(l || []));
    return api.onWaAccounts((l) => setAccounts(l || []));
  }, [loadOverview]);

  useEffect(() => {
    setDirty(false);
    setPreviewPhone('');
    loadSnap(selected);
  }, [selected, loadSnap]);

  useEffect(() => {
    let t = null;
    const off = api.onOutreach(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        loadOverview();
        loadSnap(selected);
      }, 150);
    });
    const offEv = api.onOutreachEvent((e) => {
      if (e.type === 'replied') notify({ type: 'ok', text: `${e.phone} replied. Their remaining messages still go.` });
      else if (e.type === 'opted_out') notify({ type: 'ok', text: `${e.phone} asked not to be contacted. They won’t be messaged again.` });
      else if (e.type === 'failed') notify({ type: 'error', text: `Message to ${e.phone} failed: ${e.error}${e.paused ? ' The campaign is paused.' : ''}` });
    });
    return () => {
      off();
      offEv();
      clearTimeout(t);
    };
  }, [loadOverview, loadSnap, selected, notify]);

  const fresh = (s) => ({ ...JSON.parse(JSON.stringify(s.config)), name: s.name });
  useEffect(() => {
    if (snap && !dirty) setDraft(fresh(snap));
  }, [snap, dirty]);

  const contacts = snap?.contacts || [];
  useEffect(() => {
    if (!previewPhone && contacts.length) setPreviewPhone(contacts[0].phone);
  }, [contacts, previewPhone]);

  // Live preview of the (possibly unsaved) messages and links for one contact
  // (only the latest answer is shown).
  const previewSeq = useRef(0);
  const snapId = snap?.id;
  useEffect(() => {
    if (!draft || !snapId) return undefined;
    const t = setTimeout(() => {
      const n = ++previewSeq.current;
      api.outreachRender(snapId, draft.templates, previewPhone, { links: draft.links.filter((l) => !urlProblem(l.url)), attachStep: draft.attachStep }).then((r) => r.ok && n === previewSeq.current && setPreview(r));
    }, 150);
    return () => clearTimeout(t);
  }, [draft, previewPhone, snapId]);

  const edit = (patch) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  async function save() {
    const r = await api.outreachConfigure(snap.id, { ...draft, links: draft.links.filter((l) => l.url.trim() || l.title.trim()) });
    if (r.ok) {
      // The saved campaign first, so the editor never shows the old one.
      await loadSnap(snap.id);
      setDirty(false);
      notify({ type: 'ok', text: 'Campaign settings saved.' });
      await loadOverview();
    } else notify({ type: 'error', text: r.error });
    return r.ok;
  }

  // The campaign using an account (live, running or paused), for labels and the picker.
  const usedBy = (accountId, excludeSelected = false) => {
    const c = (overview?.campaigns || []).find((x) => !x.test && ['running', 'paused'].includes(x.status) && (x.accountId || 'primary') === accountId && !(excludeSelected && picker2 && x.id === picker2.campaign));
    return c ? `used by ${c.name}` : null;
  };
  const accountName = (id) => accounts.find((a) => a.id === (id || 'primary'))?.label || 'WhatsApp';

  async function act(fn, accountId) {
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok && r.needsAcknowledgement) setAck({ campaign: true, accountId });
      else if (!r.ok && !planNeeded(r)) notify({ type: 'error', text: r.error });
      await loadOverview();
      await loadSnap(selected);
      return r;
    } finally {
      setBusy(false);
    }
  }

  // Live campaigns ask which WhatsApp account to send from; test runs send nothing.
  async function start(acknowledge = false, accountId = null) {
    if (dirty && !(await save())) return;
    if (live && !accountId) return setPicker2({ campaign: snap.id, name: snap.name, current: snap.config.accountId });
    await act(() => api.outreachStart(snap.id, acknowledge, accountId || undefined), accountId);
  }

  async function selectCategory(key, campaign) {
    if (campaign) return setSelected(campaign.id);
    const r = await api.outreachCategoryCampaign(key);
    if (!r.ok) return notify({ type: 'error', text: r.error });
    await loadOverview();
    setSelected(r.id);
  }

  // The category switch: ON fills the queue and starts sending; OFF stops
  // scheduling (a message already being sent finishes).
  async function toggleCategory(key, on, acknowledge = false, accountId = null) {
    // The campaign as it is now (its mode may have just changed).
    const existing = on && !accountId ? ((await api.outreachOverview())?.campaigns || overview.campaigns).find((c) => c.category === key) : null;
    if (existing && !existing.test) return setPicker2({ campaign: existing.id, name: existing.name, category: key, current: existing.accountId });
    setToggling(key);
    try {
      const r = await api.outreachSetCategory(key, on, acknowledge, accountId || undefined);
      if (!r.ok && r.needsAcknowledgement) {
        setAck({ category: key, accountId });
        return;
      }
      if (!r.ok && !planNeeded(r)) notify({ type: 'error', text: r.error });
      await loadOverview();
      if (r.id) {
        setSelected(r.id);
        await loadSnap(r.id);
      }
    } finally {
      setToggling(null);
    }
  }

  async function bulk(kind) {
    const ids = [...confirm.ids];
    setConfirm(null);
    const r = await act(() => (kind === 'delete' ? api.outreachDelete(ids) : api.outreachReset(ids)));
    if (r.ok) {
      notify({ type: 'ok', text: kind === 'delete' ? `${r.deleted} campaign${r.deleted === 1 ? '' : 's'} deleted.` : `${r.reset} campaign${r.reset === 1 ? '' : 's'} reset.` });
      setChecked(new Set());
      setDirty(false);
    }
  }

  if (error) {
    return (
      <section className="outreach panel" hidden={hidden}>
        <p className="chat-note">{error}</p>
      </section>
    );
  }
  if (!overview) {
    return (
      <section className="outreach panel" hidden={hidden}>
        <p className="muted">Loading campaigns…</p>
      </section>
    );
  }

  const running = snap?.status === 'running';
  const paused = snap?.status === 'paused';
  const live = draft ? !draft.test : false;
  const counts = contacts.reduce((m, c) => ((m[c.state] = (m[c.state] || 0) + 1), m), {});
  const statusText = !snap ? '' : running ? WAITING[snap.waiting] || 'Running' : paused ? PAUSED[snap.pauseReason] || 'Paused' : PAUSED[snap.pauseReason] || 'Not running';
  const names = overview.campaigns.filter((c) => confirm?.ids.includes(c.id)).map((c) => c.name);
  const account = snap ? accounts.find((x) => x.id === (snap.config.accountId || 'primary')) : null;
  const reached = contacts.filter((c) => c.stage > 0).length;
  const failedSends = (snap?.sends || []).filter((s) => s.status === 'failed').length;
  const contactName = (() => {
    const c = contacts.find((x) => x.phone === previewPhone);
    if (c) return `${c.name || 'No name'} · ${c.phone}`;
    return preview?.sample ? `${preview.sample.name} · ${preview.sample.phone}` : 'A contact without a known name';
  })();

  return (
    <section className="outreach or-grid" hidden={hidden} aria-label="Real-estate outreach">
      <aside className="or-side">
        <WaAccounts accounts={accounts} usedBy={(id) => usedBy(id)} defaultInterval={overview.defaultInterval} notify={notify} onOpen={setDetail} />
        <CategoryCampaigns
          overview={overview}
          cats={cats}
          selected={selected}
          onSelect={selectCategory}
          onToggle={toggleCategory}
          toggling={toggling}
          checked={checked}
          setChecked={setChecked}
          onBulk={(kind) => setConfirm({ kind, ids: [...checked] })}
          accountName={accountName}
        />
      </aside>

      <div className="or-main">
        {!snap || !draft ? (
          <div className="panel or-blank">
            <Icon name="message" size={28} />
            <p>Choose a campaign</p>
          </div>
        ) : (
          <>
            <header className="panel or-head campaign-card">
              <div className="or-head-top">
                <div className="or-head-title">
                  <h2>{snap.name}</h2>
                  <span className={`or-status st-${snap.display}`}>
                    <span className="or-dot" />
                    {DISPLAY[snap.display]}
                  </span>
                  <span className={`or-badge ${live ? 'live' : ''}`}>{live ? 'Live' : 'Test run'}</span>
                  {live && (
                    <button type="button" className="or-badge or-acc-badge" onClick={() => account && setDetail(account.id)} title="WhatsApp account">
                      <span className={`wa-dot tone-${(ACCOUNT_STATE[account?.state] || ACCOUNT_STATE.disconnected)[1]}`} />
                      {account ? `${account.label}${account.number ? ` · ${account.number}` : ''}` : 'Account chosen at start'}
                    </button>
                  )}
                </div>
                <div className="or-controls campaign-controls">
                  {snap.category && (
                    <button type="button" role="switch" aria-checked={running || paused} aria-label={`${snap.name} campaign switch`} className={`switch ${running || paused ? 'on' : ''}`} disabled={toggling === snap.category} onClick={() => toggleCategory(snap.category, !(running || paused))}>
                      <span className="switch-knob" />
                    </button>
                  )}
                  {!snap.category && !running && !paused && (
                    <button type="button" className="btn btn-primary" disabled={busy || !contacts.length} onClick={() => start()}>
                      <Icon name="play" /> Start
                    </button>
                  )}
                  {running && (
                    <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.outreachPause(snap.id))}>
                      <Icon name="pause" /> Pause
                    </button>
                  )}
                  {paused && (
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(() => api.outreachResume(snap.id))}>
                      <Icon name="play" /> Resume
                    </button>
                  )}
                  {!snap.category && (running || paused) && (
                    <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.outreachStop(snap.id))}>
                      <Icon name="stop" /> Stop
                    </button>
                  )}
                </div>
              </div>
              <div className="or-stats campaign-facts" aria-label="Campaign numbers">
                <div className="or-stat">
                  <b className="mono">
                    {snap.today.recipients}
                    <small>/{snap.today.cap}</small>
                  </b>
                  <span>Today</span>
                </div>
                <div className="or-stat">
                  <b className="mono">{counts.queued || 0}</b>
                  <span>Pending</span>
                </div>
                <div className="or-stat tone-accent">
                  <b className="mono">{counts.active || 0}</b>
                  <span>In progress</span>
                </div>
                <div className="or-stat">
                  <b className="mono">{counts.done || 0}</b>
                  <span>Completed</span>
                </div>
                <div className="or-stat">
                  <b className="mono">{contacts.filter((c) => c.repliedAt || c.state === 'replied').length}</b>
                  <span>Replied</span>
                </div>
                <div className={`or-stat ${counts.failed || failedSends ? 'tone-bad' : ''}`}>
                  <b className="mono">{(counts.failed || 0) + (counts.uncertain || 0)}</b>
                  <span>Failed</span>
                </div>
              </div>
              <div className="or-progress" title={`${reached} of ${contacts.length} contacts messaged`}>
                <span className="dl-progress-bar">
                  <span style={{ width: `${contacts.length ? (reached / contacts.length) * 100 : 0}%` }} />
                </span>
                <span className="mono">
                  {reached}/{contacts.length}
                </span>
              </div>
            </header>

            <nav className="segmented or-tabs" role="tablist" aria-label="Campaign sections">
              {TABS.map(([key, label, icon]) => (
                <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
                  <Icon name={icon} size={14} /> {label}
                  {key === 'contacts' && <span className="or-count">{contacts.length}</span>}
                </button>
              ))}
            </nav>

            <div className="or-pane">
            {tab === 'overview' && (
              <div className="or-overview">
                <LiveQueue snap={snap} contacts={contacts} now={now} statusText={statusText} />
                <SentList snap={snap} onOpen={(s) => setModal({ sent: s })} />
                <Previews preview={preview} draft={draft} contactName={contactName} onOpen={setModal} />
              </div>
            )}

            {tab === 'messages' && (
              <>
                {contacts.length > 0 || preview?.sample ? (
                  <div className="or-msg-bar">
                    <label className="or-field preview-for">
                      <span>Preview for</span>
                      <select value={previewPhone} onChange={(e) => setPreviewPhone(e.target.value)} aria-label="Preview for contact">
                        {!contacts.length && <option value="">{preview?.sample ? `${preview.sample.name} · ${preview.sample.phone}` : 'A contact without a known name'}</option>}
                        {contacts.map((c) => (
                          <option key={c.phone} value={c.phone}>
                            {c.name || 'No name'} · {c.phone}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
                <Composer draft={draft} disabled={running} edit={edit} notify={notify} preview={preview} />
              </>
            )}

            {tab === 'settings' && (
              <section className="panel or-settings campaign-settings" aria-label="Settings">
                <fieldset disabled={running}>
                  <div className="or-set-row">
                    <label className="or-field grow">
                      <span>Campaign name</span>
                      <input value={draft.name} maxLength={60} onChange={(e) => edit({ name: e.target.value })} aria-label="Campaign name" />
                    </label>
                    <div className="or-field">
                      <span>Mode</span>
                      <div className="segmented" role="group" aria-label="Mode">
                        <button type="button" className={!live ? 'on' : ''} onClick={() => edit({ test: true })}>
                          Test run
                        </button>
                        <button type="button" className={live ? 'on' : ''} onClick={() => edit({ test: false })}>
                          Live
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="or-set-grid">
                    <label className="or-tile">
                      <Icon name="calendar" size={15} />
                      <span>Interval</span>
                      <span className="or-tile-input">
                        <input type="number" min={snap.limits.interval.min} max={snap.limits.interval.max} value={draft.interval} onChange={(e) => edit({ interval: Number(e.target.value) })} aria-label="Interval (minutes)" />
                        min
                      </span>
                    </label>
                    <label className="or-tile">
                      <Icon name="send" size={15} />
                      <span>Daily limit</span>
                      <span className="or-tile-input">
                        <input type="number" min={snap.limits.capMin} step="1" value={draft.dailyCap} onChange={(e) => edit({ dailyCap: Number(e.target.value) })} aria-label="Daily limit" />
                        contacts
                      </span>
                    </label>
                    <div className="or-tile">
                      <Icon name="sun" size={15} />
                      <span>Sending hours</span>
                      <span className="or-tile-input">
                        <select value={draft.quietEnd} onChange={(e) => edit({ quietEnd: Number(e.target.value) })} aria-label="Sending hours from">
                          {hours.map((h) => (
                            <option key={h} value={h}>
                              {hh(h)}
                            </option>
                          ))}
                        </select>
                        –
                        <select value={draft.quietStart} onChange={(e) => edit({ quietStart: Number(e.target.value) })} aria-label="Sending hours to">
                          {hours.map((h) => (
                            <option key={h} value={h}>
                              {hh(h)}
                            </option>
                          ))}
                        </select>
                      </span>
                    </div>
                    <div className="or-tile">
                      <Icon name="calendar" size={15} />
                      <span>Dates</span>
                      <span className="or-tile-input">
                        <input type="date" value={draft.startDate || ''} onChange={(e) => edit({ startDate: e.target.value || null })} aria-label="Start date" />
                        –
                        <input type="date" value={draft.endDate || ''} onChange={(e) => edit({ endDate: e.target.value || null })} aria-label="End date" />
                      </span>
                    </div>
                  </div>
                  <label className="or-toggle-row">
                    <input type="checkbox" checked={Boolean(draft.allowPrevious)} onChange={(e) => edit({ allowPrevious: e.target.checked })} /> Allow previously contacted contacts
                  </label>
                </fieldset>
              </section>
            )}

            {tab === 'contacts' && (
              <>
                <section className="panel or-contacts campaign-contacts" aria-label="Queue">
                  <div className="or-card-head">
                    <h3>
                      Queue <span className="or-count">{contacts.length}</span>
                    </h3>
                    {!snap.category && (
                      <button type="button" className="btn btn-sm" onClick={() => setPicker(true)}>
                        <Icon name="users" size={13} /> Add verified leads
                      </button>
                    )}
                  </div>
                  {!contacts.length ? (
                    <p className="or-empty">{snap.category ? 'Empty. Switch the campaign ON, or wait for leads confirmed on WhatsApp.' : 'No contacts yet.'}</p>
                  ) : (
                    <div className="table-scroll">
                      <table className="mini-table">
                        <thead>
                          <tr>
                            <th>Contact</th>
                            <th>Progress</th>
                            <th aria-label="Actions" />
                          </tr>
                        </thead>
                        <tbody>
                          {contacts.map((c) => (
                            <tr key={c.phone} className={`st-${c.state}`}>
                              <td>
                                <div className="contact-cell">
                                  <input
                                    className="name-edit"
                                    defaultValue={c.name || ''}
                                    placeholder="No name"
                                    disabled={c.stage > 0 || running}
                                    title={c.stage > 0 ? 'Already messaged' : 'Leave empty to use the version without a name'}
                                    onBlur={(e) => e.target.value.trim() !== (c.name || '') && api.outreachSetName(snap.id, c.phone, e.target.value.trim() || null)}
                                    aria-label={`Name used for ${c.phone}`}
                                  />
                                  <span className="mono muted contact-phone">
                                    <span className="wa-dot" title="Confirmed on WhatsApp" /> {c.phone}
                                  </span>
                                </div>
                              </td>
                              <td className="progress-cell">
                                <Stage n={c.stage} of={snap.config.templates.length} />
                                <span className={`chip st-chip st-${c.state}`} title={c.note || ''}>
                                  {c.phone === snap.current ? 'Sending' : c.state === 'failed' && c.retryAt ? 'Failed: retrying' : STATE_LABEL[c.state] || c.state}
                                </span>
                                {c.repliedAt && c.state !== 'replied' && (
                                  <span className="chip st-chip st-replied" title={`Replied ${when(c.repliedAt)}`}>
                                    Replied
                                  </span>
                                )}
                              </td>
                              <td className="row-actions">
                                {['queued', 'active'].includes(c.state) && (
                                  <button type="button" className="btn btn-ghost" onClick={() => act(() => api.outreachExclude(snap.id, c.phone))}>
                                    Exclude
                                  </button>
                                )}
                                {['excluded', 'failed', 'uncertain', 'replied', 'skipped'].includes(c.state) && !c.optedOut && (
                                  <button type="button" className="btn btn-ghost" onClick={() => act(() => api.outreachInclude(snap.id, c.phone))}>
                                    {c.state === 'failed' ? 'Retry' : 'Resume'}
                                  </button>
                                )}
                                {!c.optedOut && (
                                  <button type="button" className="btn btn-ghost" title="Never message this number from campaigns" onClick={() => act(() => api.outreachOptOut(c.phone))}>
                                    Opt out
                                  </button>
                                )}
                                {c.stage === 0 && ['queued', 'excluded', 'skipped'].includes(c.state) && (
                                  <button type="button" className="icon-btn" aria-label={`Remove ${c.phone}`} onClick={() => act(() => api.outreachRemoveContact(snap.id, c.phone))}>
                                    <Icon name="x" size={14} />
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
                <History history={history} />
              </>
            )}

            </div>

            {dirty && (
              <div className="or-savebar" role="region" aria-label="Unsaved changes">
                <button type="button" className="btn btn-primary" disabled={running} onClick={save}>
                  Save settings
                </button>
                <button type="button" className="btn" disabled={running} onClick={() => (setDirty(false), setDraft(fresh(snap)))}>
                  Discard
                </button>
                <span>Unsaved changes</span>
              </div>
            )}
          </>
        )}
      </div>

      {picker && snap && <LeadPicker campaign={snap} onClose={() => setPicker(false)} onAdded={() => (loadOverview(), loadSnap(snap.id))} notify={notify} />}
      {detail && <AccountDetails key={detail} account={accounts.find((a) => a.id === detail)} usedBy={(id) => usedBy(id)} notify={notify} onClose={() => setDetail(null)} />}
      {modal && draft && <PreviewModal item={modal} preview={preview} draft={draft} contactName={contactName} onClose={() => setModal(null)} />}
      {picker2 && (
        <AccountPicker
          campaignName={picker2.name}
          accounts={accounts}
          usedBy={usedBy}
          current={picker2.current}
          onCancel={() => setPicker2(null)}
          onAdd={() => {
            setPicker2(null);
            api.waAddAccount().then((r) => (r.ok ? setDetail(r.id) : !planNeeded(r) && notify({ type: 'error', text: r.error })));
          }}
          onChoose={(id) => {
            const p = picker2;
            setPicker2(null);
            if (p.category) toggleCategory(p.category, true, false, id);
            else start(false, id);
          }}
        />
      )}
      {ack && (
        <Acknowledge
          onCancel={() => setAck(null)}
          onConfirm={() => {
            const pending = ack;
            setAck(null);
            if (pending.category) toggleCategory(pending.category, true, true, pending.accountId);
            else start(true, pending.accountId);
          }}
        />
      )}
      {confirm && (
        <Confirm
          title={confirm.kind === 'delete' ? 'Delete campaigns?' : 'Reset campaigns?'}
          danger={confirm.kind === 'delete'}
          action={confirm.kind === 'delete' ? `Delete ${confirm.ids.length}` : `Reset ${confirm.ids.length}`}
          text={
            confirm.kind === 'delete'
              ? `${names.join(', ')} will be deleted with their queues and settings. Everyone they already messaged stays in “Previously contacted” and won’t be messaged by new campaigns.`
              : `${names.join(', ')} will be stopped and their queues and progress cleared; their settings and messages are kept. Everyone already messaged stays in “Previously contacted” and can’t be messaged again by mistake.`
          }
          onCancel={() => setConfirm(null)}
          onConfirm={() => bulk(confirm.kind)}
        />
      )}
    </section>
  );
}
