import { useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';

// Small popover to rename or delete saved categories. Renaming onto an
// existing name offers a merge (confirmed in the main process); deleting
// keeps the leads as Uncategorized.

export default function CategoryManager({ categories, onChanged, notify }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // { id, name }
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (e) => !ref.current?.contains(e.target) && (setOpen(false), setEditing(null));
    const esc = (e) => e.key === 'Escape' && (editing ? setEditing(null) : setOpen(false));
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, editing]);

  async function save(e) {
    e.preventDefault();
    const res = await window.leadFinder.renameCategory(editing.id, editing.name);
    if (res.ok) {
      notify({ type: 'ok', text: res.merged ? `Merged into “${res.name}” (${res.moved} lead${res.moved === 1 ? '' : 's'} moved).` : `Renamed to “${res.name}”.` });
      setEditing(null);
      onChanged();
    } else if (!res.canceled) notify({ type: 'error', text: res.error });
  }

  async function remove(c) {
    const res = await window.leadFinder.deleteCategory(c.id);
    if (res.ok) {
      notify({ type: 'ok', text: `Deleted “${res.name}”.${res.uncategorized ? ` ${res.uncategorized} lead${res.uncategorized === 1 ? '' : 's'} kept as Uncategorized.` : ''}` });
      onChanged();
    } else if (!res.canceled) notify({ type: 'error', text: res.error });
  }

  return (
    <div className="catman" ref={ref}>
      <button type="button" className="icon-btn" aria-label="Manage categories" aria-expanded={open} title="Rename or delete categories" onClick={() => setOpen((o) => !o)}>
        <Icon name="edit" />
      </button>
      {open && (
        <div className="menu catman-menu" role="dialog" aria-label="Manage categories">
          <div className="menu-head">
            <span className="menu-title">Categories</span>
            <span className="menu-state">Rename or delete. Leads are always kept.</span>
          </div>
          {categories.length === 0 && <p className="menu-note">No saved categories yet.</p>}
          <ul className="catman-list">
            {categories.map((c) => (
              <li key={c.id}>
                {editing?.id === c.id ? (
                  <form className="catman-edit" onSubmit={save}>
                    <input
                      aria-label={`New name for ${c.name}`}
                      value={editing.name}
                      maxLength={60}
                      autoFocus
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    />
                    <button type="submit" className="icon-btn" aria-label="Save name" disabled={editing.name.trim().length < 2}>
                      <Icon name="check" />
                    </button>
                    <button type="button" className="icon-btn" aria-label="Cancel rename" onClick={() => setEditing(null)}>
                      <Icon name="x" />
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="catman-name">{c.name}</span>
                    <span className="count-badge">{c.leadCount}</span>
                    <button type="button" className="icon-btn" aria-label={`Rename ${c.name}`} onClick={() => setEditing({ id: c.id, name: c.name })}>
                      <Icon name="edit" size={14} />
                    </button>
                    <button type="button" className="icon-btn danger" aria-label={`Delete category ${c.name}`} onClick={() => remove(c)}>
                      <Icon name="trash" size={14} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
