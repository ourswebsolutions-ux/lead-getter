import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './icons.jsx';

const api = window.leadFinder;

const STATE_LABEL = {
  queued: 'Queued',
  active: 'In sequence',
  replied: 'Replied',
  opted_out: 'Opted out',
  excluded: 'Excluded',
  done: 'Done',
  failed: 'Failed',
  uncertain: 'Check chat',
};
const SEND_LABEL = { pending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', unknown: 'Unknown' };
const WAITING = {
  interval: 'Waiting before the next contact (45–60 minutes after the last one)',
  next_message: 'Next message to the same contact in about a minute',
  whatsapp: 'Waiting for WhatsApp to connect',
  subscription: 'Waiting for an active subscription',
  daily_cap: 'Daily limit reached: continues tomorrow',
  quiet_hours: 'Quiet hours for the remaining contacts',
  nothing_due: 'Nothing due right now',
};
const PAUSED = {
  user: 'Paused by you',
  restricted: 'Paused: WhatsApp refused messages (possible restriction). Check your account before resuming.',
  errors: 'Paused after repeated sending errors',
  finished: 'Finished: every contact has received the sequence or left it',
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

function LeadPicker({ onClose, onAdded, notify }) {
  const [leads, setLeads] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.outreachEligible().then((r) => (r.ok ? setLeads(r.leads) : setError(r.error)));
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const shown = useMemo(() => (leads || []).filter((l) => !q || `${l.name} ${l.phone} ${l.category || ''}`.toLowerCase().includes(q.toLowerCase())), [leads, q]);
  const selectable = shown.filter((l) => !l.inCampaign && !l.optedOut);
  async function add() {
    setBusy(true);
    try {
      const r = await api.outreachAddLeads([...pick]);
      if (r.ok) {
        notify({ type: 'ok', text: `${r.added} lead${r.added === 1 ? '' : 's'} added to the campaign${r.skipped ? ` (${r.skipped} skipped: already added or opted out)` : ''}.` });
        onAdded();
        onClose();
      } else setError(r.error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lead-picker" role="dialog" aria-modal="true" aria-label="Add verified leads">
        <header className="plans-head">
          <div>
            <h2>Add verified leads</h2>
            <p className="muted">Only numbers confirmed on WhatsApp by the automatic check can be added.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="picker-tools">
          <input type="search" placeholder="Search leads" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search leads" />
          <button type="button" className="btn btn-ghost" disabled={!selectable.length} onClick={() => setPick(new Set(selectable.map((l) => l.id)))}>
            Select all ({selectable.length})
          </button>
        </div>
        {error && <p className="composer-error">{error}</p>}
        <ul className="picker-list">
          {!leads && !error && <li className="muted">Loading leads…</li>}
          {leads && !leads.length && <li className="muted">No verified WhatsApp numbers yet. Check numbers on WhatsApp from the lead table first.</li>}
          {shown.map((l) => (
            <li key={l.id}>
              <label className={l.inCampaign || l.optedOut ? 'disabled' : ''}>
                <input
                  type="checkbox"
                  disabled={l.inCampaign || l.optedOut}
                  checked={pick.has(l.id)}
                  onChange={(e) => setPick((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(l.id);
                    else n.delete(l.id);
                    return n;
                  })}
                />
                <span className="picker-name">{l.name}</span>
                <span className="mono muted">{l.phone}</span>
                {l.inCampaign && <span className="chip chip-soft">In campaign</span>}
                {l.optedOut && <span className="chip">Opted out</span>}
              </label>
            </li>
          ))}
        </ul>
        <footer className="composer-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!pick.size || busy} onClick={add}>
            Add {pick.size || ''} lead{pick.size === 1 ? '' : 's'}
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

export default function OutreachView({ wa, notify, hidden }) {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null); // editable settings + templates
  const [dirty, setDirty] = useState(false);
  const [previewPhone, setPreviewPhone] = useState('');
  const [preview, setPreview] = useState(null);
  const [picker, setPicker] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api.outreachState();
    if (r.ok) {
      setSnap(r);
      setError('');
    } else setError(r.error);
  }, []);

  useEffect(() => {
    load();
    const off = api.onOutreach((s) => setSnap({ ok: true, ...s }));
    const offEv = api.onOutreachEvent((e) => {
      if (e.type === 'replied') notify({ type: 'ok', text: `${e.phone} replied. The sequence stopped for them; continue in Chats.` });
      else if (e.type === 'opted_out') notify({ type: 'ok', text: `${e.phone} asked not to be contacted. They won’t be messaged again.` });
      else if (e.type === 'failed') notify({ type: 'error', text: `Message to ${e.phone} failed: ${e.error}${e.paused ? ' The campaign is paused.' : ''}` });
    });
    return () => {
      off();
      offEv();
    };
  }, [load, notify]);

  useEffect(() => {
    if (snap && !dirty) setDraft(JSON.parse(JSON.stringify(snap.config)));
  }, [snap, dirty]);

  const contacts = snap?.contacts || [];
  useEffect(() => {
    if (!previewPhone && contacts.length) setPreviewPhone(contacts[0].phone);
  }, [contacts, previewPhone]);

  // Live preview of the (possibly unsaved) templates for one contact.
  useEffect(() => {
    if (!draft) return undefined;
    const t = setTimeout(() => api.outreachRender(draft.templates, previewPhone).then((r) => r.ok && setPreview(r)), 150);
    return () => clearTimeout(t);
  }, [draft, previewPhone]);

  const edit = (patch) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const editTemplate = (i, field, value) => {
    setDraft((d) => ({ ...d, templates: d.templates.map((t, j) => (j === i ? { ...t, [field]: value } : t)) }));
    setDirty(true);
  };

  async function save() {
    const r = await api.outreachConfigure(draft);
    if (r.ok) {
      setDirty(false);
      notify({ type: 'ok', text: 'Campaign settings saved.' });
    } else notify({ type: 'error', text: r.error });
    return r.ok;
  }

  async function act(fn) {
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok && r.needsAcknowledgement) setAck(true);
      else if (!r.ok) notify({ type: 'error', text: r.error });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function start(acknowledge = false) {
    if (dirty && !(await save())) return;
    await act(() => api.outreachStart(acknowledge));
  }

  if (error) {
    return (
      <section className="outreach panel" hidden={hidden}>
        <p className="chat-note">{error}</p>
      </section>
    );
  }
  if (!snap || !draft) {
    return (
      <section className="outreach panel" hidden={hidden}>
        <p className="muted">Loading the campaign…</p>
      </section>
    );
  }

  const running = snap.status === 'running';
  const paused = snap.status === 'paused';
  const live = !draft.test;
  const connected = wa?.state === 'open';
  const statusText = running ? WAITING[snap.waiting] || 'Running' : paused ? PAUSED[snap.pauseReason] || 'Paused' : snap.pauseReason === 'finished' ? PAUSED.finished : 'Not running';
  const counts = contacts.reduce((m, c) => ((m[c.state] = (m[c.state] || 0) + 1), m), {});

  return (
    <section className="outreach" hidden={hidden} aria-label="Real-estate outreach">
      <div className="outreach-col">
        <div className="panel campaign-card">
          <div className="campaign-top">
            <div>
              <h2>Real-estate outreach</h2>
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
              <dt>Today</dt>
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
                {contacts.length} ({counts.queued || 0} queued, {counts.active || 0} in sequence, {counts.replied || 0} replied)
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
              <button type="button" className="btn" disabled={busy} onClick={() => act(api.outreachPause)}>
                <Icon name="pause" /> Pause
              </button>
            )}
            {paused && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(api.outreachResume)}>
                <Icon name="play" /> Resume
              </button>
            )}
            {(running || paused) && (
              <button type="button" className="btn" disabled={busy} onClick={() => act(api.outreachStop)}>
                <Icon name="stop" /> Stop
              </button>
            )}
          </div>
          {live && !snap.acknowledged && <p className="muted small">Live sending asks for your confirmation first.</p>}
        </div>

        <div className="panel campaign-settings">
          <h3>Settings</h3>
          <fieldset disabled={running}>
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
                <span className="field-label">Daily limit (contacts)</span>
                <input type="number" min={snap.limits.capMin} max={snap.limits.capMax} value={draft.dailyCap} onChange={(e) => edit({ dailyCap: Number(e.target.value) })} />
              </label>
              <label>
                <span className="field-label">Quiet hours (recipient’s time)</span>
                <span className="range-pair">
                  <select value={draft.quietStart} onChange={(e) => edit({ quietStart: Number(e.target.value) })} aria-label="Quiet hours start">
                    {hours.map((h) => (
                      <option key={h} value={h}>
                        {hh(h)}
                      </option>
                    ))}
                  </select>
                  <span>to</span>
                  <select value={draft.quietEnd} onChange={(e) => edit({ quietEnd: Number(e.target.value) })} aria-label="Quiet hours end">
                    {hours.map((h) => (
                      <option key={h} value={h}>
                        {hh(h)}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
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
            <button type="button" className="btn" disabled={!dirty || running} onClick={() => (setDirty(false), setDraft(JSON.parse(JSON.stringify(snap.config))))}>
              Discard
            </button>
            <button type="button" className="btn btn-primary" disabled={!dirty || running} onClick={save}>
              Save settings
            </button>
          </footer>
        </div>
      </div>

      <div className="outreach-col wide">
        <div className="panel campaign-contacts">
          <div className="templates-head">
            <h3>Contacts</h3>
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
                        onBlur={(e) => e.target.value.trim() !== (c.name || '') && api.outreachSetName(c.phone, e.target.value.trim() || null)}
                        aria-label={`Name used for ${c.phone}`}
                      />
                      <span className="mono muted contact-phone">{c.phone}</span>
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
                        <button type="button" className="btn btn-ghost" onClick={() => act(() => api.outreachExclude(c.phone))}>
                          Exclude
                        </button>
                      )}
                      {['excluded', 'failed', 'uncertain', 'replied'].includes(c.state) && !c.optedOut && (
                        <button type="button" className="btn btn-ghost" onClick={() => act(() => api.outreachInclude(c.phone))}>
                          Resume
                        </button>
                      )}
                      {!c.optedOut && (
                        <button type="button" className="btn btn-ghost" title="Never message this number from campaigns" onClick={() => act(() => api.outreachOptOut(c.phone))}>
                          Opt out
                        </button>
                      )}
                      {c.stage === 0 && ['queued', 'excluded'].includes(c.state) && (
                        <button type="button" className="icon-btn" aria-label={`Remove ${c.phone}`} onClick={() => act(() => api.outreachRemove(c.phone))}>
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

        <div className="panel campaign-history">
          <h3>Sent {live ? '' : '(test run)'}</h3>
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
      </div>

      {picker && <LeadPicker onClose={() => setPicker(false)} onAdded={load} notify={notify} />}
      {ack && (
        <Acknowledge
          onCancel={() => setAck(false)}
          onConfirm={() => {
            setAck(false);
            start(true);
          }}
        />
      )}
    </section>
  );
}
