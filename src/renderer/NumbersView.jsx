import { useCallback, useEffect, useState } from 'react';
import Icon from './icons.jsx';

const api = window.leadFinder;

const FIELDS = [
  ['phone', 'Phone number'],
  ['name', 'Name'],
  ['business', 'Business'],
  ['email', 'Email'],
  ['city', 'City'],
  ['notes', 'Notes'],
];

const CALL = { seen: ['Call Seen', 'call-seen'], unseen: ['Call Unseen', 'call-unseen'], dnc: ['Do not call', 'call-dnc'] };

// Import: a file or pasted numbers, the column mapping, then the category.
function ImportDialog({ lists, listId, onClose, onDone, notify }) {
  const [step, setStep] = useState('source'); // source | map
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [target, setTarget] = useState(listId ? String(listId) : lists[0] ? String(lists[0].id) : '');
  const [busy, setBusy] = useState(false);
  const loaded = (r) => {
    if (!r?.ok) {
      if (!r?.canceled) notify({ type: 'error', text: r?.error || 'Nothing to import.' });
      return;
    }
    setPreview(r);
    setMapping(r.mapping || {});
    setStep('map');
  };
  const run = async () => {
    if (!target) return notify({ type: 'error', text: 'Choose a category (or create one first).' });
    setBusy(true);
    const r = await api.importNumbers(preview.token, mapping, Number(target));
    setBusy(false);
    if (!r.ok) return notify({ type: 'error', text: r.error });
    const parts = [`${r.added} number${r.added === 1 ? '' : 's'} added`];
    if (r.duplicateInCategory) parts.push(`${r.duplicateInCategory} already in this category`);
    if (r.duplicatesInFile) parts.push(`${r.duplicatesInFile} repeated in the file`);
    if (r.alsoElsewhere) parts.push(`${r.alsoElsewhere} also in another category or your leads`);
    if (r.invalid) parts.push(`${r.invalid} without a phone number`);
    if (r.notValid) parts.push(`${r.notValid} not valid (kept, never auto-called)`);
    notify({ type: 'info', text: `${parts.join(' · ')}.` });
    onDone(Number(target));
  };
  const cols = preview ? Math.max(preview.headers?.length || 0, ...preview.preview.map((r) => r.length)) : 0;
  const colName = (i) => preview?.headers?.[i] || `Column ${i + 1}`;

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="composer nm-import" role="dialog" aria-label="Import numbers">
        <header className="composer-head">
          <span className="composer-icon neutral"><Icon name="download" /></span>
          <div>
            <strong>Import phone numbers</strong>
            <span className="muted">{step === 'source' ? 'CSV, Excel (.xlsx) or text file, or paste numbers.' : `${preview.file}: ${preview.rows} row${preview.rows === 1 ? '' : 's'}`}</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            <Icon name="x" />
          </button>
        </header>
        {step === 'source' ? (
          <div className="nm-source">
            <button type="button" className="nm-drop" onClick={async () => loaded(await api.pickNumbersFile())}>
              <Icon name="download" size={20} />
              <strong>Choose a file</strong>
              <span>CSV · Excel (.xlsx) · TXT</span>
            </button>
            <div className="nm-paste">
              <label htmlFor="nm-paste-text">Or paste numbers (one per line, or name, business, number)</label>
              <textarea id="nm-paste-text" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={'+92 300 1234567\nAli Raza, SEO Hub, 0321 4445566'} />
              <button type="button" className="btn btn-sm" disabled={!text.trim()} onClick={async () => loaded(await api.parseNumbersText(text))}>
                Continue
              </button>
            </div>
          </div>
        ) : (
          <div className="nm-map">
            <div className="nm-map-grid">
              {FIELDS.map(([f, label]) => (
                <label key={f}>
                  <span>{label}{f === 'phone' ? ' *' : ''}</span>
                  <select aria-label={`Column for ${label}`} value={mapping[f] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                    <option value="">{f === 'phone' ? 'Choose a column' : 'Not imported'}</option>
                    {Array.from({ length: cols }, (_, i) => (
                      <option key={i} value={i}>{colName(i)}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="nm-preview">
              <table>
                <thead>
                  <tr>{Array.from({ length: cols }, (_, i) => <th key={i}>{colName(i)}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.preview.map((r, i) => (
                    <tr key={i}>{Array.from({ length: cols }, (_, j) => <td key={j} className={mapping.phone === j ? 'on' : ''}>{r[j]}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="dl-fine">Numbers are put in international format with your phone country ({preview.country || 'automatic'}) when they are valid. Duplicates are added once. Other columns are kept with each number.</p>
            <div className="nm-map-foot">
              <label className="nm-target">
                <span>Category</span>
                <select aria-label="Import into category" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {!lists.length && <option value="">Create a category first</option>}
                  {lists.map((l) => (
                    <option key={l.id} value={String(l.id)}>{l.name}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn" onClick={() => setStep('source')} disabled={busy}>Back</button>
              <button type="button" className="btn btn-primary" onClick={run} disabled={busy || mapping.phone == null || !target}>
                {busy ? <span className="spinner" aria-hidden="true" /> : null} Import
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function NumbersView({ notify, hidden, onCall, onMessage }) {
  const [lists, setLists] = useState([]);
  const [listId, setListId] = useState(null);
  const [data, setData] = useState({ total: 0, rows: [] });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [importing, setImporting] = useState(false);
  const [newName, setNewName] = useState(null);
  const [renaming, setRenaming] = useState(null);

  const loadLists = useCallback(() => api.numberLists().then((l) => setLists(l || [])), []);
  const load = useCallback(() => {
    if (!listId) return setData({ total: 0, rows: [] });
    return api.listNumbers({ listId, search, status, limit: 500 }).then((r) => setData(r || { total: 0, rows: [] }));
  }, [listId, search, status]);
  useEffect(() => {
    loadLists();
  }, [loadLists]);
  useEffect(() => {
    if (!listId && lists.length) setListId(lists[0].id);
    if (listId && lists.length && !lists.some((l) => l.id === listId)) setListId(lists[0]?.id ?? null);
  }, [lists, listId]);
  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(
    () =>
      api.onNumbersChanged(() => {
        loadLists();
        load();
      }),
    [load, loadLists],
  );
  useEffect(() => setSelected(new Set()), [listId]);

  const list = lists.find((l) => l.id === listId);
  const act = async (p, done) => {
    const r = await p;
    if (r && r.ok === false) notify({ type: 'error', text: r.error });
    else done?.(r);
    return r;
  };
  const create = async () => {
    const name = (newName || '').trim();
    if (!name) return setNewName(null);
    await act(api.createNumberList(name), (r) => {
      setNewName(null);
      loadLists().then(() => setListId(r.id));
    });
  };
  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const allOn = data.rows.length > 0 && data.rows.every((r) => selected.has(r.id));

  return (
    <section className="numbers" hidden={hidden} aria-label="Numbers">
      <aside className="panel nm-lists" aria-label="Number categories">
        <header className="nm-lists-head">
          <h2>Categories</h2>
          <button type="button" className="icon-btn" aria-label="New category" title="New category" onClick={() => setNewName('')}>
            <Icon name="edit" />
          </button>
        </header>
        {newName != null && (
          <form className="nm-new" onSubmit={(e) => (e.preventDefault(), create())}>
            <input autoFocus aria-label="Category name" placeholder="e.g. SEO USA" value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNewName(null)} />
            <button type="submit" className="btn btn-sm btn-primary">Add</button>
          </form>
        )}
        <ul>
          {lists.map((l) => (
            <li key={l.id}>
              {renaming?.id === l.id ? (
                <form className="nm-new" onSubmit={(e) => (e.preventDefault(), act(api.renameNumberList(l.id, renaming.name), () => (setRenaming(null), loadLists())))}>
                  <input autoFocus aria-label="New name" value={renaming.name} maxLength={80} onChange={(e) => setRenaming({ id: l.id, name: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} />
                  <button type="submit" className="btn btn-sm btn-primary">Save</button>
                </form>
              ) : (
                <button type="button" className={`nm-list ${l.id === listId ? 'on' : ''}`} aria-pressed={l.id === listId} onClick={() => setListId(l.id)}>
                  <span className="nm-list-name">{l.name}</span>
                  <span className="nm-list-count mono">{l.total}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
        {!lists.length && newName == null && <p className="nm-empty-side">Create a category (SEO, Web Development, USA Leads…) and import numbers into it.</p>}
      </aside>

      <div className="nm-main">
        {list ? (
          <>
            <header className="panel nm-head">
              <div className="nm-title">
                <h2>{list.name}</h2>
                <div className="nm-title-actions">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming({ id: list.id, name: list.name })}>Rename</button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={!list.called}
                    onClick={() => window.confirm(`Mark all ${list.called} called numbers in "${list.name}" as Call Unseen again? The Auto Dialer may then call them again.`) && act(api.resetNumberListCalls(list.id), (r) => notify({ type: 'info', text: `${r.reset} numbers are Call Unseen again.` }))}
                  >
                    Reset call status
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost btn-danger-text" onClick={() => window.confirm(`Delete the category "${list.name}" and its ${list.total} numbers? Their calls stay in the call log.`) && act(api.deleteNumberList(list.id), () => loadLists())}>
                    Delete
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => setImporting(true)}>
                    <Icon name="download" size={14} /> Import numbers
                  </button>
                </div>
              </div>
              <div className="nm-stats">
                {[
                  ['', 'Total', list.total],
                  ['called', 'Call Seen', list.called],
                  ['unseen', 'Call Unseen', list.unseen],
                  ['optout', 'Opted out / do not call', list.optedOut],
                  ['texted', 'SMS sent', list.texted],
                ].map(([key, label, n]) => (
                  <button key={label} type="button" className={`nm-stat ${status === key ? 'on' : ''}`} aria-pressed={status === key} onClick={() => setStatus(key)}>
                    <b className="mono">{n}</b>
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </header>

            <section className="panel nm-table-panel">
              <div className="nm-tools">
                <label className="table-search">
                  <Icon name="search" size={14} />
                  <input type="search" value={search} placeholder="Name, business or number" aria-label="Search numbers" onChange={(e) => setSearch(e.target.value)} />
                </label>
                {selected.size > 0 && (
                  <div className="nm-bulk">
                    <span>{selected.size} selected</span>
                    <select aria-label="Move selected to" value="" onChange={(e) => e.target.value && act(api.moveNumbers([...selected], Number(e.target.value)), (r) => (notify({ type: 'info', text: `${r.moved} moved${r.skipped ? `, ${r.skipped} already in that category` : ''}.` }), setSelected(new Set())))}>
                      <option value="">Move to…</option>
                      {lists.filter((l) => l.id !== listId).map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </select>
                    <button type="button" className="btn btn-sm btn-ghost btn-danger-text" onClick={() => window.confirm(`Delete ${selected.size} numbers?`) && act(api.deleteNumbers([...selected]), () => setSelected(new Set()))}>
                      Delete
                    </button>
                  </div>
                )}
                <span className="nm-count muted">{data.total} shown</span>
              </div>
              {data.rows.length === 0 ? (
                <p className="nm-empty">{list.total ? 'No numbers match.' : 'No numbers yet: import a file or paste numbers.'}</p>
              ) : (
                <div className="nm-table-wrap">
                  <table className="nm-table">
                    <thead>
                      <tr>
                        <th className="check"><input type="checkbox" aria-label="Select all" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(data.rows.map((r) => r.id)))} /></th>
                        <th>Name</th>
                        <th>Number</th>
                        <th>Call</th>
                        <th>SMS</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((n) => {
                        const [label, cls] = CALL[n.callStatus] || CALL.unseen;
                        return (
                          <tr key={n.id} className={selected.has(n.id) ? 'selected' : ''}>
                            <td className="check"><input type="checkbox" aria-label={`Select ${n.name || n.phone}`} checked={selected.has(n.id)} onChange={() => toggle(n.id)} /></td>
                            <td>
                              <span className="nm-name">
                                <strong>{n.name || n.business || <span className="muted">No name</span>}</strong>
                                {n.business && n.name && <span className="muted">{n.business}</span>}
                              </span>
                            </td>
                            <td className="mono">
                              {n.phone}
                              {!n.valid && <span className="chip chip-warn nm-flag" title={`Not a valid number: ${n.raw}`}>Invalid</span>}
                              {n.duplicates > 0 && <span className="chip chip-soft nm-flag" title="This number is also in another category or in your leads">Duplicate</span>}
                              {n.optedOut && <span className="chip chip-danger nm-flag" title="Opted out">Opted out</span>}
                            </td>
                            <td>
                              <button type="button" className={`chip ${cls}`} disabled={n.callStatus === 'seen'} aria-label={`${label}: ${n.name || n.phone}`} title={n.callStatus === 'seen' ? 'Called' : n.callStatus === 'dnc' ? 'Click to allow calls again' : 'Click to mark do not call'} onClick={() => (n.callStatus === 'dnc' || window.confirm(`Never call ${n.name || n.phone} automatically?`)) && act(api.setNumberDoNotCall(n.id, n.callStatus !== 'dnc'))}>
                                {label}
                              </button>
                            </td>
                            <td>{n.smsStatus === 'seen' ? <span className="chip sms-seen">SMS sent</span> : <span className="chip call-unseen">No SMS</span>}</td>
                            <td className="row-actions">
                              <button type="button" className="icon-btn call" aria-label={`Call ${n.name || n.phone}`} title="Call" disabled={!n.valid} onClick={() => onCall({ ...n, numberEntry: true })}>
                                <Icon name="phone" />
                              </button>
                              <button type="button" className="icon-btn" aria-label={`Text ${n.name || n.phone}`} title="Send SMS" onClick={() => onMessage({ phone: n.phone, numberId: n.id, name: n.name || n.business })}>
                                <Icon name="chat" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : (
          <section className="panel nm-welcome">
            <Icon name="users" size={28} />
            <h2>Phone numbers by category</h2>
            <p>Import numbers from CSV, Excel or text into categories of their own, apart from your leads. Call them one by one, or let the Auto Dialer call a whole category, and text them over your phone.</p>
            <button type="button" className="btn btn-primary" onClick={() => setNewName('')}>New category</button>
          </section>
        )}
      </div>
      {importing && <ImportDialog lists={lists} listId={listId} notify={notify} onClose={() => setImporting(false)} onDone={(id) => (setImporting(false), loadLists(), setListId(id), load())} />}
    </section>
  );
}
