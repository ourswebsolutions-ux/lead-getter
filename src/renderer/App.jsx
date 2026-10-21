import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';
import Ambient from './Ambient.jsx';
import AgentCard from './AgentCard.jsx';
import Celebration from './Celebration.jsx';
import CategoryManager from './CategoryManager.jsx';
import WhatsAppPanel from './WhatsAppPanel.jsx';
import ChatsView from './ChatsView.jsx';
import OutreachView from './OutreachView.jsx';
import Composer from './Composer.jsx';
import { currentTheme, setTheme } from './theme.js';
import Plans, { statusLine } from './Plans.jsx';
import { ChangePin } from './LockScreen.jsx';

const api = window.leadFinder;

const ACTIVE = new Set(['connecting', 'running', 'paused', 'stopping']);

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Same rule as the database: single spaces, first letter of each word upper-case.
function formatCategory(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0].toLocaleUpperCase() + w.slice(1) : w))
    .join(' ');
}

function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatChecked(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Applies a batch of live leads (newest last) to the list in one pass.
function upsertMany(list, batch) {
  const byKey = new Map(batch.map((l) => [l.placeKey, l]));
  const next = list.map((l) => {
    const u = byKey.get(l.placeKey);
    if (!u) return l;
    byKey.delete(l.placeKey);
    return u;
  });
  return [...[...byKey.values()].reverse(), ...next];
}

// --- Category field with saved-category suggestions -----------------------------

function CategoryInput({ value, onChange, categories, disabled }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const matches = useMemo(() => {
    const list = categories.filter((c) => !typed || c.name.toLocaleLowerCase().includes(typed));
    return list
      .sort((a, b) => Number(!a.name.toLocaleLowerCase().startsWith(typed)) - Number(!b.name.toLocaleLowerCase().startsWith(typed)))
      .slice(0, 8);
  }, [categories, typed]);
  const exact = categories.some((c) => c.name.toLocaleLowerCase() === typed);
  const show = open && !disabled && matches.length > 0 && !(exact && matches.length === 1);

  function pick(name) {
    onChange(name);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div className="combo">
      <span className="field-icon">
        <Icon name="tag" />
      </span>
      <input
        id="cat"
        role="combobox"
        aria-expanded={show}
        aria-controls="cat-list"
        aria-autocomplete="list"
        autoComplete="off"
        value={value}
        placeholder="e.g. Software House"
        maxLength={60}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          onChange(formatCategory(value));
        }}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (i + 1) % matches.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i <= 0 ? matches.length - 1 : i - 1));
          } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault();
            pick(matches[active].name);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {show && (
        <ul className="suggestions" id="cat-list" role="listbox">
          {matches.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              // mousedown so the choice lands before the input's blur
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c.name);
              }}
            >
              <span>{c.name}</span>
              <span className="count-badge">{c.leadCount}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Phone cell with the automatic WhatsApp status ---------------------------

// Status from the automatic check. Earlier manual marks are not a confirmed
// result, so they count as "not checked" until the automatic check runs.
export function waStatus(lead) {
  if (lead.phoneStatus !== 'valid') return 'none';
  if (lead.whatsappMethod === 'manual') return 'not_checked';
  return lead.whatsapp || 'not_checked';
}

// WhatsApp is shown only by colour: a number WhatsApp confirmed is green
// (click it to write a message); every other number looks normal.
function PhoneCell({ lead, onCompose }) {
  if (!lead.phone && lead.phoneStatus !== 'invalid') return <span className="muted">Not listed</span>;
  if (lead.phoneStatus === 'invalid') {
    return (
      <span className="phone-wrap" title="This number is incomplete or malformed, so it is not shown as a phone number.">
        <span className="mono muted strike">{lead.phoneRaw}</span>
        <span className="chip chip-danger">Invalid</span>
      </span>
    );
  }
  if (lead.phoneStatus !== 'valid') {
    return (
      <span className="phone-wrap" title="Shown as found on Google Maps. Its country could not be confirmed, so it was not converted to international format.">
        <span className="mono">{lead.phone}</span>
        <span className="chip chip-warn">Unverified</span>
      </span>
    );
  }
  if (waStatus(lead) === 'available') {
    return (
      <button type="button" className="mono phone wa-available phone-link" aria-label={`Send WhatsApp message to ${lead.name}`} title="On WhatsApp: click to write a message" onClick={() => onCompose(lead)}>
        {lead.phone}
      </button>
    );
  }
  return <span className="mono phone">{lead.phone}</span>;
}

