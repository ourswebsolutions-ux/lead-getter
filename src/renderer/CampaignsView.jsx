import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';

const api = window.leadFinder;

const PLACEHOLDERS = ['name', 'business_name', 'phone', 'category', 'city'];
const STATUS = {
  draft: ['Draft', 'soft'],
  running: ['Sending', 'ok'],
  paused: ['Paused', 'warn'],
  stopped: ['Stopped', 'bad'],
  done: ['Finished', 'ok'],
};
const R_STATUS = {
  pending: ['Pending', 'soft'],
  sending: ['Sending…', 'soft'],
  submitted: ['Submitted', 'soft'],
  sent: ['Sent', 'ok'],
  delivered: ['Delivered', 'ok'],
  failed: ['Failed', 'bad'],
  skipped: ['Skipped', 'warn'],
};
const SPEED = [
  ['slow', 'Slow · 1 per minute', 60],
  ['normal', 'Normal · 1 per 30 s', 30],
  ['fast', 'Fast · 1 per 15 s', 15],
];
const FIELDS = [
  ['phone', 'Phone number'],
  ['name', 'Name'],
  ['business', 'Business name'],
  ['category', 'Category'],
  ['city', 'City'],
];

const date = (ms) => (ms ? new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

function Counts({ c }) {
  const n = c.counts;
  const done = n.submitted + n.sent + n.delivered + n.failed + n.skipped;
  return (
    <div className="cp-progress">
      <div className="dl-progress-bar" aria-label={`${done} of ${n.total} processed`}>
        <span style={{ width: `${n.total ? (done / n.total) * 100 : 0}%` }} />
      </div>
      <span className="mono">{done} / {n.total}</span>
    </div>
  );
}

// Leads from Lead Finder: filters, select some or all filtered, add.
function LeadPicker({ campaignId, onClose, notify }) {
  const [cats, setCats] = useState([]);
  const [category, setCategory] = useState('all');
  const [source, setSource] = useState('all');
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState('');
  const [leads, setLeads] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.listCategories().then((r) => setCats(r?.categories || []));
  }, []);
  const filter = { category: category === 'all' ? 'all' : Number(category), ...(source !== 'all' ? { source } : {}), ...(search.trim() ? { search: search.trim() } : {}) };
  useEffect(() => {
    const t = setTimeout(() => api.listLeads(filter).then((l) => setLeads((l || []).filter((x) => x.phone))), 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, source, search]);
  const shown = location.trim() ? leads.filter((l) => (l.address || '').toLowerCase().includes(location.trim().toLowerCase())) : leads;
  const allOn = shown.length > 0 && shown.every((l) => selected.has(l.id));
  const add = async () => {
    setBusy(true);
    const r = await api.addCampaignLeads(campaignId, [...selected]);
    setBusy(false);
    if (!r.ok) return notify({ type: 'error', text: r.error });
    notify({ type: 'info', text: `${r.added} added${r.duplicates ? ` · ${r.duplicates} already in the campaign` : ''}.` });
    onClose();
  };
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="composer cp-picker" role="dialog" aria-label="Choose leads">
        <header className="composer-head">
          <span className="composer-icon neutral"><Icon name="inbox" /></span>
          <div>
            <strong>Choose leads</strong>
            <span className="muted">Leads with a phone number. {selected.size} selected.</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="cp-filters">
          <label className="table-search">
            <Icon name="search" size={14} />
            <input type="search" aria-label="Search leads" placeholder="Name, business or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="all">All categories</option>
            {cats.map((c) => (
              <option key={c.id} value={String(c.id)}>{c.name}</option>
            ))}
          </select>
          <select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">All sources</option>
            <option value="maps">Google Maps</option>
            <option value="facebook">Facebook</option>
            <option value="linkedin">LinkedIn</option>
            <option value="podcast">Podcasts</option>
          </select>
          <input className="cp-loc" aria-label="Location" placeholder="Location (e.g. Lahore)" value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
        <div className="cp-pick-list">
          <table className="nm-table">
            <thead>
              <tr>
                <th className="check"><input type="checkbox" aria-label="Select all filtered" checked={allOn} onChange={() => setSelected((s) => { const n = new Set(s); shown.forEach((l) => (allOn ? n.delete(l.id) : n.add(l.id))); return n; })} /></th>
                <th>Lead</th>
                <th>Phone</th>
                <th>Category</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 500).map((l) => (
                <tr key={l.id} className={selected.has(l.id) ? 'selected' : ''}>
                  <td className="check"><input type="checkbox" aria-label={`Select ${l.name}`} checked={selected.has(l.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); return n; })} /></td>
                  <td>{l.name}</td>
                  <td className="mono">{l.phone}</td>
                  <td>{l.category || <span className="muted">—</span>}</td>
                  <td className="cp-addr" title={l.address}>{l.address || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > 500 && <p className="dl-fine">Showing 500 of {shown.length}; "select all" selects all {shown.length}.</p>}
          {shown.length === 0 && <p className="nm-empty">No leads with a phone number match.</p>}
        </div>
        <div className="dl-pair-actions">
          <span className="muted cp-sel">{shown.length} shown · {selected.size} selected</span>
          <button type="button" className="btn btn-primary" disabled={busy || !selected.size} onClick={add}>Add {selected.size || ''} lead{selected.size === 1 ? '' : 's'}</button>
        </div>
      </div>
    </div>
  );
}

