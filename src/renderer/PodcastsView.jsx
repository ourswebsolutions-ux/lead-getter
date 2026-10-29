import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { planNeeded } from './Activation.jsx';

const api = window.leadFinder;

const PLATFORMS = [
  { id: 'apple', label: 'Apple Podcasts', short: 'Apple' },
  { id: 'spotify', label: 'Spotify', short: 'Spotify' },
  { id: 'youtube', label: 'YouTube', short: 'YouTube' },
  { id: 'amazon', label: 'Amazon Music', short: 'Amazon' },
];
const LABEL = { ...Object.fromEntries(PLATFORMS.map((p) => [p.id, p.label])), website: 'Website' };

// Keys each platform needs (Settings dialog).
const KEYS = {
  youtube: { fields: [['apiKey', 'API key']], where: 'console.cloud.google.com → APIs → YouTube Data API v3 → Credentials' },
};

// Recognisable, single-colour platform marks.
export function PlatformIcon({ id, size = 16 }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, className: `pf-icon pf-${id}` };
  if (id === 'apple')
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <circle cx="8" cy="6.4" r="1.6" fill="currentColor" stroke="none" />
        <path d="M8 9.2v4.3" strokeWidth="2" />
        <path d="M5.2 9.4a3.6 3.6 0 1 1 5.6 0" />
        <path d="M3.4 11.4a6 6 0 1 1 9.2 0" />
      </svg>
    );
  if (id === 'spotify')
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeLinecap="round">
        <circle cx="8" cy="8" r="6.6" strokeWidth="1.3" />
        <path d="M4.6 6.3c2.4-.8 4.9-.6 7 .6" strokeWidth="1.5" />
        <path d="M5 8.5c2-.6 4-.4 5.7.5" strokeWidth="1.3" />
        <path d="M5.4 10.6c1.6-.4 3.1-.3 4.4.4" strokeWidth="1.1" />
      </svg>
    );
  if (id === 'youtube')
    return (
      <svg {...common}>
        <rect x="1.2" y="3.4" width="13.6" height="9.2" rx="2.6" fill="currentColor" />
        <path d="m6.6 5.9 3.6 2.1-3.6 2.1Z" fill="var(--surface)" />
      </svg>
    );
  if (id === 'amazon')
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 3.4v5.2M5 3.4l3.3 1.1v5.2M8.3 4.5l3.2 1.1v5" strokeWidth="1.3" />
        <path d="M2.4 11.5c3.3 2 7.8 2 11.2-.2" strokeWidth="1.4" />
        <path d="m12 10.6 1.6.7-.5 1.6" strokeWidth="1.2" />
      </svg>
    );
  // A website.
  return (
    <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.6 3.8 2.6 6.2S9.8 12.5 8 14.2C6.2 12.5 5.4 10.4 5.4 8S6.2 3.5 8 1.8Z" />
    </svg>
  );
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
};

// Opens the user's mail app (links inside the window cannot navigate).
function MailLink({ email, className = '', title }) {
  return (
    <a
      href={`mailto:${email}`}
      className={className}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        api.openPodcastLink(`mailto:${email}`);
      }}
    >
      {email}
    </a>
  );
}

function ExtLink({ url, children, title, className = '' }) {
  if (!url) return null;
  return (
    <button
      type="button"
      className={`pc-link ${className}`}
      title={title || url}
      onClick={(e) => {
        e.stopPropagation();
        api.openPodcastLink(url);
      }}
    >
      {children || hostOf(url)}
    </button>
  );
}