// One table row; memoised so live updates only render rows that changed.
const LeadRow = memo(function LeadRow({ lead: l, fresh, selected, pastView, onToggle, onDelete, onWhatsApp, onCompose, waOpen, notify }) {
  return (
    <tr className={`${fresh ? 'fresh' : ''} ${selected ? 'selected' : ''}`}>
      <td className="check">
        <input type="checkbox" aria-label={`Select ${l.name}`} checked={selected} onChange={() => onToggle(l.id)} />
      </td>
      <td className="name" dir="auto">{l.name}</td>
      <td className="phone-cell">
        <PhoneCell lead={l} waOpen={waOpen} onCompose={onCompose} onChanged={onWhatsApp} notify={notify} />
      </td>
      <td className="address" dir="auto" title={l.address}>
        {l.address ? <span className="address-text">{l.address}</span> : <span className="muted">Not listed</span>}
      </td>
      <td>{websiteChip(l)}</td>
      <td>{l.category ? <span className="cat">{l.category}</span> : <span className="muted">Uncategorized</span>}</td>
      <td className="mono date">
        {pastView ? (
          <>
            {formatDay(l.discoveredDate)} <span className="muted">{formatTime(l.discoveredAt)}</span>
          </>
        ) : (
          formatTime(l.discoveredAt)
        )}
      </td>
      <td className="row-actions">
        <button type="button" className="icon-btn" aria-label={`Open ${l.name} on Google Maps`} title="Open listing on Google Maps" onClick={() => api.openListing(l.mapsUrl)}>
          <Icon name="external" />
        </button>
        <button type="button" className="icon-btn danger" aria-label={`Delete ${l.name}`} title="Delete lead" onClick={() => onDelete([l.id])}>
          <Icon name="trash" />
        </button>
      </td>
    </tr>
  );
});

