import { useCallback, useEffect, useState } from 'react';
import Icon from './icons.jsx';

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
  interval: 'Waiting before the next contact (45–60 minutes after the last one)',
  next_message: 'Next message to the same contact in about a minute',
  whatsapp: 'Waiting for WhatsApp to connect',
  subscription: 'Waiting for an active subscription',
  daily_cap: 'Daily limit reached: continues tomorrow',
  quiet_hours: 'Outside sending hours for the remaining contacts',
  not_started: 'Waiting for the start date',
  nothing_due: 'Nothing due right now',
};
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

function Stage({ n }) {
  return (
    <span className="stage-dots" aria-label={`${n} of 3 messages sent`} title={`${n} of 3 messages sent`}>
      {[1, 2, 3].map((i) => (
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
            <p className="muted">Only numbers confirmed on WhatsApp by the automatic check. People already messaged in any campaign are listed separately.</p>
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
            {!data.allowPrevious && <p className="muted small">To message someone again, turn on “Allow previously contacted contacts” in this campaign’s settings. Opt-outs are never messaged.</p>}
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
          WhatsApp’s terms don’t allow automated or bulk messaging from unofficial apps, and numbers that send unexpected messages are often restricted or banned. Lead Finder keeps the volume low (one new person every 45–60 minutes, their three messages about a minute apart, at most 15 people a day), stops as soon as
          someone replies or opts out, and pauses if WhatsApp refuses messages. The risk to your number remains yours.
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

function CampaignList({ overview, selected, onSelect, checked, setChecked, onCreate, onBulk }) {
  const all = overview.campaigns;
  const allOn = all.length > 0 && all.every((c) => checked.has(c.id));
  return (
    <div className="panel campaign-list">
      <div className="templates-head">
        <h3>Campaigns</h3>
        <button type="button" className="btn" onClick={onCreate}>
          <Icon name="send" /> New campaign
        </button>
      </div>
      {all.length > 0 && (
        <div className="bulk-bar">
          <label className="check">
            <input type="checkbox" checked={allOn} onChange={(e) => setChecked(e.target.checked ? new Set(all.map((c) => c.id)) : new Set())} aria-label="Select all campaigns" /> Select all
          </label>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" disabled={!checked.size} onClick={() => onBulk('reset')}>
            Reset selected
          </button>
          <button type="button" className="btn btn-ghost btn-danger-text" disabled={!checked.size} onClick={() => onBulk('delete')}>
            <Icon name="trash" /> Delete selected
          </button>
        </div>
      )}
      {!all.length ? (
        <p className="muted">No campaigns yet. Create one to start.</p>
      ) : (
        <ul className="campaign-items" aria-label="Campaigns">
          {all.map((c) => (
            <li key={c.id} className={selected === c.id ? 'on' : ''}>
              <input
                type="checkbox"
                checked={checked.has(c.id)}
                aria-label={`Select ${c.name}`}
                onChange={(e) =>
                  setChecked((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(c.id);
                    else n.delete(c.id);
                    return n;
                  })
                }
              />
              <button type="button" className="campaign-item" onClick={() => onSelect(c.id)} aria-current={selected === c.id}>
                <span className="campaign-item-name">{c.name}</span>
                <span className="muted small">
                  {c.contacts} contact{c.contacts === 1 ? '' : 's'} · {c.counts.done || 0} done · {c.counts.replied || 0} replied
                </span>
              </button>
              <span className={`chip ${c.test ? 'chip-soft' : 'chip-live'}`}>{c.test ? 'Test' : 'Live'}</span>
              <span className={`chip st-campaign st-${c.status}`}>{c.status === 'running' ? 'Running' : c.status === 'paused' ? 'Paused' : 'Stopped'}</span>
            </li>
          ))}
        </ul>
      )}
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

export default function OutreachView({ wa, notify, hidden }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [snap, setSnap] = useState(null);
  const [history, setHistory] = useState([]);
  const [draft, setDraft] = useState(null); // editable settings + templates
  const [dirty, setDirty] = useState(false);
  const [previewPhone, setPreviewPhone] = useState('');
  const [preview, setPreview] = useState(null);
  const [picker, setPicker] = useState(false);
  const [ack, setAck] = useState(false);
  const [confirm, setConfirm] = useState(null); // { kind, ids }
  const [busy, setBusy] = useState(false);

  const loadOverview = useCallback(async () => {
    const r = await api.outreachOverview();
    if (!r.ok) return setError(r.error);
    setError('');
    setOverview(r);
    setChecked((s) => new Set([...s].filter((id) => r.campaigns.some((c) => c.id === id))));
    setSelected((cur) => (r.campaigns.some((c) => c.id === cur) ? cur : r.campaigns[0]?.id ?? null));
    api.outreachHistory().then((h) => h.ok && setHistory(h.history));
  }, []);

  const loadSnap = useCallback(async (id) => {
    if (!id) return setSnap(null);
    const r = await api.outreachState(id);
    if (r.ok) setSnap(r);
  }, []);

  useEffect(() => {
    loadOverview();
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
      if (e.type === 'replied') notify({ type: 'ok', text: `${e.phone} replied. The sequence stopped for them; continue in Chats.` });
      else if (e.type === 'opted_out') notify({ type: 'ok', text: `${e.phone} asked not to be contacted. They won’t be messaged again.` });
      else if (e.type === 'failed') notify({ type: 'error', text: `Message to ${e.phone} failed: ${e.error}${e.paused ? ' The campaign is paused.' : ''}` });
    });
    return () => {
      off();
      offEv();
      clearTimeout(t);
    };
  }, [loadOverview, loadSnap, selected, notify]);

  useEffect(() => {
    if (snap && !dirty) setDraft({ ...JSON.parse(JSON.stringify(snap.config)), name: snap.name });
  }, [snap, dirty]);

  const contacts = snap?.contacts || [];
  useEffect(() => {
    if (!previewPhone && contacts.length) setPreviewPhone(contacts[0].phone);
  }, [contacts, previewPhone]);

  // Live preview of the (possibly unsaved) templates for one contact.
  useEffect(() => {
    if (!draft || !snap) return undefined;
    const t = setTimeout(() => api.outreachRender(snap.id, draft.templates, previewPhone).then((r) => r.ok && setPreview(r)), 150);
    return () => clearTimeout(t);
  }, [draft, previewPhone, snap]);

  const edit = (patch) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const editTemplate = (i, field, value) => {
    setDraft((d) => ({ ...d, templates: d.templates.map((t, j) => (j === i ? { ...t, [field]: value } : t)) }));
    setDirty(true);
  };

  async function save() {
    const r = await api.outreachConfigure(snap.id, draft);
    if (r.ok) {
      setDirty(false);
      notify({ type: 'ok', text: 'Campaign settings saved.' });
      await loadOverview();
      await loadSnap(snap.id);
    } else notify({ type: 'error', text: r.error });
    return r.ok;
  }

  async function act(fn) {
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok && r.needsAcknowledgement) setAck(true);
      else if (!r.ok) notify({ type: 'error', text: r.error });
      await loadOverview();
      await loadSnap(selected);
      return r;
    } finally {
      setBusy(false);
    }
  }

  async function start(acknowledge = false) {
    if (dirty && !(await save())) return;
    await act(() => api.outreachStart(snap.id, acknowledge));
  }

  async function create() {
    const r = await api.outreachCreate('');
    if (r.ok) {
      await loadOverview();
      setSelected(r.id);
    } else notify({ type: 'error', text: r.error });
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
  const connected = wa?.state === 'open';
  const counts = contacts.reduce((m, c) => ((m[c.state] = (m[c.state] || 0) + 1), m), {});
  const statusText = !snap ? '' : running ? WAITING[snap.waiting] || 'Running' : paused ? PAUSED[snap.pauseReason] || 'Paused' : PAUSED[snap.pauseReason] || 'Not running';
  const names = overview.campaigns.filter((c) => confirm?.ids.includes(c.id)).map((c) => c.name);

  return (
    <section className="outreach" hidden={hidden} aria-label="Real-estate outreach">
      <div className="outreach-col">
        <CampaignList overview={overview} selected={selected} onSelect={setSelected} checked={checked} setChecked={setChecked} onCreate={create} onBulk={(kind) => setConfirm({ kind, ids: [...checked] })} />

        {snap && draft && (
          <>
            <div className="panel campaign-card">
              <div className="campaign-top">
                <div>
                  <h2>{snap.name}</h2>
                  <p className={`campaign-status status-${snap.status}${snap.pauseReason === 'restricted' ? ' danger' : ''}`}>
                    <span className="dot" /> {statusText}
                  </p>
                </div>
                <span className={`chip ${live ? 'chip-live' : 'chip-soft'}`}>{live ? 'Live' : 'Test run'}</span>
              </div>
              <dl className="campaign-facts">
                <div>
                  <dt>WhatsApp</dt>
                  <dd>{connected ? `${wa.account?.name || 'Linked'} · +${wa.account?.id || ''}` : live ? 'Not connected' : 'Not needed in a test run'}</dd>
                </div>
                <div>
                  <dt>Today (all campaigns)</dt>
                  <dd>
                    {snap.today.recipients} / {snap.today.cap} contacts
                  </dd>
                </div>
                <div>
                  <dt>Next message</dt>
                  <dd>{running ? (snap.nextDueAt && snap.nextDueAt > Date.now() ? when(snap.nextDueAt) : 'When due') : '–'}</dd>
                </div>
                <div>
                  <dt>Contacts</dt>
                  <dd>
                    {contacts.length} ({counts.queued || 0} pending, {counts.active || 0} in sequence, {counts.done || 0} done, {counts.replied || 0} replied)
                  </dd>
                </div>
              </dl>
              <div className="campaign-controls">
                {!running && !paused && (
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
                {(running || paused) && (
                  <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.outreachStop(snap.id))}>
                    <Icon name="stop" /> Stop
                  </button>
                )}
              </div>
              {live && !snap.acknowledged && <p className="muted small">Live sending asks for your confirmation first.</p>}
            </div>

            <div className="panel campaign-settings">
              <h3>Settings</h3>
              <fieldset disabled={running}>
                <label className="settings-name">
                  <span className="field-label">Campaign name</span>
                  <input value={draft.name} maxLength={60} onChange={(e) => edit({ name: e.target.value })} aria-label="Campaign name" />
                </label>
                <div className="segmented" role="group" aria-label="Mode">
                  <button type="button" className={!live ? 'on' : ''} onClick={() => edit({ test: true })}>
                    Test run
                  </button>
                  <button type="button" className={live ? 'on' : ''} onClick={() => edit({ test: false })}>
                    Live
                  </button>
                </div>
                <p className="muted small">{live ? 'Messages are sent from your WhatsApp.' : 'Runs the whole schedule without sending anything, so you can check the order and timing.'}</p>
                <div className="settings-grid">
                  <label>
                    <span className="field-label">Gap between contacts (minutes)</span>
                    <span className="range-pair">
                      <input type="number" min={snap.limits.intervalMin} max={snap.limits.intervalMax} value={draft.intervalMin} onChange={(e) => edit({ intervalMin: Number(e.target.value) })} aria-label="Shortest interval" />
                      <span>to</span>
                      <input type="number" min={snap.limits.intervalMin} max={snap.limits.intervalMax} value={draft.intervalMax} onChange={(e) => edit({ intervalMax: Number(e.target.value) })} aria-label="Longest interval" />
                    </span>
                    <span className="muted small">Each contact’s three messages go about a minute apart; the next contact starts a random 45–60 minutes after that.</span>
                  </label>
                  <label>
                    <span className="field-label">Daily limit (contacts, all campaigns)</span>
                    <input type="number" min={snap.limits.capMin} max={snap.limits.capMax} value={draft.dailyCap} onChange={(e) => edit({ dailyCap: Number(e.target.value) })} aria-label="Daily limit" />
                  </label>
                  <label>
                    <span className="field-label">Sending hours (recipient’s time)</span>
                    <span className="range-pair">
                      <select value={draft.quietEnd} onChange={(e) => edit({ quietEnd: Number(e.target.value) })} aria-label="Sending hours from">
                        {hours.map((h) => (
                          <option key={h} value={h}>
                            {hh(h)}
                          </option>
                        ))}
                      </select>
                      <span>to</span>
                      <select value={draft.quietStart} onChange={(e) => edit({ quietStart: Number(e.target.value) })} aria-label="Sending hours to">
                        {hours.map((h) => (
                          <option key={h} value={h}>
                            {hh(h)}
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                  <label>
                    <span className="field-label">Campaign dates (optional)</span>
                    <span className="range-pair">
                      <input type="date" value={draft.startDate || ''} onChange={(e) => edit({ startDate: e.target.value || null })} aria-label="Start date" />
                      <span>to</span>
                      <input type="date" value={draft.endDate || ''} onChange={(e) => edit({ endDate: e.target.value || null })} aria-label="End date" />
                    </span>
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={Boolean(draft.allowPrevious)} onChange={(e) => edit({ allowPrevious: e.target.checked })} /> Allow previously contacted contacts
                  </label>
                  {draft.allowPrevious && <p className="muted small">People messaged before in any campaign can be added to this one. Opt-outs are never messaged.</p>}
                </div>
              </fieldset>
            </div>

            <div className="panel campaign-templates">
              <div className="templates-head">
                <h3>Messages</h3>
                <label className="preview-for">
                  <span className="muted small">Preview for</span>
                  <select value={previewPhone} onChange={(e) => setPreviewPhone(e.target.value)} aria-label="Preview for contact">
                    {!contacts.length && <option value="">A contact without a known name</option>}
                    {contacts.map((c) => (
                      <option key={c.phone} value={c.phone}>
                        {c.name || 'No name'} · {c.phone}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="muted small">
                Sent in this order, about a minute apart, to one contact at a time. Use <code>{'{name}'}</code> and <code>{'{business}'}</code> (the business name from Google Maps); the second box is used when that isn’t known.
              </p>
              <fieldset disabled={running}>
                {draft.templates.map((t, i) => (
                  <div key={i} className="template">
                    <span className="field-label">Message {i + 1}</span>
                    <textarea rows={2} dir="auto" value={t.text} onChange={(e) => editTemplate(i, 'text', e.target.value)} aria-label={`Message ${i + 1}`} />
                    <textarea rows={1} dir="auto" value={t.fallback} placeholder="Version without {name} / {business} (needed when they are used)" onChange={(e) => editTemplate(i, 'fallback', e.target.value)} aria-label={`Message ${i + 1} without a name`} />
                    {preview && (
                      <p className="template-preview" dir="auto">
                        <span className="muted small">Preview:</span> {preview.messages[i]}
                      </p>
                    )}
                  </div>
                ))}
              </fieldset>
              <footer className="composer-actions">
                {dirty && <span className="muted small">Unsaved changes</span>}
                <button type="button" className="btn" disabled={!dirty || running} onClick={() => (setDirty(false), setDraft({ ...JSON.parse(JSON.stringify(snap.config)), name: snap.name }))}>
                  Discard
                </button>
                <button type="button" className="btn btn-primary" disabled={!dirty || running} onClick={save}>
                  Save settings
                </button>
              </footer>
            </div>
          </>
        )}
      </div>

      <div className="outreach-col wide">
        {snap && (
          <>
            <div className="panel campaign-contacts">
              <div className="templates-head">
                <h3>Contacts in {snap.name}</h3>
                <button type="button" className="btn" onClick={() => setPicker(true)}>
                  <Icon name="users" /> Add verified leads
                </button>
              </div>
              {!contacts.length ? (
                <p className="muted">No contacts yet. Add leads whose numbers were confirmed on WhatsApp.</p>
              ) : (
                <div className="table-scroll">
                  <table className="mini-table">
                    <thead>
                      <tr>
                        <th>Contact (name used in messages)</th>
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
                            <Stage n={c.stage} />
                            <span className={`chip st-chip st-${c.state}`} title={c.note || ''}>
                              {STATE_LABEL[c.state] || c.state}
                            </span>
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
            </div>

            <div className="panel campaign-sent">
              <h3>
                Sent by {snap.name} {live ? '' : '(test run)'}
              </h3>
              {!snap.sends.length ? (
                <p className="muted">Nothing sent yet.</p>
              ) : (
                <div className="table-scroll">
                  <table className="mini-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Contact</th>
                        <th>Message</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snap.sends.map((s) => (
                        <tr key={s.id}>
                          <td>{when(s.sentAt || s.createdAt)}</td>
                          <td>
                            {s.name || 'No name'} <span className="mono muted">{s.phone}</span>
                          </td>
                          <td>{s.stage} of 3</td>
                          <td>
                            <span className={`chip send-${s.status}`} title={s.error || ''}>
                              {SEND_LABEL[s.status] || s.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
        <History history={history} />
      </div>

      {picker && snap && <LeadPicker campaign={snap} onClose={() => setPicker(false)} onAdded={() => (loadOverview(), loadSnap(snap.id))} notify={notify} />}
      {ack && (
        <Acknowledge
          onCancel={() => setAck(false)}
          onConfirm={() => {
            setAck(false);
            start(true);
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