function KeysDialog({ settings, focus, onClose, onSaved, notify }) {
  const [platform, setPlatform] = useState(KEYS[focus] ? focus : Object.keys(KEYS)[0]);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const def = KEYS[platform];
  useEffect(() => {
    setForm({});
    setError('');
  }, [platform]);
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy, onClose]);
  async function save(values, removing) {
    setBusy(true);
    setError('');
    try {
      const res = await api.setPodcastKeys(platform, values);
      if (!res.ok) return setError(res.error);
      onSaved(res);
      if (res.warning) setError('');
      else notify({ type: 'info', text: removing ? `${LABEL[platform]} keys removed.` : res.stored ? `${LABEL[platform]} connected.` : `${LABEL[platform]} connected for this session (no system keychain to store keys).` });
      setForm({});
    } finally {
      setBusy(false);
    }
  }
  const connected = settings.keys[platform];
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="composer pc-keys"
        role="dialog"
        aria-modal="true"
        aria-label="Search settings"
        onSubmit={(e) => {
          e.preventDefault();
          save(form, false);
        }}
      >
        <header className="composer-head">
          <span className="composer-icon neutral">
            <Icon name="sliders" size={18} />
          </span>
          <div>
            <strong>Search settings</strong>
            <span className="muted">Results per platform, and your YouTube API key.</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className="pc-setting">
          <span>Results per platform</span>
          <div className="segmented" role="radiogroup" aria-label="Results per platform">
            {[25, 50, 100, 200].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={settings.limit === n}
                className={settings.limit === n ? 'on' : ''}
                disabled={busy}
                onClick={async () => {
                  const res = await api.setPodcastSettings({ limit: n });
                  if (res.ok) onSaved(res);
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="pc-keys-title">
          {Object.keys(KEYS).length === 1 ? (
            <>
              <PlatformIcon id={platform} size={14} /> {LABEL[platform]} API key
            </>
          ) : (
            'Platform keys'
          )}
        </div>
        <div className="segmented pc-keys-tabs" role="tablist" hidden={Object.keys(KEYS).length < 2}>
          {Object.keys(KEYS).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={platform === k} className={platform === k ? 'on' : ''} onClick={() => setPlatform(k)}>
              <PlatformIcon id={k} size={13} /> {LABEL[k]}
              {settings.keys[k] && <span className="pc-ok-dot" aria-label="connected" />}
            </button>
          ))}
        </div>
        <p className="pc-keys-state">
          {connected && settings.keyNotes?.[platform] ? (
            <span className="pc-keys-warn" role="status">
              <span className="pc-dot-label tone-warn">
                <span className="pc-dot" /> Keys accepted, searches refused
              </span>
              <span>{settings.keyNotes[platform]}</span>
            </span>
          ) : connected ? (
            <>
              <span className="pc-dot-label tone-ok">
                <span className="pc-dot" /> Connected
              </span>{' '}
              Enter new keys to replace them.
            </>
          ) : (
            <span className="muted">Not connected. Get keys at {def.where}.</span>
          )}
        </p>
        {def.fields.map(([k, label]) => (
          <label key={k} className="pc-field">
            <span>{label}</span>
            <input
              type={/secret/i.test(k) ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              value={form[k] || ''}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              disabled={busy}
            />
          </label>
        ))}
        {error && (
          <p className="composer-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted pc-keys-note">Keys are checked with {LABEL[platform]} and stored encrypted on this computer.</p>
        <footer className="composer-actions">
          {connected && (
            <button type="button" className="btn btn-ghost btn-danger-text" disabled={busy} onClick={() => save({}, true)}>
              Remove
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || def.fields.some(([k]) => !(form[k] || '').trim())}>
            {busy ? 'Checking…' : 'Connect'}
          </button>
        </footer>
      </form>
    </div>
  );
}

// A lead's email status, as shown.
const STATUS = {
  found: { tone: 'ok', text: 'Email found' },
  pending: { tone: 'busy', text: 'Finding email' },
  none: { tone: 'idle', text: 'No public email' },
  platform: { tone: 'warn', text: 'Platform address only' },
  failed: { tone: 'warn', text: 'Could not check' },
};
const statusOf = (l, live) => {
  if (live?.state === 'running') return { tone: 'busy', text: live.step || 'Checking', spin: true };
  if (live?.state === 'queued' && l.emailStatus === 'pending') return { tone: 'idle', text: 'Waiting to check' };
  if (l.emailStatus === 'pending' && !live) return { tone: 'idle', text: 'Discovery pending' };
  return STATUS[l.emailStatus] || STATUS.none;
};
const retryable = (l) => ['none', 'failed', 'platform', 'pending'].includes(l.emailStatus);

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};
// Distinct keywords a lead was found for, newest first.
const keywordsOf = (l) => [...new Set((l.hits || []).map((h) => h.keyword).filter((k) => k && k !== 'retry'))];

function StatusPill({ st }) {
  return (
    <span className={`pc-status tone-${st.tone}`}>
      {st.spin ? <span className="spinner" aria-hidden="true" /> : <span className="pc-dot" />}
      <span className="pc-status-text">{st.text}</span>
    </span>
  );
}

function PlatformBadges({ lead, size = 14 }) {
  return (
    <span className="pc-pf-row">
      {Object.entries(lead.podcastLinks || {}).map(([p, url]) => (
        <ExtLink key={p} url={url} title={`Open on ${LABEL[p] || p}`} className={`pc-pf pf-${p}`}>
          <PlatformIcon id={p} size={size} />
        </ExtLink>
      ))}
    </span>
  );
}

function KeywordBadges({ lead, max = 2 }) {
  const kws = keywordsOf(lead);
  if (!kws.length) return null;
  return (
    <span className="pc-kws">
      {kws.slice(0, max).map((k) => (
        <span key={k} className="pc-kw" title={`Found by the search “${k}”`}>
          {k}
        </span>
      ))}
      {kws.length > max && <span className="pc-kw more" title={kws.slice(max).join(', ')}>+{kws.length - max}</span>}
    </span>
  );
}

function CopyEmail({ email }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="pc-copy"
      aria-label={`Copy ${email}`}
      title={copied ? 'Copied' : 'Copy'}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(email).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} />
    </button>
  );
}