function ThemeToggle() {
  const [theme, setLocal] = useState(currentTheme());
  useEffect(() => {
    const on = (e) => setLocal(e.detail);
    window.addEventListener('themechange', on);
    return () => window.removeEventListener('themechange', on);
  }, []);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="theme-toggle" aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`} onClick={() => setTheme(next)}>
      <span className={`theme-icon ${theme === 'dark' ? 'on' : ''}`}>
        <Icon name="moon" />
      </span>
      <span className={`theme-icon ${theme === 'light' ? 'on' : ''}`}>
        <Icon name="sun" />
      </span>
    </button>
  );
}

function websiteChip(l) {
  if (l.websiteKind === 'with') {
    const site = l.websiteDetail ? l.websiteDetail.split('/')[0] : '';
    return (
      <span className={`chip ${l.websiteStatus.startsWith('Possible') ? 'chip-soft' : 'chip-site'}`} title={l.websiteStatus}>
        {l.websiteStatus.startsWith('Possible') ? 'Possible website' : 'Website'}
        {site ? <span className="chip-detail">{site}</span> : null}
      </span>
    );
  }
  if (l.websiteStatus.startsWith('No website (social page only')) {
    const host = l.websiteDetail || '';
    return (
      <span className="chip chip-soft" title={l.websiteStatus}>
        Social page only{host ? <span className="chip-detail">{host.split('/')[0]}</span> : null}
      </span>
    );
  }
  return <span className="chip chip-accent">No website</span>;
}

// --- App -------------------------------------------------------------------------

const WEBSITE_LABELS = { without: 'Without website', with: 'With website', all: 'All businesses' };

function LockMenu({ onLock, onChangePin }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div className="wa-panel" ref={ref}>
      <button type="button" className="theme-toggle" aria-label="Security" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="lock" />
      </button>
      {open && (
        <div className="menu lock-menu" role="menu" aria-label="Security">
          <button type="button" role="menuitem" onClick={() => (setOpen(false), onChangePin())}>
            <Icon name="edit" /> Change PIN
          </button>
          <button type="button" role="menuitem" onClick={() => (setOpen(false), onLock())}>
            <Icon name="lock" /> Lock now
          </button>
        </div>
      )}
    </div>
  );
}

export default function App({ onLock }) {
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [catData, setCatData] = useState({ categories: [], uncategorized: 0 });
  const [status, setStatus] = useState({ state: 'idle', message: 'Ready' });
  const [toasts, setToasts] = useState([]);
  const [interrupted, setInterrupted] = useState(null);
  const [summary, setSummary] = useState(null);
  const [wa, setWa] = useState(null);
  const [composeLead, setComposeLead] = useState(null);
  const [websiteFilter, setWebsiteFilter] = useState('without'); // for the next search
  const [siteView, setSiteView] = useState('all'); // table: all | without | with
  const [waOnly, setWaOnly] = useState(false);
  const [sub, setSub] = useState(null);
  const [plansOpen, setPlansOpen] = useState(null); // null | { notice }
  const [changePin, setChangePin] = useState(false);
  // Leads | Chats | Outreach. Views stay mounted once opened, so switching
  // keeps each one's place (scroll, open chat, unsaved templates).
  const [workspace, setWorkspaceState] = useState(() => {
    try {
      return ['leads', 'chats', 'outreach'].includes(localStorage.getItem('workspace')) ? localStorage.getItem('workspace') : 'leads';
    } catch {
      return 'leads';
    }
  });
  const [visited, setVisited] = useState(() => new Set([workspace]));
  const setWorkspace = (w) => {
    setWorkspaceState(w);
    setVisited((v) => (v.has(w) ? v : new Set([...v, w])));
    try {
      localStorage.setItem('workspace', w);
    } catch {}
  };

  const [today, setToday] = useState(localDate());
  const [view, setView] = useState('today');
  const [pastMode, setPastMode] = useState('all'); // 'all' | 'date' | 'range'
  const [pastDate, setPastDate] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [catFilter, setCatFilter] = useState('all'); // 'all' | 'none' | id
  const [dates, setDates] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const freshIds = useRef(new Set());

  const notify = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list.slice(-2), { ...t, id }]);
    if (t.type !== 'error') setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 6000);
  }, []);
  const dismiss = (id) => setToasts((list) => list.filter((x) => x.id !== id));

  const filter = useMemo(() => {
    const f = { category: catFilter };
    if (siteView !== 'all') f.website = siteView;
    if (waOnly) f.whatsapp = 'available';
    if (view === 'today') f.date = today;
    else if (pastMode === 'date' && pastDate) f.date = pastDate;
    else if (pastMode === 'range') {
      if (range.from) f.from = range.from;
      if (range.to) f.to = range.to;
    } else f.before = today;
    return f;
  }, [view, today, pastMode, pastDate, range, catFilter, siteView, waOnly]);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const viewKey = JSON.stringify(filter);

  const loadCategories = useCallback(() => api.listCategories().then(setCatData).catch(() => {}), []);

  const loadLeads = useCallback(() => {
    const f = filterRef.current;
    const slow = setTimeout(() => setLoading(true), 120);
    return api
      .listLeads(f)
      .then((rows) => {
        if (filterRef.current !== f) return;
        setLeads(rows);
        setSelected((sel) => new Set([...sel].filter((id) => rows.some((r) => r.id === id))));
      })
      .catch((e) => notify({ type: 'error', text: `Could not load leads: ${e.message}` }))
      .finally(() => {
        clearTimeout(slow);
        setLoading(false);
      });
  }, [notify]);

  useEffect(() => {
    loadLeads();
  }, [filter, loadLeads]);

  useEffect(() => {
    if (view !== 'past') return;
    api.listDates({ category: catFilter, before: today }).then(setDates).catch(() => {});
  }, [view, catFilter, today, leads]);

  useEffect(() => {
    loadCategories();
    api.getStatus().then(setStatus).catch(() => {});
    api.getInterrupted().then(setInterrupted).catch(() => {});
    const offStatus = api.onStatus(setStatus);
    const offSummary = api.onSummary(setSummary);
    api.whatsappState().then(setWa).catch(() => {});
    api.subscriptionStatus().then(setSub).catch(() => {});
    const offSub = api.onSubscription(setSub);
    const offWa = api.onWhatsAppState(setWa);
    // Background check results update the matching rows in place.
    const offWaLeads = api.onWhatsAppLeads(({ phone, leads: updated }) =>
      setLeads((list) => list.map((l) => (l.phone === phone ? updated.find((u) => u.id === l.id) || l : l))),
    );
    // Live leads are applied once per frame and category counts refreshed
    // at most twice a second, so bursts never stall the table.
    let queue = [];
    let frame = 0;
    let catTimer = 0;
    const flush = () => {
      frame = 0;
      const batch = queue;
      queue = [];
      if (batch.length) setLeads((list) => upsertMany(list, batch));
    };
    const offLead = api.onLead((lead) => {
      freshIds.current.add(lead.placeKey);
      const f = filterRef.current;
      const catOk = f.category === 'all' || (f.category === 'none' ? lead.categoryId == null : lead.categoryId === f.category);
      const siteOk = !f.website || f.website === lead.websiteKind;
      // New numbers are not checked on WhatsApp yet, so they wait for the check.
      if (catOk && siteOk && !f.whatsapp && f.date === lead.discoveredDate) {
        queue.push(lead);
        if (!frame) frame = requestAnimationFrame(flush);
      }
      if (!catTimer) catTimer = setTimeout(() => ((catTimer = 0), loadCategories()), 500);
    });
    // The computer's date can change while the app is open.
    const timer = setInterval(() => setToday(localDate()), 30_000);
    return () => {
      offStatus();
      offSummary();
      offWa();
      offSub();
      offWaLeads();
      offLead();
      clearInterval(timer);
      cancelAnimationFrame(frame);
      clearTimeout(catTimer);
    };
  }, [loadCategories]);

  useEffect(() => {
    if (!ACTIVE.has(status.state)) loadCategories();
  }, [status.state, loadCategories]);

  const active = ACTIVE.has(status.state);
  const canStart = !active && keyword.trim().length >= 2 && formatCategory(category).length >= 2;

  async function runSearch(kw, cat) {
    const res = await api.startSearch(kw, cat, websiteFilter);
    if (!res.ok) {
      // No active subscription: show the plans with the exact reason.
      if (res.subscription) setPlansOpen({ notice: res.error });
      else notify({ type: 'error', text: res.error });
      return;
    }
    setCategory(res.category.name); // the saved spelling
    setInterrupted(null);
    setSummary(null);
    loadCategories();
    if (view !== 'today') setView('today');
  }

  async function start(e) {
    e.preventDefault();
    const cat = formatCategory(category);
    setCategory(cat);
    await runSearch(keyword, cat);
  }

  async function resume() {
    setKeyword(interrupted.keyword);
    setCategory(interrupted.category);
    await runSearch(interrupted.keyword, interrupted.category);
  }

  async function exportCsv(scope) {
    try {
      const res = await api.exportCsv(scope, filter);
      if (res.subscription) setPlansOpen({ notice: res.error });
      else if (res.ok) notify({ type: 'ok', text: `Exported ${res.count} leads to ${res.filePath}` });
      else if (!res.canceled) notify({ type: 'error', text: res.error });
    } catch (err) {
      notify({ type: 'error', text: `Export failed: ${err.message}` });
    }
  }

  async function afterDelete(res) {
    if (res.ok) {
      notify({ type: 'ok', text: `Deleted ${res.deleted} lead${res.deleted === 1 ? '' : 's'}.` });
      setSelected(new Set());
      await loadLeads();
      loadCategories();
    } else if (!res.canceled) notify({ type: 'error', text: res.error });
  }

  const deleteIds = useCallback(async (ids) => afterDelete(await api.deleteLeads(ids)), [loadLeads]); // eslint-disable-line react-hooks/exhaustive-deps
  const deleteShown = async () => afterDelete(await api.deleteFiltered(filter));

  // A WhatsApp result applies to every lead with that number.
  const onWhatsAppChanged = useCallback((phone, updated) => {
    setLeads((list) => list.map((l) => (l.phone === phone ? updated.find((u) => u.id === l.id) || l : l)));
  }, []);

  const toggle = useCallback((id) => {
    setSelected((sel) => {
      const next = new Set(sel);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = leads.length > 0 && leads.every((l) => selected.has(l.id));
  const title = view === 'today' ? `Today's leads` : 'Past leads';
  const subtitle = view === 'today' ? formatDay(today) : pastMode === 'date' && pastDate ? formatDay(pastDate) : pastMode === 'range' ? 'Date range' : 'All earlier dates';

  return (
    <>
    <Ambient active={active} />
    <div className="shell">
      <header className="appbar">
        <div className="brand">
          <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="1" y="1" width="22" height="22" rx="6" />
            <path d="M8 6.5v11h8" />
            <circle cx="16" cy="8" r="2" />
          </svg>
          <h1 className="brand-name">Lead Finder</h1>
        </div>
        <nav className="segmented workspace-switch" aria-label="Workspace">
          {[
            ['leads', 'Leads', 'inbox'],
            ['chats', 'Chats', 'chat'],
            ['outreach', 'Outreach', 'send'],
          ].map(([id, label, icon]) => (
            <button key={id} type="button" className={workspace === id ? 'on' : ''} aria-pressed={workspace === id} onClick={() => setWorkspace(id)}>
              <Icon name={icon} size={14} /> {label}
            </button>
          ))}
        </nav>
        <div className={`conn ${status.profile && status.phase !== 'connection' ? 'on' : ''}`} title="Chrome profile used for searching">
          <span className="conn-dot" />
          {status.profile ? <span>Chrome · {status.profile}</span> : <span>Chrome not connected</span>}
        </div>
        <button
          type="button"
          className={`plan-pill reason-${sub?.reason || 'loading'}`}
          title={statusLine(sub)}
          onClick={() => setPlansOpen({ notice: null })}
        >
          <Icon name="crown" size={14} />
          <span>{!sub ? 'Plan…' : sub.reason === 'active' ? (sub.subscription?.expiresAt ? `${sub.subscription.daysLeft} days left` : 'Lifetime') : { trial: `Free: ${sub.trial?.remaining} search${sub.trial?.remaining === 1 ? '' : 'es'} left`, trial_used: 'Get a plan', pending: 'Pending approval', expired: 'Expired', cancelled: 'Apply again', none: 'Get a plan', offline: 'Plans', unconfigured: 'Plans', invalid: 'Plan: error', suspended: 'Suspended', inactive: 'Not activated', unavailable: 'Plan: checking', email_in_use: 'Email in use' }[sub.reason]}</span>
        </button>
        <WhatsAppPanel wa={wa} />
        <ThemeToggle />
        <LockMenu onLock={onLock} onChangePin={() => setChangePin(true)} />
      </header>

      {visited.has('chats') && <ChatsView wa={wa} notify={notify} hidden={workspace !== 'chats'} />}
      {visited.has('outreach') && <OutreachView wa={wa} notify={notify} hidden={workspace !== 'outreach'} />}
      <main className="content" hidden={workspace !== 'leads'}>
        <section className="panel search-panel">
          <form className="search" onSubmit={start}>
            <div className="field grow">
              <label htmlFor="kw">Search keyword</label>
              <div className="input-wrap">
                <span className="field-icon">
                  <Icon name="search" />
                </span>
                <input
                  id="kw"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="e.g. Software House in Lahore"
                  maxLength={120}
                  disabled={active}
                  autoFocus
                />
              </div>
            </div>
            <div className="field cat">
              <label htmlFor="cat">Category</label>
              <CategoryInput value={category} onChange={setCategory} categories={catData.categories} disabled={active} />
            </div>
            <div className="field site">
              <label htmlFor="site">Website</label>
              <select id="site" className="site-select" value={websiteFilter} disabled={active} onChange={(e) => setWebsiteFilter(e.target.value)}>
                {Object.entries(WEBSITE_LABELS).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="buttons">
              <button type="submit" className="btn btn-primary" disabled={!canStart}>
                <Icon name="play" /> Start Search
              </button>
              <button type="button" className="btn" onClick={() => api.stopSearch()} disabled={!active || status.state === 'stopping'}>
                <Icon name="stop" /> Stop Search
              </button>
            </div>
          </form>

          <div className={`progress state-${status.state}`} aria-live="polite">
            <div className="progress-bar" aria-hidden="true">
              <span />
            </div>
            <div className="progress-main">
              <span className="dot" />
              {status.state === 'error' && <span className="phase">{status.phase === 'connection' ? 'Chrome connection' : 'Search'}</span>}
              {status.state === 'paused' && <span className="phase phase-warn">Paused</span>}
              <span className="msg">{status.message}</span>
            </div>
            <dl className="stats">
              {status.keyword && (
                <div>
                  <dt>Keyword</dt>
                  <dd>{status.keyword}</dd>
                </div>
              )}
              {status.category && (
                <div>
                  <dt>Category</dt>
                  <dd>{status.category}</dd>
                </div>
              )}
              <div>
                <dt>Processed</dt>
                <dd className="num">{status.processed ?? 0}</dd>
              </div>
              <div>
                <dt>Qualified</dt>
                <dd className="num">{status.leads ?? 0}</dd>
              </div>
            </dl>
          </div>
        </section>

        {interrupted && !active && (
          <div className="banner" role="status">
            <Icon name="alert" />
            <span>
              Your last search <b>“{interrupted.keyword}”</b> ({interrupted.category}) was interrupted when Lead Finder closed. Saved leads are kept; resuming skips businesses already checked.
            </span>
            <span className="banner-actions">
              <button type="button" className="btn btn-sm btn-primary" onClick={resume}>
                Resume search
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  api.dismissInterrupted();
                  setInterrupted(null);
                }}
              >
                Dismiss
              </button>
            </span>
          </div>
        )}

        <section className="panel results">
          <div className="results-head">
            <div className="segmented" role="tablist" aria-label="Leads view">
              <button type="button" role="tab" aria-selected={view === 'today'} className={view === 'today' ? 'on' : ''} onClick={() => setView('today')}>
                Today
              </button>
              <button type="button" role="tab" aria-selected={view === 'past'} className={view === 'past' ? 'on' : ''} onClick={() => setView('past')}>
                Past leads
              </button>
            </div>
            <div className="title-block">
              <h2>
                {title} <span className="count-badge">{leads.length}</span>
              </h2>
              <span className="subtitle">{subtitle}</span>
            </div>
            <span className="spacer" />
            <button type="button" className="btn" onClick={() => exportCsv('filtered')} disabled={!leads.length} title="Export the leads shown, using the current category and date filters">
              <Icon name="download" /> Export CSV ({leads.length})
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => exportCsv('all')} title="Export every saved lead">
              Export all
            </button>
          </div>

          <div className="toolbar">
            <label className="select-wrap">
              <span>Category</span>
              <select
                aria-label="Show category"
                value={String(catFilter)}
                onChange={(e) => {
                  const v = e.target.value;
                  setCatFilter(v === 'all' || v === 'none' ? v : Number(v));
                }}
              >
                <option value="all">All categories</option>
                {catData.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.leadCount})
                  </option>
                ))}
                {catData.uncategorized > 0 && <option value="none">Uncategorized ({catData.uncategorized})</option>}
              </select>
            </label>
            <label className="select-wrap">
              <span>Website</span>
              <select aria-label="Show websites" value={siteView} onChange={(e) => setSiteView(e.target.value)}>
                <option value="all">All businesses</option>
                <option value="without">Without website</option>
                <option value="with">With website</option>
              </select>
            </label>
            <label className="check-wrap" title="Show and export only numbers that WhatsApp confirmed">
              <input type="checkbox" checked={waOnly} onChange={(e) => setWaOnly(e.target.checked)} aria-label="WhatsApp numbers only" />
              <span>WhatsApp only</span>
            </label>
            <CategoryManager
              categories={catData.categories}
              notify={notify}
              onChanged={() => {
                loadCategories();
                loadLeads();
                if (typeof catFilter === 'number') setCatFilter('all');
              }}
            />

            {view === 'past' && (
              <label className="select-wrap">
                <span>Date</span>
                <select
                  aria-label="Show date"
                  value={pastMode === 'date' ? pastDate : pastMode}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === 'all' || v === 'range') setPastMode(v);
                    else {
                      setPastMode('date');
                      setPastDate(v);
                    }
                  }}
                >
                  <option value="all">All past dates</option>
                  {dates.map((d) => (
                    <option key={d.date} value={d.date}>
                      {formatDay(d.date)} ({d.count})
                    </option>
                  ))}
                  <option value="range">Date range…</option>
                </select>
              </label>
            )}
            {view === 'past' && pastMode === 'range' && (
              <div className="range">
                <input type="date" aria-label="From date" value={range.from} max={range.to || today} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
                <span className="muted">to</span>
                <input type="date" aria-label="To date" value={range.to} min={range.from} max={today} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
              </div>
            )}

            <span className="spacer" />
            {selected.size > 0 && (
              <button type="button" className="btn btn-danger" onClick={() => deleteIds([...selected])}>
                <Icon name="trash" /> Delete selected ({selected.size})
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-danger-text" onClick={deleteShown} disabled={!leads.length}>
              Delete all shown
            </button>
          </div>

          <div className={`table-wrap ${loading ? 'is-loading' : ''}`}>
            <div className="view" key={viewKey}>
              {leads.length > 0 ? (
                <table>
                  <thead>
                    <tr>
                      <th className="check">
                        <input
                          type="checkbox"
                          aria-label="Select all shown leads"
                          checked={allSelected}
                          onChange={() => setSelected(allSelected ? new Set() : new Set(leads.map((l) => l.id)))}
                        />
                      </th>
                      <th>Business</th>
                      <th>Phone</th>
                      <th>Address</th>
                      <th>Website</th>
                      <th>Category</th>
                      <th>Discovered</th>
                      <th className="actions-col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((l) => (
                      <LeadRow
                        key={l.placeKey}
                        lead={l}
                        fresh={freshIds.current.has(l.placeKey)}
                        selected={selected.has(l.id)}
                        pastView={view !== 'today'}
                        onToggle={toggle}
                        onDelete={deleteIds}
                        onWhatsApp={onWhatsAppChanged}
                        onCompose={setComposeLead}
                        waOpen={wa?.state === 'open'}
                        notify={notify}
                      />
                    ))}
                  </tbody>
                </table>
              ) : loading ? (
                <div className="skeleton" aria-label="Loading leads">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="skeleton-row" style={{ animationDelay: `${i * 60}ms` }}>
                      <span />
                      <span />
                      <span />
                      <span />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <span className="empty-icon">
                    <Icon name={view === 'today' ? 'inbox' : 'calendar'} size={22} />
                  </span>
                  <h3>{view === 'today' ? 'No leads yet today' : 'Nothing here'}</h3>
                  <p>
                    {view === 'today'
                      ? active
                        ? 'Searching. Businesses without a website appear here the moment they are found.'
                        : 'Enter a keyword and category, then start a search. Qualified businesses appear here as Chrome finds them.'
                      : 'No past leads match these filters. Try another date or category.'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      {active && <AgentCard status={status} />}
      {summary && !active && <Celebration summary={summary} onClose={() => setSummary(null)} />}
      {plansOpen && <Plans status={sub} notice={plansOpen.notice} notify={notify} onClose={() => (setPlansOpen(null), api.subscriptionStatus().then(setSub).catch(() => {}))} />}
      {changePin && <ChangePin notify={notify} onClose={() => setChangePin(false)} />}
      {composeLead && <Composer lead={composeLead} connected={wa?.state === 'open'} notify={notify} onClose={() => setComposeLead(null)} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast notice ${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
            <Icon name={t.type === 'error' ? 'alert' : 'check'} />
            <span className="toast-text">{t.text}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
    </>
  );
}