// A CSV or Excel file: columns, then the check (valid, invalid, repeated), then add.
function ImportPicker({ campaignId, onClose, notify }) {
  const [file, setFile] = useState(null);
  const [mapping, setMapping] = useState({});
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    const r = await api.pickNumbersFile();
    if (!r?.ok) return r?.canceled || notify({ type: 'error', text: r?.error || 'Nothing to import.' });
    setFile(r);
    setMapping(r.mapping || {});
    setCheck(null);
  };
  const cols = file ? Math.max(file.headers?.length || 0, ...file.preview.map((r) => r.length)) : 0;
  const colName = (i) => file?.headers?.[i] || `Column ${i + 1}`;
  const runCheck = async () => {
    const r = await api.checkCampaignImport(file.token, mapping);
    if (!r.ok) return notify({ type: 'error', text: r.error });
    setCheck(r);
  };
  const add = async () => {
    setBusy(true);
    const r = await api.addCampaignImport(campaignId, file.token, mapping);
    setBusy(false);
    if (!r.ok) return notify({ type: 'error', text: r.error });
    notify({ type: 'info', text: `${r.added} contacts added${r.duplicates ? ` · ${r.duplicates} already in the campaign` : ''}${r.skippedInvalid ? ` · ${r.skippedInvalid} invalid left out` : ''}.` });
    onClose();
  };
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="composer nm-import" role="dialog" aria-label="Import contacts">
        <header className="composer-head">
          <span className="composer-icon neutral"><Icon name="download" /></span>
          <div>
            <strong>Import contacts</strong>
            <span className="muted">{file ? `${file.file}: ${file.rows} rows` : 'A CSV or Excel (.xlsx) file.'}</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </header>
        {!file ? (
          <button type="button" className="nm-drop" onClick={pick}>
            <Icon name="download" size={20} />
            <strong>Choose a file</strong>
            <span>CSV · Excel (.xlsx) · TXT</span>
          </button>
        ) : (
          <div className="nm-map">
            <div className="nm-map-grid">
              {FIELDS.map(([f, label]) => (
                <label key={f}>
                  <span>{label}{f === 'phone' ? ' *' : ''}</span>
                  <select aria-label={`Column for ${label}`} value={mapping[f] ?? ''} onChange={(e) => (setCheck(null), setMapping((m) => ({ ...m, [f]: e.target.value === '' ? undefined : Number(e.target.value) })))}>
                    <option value="">{f === 'phone' ? 'Choose a column' : 'Not imported'}</option>
                    {Array.from({ length: cols }, (_, i) => (
                      <option key={i} value={i}>{colName(i)}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {check ? (
              <div className="cp-check">
                <div className="nm-stats">
                  <div className="nm-stat on"><b className="mono">{check.valid}</b><span>Valid, will be added</span></div>
                  <div className="nm-stat"><b className="mono">{check.notValid + check.noNumber}</b><span>Invalid, left out</span></div>
                  <div className="nm-stat"><b className="mono">{check.duplicates}</b><span>Repeated in the file</span></div>
                </div>
                {check.sample.length > 0 && (
                  <p className="dl-fine">For example: {check.sample.map((s) => [s.name || s.business, s.phone].filter(Boolean).join(' ')).join(' · ')}</p>
                )}
                {check.invalidRows.length > 0 && (
                  <details className="cp-invalid">
                    <summary>Invalid rows ({check.notValid + check.noNumber})</summary>
                    <ul>
                      {check.invalidRows.map((r, i) => (
                        <li key={i} className="mono">{r.filter(Boolean).join(' · ')}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ) : (
              <div className="nm-preview">
                <table>
                  <thead>
                    <tr>{Array.from({ length: cols }, (_, i) => <th key={i}>{colName(i)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {file.preview.map((r, i) => (
                      <tr key={i}>{Array.from({ length: cols }, (_, j) => <td key={j} className={mapping.phone === j ? 'on' : ''}>{r[j]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="dl-pair-actions">
              <button type="button" className="btn" onClick={pick}>Another file</button>
              {check ? (
                <button type="button" className="btn btn-primary" disabled={busy || !check.valid} onClick={add}>Add {check.valid} contact{check.valid === 1 ? '' : 's'}</button>
              ) : (
                <button type="button" className="btn btn-primary" disabled={mapping.phone == null} onClick={runCheck}>Check contacts</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Editor({ c, smsState, notify, onDeleted }) {
  const [name, setName] = useState(c.name);
  const [message, setMessage] = useState(c.message);
  const [preview, setPreview] = useState([]);
  const [pi, setPi] = useState(0);
  const [rows, setRows] = useState({ total: 0, rows: [] });
  const [rStatus, setRStatus] = useState('');
  const [rSearch, setRSearch] = useState('');
  const [picker, setPicker] = useState(null); // 'leads' | 'import'
  const [lists, setLists] = useState([]);
  const text = useRef(null);
  const editable = c.status !== 'running' && c.status !== 'stopped' && c.status !== 'done';
  const dirty = name !== c.name || message !== c.message;

  useEffect(() => {
    setName(c.name);
    setMessage(c.message);
  }, [c.id, c.name, c.message]);
  const load = useCallback(() => {
    api.campaignRecipients(c.id, { status: rStatus, search: rSearch, limit: 300 }).then((r) => setRows(r || { total: 0, rows: [] }));
    api.campaignPreview(c.id).then((p) => setPreview(p || []));
  }, [c.id, rStatus, rSearch]);
  useEffect(() => {
    const t = setTimeout(load, 120);
    return () => clearTimeout(t);
  }, [load, c.counts.total, c.counts.pending, c.counts.sent, c.counts.failed, c.counts.delivered, c.counts.submitted, c.counts.skipped, c.message]);
  useEffect(() => {
    api.numberLists().then((l) => setLists(l || []));
  }, []);

  const act = async (p, ok) => {
    const r = await p;
    if (r && r.ok === false) notify({ type: 'error', text: r.error });
    else if (ok) notify({ type: 'info', text: typeof ok === 'function' ? ok(r) : ok });
    return r;
  };
  const save = () => act(api.updateSmsCampaign(c.id, { name, message }), 'Saved.');
  const insert = (p) => {
    const el = text.current;
    const token = `{${p}}`;
    if (!el) return setMessage((m) => m + token);
    const [a, b] = [el.selectionStart, el.selectionEnd];
    setMessage((m) => m.slice(0, a) + token + m.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + token.length, a + token.length);
    });
  };
  const n = c.counts;
  const [label, tone] = STATUS[c.status] || STATUS.draft;
  const speed = SPEED.find((s) => s[2] === c.delaySeconds)?.[0] || 'custom';
  // The preview uses the message being typed and the campaign's real recipients.
  const render = (msg, r) =>
    String(msg || '')
      .replace(/\{(name|business_name|business|phone|category|city)\}/gi, (_, k) => ({ name: r.name || r.business || '', business_name: r.business || r.name || '', business: r.business || r.name || '', phone: r.phone || '', category: r.category || '', city: r.city || '' })[k.toLowerCase()])
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.!?;:])/g, '$1')
      .trim();
  const p = preview[pi % Math.max(1, preview.length)];

  return (
    <div className="cp-editor">
      <header className="panel cp-head">
        <div className="cp-head-main">
          {editable ? (
            <input className="cp-name" aria-label="Campaign name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          ) : (
            <h2>{c.name}</h2>
          )}
          <span className={`dl-pill tone-${tone}`}><span className="dl-pill-dot" />{label}</span>
          <span className="muted cp-date">Created {date(c.createdAt)}</span>
        </div>
        <div className="cp-controls">
          {(c.status === 'draft' || c.status === 'paused') && (
            <button type="button" className="btn btn-primary" disabled={!n.pending || dirty} title={dirty ? 'Save your changes first' : undefined} onClick={() => act(api.startSmsCampaign(c.id))}>
              <Icon name="play" size={13} /> {c.status === 'draft' ? 'Start' : 'Resume'}
            </button>
          )}
          {c.status === 'running' && (
            <button type="button" className="btn" onClick={() => act(api.pauseSmsCampaign(c.id))}>
              <Icon name="pause" size={13} /> Pause
            </button>
          )}
          {['running', 'paused'].includes(c.status) && (
            <button type="button" className="btn btn-danger" onClick={() => window.confirm(`Stop "${c.name}"? Messages not sent yet will not be sent.`) && act(api.stopSmsCampaign(c.id))}>
              <Icon name="stop" size={13} /> Stop
            </button>
          )}
          {n.failed > 0 && c.status !== 'stopped' && c.status !== 'running' && (
            <button type="button" className="btn" onClick={() => act(api.retrySmsCampaign(c.id), (r) => `${r.retried} failed message${r.retried === 1 ? '' : 's'} will be sent again.`)}>
              <Icon name="refresh" size={13} /> Retry failed
            </button>
          )}
          {c.status !== 'running' && (
            <button type="button" className="icon-btn danger" aria-label="Delete campaign" title="Delete campaign" onClick={() => window.confirm(`Delete "${c.name}" and its results?`) && act(api.deleteSmsCampaign(c.id)).then((r) => r?.ok && onDeleted())}>
              <Icon name="trash" />
            </button>
          )}
        </div>
        {c.reason && <p className={`cp-reason tone-${c.status === 'running' ? 'soft' : 'warn'}`}>{c.reason}</p>}
        <div className="cp-stats">
          {[
            ['', 'Recipients', n.total],
            ['not_sent', 'Pending', n.pending],
            ['submitted', 'Submitted', n.submitted],
            ['sent', 'Sent', n.sent],
            ['delivered', 'Delivered', n.delivered],
            ['failed', 'Failed', n.failed],
            ['skipped', 'Skipped', n.skipped],
          ].map(([key, l, v]) => (
            <button key={l} type="button" className={`nm-stat ${rStatus === key ? 'on' : ''}`} aria-pressed={rStatus === key} onClick={() => setRStatus(key)}>
              <b className="mono">{v}</b>
              <span>{l}</span>
            </button>
          ))}
        </div>
        <Counts c={c} />
      </header>

      <div className="cp-body">
        <section className="panel cp-compose" aria-label="Message">
          <h3>Message</h3>
          <div className="cp-chips">
            {PLACEHOLDERS.map((p) => (
              <button key={p} type="button" className="chip-toggle" disabled={!editable} onClick={() => insert(p)}>{`{${p}}`}</button>
            ))}
          </div>
          <textarea ref={text} aria-label="Campaign message" rows={6} maxLength={1600} disabled={!editable} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Assalam-o-Alaikum {name}, kya {business_name} aapka business hai? …" />
          <div className="cp-meta">
            <span className="muted">{message.length} characters · {message.length > 160 ? `${Math.ceil(message.length / 153)} SMS each` : '1 SMS each'}</span>
            {editable && dirty && <button type="button" className="btn btn-sm btn-primary" onClick={save}>Save</button>}
          </div>
          <div className="cp-preview" aria-label="Preview">
            <div className="cp-preview-head">
              <span>Preview{p ? ` for ${p.recipient.name || p.recipient.business || p.recipient.phone}` : ''}</span>
              {preview.length > 1 && (
                <span className="cp-preview-nav">
                  <button type="button" className="icon-btn" aria-label="Previous preview" onClick={() => setPi((i) => (i + preview.length - 1) % preview.length)}><Icon name="chevron" className="cp-left" /></button>
                  <span className="mono">{(pi % preview.length) + 1}/{preview.length}</span>
                  <button type="button" className="icon-btn" aria-label="Next preview" onClick={() => setPi((i) => (i + 1) % preview.length)}><Icon name="chevron" className="cp-right" /></button>
                </span>
              )}
            </div>
            {p ? <div className="ms-bubble out cp-bubble"><p>{render(message, p.recipient)}</p></div> : <p className="dl-fine">Add recipients to see the message as each one will get it.</p>}
          </div>
          <h3>Sending</h3>
          <div className="cp-settings">
            <label>
              <span>Device</span>
              <select aria-label="Sending device" value="phone" disabled>
                <option value="phone">{smsState.state === 'ready' ? 'Connected phone · its default SMS SIM' : 'Phone (not connected)'}</option>
              </select>
            </label>
            <label>
              <span>Speed</span>
              <select aria-label="Speed" disabled={!editable} value={speed} onChange={(e) => e.target.value !== 'custom' && act(api.updateSmsCampaign(c.id, { speed: e.target.value }))}>
                {SPEED.map(([k, l]) => (
                  <option key={k} value={k}>{l}</option>
                ))}
                {speed === 'custom' && <option value="custom">Every {c.delaySeconds} s</option>}
              </select>
            </label>
            <label>
              <span>At most per hour</span>
              <input type="number" min="1" max="500" aria-label="At most per hour" disabled={!editable} defaultValue={c.perHour} key={`h${c.id}${c.perHour}`} onBlur={(e) => Number(e.target.value) !== c.perHour && act(api.updateSmsCampaign(c.id, { perHour: Number(e.target.value) }))} />
            </label>
            <label>
              <span>Retries after a failure</span>
              <input type="number" min="0" max="5" aria-label="Retries" disabled={!editable} defaultValue={c.maxRetries} key={`r${c.id}${c.maxRetries}`} onBlur={(e) => Number(e.target.value) !== c.maxRetries && act(api.updateSmsCampaign(c.id, { maxRetries: Number(e.target.value) }))} />
            </label>
            <label className="dl-check">
              <input type="checkbox" disabled={!editable} checked={c.skipTexted} onChange={(e) => act(api.updateSmsCampaign(c.id, { skipTexted: e.target.checked }))} />
              <span>Skip contacts already texted</span>
            </label>
          </div>
          <p className="dl-fine">One message at a time, never faster than one every 10 seconds. Opted-out contacts (including anyone who replied STOP) are never texted.</p>
        </section>

        <section className="panel cp-recipients" aria-label="Recipients">
          <div className="cp-rec-head">
            <h3>Recipients</h3>
            {editable && (
              <div className="cp-add">
                <button type="button" className="btn btn-sm" onClick={() => setPicker('leads')}><Icon name="inbox" size={13} /> From leads</button>
                <select aria-label="Add a number category" value="" onChange={(e) => e.target.value && act(api.addCampaignNumbers(c.id, Number(e.target.value)), (r) => `${r.added} added${r.duplicates ? ` · ${r.duplicates} already in the campaign` : ''}.`)}>
                  <option value="">From numbers…</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>{l.name} ({l.total})</option>
                  ))}
                </select>
                <button type="button" className="btn btn-sm" onClick={() => setPicker('import')}><Icon name="download" size={13} /> Import file</button>
              </div>
            )}
          </div>
          <label className="table-search">
            <Icon name="search" size={14} />
            <input type="search" aria-label="Search recipients" placeholder="Name, business or number" value={rSearch} onChange={(e) => setRSearch(e.target.value)} />
          </label>
          {rows.rows.length === 0 ? (
            <p className="nm-empty">{n.total ? 'No recipients match.' : 'Add recipients from your leads, a number category or a file.'}</p>
          ) : (
            <div className="nm-table-wrap cp-rec-table">
              <table className="nm-table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Number</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.rows.map((r) => {
                    const [l, t] = R_STATUS[r.status] || R_STATUS.pending;
                    return (
                      <tr key={r.id}>
                        <td>
                          <span className="nm-name">
                            <strong>{r.name || r.business || <span className="muted">No name</span>}</strong>
                            <span className="muted">{[r.name && r.business, r.category, r.city, { lead: 'Lead', number: 'Numbers', import: 'Imported' }[r.kind]].filter(Boolean).join(' · ')}</span>
                          </span>
                        </td>
                        <td className="mono">{r.phone}</td>
                        <td>
                          <span className={`dl-status s-${t}`} title={r.reason || undefined}>{l}</span>
                          {r.reason && <span className="cp-why">{r.reason}</span>}
                        </td>
                        <td className="row-actions">
                          {editable && ['pending', 'failed', 'skipped'].includes(r.status) && (
                            <button type="button" className="icon-btn danger" aria-label={`Remove ${r.name || r.phone}`} title="Remove" onClick={() => act(api.removeCampaignRecipients(c.id, [r.id]))}>
                              <Icon name="x" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.total > rows.rows.length && <p className="dl-fine">Showing {rows.rows.length} of {rows.total}.</p>}
            </div>
          )}
        </section>
      </div>
      {picker === 'leads' && <LeadPicker campaignId={c.id} notify={notify} onClose={() => (setPicker(null), load())} />}
      {picker === 'import' && <ImportPicker campaignId={c.id} notify={notify} onClose={() => (setPicker(null), load())} />}
    </div>
  );
}

export default function CampaignsView({ notify, smsState }) {
  const [list, setList] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const load = useCallback(() => api.smsCampaigns().then((l) => setList(l || [])), []);
  useEffect(() => {
    load();
    return api.onSmsCampaigns(load);
  }, [load]);
  const open = list.find((c) => c.id === openId);
  const create = async () => {
    const r = await api.createSmsCampaign({ name: newName, message: 'Assalam-o-Alaikum {name}, ' });
    if (!r.ok) return notify({ type: 'error', text: r.error });
    setCreating(false);
    setNewName('');
    await load();
    setOpenId(r.id);
  };

  return (
    <div className="cp-grid">
      <aside className="panel cp-list" aria-label="Campaigns">
        <header className="ms-threads-head">
          <strong className="cp-list-title">Campaigns</strong>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}><Icon name="edit" size={13} /> New campaign</button>
        </header>
        {creating && (
          <form className="nm-new cp-new" onSubmit={(e) => (e.preventDefault(), create())}>
            <input autoFocus aria-label="New campaign name" placeholder="Campaign name" value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setCreating(false)} />
            <button type="submit" className="btn btn-sm btn-primary">Create</button>
          </form>
        )}
        {list.length === 0 && !creating && <p className="nm-empty">No campaigns yet.</p>}
        <ul>
          {list.map((c) => {
            const [l, t] = STATUS[c.status] || STATUS.draft;
            return (
              <li key={c.id}>
                <button type="button" className={`cp-card ${c.id === openId ? 'on' : ''}`} onClick={() => setOpenId(c.id)}>
                  <span className="cp-card-top">
                    <strong>{c.name}</strong>
                    <span className={`dl-status s-${t}`}>{l}</span>
                  </span>
                  <span className="cp-card-meta">{date(c.createdAt)} · {c.counts.total} recipient{c.counts.total === 1 ? '' : 's'}</span>
                  <Counts c={c} />
                  <span className="cp-card-meta">
                    {c.counts.sent + c.counts.delivered} sent · {c.counts.delivered} delivered · {c.counts.failed} failed
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      {open ? (
        <Editor key={open.id} c={open} smsState={smsState} notify={notify} onDeleted={() => setOpenId(null)} />
      ) : (
        <section className="panel nm-welcome">
          <Icon name="send" size={28} />
          <h2>SMS campaigns</h2>
          <p>Write one message with {'{name}'}, {'{business_name}'} and more, choose your leads, a number category or a file, and Lead Finder sends it to everyone through your phone, one at a time, with the progress of each message.</p>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>New campaign</button>
        </section>
      )}
    </div>
  );
}