function LeadDetails({ lead }) {
  const hits = lead.hits || [];
  return (
    <div className="pc-detail">
      <dl className="pc-facts">
        {lead.discovery && (
          <div>
            <dt>Discovery</dt>
            <dd>{lead.discovery}</dd>
          </div>
        )}
        {lead.rssUrl && (
          <div>
            <dt>RSS feed</dt>
            <dd>
              <ExtLink url={lead.rssUrl}>{lead.rssUrl}</ExtLink>
            </dd>
          </div>
        )}
        {lead.phone && (
          <div>
            <dt>Phone</dt>
            <dd className="mono">{lead.phone}</dd>
          </div>
        )}
        {hits.length > 0 && (
          <div>
            <dt>Found by</dt>
            <dd className="pc-hits">
              {hits.map((h) => (
                <span key={`${h.searchId}`}>
                  “{h.keyword}” on {LABEL[h.platform] || h.platform} · {when(h.foundAt)} · {h.outcome === 'new' ? 'new' : 'already saved'}
                  {h.sourceUrl && (
                    <>
                      {' · '}
                      <ExtLink url={h.sourceUrl}>source</ExtLink>
                    </>
                  )}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
      {lead.emails?.length > 0 && (
        <ul className="pc-emails">
          {lead.emails.map((e) => (
            <li key={e.email}>
              <MailLink email={e.email} className="mono" />
              {e.kind === 'platform' && <span className="pc-tag">hosting platform</span>}
              <span className="muted">{e.from}</span>
              {e.url && <ExtLink url={e.url}>source</ExtLink>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LeadCard({ lead, live, onRetry, busy, selected, onSelect }) {
  const [open, setOpen] = useState(false);
  const st = statusOf(lead, live);
  return (
    <article className={`pc-card ${st.spin ? 'busy' : ''} ${selected ? 'selected' : ''}`}>
      <div className="pc-card-top">
        <input type="checkbox" className="pc-check" aria-label={`Select ${lead.name}`} checked={selected} onChange={() => onSelect(lead.id)} />
        {lead.artworkUrl ? <img className="pc-cover" src={lead.artworkUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="pc-cover pc-cover-empty" aria-hidden="true"><Icon name="mic" size={20} /></span>}
        <div className="pc-card-head">
          <h3 className="pc-card-title" dir="auto" title={lead.name}>
            {lead.name}
          </h3>
          {lead.podcastHost && (
            <p className="pc-card-host" dir="auto">
              {lead.podcastHost}
            </p>
          )}
          <div className="pc-card-badges">
            <PlatformBadges lead={lead} />
            <KeywordBadges lead={lead} />
          </div>
        </div>
      </div>
      {lead.description && (
        <p className="pc-card-desc" dir="auto">
          {lead.description}
        </p>
      )}
      <div className={`pc-card-contact tone-${st.tone}`}>
        <StatusPill st={st} />
        {lead.email ? (
          <span className="pc-email">
            <MailLink email={lead.email} title={lead.emails?.find((e) => e.email === lead.email)?.from} />
            <CopyEmail email={lead.email} />
            {lead.emails?.filter((e) => e.kind !== 'platform').length > 1 && <span className="pc-more">+{lead.emails.filter((e) => e.kind !== 'platform').length - 1}</span>}
          </span>
        ) : null}
      </div>
      <footer className="pc-card-foot">
        {lead.websiteUrl ? <ExtLink url={lead.websiteUrl} /> : <span className="muted">No website found</span>}
        <span className="spacer" />
        {retryable(lead) && !st.spin && (
          <button type="button" className="pc-inline" onClick={() => onRetry([lead.id])} disabled={busy} title="Look for this podcast’s email again">
            Retry
          </button>
        )}
        <button type="button" className="pc-inline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Less' : 'Details'}
        </button>
      </footer>
      {open && <LeadDetails lead={lead} />}
    </article>
  );
}

function LeadRow({ lead, live, onRetry, busy, selected, onSelect }) {
  const [open, setOpen] = useState(false);
  const st = statusOf(lead, live);
  return (
    <>
      <tr className={`pc-row ${open ? 'open' : ''} ${st.spin ? 'busy' : ''} ${selected ? 'selected' : ''}`} onClick={() => setOpen((o) => !o)}>
        <td className="check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" aria-label={`Select ${lead.name}`} checked={selected} onChange={() => onSelect(lead.id)} />
        </td>
        <td className="pc-c-show">
          <div className="pc-show">
            {lead.artworkUrl ? <img src={lead.artworkUrl} alt="" width="36" height="36" loading="lazy" referrerPolicy="no-referrer" /> : <span className="pc-art" aria-hidden="true" />}
            <div className="pc-show-text">
              <span className="pc-title" dir="auto">
                {lead.name}
              </span>
              <span className="pc-host-sm" dir="auto">
                {lead.podcastHost}
              </span>
            </div>
          </div>
        </td>
        <td className="pc-c-host" dir="auto">
          {lead.podcastHost || <span className="muted">–</span>}
        </td>
        <td className="pc-c-platforms">
          <PlatformBadges lead={lead} size={15} />
        </td>
        <td className="pc-c-kw">
          <KeywordBadges lead={lead} max={1} />
        </td>
        <td className="pc-c-email">
          {lead.email ? (
            <span className="pc-email">
              <MailLink email={lead.email} />
              <CopyEmail email={lead.email} />
            </span>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td className="pc-c-site">{lead.websiteUrl ? <ExtLink url={lead.websiteUrl} /> : <span className="muted">—</span>}</td>
        <td className="pc-c-status">
          <StatusPill st={st} />
        </td>
        <td className="pc-c-act" onClick={(e) => e.stopPropagation()}>
          {retryable(lead) && !st.spin && (
            <button type="button" className="pc-inline" onClick={() => onRetry([lead.id])} disabled={busy}>
              Retry
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="pc-detail-row">
          <td colSpan={9}>
            <LeadDetails lead={lead} />
          </td>
        </tr>
      )}
    </>
  );
}

const SORT_OPTIONS = [
  ['rank:asc', 'Best match'],
  ['found:desc', 'Newest first'],
  ['found:asc', 'Oldest first'],
  ['name:asc', 'Name A–Z'],
  ['status:asc', 'Email status'],
];

export default function PodcastsView({ notify, hidden, categories = [] }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(() => {
    try {
      return localStorage.getItem('lf-podcast-category') || 'Podcasts';
    } catch {
      return 'Podcasts';
    }
  });
  const [settings, setSettings] = useState(null);
  const [keysOpen, setKeysOpen] = useState(null);
  const [run, setRun] = useState(null); // podcast:status of the current run
  const runId = useRef(null);
  const [platformState, setPlatformState] = useState({});
  const [browserFinds, setBrowserFinds] = useState([]);
  const [live, setLive] = useState({}); // leadId -> { state, step } during a run
  // The library.
  const [filter, setFilter] = useState({ status: 'all', searchId: null, platform: '', search: '', sort: 'found:desc', page: 1 });
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem('lf-podcast-view') === 'table' ? 'table' : 'cards';
    } catch {
      return 'cards';
    }
  });
  const [data, setData] = useState(null); // { rows, total, counts, page, pageSize }
  const [loadError, setLoadError] = useState('');
  const [searches, setSearches] = useState([]);
  const [text, setText] = useState('');
  // Selected podcast leads (by id): kept across pages, filters and searches.
  const [selected, setSelected] = useState(() => new Set());
  const [working, setWorking] = useState(''); // 'delete' | 'export' while one runs
  const running = run?.state === 'running';
  const pageSize = view === 'cards' ? 24 : 25;

  const load = useCallback(async () => {
    const [by, dir] = filter.sort.split(':');
    try {
      const res = await api.podcastLeads({ status: filter.status, searchId: filter.searchId ?? undefined, platform: filter.platform || undefined, search: filter.search, sort: by, dir, page: filter.page, pageSize });
      setData(res);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message || 'The podcast leads could not be loaded.');
    }
  }, [filter, pageSize]);
  const loadRef = useRef(load);
  loadRef.current = load;
  // Live updates refresh the library at most every 600ms.
  const refresh = useRef({ timer: 0 });
  const scheduleLoad = useCallback(() => {
    if (refresh.current.timer) return;
    refresh.current.timer = setTimeout(() => {
      refresh.current.timer = 0;
      loadRef.current();
    }, 600);
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    api.podcastSettings().then(setSettings);
    api.podcastSearches().then(setSearches);
    const offItem = api.onPodcastItem((it) => {
      if (it.runId !== runId.current) return; // an earlier run's late event
      if (it.leadId) setLive((m) => ({ ...m, [it.leadId]: { state: it.state, step: it.step } }));
      if (it.state === 'done' || it.state === 'queued' || it.state === 'rejected') scheduleLoad();
    });
    const offPlatform = api.onPodcastPlatform((p) => {
      if (p.runId !== runId.current) return;
      setPlatformState((m) => ({ ...m, [p.id]: p }));
    });
    const offStatus = api.onPodcastStatus((s) => {
      // A run started from the browser (a podcast opened there) becomes current.
      if (s.state === 'running' && s.runId !== runId.current) {
        runId.current = s.runId;
        setPlatformState({});
        setLive({});
      }
      if (s.runId !== runId.current) return;
      setRun(s);
      if (s.state !== 'running') {
        scheduleLoad();
        api.podcastSearches().then(setSearches);
        setLive({});
      }
      if (s.state === 'failed') notify({ type: 'error', text: s.message });
    });
    const offBrowser = api.onPodcastBrowser((b) =>
      setBrowserFinds((list) => [{ ...b, at: Date.now() }, ...list.filter((x) => x.url !== b.url)].slice(0, 6)),
    );
    return () => {
      offItem();
      offPlatform();
      offStatus();
      offBrowser();
      clearTimeout(refresh.current.timer);
    };
  }, [notify, scheduleLoad]);

  // Filter text: applied after a short pause.
  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => (f.search === text.trim() ? f : { ...f, search: text.trim(), page: 1 })), 300);
    return () => clearTimeout(t);
  }, [text]);

  // Shown at once and saved in order, so quick clicks are never lost.
  const latest = useRef(null);
  latest.current = settings;
  const saving = useRef(Promise.resolve());
  const togglePlatform = (id) => {
    const cur = latest.current;
    const platforms = { ...cur.platforms, [id]: !cur.platforms[id] };
    if (!Object.values(platforms).some(Boolean)) return notify({ type: 'error', text: 'Keep at least one platform on.' });
    latest.current = { ...cur, platforms };
    setSettings(latest.current);
    saving.current = saving.current.then(async () => {
      const res = await api.setPodcastSettings({ platforms });
      if (!res.ok) {
        notify({ type: 'error', text: res.error });
        setSettings(await api.podcastSettings());
      }
    });
  };

  async function search(e) {
    e?.preventDefault();
    if (running) return;
    try {
      localStorage.setItem('lf-podcast-category', category);
    } catch {}
    setPlatformState({});
    setLive({});
    // Shown first: a search that ends at once reports its end before the call returns.
    runId.current = 'starting';
    setRun({ state: 'running', found: 0, done: 0, withEmail: 0, message: 'Searching' });
    const res = await api.searchPodcasts(query, category);
    if (!res.ok) {
      runId.current = null;
      setRun(null);
      if (!planNeeded(res)) notify({ type: 'error', text: res.error });
      return;
    }
    runId.current = res.runId;
  }

  // This search's leads, once it has a search record.
  useEffect(() => {
    if (run?.searchId && run.state === 'running') setFilter((f) => (f.searchId === run.searchId ? f : { ...f, searchId: run.searchId, status: 'all', sort: 'rank:asc', page: 1 }));
  }, [run?.searchId, run?.state]);

  const toggleSelect = useCallback((id) => {
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);
  const pageIds = (data?.rows || []).map((l) => l.id);
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const togglePage = () =>
    setSelected((cur) => {
      const n = new Set(cur);
      for (const id of pageIds) pageAllSelected ? n.delete(id) : n.add(id);
      return n;
    });
  async function selectAllMatching() {
    try {
      const ids = await api.podcastIds({ status: filter.status, searchId: filter.searchId ?? undefined, platform: filter.platform || undefined, search: filter.search });
      setSelected(new Set(ids));
    } catch (err) {
      notify({ type: 'error', text: err.message });
    }
  }

  // Delete or export the selection ({ ids }) or every podcast lead ({ all }).
  async function act(kind, scope) {
    if (working) return;
    if (!scope.all && !scope.ids.length) return notify({ type: 'error', text: 'No podcast leads are selected.' });
    setWorking(kind);
    try {
      const res = kind === 'delete' ? await api.deletePodcasts(scope) : await api.exportPodcasts(scope);
      if (res.canceled) return;
      if (!res.ok) {
        if (!planNeeded(res)) notify({ type: 'error', text: res.error });
        return;
      }
      if (kind === 'delete') {
        notify({ type: 'info', text: `Deleted ${res.deleted} podcast lead${res.deleted === 1 ? '' : 's'}.` });
        setSelected(new Set());
        await load();
        api.podcastSearches().then(setSearches);
      } else notify({ type: 'info', text: `Exported ${res.count} podcast lead${res.count === 1 ? '' : 's'} to ${res.filePath}.` });
    } catch (err) {
      notify({ type: 'error', text: err.message });
    } finally {
      setWorking('');
    }
  }

  async function retry(ids) {
    if (!ids.length) return;
    runId.current = 'starting';
    const res = await api.retryPodcasts(ids);
    if (!res.ok) {
      runId.current = null;
      if (!planNeeded(res)) notify({ type: 'error', text: res.error });
      return;
    }
    runId.current = res.runId;
    setLive(Object.fromEntries(ids.map((id) => [id, { state: 'queued' }])));
  }

  const set = (patch) => setFilter((f) => ({ ...f, page: 1, ...patch }));
  const counts = data?.counts || { all: 0, found: 0, none: 0, pending: 0 };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const selectedCount = settings ? PLATFORMS.filter((p) => settings.platforms[p.id]).length : 0;
  const progress = run && run.found ? Math.round((run.done / run.found) * 100) : 0;
  // Shown leads without an email (pending ones from a stopped search too), unless being checked now.
  const retryIds = running ? [] : (data?.rows || []).filter((l) => retryable(l) && !live[l.id]).map((l) => l.id);
  const scopeSearch = searches.find((x) => x.id === filter.searchId);

  return (
    <section className="podcasts" hidden={hidden} aria-label="Podcasts">
      <div className="panel pc-hero">
        <div className="pc-hero-head">
          <div>
            <h2>Podcasts</h2>
            <p>Discover podcasts and find contact emails automatically.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm pc-keys-btn" onClick={() => setKeysOpen('youtube')}>
            <Icon name="sliders" size={14} /> Settings
          </button>
        </div>
        <form className="pc-search" onSubmit={search}>
          <div className="pc-search-box">
            <Icon name="search" size={18} />
            <input
              id="pc-q"
              aria-label="Search podcasts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Topic, podcast name, podcast link or website"
              maxLength={300}
              disabled={running}
              autoComplete="off"
            />
          </div>
          {running ? (
            <button type="button" className="btn pc-go" onClick={() => api.stopPodcasts()}>
              <Icon name="stop" /> Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary pc-go" disabled={query.trim().length < 2 || !selectedCount}>
              Search
            </button>
          )}
        </form>
        {settings && (
          <div className="pc-options">
            <div className="pc-platforms" role="group" aria-label="Platforms">
              {PLATFORMS.map((p) => {
                const on = settings.platforms[p.id];
                const needsKey = KEYS[p.id] && !settings.keys[p.id];
                const ps = platformState[p.id];
                const browser = p.id === 'spotify' || p.id === 'amazon';
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={p.label}
                    className={`pc-chip pf-${p.id} ${on ? 'on' : ''}`}
                    disabled={running}
                    onClick={() => togglePlatform(p.id)}
                    title={browser ? `Opens ${p.label}’s search in Chrome for you; podcasts you open there are added here` : needsKey ? `${p.label} needs your free API key (Settings)` : `Search ${p.label}`}
                  >
                    <PlatformIcon id={p.id} />
                    <span>{p.short}</span>
                    {on && ps?.state === 'searching' && <span className="spinner pc-chip-spin" aria-hidden="true" />}
                    {on && ps?.state === 'done' && <span className="pc-chip-count">{ps.count}</span>}
                    {on && (ps?.state === 'needs_key' || (!ps && needsKey)) && <span className="pc-chip-flag warn">Key</span>}
                    {on && ps?.state === 'failed' && <span className="pc-chip-flag bad">!</span>}
                    {browser && on && (!ps || ps.state === 'searching') && <span className="pc-chip-flag">Chrome</span>}
                    {on && ps?.state === 'opened' && <span className="pc-chip-flag ok">In Chrome</span>}
                  </button>
                );
              })}
            </div>
            <label className="pc-save" title="Leads from this search are saved under this category">
              <Icon name="tag" size={14} />
              <span>Save to</span>
              <input aria-label="Save leads to category" list="pc-cats" value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} disabled={running} />
              <datalist id="pc-cats">
                {categories.map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
            </label>
          </div>
        )}
        {run && (
          <div className={`pc-run state-${run.state}`} aria-live="polite">
            <div className="pc-run-bar" aria-hidden="true">
              <span style={{ width: `${run.state === 'running' ? Math.max(progress, run.found ? 3 : 0) : 100}%` }} />
            </div>
            <div className="pc-run-line">
              <span className="pc-run-msg">{run.message}</span>
              {(run.saved > 0 || run.rejected > 0 || run.duplicates > 0) && (
                <span className="pc-run-counts" aria-label="This search">
                  <span title="Saved for the first time">
                    <b>{run.newLeads || 0}</b> new
                  </span>
                  <span title="Already saved before, or the same podcast twice">
                    <b>{run.duplicates || 0}</b> duplicate
                  </span>
                  <span title="Saved or updated in Leads">
                    <b>{run.saved || 0}</b> saved
                  </span>
                  <span title="Results that are not podcasts, deleted before, or could not be saved">
                    <b>{run.rejected || 0}</b> rejected
                  </span>
                </span>
              )}
              {(() => {
                const all = Object.values(platformState);
                const keyless = all.filter((p) => p.state === 'needs_key' && p.id !== 'link');
                return (
                  <>
                    {keyless.length > 0 && (
                      <span className="pc-run-note" title={keyless.map((p) => p.message).join('\n')}>
                        {keyless.map((p) => LABEL[p.id]).join(', ')} {keyless.length === 1 ? 'needs' : 'need'} your API key
                        <button type="button" className="pc-inline" onClick={() => setKeysOpen(keyless[0].id)}>
                          Add key
                        </button>
                      </span>
                    )}
                    {all
                      .filter((p) => ['failed', 'opened', 'not_permitted'].includes(p.state) || (p.state === 'done' && !p.count))
                      .map((p) => (
                        <span key={p.id} className={`pc-run-note ${p.state === 'failed' ? 'bad' : p.state === 'not_permitted' ? '' : 'soft'}`} title={p.message}>
                          {LABEL[p.id] && <PlatformIcon id={p.id} size={12} />} {p.state === 'done' ? `${LABEL[p.id]}: ${p.message}` : p.message}
                        </span>
                      ))}
                  </>
                );
              })()}
            </div>
          </div>
        )}
        {browserFinds.length > 0 && (
          <div className="pc-browser" aria-live="polite">
            <span className="pc-browser-title">
              <Icon name="external" size={13} /> Opened in Chrome
            </span>
            {browserFinds.map((b) => (
              <span key={b.url} className="pc-browser-item" title={b.url}>
                <PlatformIcon id={b.platform} size={12} /> {hostOf(b.url)}
                <span className="muted"> · {b.state === 'queued' ? 'waiting' : 'checking'}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="panel pc-library">
        <div className="pc-toolbar">
          <div className="segmented pc-filter" role="tablist" aria-label="Email">
            {[
              ['all', 'All leads'],
              ['found', 'Email found'],
              ['none', 'No email'],
              ['pending', 'Pending'],
            ].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={filter.status === k} className={filter.status === k ? 'on' : ''} onClick={() => set({ status: k })}>
                {label} <span className="pc-count">{counts[k]}</span>
              </button>
            ))}
          </div>
          <span className="spacer" />
          <label className="pc-filter-text">
            <Icon name="search" size={14} />
            <input aria-label="Filter podcasts" placeholder="Filter" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="segmented pc-view" role="tablist" aria-label="View">
            {[
              ['cards', 'Cards'],
              ['table', 'Table'],
            ].map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={view === k}
                className={view === k ? 'on' : ''}
                onClick={() => {
                  setView(k);
                  set({});
                  try {
                    localStorage.setItem('lf-podcast-view', k);
                  } catch {}
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="pc-subbar">
          <label className="pc-select">
            <span>Search</span>
            <select
              aria-label="Search"
              value={filter.searchId ?? ''}
              onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                set({ searchId: id, sort: id ? 'rank:asc' : filter.sort === 'rank:asc' ? 'found:desc' : filter.sort });
              }}
            >
              <option value="">All searches</option>
              {searches.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.keyword.length > 40 ? `${x.keyword.slice(0, 40)}…` : x.keyword} · {when(x.startedAt)} ({x.found})
                </option>
              ))}
            </select>
          </label>
          <label className="pc-select">
            <span>Platform</span>
            <select aria-label="Platform" value={filter.platform} onChange={(e) => set({ platform: e.target.value })}>
              <option value="">All</option>
              {[...PLATFORMS, { id: 'website', label: 'Website' }].map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="pc-select">
            <span>Sort</span>
            <select aria-label="Sort" value={filter.sort} onChange={(e) => set({ sort: e.target.value })}>
              {SORT_OPTIONS.filter(([v]) => v !== 'rank:asc' || filter.searchId).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          {retryIds.length > 0 && selected.size === 0 && (
            <button type="button" className="btn btn-sm btn-ghost" disabled={running} onClick={() => retry(retryIds)} title="Look again for the emails of the podcasts shown without one">
              <Icon name="refresh" size={13} /> Retry {retryIds.length} without email
            </button>
          )}
          {selected.size === 0 && counts.all > 0 && (
            <>
              <button type="button" className="btn btn-sm btn-ghost" disabled={Boolean(working)} onClick={() => act('export', { all: true })} title="Export every podcast lead to a CSV file">
                <Icon name="download" size={13} /> Export all
              </button>
              <button type="button" className="btn btn-sm btn-ghost btn-danger-text" disabled={Boolean(working) || running} onClick={() => act('delete', { all: true })} title="Delete every podcast lead (you are asked first)">
                <Icon name="trash" size={13} /> Delete all
              </button>
            </>
          )}
        </div>
        {selected.size > 0 && (
          <div className="pc-selbar" role="region" aria-label="Selection">
            <span className="pc-selcount">
              <b>{selected.size.toLocaleString()}</b> selected
              {(() => {
                const hidden = [...selected].filter((id) => !pageIds.includes(id)).length;
                return hidden ? <span className="muted"> ({hidden.toLocaleString()} not on this page)</span> : null;
              })()}
            </span>
            {data && selected.size < data.total && (
              <button type="button" className="pc-inline" onClick={selectAllMatching}>
                Select all {data.total.toLocaleString()} matching
              </button>
            )}
            <button type="button" className="pc-inline" onClick={() => setSelected(new Set())}>
              Clear
            </button>
            <span className="spacer" />
            <button type="button" className="btn btn-sm" disabled={Boolean(working)} onClick={() => act('export', { ids: [...selected] })}>
              <Icon name="download" size={13} /> Export selected
            </button>
            <button type="button" className="btn btn-sm btn-danger" disabled={Boolean(working) || running} onClick={() => act('delete', { ids: [...selected] })}>
              <Icon name="trash" size={13} /> Delete selected
            </button>
          </div>
        )}
        <div className="pc-library-body">
          {loadError ? (
            <div className="empty">
              <span className="empty-icon">
                <Icon name="alert" size={22} />
              </span>
              <h3>Podcast leads could not be loaded</h3>
              <p>{loadError}</p>
              <button type="button" className="btn btn-sm" onClick={load}>
                Try again
              </button>
            </div>
          ) : !data ? (
            <div className="pc-cards" aria-busy="true">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="pc-card pc-skeleton" />
              ))}
            </div>
          ) : data.rows.length === 0 ? (
            <div className="empty">
              <span className="empty-icon">
                <Icon name="mic" size={22} />
              </span>
              {running ? (
                <>
                  <h3>Searching…</h3>
                  <p>Podcasts appear here as they are found and saved.</p>
                </>
              ) : counts.all ? (
                <>
                  <h3>Nothing here</h3>
                  <p>No podcast lead matches these filters.</p>
                </>
              ) : filter.searchId || filter.platform || filter.search ? (
                <>
                  <h3>No podcasts {scopeSearch ? `for “${scopeSearch.keyword}”` : 'match'}</h3>
                  <p>{platformMessage(platformState) || 'Try another search or platform.'}</p>
                </>
              ) : (
                <>
                  <h3>Find podcasts to reach out to</h3>
                  <p>Search a topic like “small business marketing”, or paste a podcast’s website or its link from Apple Podcasts, YouTube or Amazon Music.</p>
                </>
              )}
            </div>
          ) : view === 'cards' ? (
            <>
            <label className="pc-pagecheck">
              <input type="checkbox" aria-label="Select all podcast leads on this page" checked={pageAllSelected} onChange={togglePage} /> Select this page
            </label>
            <div className="pc-cards">
              {data.rows.map((l) => (
                <LeadCard key={l.id} lead={l} live={live[l.id]} onRetry={retry} busy={running} selected={selected.has(l.id)} onSelect={toggleSelect} />
              ))}
            </div>
            </>
          ) : (
            <div className="table-wrap">
              <table className="pc-table">
                <thead>
                  <tr>
                    <th className="check">
                      <input type="checkbox" aria-label="Select all podcast leads on this page" checked={pageAllSelected} onChange={togglePage} />
                    </th>
                    <th className="pc-c-show">Podcast</th>
                    <th className="pc-c-host">Publisher</th>
                    <th className="pc-c-platforms">Platforms</th>
                    <th className="pc-c-kw">Keyword</th>
                    <th className="pc-c-email">Email</th>
                    <th className="pc-c-site">Website</th>
                    <th className="pc-c-status">Status</th>
                    <th className="pc-c-act">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((l) => (
                    <LeadRow key={l.id} lead={l} live={live[l.id]} onRetry={retry} busy={running} selected={selected.has(l.id)} onSelect={toggleSelect} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {data && data.total > 0 && (
          <div className="pc-pager">
            <span className="muted">
              {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total.toLocaleString()}
            </span>
            <span className="spacer" />
            <button type="button" className="btn btn-sm btn-ghost" disabled={data.page <= 1} onClick={() => setFilter((f) => ({ ...f, page: f.page - 1 }))} aria-label="Previous page">
              ‹ Previous
            </button>
            <span className="pc-page">
              Page {data.page} of {pages}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" disabled={data.page >= pages} onClick={() => setFilter((f) => ({ ...f, page: f.page + 1 }))} aria-label="Next page">
              Next ›
            </button>
          </div>
        )}
      </div>
      {keysOpen && settings && <KeysDialog settings={settings} focus={keysOpen} notify={notify} onClose={() => setKeysOpen(null)} onSaved={setSettings} />}
    </section>
  );
}

// Why a search has no podcasts, from what its platforms said.
function platformMessage(ps) {
  return Object.values(ps)
    .filter((p) => p.message && p.state !== 'searching')
    .map((p) => (LABEL[p.id] ? `${LABEL[p.id]}: ${p.message}` : p.message))
    .join(' ');
}
