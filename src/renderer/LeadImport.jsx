import { useEffect, useMemo, useState } from 'react';
import Icon from './icons.jsx';

// Leads tab > Import: the user's own CSV or Excel file. Each lead field gets
// one of the file's columns (guessed from the column names), the leads go
// into a category, and the import says what was added and what was skipped.

const api = window.leadFinder;

export default function LeadImport({ categories, onClose, onDone, notify }) {
  const [file, setFile] = useState(null);
  const [mapping, setMapping] = useState({});
  const [cat, setCat] = useState({ mode: 'existing', id: categories[0]?.id ? String(categories[0].id) : '', name: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  async function pick() {
    setError('');
    const r = await api.importLeadsPick();
    if (r.canceled) return;
    if (!r.ok) return setError(r.error);
    setFile(r);
    setMapping(r.mapping);
    setResult(null);
    if (!categories.length) setCat((c) => ({ ...c, mode: 'new', name: r.file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') }));
  }
  useEffect(() => {
    pick();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = useMemo(() => (file ? file.sample.map((row) => Object.fromEntries(file.fields.map(([f]) => [f, Number.isInteger(mapping[f]) ? row[mapping[f]] || '' : '']))) : []), [file, mapping]);

  async function run() {
    setBusy(true);
    setError('');
    const category = cat.mode === 'new' ? { name: cat.name } : cat.mode === 'existing' && cat.id ? { id: Number(cat.id) } : {};
    const r = await api.importLeads(file.token, mapping, category);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setResult(r);
    onDone(r);
    notify?.({ type: 'ok', text: `${r.added} lead${r.added === 1 ? '' : 's'} imported.` });
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="em-modal wide li-import" role="dialog" aria-modal="true" aria-label="Import leads">
        <header className="em-modal-head">
          <span className="em-mark">
            <Icon name="download" size={16} />
          </span>
          <div>
            <h2>Import leads</h2>
            <p>{file ? `${file.file} · ${file.total} row${file.total === 1 ? '' : 's'}${file.truncated ? ' (first 20,000)' : ''}` : 'Your own CSV or Excel (.xlsx) file'}</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        {!file ? (
          <div className="li-pick">
            <button type="button" className="btn btn-primary" onClick={pick}>
              <Icon name="file" size={14} /> Choose CSV or Excel file
            </button>
            <p className="muted small">The first row must be the column names (e.g. Business, Email, Phone, Website, City).</p>
          </div>
        ) : result ? (
          <div className="li-result" role="status">
            <p>
              <strong>{result.added}</strong> lead{result.added === 1 ? '' : 's'} added ({result.withEmail} with an email, {result.withPhone} with a phone).
            </p>
            {result.duplicates > 0 && <p className="muted">{result.duplicates} already saved (same email or phone), not added again.</p>}
            {result.skipped > 0 && <p className="muted">{result.skipped} row{result.skipped === 1 ? '' : 's'} without a business name, email or phone skipped.</p>}
          </div>
        ) : (
          <>
            <div className="li-map" role="group" aria-label="Columns">
              {file.fields.map(([f, label]) => (
                <label key={f}>
                  <span>{label}</span>
                  <select aria-label={label} value={Number.isInteger(mapping[f]) ? String(mapping[f]) : ''} onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                    <option value="">— not in the file —</option>
                    {file.columns.map((c, i) => (
                      <option key={i} value={String(i)}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="li-cat" role="group" aria-label="Category for the imported leads">
              <span>Category</span>
              <select aria-label="Category" value={cat.mode === 'new' ? '__new' : cat.mode === 'none' ? '__none' : cat.id} onChange={(e) => setCat((c) => (e.target.value === '__new' ? { ...c, mode: 'new' } : e.target.value === '__none' ? { ...c, mode: 'none' } : { ...c, mode: 'existing', id: e.target.value }))}>
                {categories.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name}
                  </option>
                ))}
                <option value="__new">New category…</option>
                <option value="__none">No category</option>
              </select>
              {cat.mode === 'new' && <input aria-label="New category name" placeholder="e.g. Imported Real Estate" value={cat.name} maxLength={60} onChange={(e) => setCat((c) => ({ ...c, name: e.target.value }))} />}
            </div>
            <div className="li-preview">
              <table className="em-table">
                <thead>
                  <tr>
                    {file.fields.filter(([f]) => Number.isInteger(mapping[f])).map(([f, label]) => (
                      <th key={f}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, i) => (
                    <tr key={i}>
                      {file.fields.filter(([f]) => Number.isInteger(mapping[f])).map(([f]) => (
                        <td key={f}>{row[f]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {error && (
          <p className="em-error" role="alert">
            <Icon name="alert" size={13} /> {error}
          </p>
        )}
        <footer className="em-modal-foot">
          {file && !result && (
            <button type="button" className="btn btn-ghost" onClick={pick}>
              Other file
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {result ? 'Done' : 'Cancel'}
          </button>
          {file && !result && (
            <button type="button" className="btn btn-primary" disabled={busy || (cat.mode === 'new' && cat.name.trim().length < 2)} onClick={run}>
              <Icon name="check" size={13} /> {busy ? 'Importing…' : `Import ${file.total} row${file.total === 1 ? '' : 's'}`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
