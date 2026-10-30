import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';
import Ambient from './Ambient.jsx';
import AgentCard from './AgentCard.jsx';
import Celebration from './Celebration.jsx';
import CategoryManager from './CategoryManager.jsx';
import WhatsAppPanel from './WhatsAppPanel.jsx';
import OutreachView from './OutreachView.jsx';
import PodcastsView from './PodcastsView.jsx';
import DialerView, { useLeadCall } from './DialerView.jsx';
import NumbersView from './NumbersView.jsx';
import MessagesView from './MessagesView.jsx';
import Composer from './Composer.jsx';
import { currentTheme, setTheme } from './theme.js';
import Activation, { planNeeded, planPill, statusLine } from './Activation.jsx';
import { ChangePin } from './LockScreen.jsx';

const ROWS_PER_PAGE = 500;

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
// Matched by id: a Facebook lead later found on Google Maps keeps its id but
// gets the listing's key.
function upsertMany(list, batch) {
  const byKey = new Map(batch.map((l) => [l.id, l]));
  const next = list.map((l) => {
    const u = byKey.get(l.id);
    if (!u) return l;
    byKey.delete(l.id);
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

// A person's email status (contact discovery): verified by the mail server,
// unverified (published, not confirmed), or invalid.
const EMAIL_BADGE = { verified: ['Verified', 'chip-ok', 'The mail server confirmed this mailbox.'], unverified: ['Unverified', 'chip-warn', 'Published for this person, but the mail server could not confirm it.'], invalid: ['Invalid', 'chip-danger', 'The mail server says this mailbox does not exist.'] };
function EmailBadge({ status }) {
  const b = EMAIL_BADGE[status];
  return b ? (
    <span className={`chip ${b[1]}`} title={b[2]}>
      {b[0]}
    </span>
  ) : null;
}

function personEmailTitle(l) {
  const lines = (l.emails || []).map((e) => `${e.email}: ${e.status}${e.kind === 'company' ? ' (company address)' : ''}${e.from ? ` [${e.from}]` : ''}`);
  const phones = (l.phones || []).map((p) => `${p.phone}: ${p.kind === 'direct' ? 'direct' : 'company'}${p.from ? ` [${p.from}]` : ''}`);
  return [...lines, ...phones].join('\n') || 'Email';
}

// One table row; memoised so live updates only render rows that changed.
// Call status (the Dialer), kept apart from the WhatsApp campaign status.
// Clicking it marks the lead Do not call, or allows calls again.
function CallStatus({ lead: l, notify }) {
  const label = { seen: 'Call Seen', unseen: 'Call Unseen', dnc: 'Do not call' }[l.callStatus || 'unseen'];
  const title =
    l.callStatus === 'seen'
      ? `Called ${l.callSeenAt ? new Date(l.callSeenAt).toLocaleString() : ''}. The Auto Dialer will not call it again.`
      : l.callStatus === 'dnc'
        ? 'Marked do not call: it is never called automatically. Click to allow calls again.'
        : l.phone
          ? 'Not called yet. Click to mark it do not call.'
          : 'No phone number';
  const toggle = async () => {
    if (l.callStatus === 'seen' || !l.phone) return;
    const on = l.callStatus !== 'dnc';
    if (on && !window.confirm(`Never call ${l.name} automatically?`)) return;
    const r = await api.setDoNotCall(l.id, on);
    if (!r?.ok) notify({ type: 'error', text: r?.error || 'Could not change the call status.' });
  };
  return (
    <button type="button" className={`chip call-${l.callStatus || 'unseen'}`} title={title} aria-label={`${label}: ${l.name}`} onClick={toggle} disabled={l.callStatus === 'seen' || !l.phone}>
      {label}
    </button>
  );
}

const LeadRow = memo(function LeadRow({ lead: l, fresh, selected, pastView, onToggle, onDelete, onWhatsApp, onCompose, onCall, onText, waOpen, notify }) {
  return (
    <tr className={`${fresh ? 'fresh' : ''} ${selected ? 'selected' : ''}`}>
      <td className="check">
        <input type="checkbox" aria-label={`Select ${l.name}`} checked={selected} onChange={() => onToggle(l.id)} />
      </td>
      <td className="name" dir="auto">
        {l.name}
        {l.kind === 'person' && (l.personTitle || l.companyName) && (
          <span className="name-extra person-role" title={l.description || undefined}>
            {[l.personTitle, l.companyName].filter(Boolean).join(' · ')}
          </span>
        )}
        {(l.email || l.jobTitle || l.podcastHost) && (
          <span className="name-extra">
            {l.email && (
              <a
                href={`mailto:${l.email}`}
                title={l.kind === 'person' ? personEmailTitle(l) : 'Business email'}
                onClick={(e) => {
                  e.preventDefault(); // the window never navigates: the mail app opens
                  api.openPodcastLink(`mailto:${l.email}`);
                }}
              >
                {l.email}
              </a>
            )}
            {l.kind === 'person' && l.email && <EmailBadge status={l.emailStatus} />}
            {l.jobTitle && <span title="LinkedIn job">{l.jobTitle}</span>}
            {l.podcastHost && <span title="Podcast host">{l.podcastHost}</span>}
          </span>
        )}
      </td>
      <td className="phone-cell">
        <PhoneCell lead={l} waOpen={waOpen} onCompose={onCompose} onChanged={onWhatsApp} notify={notify} />
      </td>
      <td className="address" dir="auto" title={l.address}>
        {l.address ? <span className="address-text">{l.address}</span> : <span className="muted">Not listed</span>}
      </td>
      <td>{websiteChip(l)}</td>
      <td>{l.category ? <span className="cat">{l.category}</span> : <span className="muted">Uncategorized</span>}</td>
      <td className="sources">
        {(l.sources || ['maps']).includes('maps') && <span className="chip src-maps">Maps</span>}
        {(l.sources || []).includes('facebook') && (
          <button
            type="button"
            className="chip src-facebook"
            title={`Found in a Facebook post${l.contactName ? ` by ${l.contactName}` : ''}${l.description ? `:\n${l.description.slice(0, 300)}` : ''}`}
            aria-label={`Open the Facebook post for ${l.name}`}
            onClick={() => api.openListing(l.fbPostUrl)}
          >
            Facebook
          </button>
        )}
        {(l.sources || []).includes('linkedin') && (
          <button
            type="button"
            className="chip src-linkedin"
            title={`Found on LinkedIn${l.kind === 'person' ? ' (People search)' : ''}${l.jobTitle ? `: ${l.jobTitle}` : ''}${l.discovery ? `\n${l.discovery}` : ''}`}
            aria-label={`Open ${l.name} on LinkedIn`}
            onClick={() => api.openListing(l.profileUrl || l.jobUrl || l.linkedinUrl || l.linkedinPostUrl)}
          >
            LinkedIn
          </button>
        )}
        {(l.contactProviders || []).includes('contactout') && (
          <span className="chip src-contactout" title="Contact details read from the ContactOut extension">
            ContactOut
          </span>
        )}
        {(l.sources || []).includes('podcast') && (
          <button
            type="button"
            className="chip src-podcast"
            title={`Podcast${l.podcastHost ? ` by ${l.podcastHost}` : ''}${l.rssUrl ? `\nRSS: ${l.rssUrl}` : ''}${l.discovery ? `\n${l.discovery}` : ''}`}
            aria-label={`Open ${l.name} on Apple Podcasts`}
            onClick={() => api.openListing(l.podcastUrl)}
          >
            Podcast
          </button>
        )}
      </td>
      <td>
        {l.campaign === 'seen' ? (
          <span className={`chip camp-seen camp-${l.campaignDelivery}`} title={`Campaign message ${l.campaignDelivery === 'read' ? 'read' : l.campaignDelivery === 'delivered' ? 'delivered' : 'sent'}`}>
            Seen
          </span>
        ) : (
          <span className="chip camp-unseen" title="No campaign message sent yet">
            Unseen
          </span>
        )}
      </td>
      <td>
        <CallStatus lead={l} notify={notify} />
      </td>
      <td>{l.smsStatus === 'seen' ? <span className="chip sms-seen" title="An SMS was sent to this lead">SMS sent</span> : <span className="chip call-unseen" title="No SMS sent yet">No SMS</span>}</td>
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
        {l.phone && (
          <button type="button" className="icon-btn call" aria-label={`Call ${l.name}`} title={`Call ${l.phone} from your phone`} onClick={() => onCall(l)}>
            <Icon name="phone" />
          </button>
        )}
        {l.phone && (
          <button type="button" className="icon-btn" aria-label={`Text ${l.name}`} title={`Send an SMS to ${l.phone} from your phone`} onClick={() => onText(l)}>
            <Icon name="chat" />
          </button>
        )}
        {l.source === 'linkedin' ? (
          <button type="button" className="icon-btn" aria-label={`Open ${l.name} on LinkedIn`} title="Open on LinkedIn" onClick={() => api.openListing(l.profileUrl || l.linkedinUrl || l.jobUrl || l.linkedinPostUrl)}>
            <Icon name="external" />
          </button>
        ) : l.source === 'facebook' ? (
          <button type="button" className="icon-btn" aria-label={`Open ${l.name} on Facebook`} title="Open the Facebook post" onClick={() => api.openListing(l.fbPostUrl)}>
            <Icon name="external" />
          </button>
        ) : (
          <button type="button" className="icon-btn" aria-label={`Open ${l.name} on Google Maps`} title="Open listing on Google Maps" onClick={() => api.openListing(l.mapsUrl)}>
            <Icon name="external" />
          </button>
        )}
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
  if (l.websiteKind === 'unknown') {
    return (
      <span className="chip" title={l.websiteStatus}>
        Not checked
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

// Progress of each lead source while they search side by side.
const WORKER_TEXT = { running: 'Running', paused: 'Paused', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };

function WorkerRows({ workers }) {
  return (
    <ul className="workers" aria-label="Search progress by source">
      {[
        ['maps', 'Google Maps'],
        ['facebook', 'Facebook'],
        ['linkedin', 'LinkedIn'],
      ].map(([key, label]) => {
        const w = workers[key];
        if (!w) return null;
        return (
          <li key={key} className={`worker w-${w.state}`} aria-label={`${label}: ${WORKER_TEXT[w.state] || w.state}`}>
            <span className="worker-name">{label}</span>
            <span className="worker-state">{WORKER_TEXT[w.state] || w.state}</span>
            <span className="worker-msg">{w.message}</span>
            <span className="worker-count">
              {w.leads ?? 0} lead{w.leads === 1 ? '' : 's'} · {w.processed ?? 0} checked
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// The table is empty: say why. "No leads found" only when the filters
// really match nothing; during a search, that it is searching (and where its
// leads go when the filters or the Past view hide them).
function EmptyLeads({ view, active, filtered, onShowAll, onShowToday }) {
  let title;
  let text;
  let action = null;
  if (active && view === 'today' && !filtered) {
    title = 'Searching for leads…';
    text = 'New leads appear here as Google Maps, Facebook and LinkedIn find them.';
  } else if (active && view !== 'today') {
    title = 'Searching for leads…';
    text = 'Leads from the running search are listed under Today.';
    action = { label: 'Show Today', onClick: onShowToday };
  } else if (filtered) {
    title = 'No leads found';
    text = active ? 'Searching. No lead found so far matches the current filters; new leads that match appear here.' : 'No leads match the current filters.';
    action = { label: 'Show all leads', onClick: onShowAll };
  } else if (view === 'today') {
    title = 'No leads yet today';
    text = 'Enter a keyword and category, then start a search. Qualified businesses appear here as Chrome finds them.';
  } else {
    title = 'Nothing here';
    text = 'No past leads match these filters. Try another date or category.';
  }
  return (
    <div className="empty" role="status">
      <span className="empty-icon">
        <Icon name={active ? 'search' : view === 'today' ? 'inbox' : 'calendar'} size={22} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action && (
        <button type="button" className="btn btn-sm" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
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
  const [waView, setWaView] = useState('all'); // all | available | unavailable (WhatsApp's own check)
  const [campaignView, setCampaignView] = useState('all'); // all | seen | unseen
  const [callView, setCallView] = useState('all'); // all | seen | unseen | dnc (the Dialer)
  const [sourceView, setSourceView] = useState('all'); // all | maps | facebook | linkedin | podcast
  const [mapsOn, setMapsOn] = useState(true); // Google Maps search (stored in the app)
  const [facebookOn, setFacebookOn] = useState(false); // Facebook Lead Search (stored in the app)
  const [liKeyword, setLiKeyword] = useState(() => {
    try {
      return localStorage.getItem('lf-linkedin-keyword') || '';
    } catch {
      return '';
    }
  }); // LinkedIn's own search
  const [linkedinOn, setLinkedinOn] = useState(false); // LinkedIn Lead Search (stored in the app)
  const [country, setCountry] = useState(null); // { setting, effective, countries }: how local numbers are read
  const [liSettings, setLiSettings] = useState({ modes: { people: true, jobs: false, posts: false, companies: false }, contact: { verify: true, verifierUrl: '', provider: 'builtin', reveal: true, installedIn: [] }, datasets: [] }); // LinkedIn modes, contact discovery
  const [liLocation, setLiLocation] = useState(() => {
    try {
      return localStorage.getItem('lf-linkedin-location') || '';
    } catch {
      return '';
    }
  }); // where LinkedIn People search looks
  const [contactOpen, setContactOpen] = useState(null); // contact data panel: null | { top, left }
  const [tableSearch, setTableSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState(''); // debounced
  const [plan, setPlan] = useState(null); // this computer's subscription (activation.js)
  const [plansOpen, setPlansOpen] = useState(null); // null | { notice }
  const [changePin, setChangePin] = useState(false);
  // Leads | Chats | Outreach. Views stay mounted once opened, so switching
  // keeps each one's place (scroll, open chat, unsaved templates).
  const [workspace, setWorkspaceState] = useState(() => {
    try {
      return ['leads', 'podcasts', 'outreach', 'dialer', 'numbers', 'messages'].includes(localStorage.getItem('workspace')) ? localStorage.getItem('workspace') : 'leads';
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

  // A lead's Call button: the Dialer opens with the lead and calls it.
  const [dialFill, setDialFill] = useState(null);
  const openDialer = useCallback((fill) => {
    setDialFill(fill);
    setWorkspaceState('dialer');
    setVisited((v) => (v.has('dialer') ? v : new Set([...v, 'dialer'])));
    try {
      localStorage.setItem('workspace', 'dialer');
    } catch {}
  }, []);
  const callLead = useLeadCall({ onOpenDialer: openDialer, notify });
  // SMS: the Messages workspace opens with the conversation.
  const [smsFill, setSmsFill] = useState(null);
  const openMessages = useCallback((fill) => {
    setSmsFill({ ...fill, nonce: Date.now() });
    setWorkspaceState('messages');
    setVisited((v) => (v.has('messages') ? v : new Set([...v, 'messages'])));
    try {
      localStorage.setItem('workspace', 'messages');
    } catch {}
  }, []);
  const textLead = useCallback((l) => openMessages({ phone: l.phone, leadId: l.id, name: l.kind === 'person' ? l.name : l.contactName || l.name }), [openMessages]);
  // Call from a conversation: a lead, an imported number or just a number.
  const callContact = useCallback((c) => callLead(c.numberId ? { numberEntry: true, id: c.numberId, phone: c.phone, name: c.name } : { id: c.leadId || null, phone: c.phone, name: c.name }), [callLead]);

  const filter = useMemo(() => {
    const f = { category: catFilter };
    if (siteView !== 'all') f.website = siteView;
    if (waView !== 'all') f.whatsapp = waView;
    if (campaignView !== 'all') f.campaign = campaignView;
    if (callView !== 'all') f.call = callView;
    if (sourceView !== 'all') f.source = sourceView;
    if (searchQuery) f.search = searchQuery;
    if (view === 'today') f.date = today;
    else if (pastMode === 'date' && pastDate) f.date = pastDate;
    else if (pastMode === 'range') {
      if (range.from) f.from = range.from;
      if (range.to) f.to = range.to;
    } else f.before = today;
    return f;
  }, [view, today, pastMode, pastDate, range, catFilter, siteView, waView, campaignView, callView, sourceView, searchQuery]);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const viewKey = JSON.stringify(filter);
  // Long lists are drawn in pages so thousands of rows don't stall the window.
  const [shown, setShown] = useState(ROWS_PER_PAGE);
  useEffect(() => setShown(ROWS_PER_PAGE), [viewKey]);

  const loadCategories = useCallback(() => api.listCategories().then(setCatData).catch(() => {}), []);

  // Live leads (found by a search, or changed by a WhatsApp check): the
  // database says which of them match the current filter, with the same
  // rules as a full load, and those rows are added or updated in place;
  // rows that no longer match leave. Arrivals are batched with a timer (a
  // window behind Chrome gets no animation frames, but timers still run).
  const live = useRef({ pending: new Set(), duringLoad: null, timer: 0 });
  const applyLive = useCallback(async (ids) => {
    const f = filterRef.current;
    const rows = await api.matchLeads(f, ids).catch(() => null);
    if (!rows || filterRef.current !== f) return; // a full load for the new filter covers them
    const matched = new Set(rows.map((r) => r.id));
    const asked = new Set(ids);
    // Rows come newest first; upsertMany puts the last new row on top.
    setLeads((list) => upsertMany(list.filter((l) => !asked.has(l.id) || matched.has(l.id)), [...rows].reverse()));
  }, []);
  const queueLive = useCallback(
    (ids) => {
      const l = live.current;
      for (const id of ids) {
        l.pending.add(id);
        l.duringLoad?.add(id);
      }
      if (!l.timer) {
        l.timer = setTimeout(() => {
          l.timer = 0;
          const batch = [...l.pending];
          l.pending.clear();
          if (batch.length) applyLive(batch);
        }, 150);
      }
    },
    [applyLive],
  );

  const loadLeads = useCallback(() => {
    const f = filterRef.current;
    const slow = setTimeout(() => setLoading(true), 120);
    // Leads that arrive while this load is on its way are applied again
    // after it, so its (older) result never hides them.
    const arrived = new Set();
    live.current.duringLoad = arrived;
    return api
      .listLeads(f)
      .then((rows) => {
        if (filterRef.current !== f) return;
        setLeads(rows);
        setSelected((sel) => new Set([...sel].filter((id) => rows.some((r) => r.id === id))));
        if (arrived.size) queueLive([...arrived]);
      })
      .catch((e) => notify({ type: 'error', text: `Could not load leads: ${e.message}` }))
      .finally(() => {
        if (live.current.duringLoad === arrived) live.current.duringLoad = null;
        clearTimeout(slow);
        setLoading(false);
      });
  }, [notify, queueLive]);

  useEffect(() => {
    loadLeads();
  }, [filter, loadLeads]);

  useEffect(() => {
    if (view !== 'past') return;
    api.listDates({ category: catFilter, before: today }).then(setDates).catch(() => {});
  }, [view, catFilter, today, leads]);

  // Search waits for a short pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(tableSearch.trim()), 250);
    return () => clearTimeout(t);
  }, [tableSearch]);

  // A lead becomes Seen when a campaign message to it is sent.
  useEffect(() => {
    let t = 0;
    const off = api.onOutreachEvent((e) => {
      if (e.type !== 'sent' || e.test) return;
      clearTimeout(t);
      t = setTimeout(() => loadLeads(), 400);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [loadLeads]);

  useEffect(() => {
    loadCategories();
    api.getStatus().then(setStatus).catch(() => {});
    api.getInterrupted().then(setInterrupted).catch(() => {});
    api.mapsSearch().then((r) => setMapsOn(r?.on !== false)).catch(() => {});
    api.facebookSearch().then((r) => setFacebookOn(Boolean(r?.on))).catch(() => {});
    api.linkedinSearch().then((r) => setLinkedinOn(Boolean(r?.on))).catch(() => {});
    api.phoneCountry().then(setCountry).catch(() => {});
    api.linkedinSettings().then((r) => r && setLiSettings(r)).catch(() => {});
    const offStatus = api.onStatus(setStatus);
    const offSummary = api.onSummary(setSummary);
    api.whatsappState().then(setWa).catch(() => {});
    api.activationStatus().then(setPlan).catch(() => {});
    const offPlan = api.onActivation(setPlan);
    const onPlanNeeded = (e) => setPlansOpen({ notice: e.detail });
    window.addEventListener('lead-finder:plan-needed', onPlanNeeded);
    const offWa = api.onWhatsAppState(setWa);
    // Background WhatsApp checks: the leads with that number are applied
    // like new ones (with "WhatsApp only", a confirmed number now shows).
    const offWaLeads = api.onWhatsAppLeads(({ leads: updated }) => queueLive(updated.map((u) => u.id)));
    // A lead became Call Seen (a call to it started) or Do not call.
    const offCallLeads = api.onCallLeads(({ ids }) => queueLive(ids));
    // Leads found by Google Maps and Facebook (both may be searching at
    // once); category counts are refreshed at most twice a second.
    let catTimer = 0;
    const offLead = api.onLead((lead) => {
      freshIds.current.add(lead.id);
      queueLive([lead.id]);
      if (!catTimer) catTimer = setTimeout(() => ((catTimer = 0), loadCategories()), 500);
    });
    // The computer's date can change while the app is open.
    const timer = setInterval(() => setToday(localDate()), 30_000);
    return () => {
      offStatus();
      offSummary();
      offWa();
      offPlan();
      window.removeEventListener('lead-finder:plan-needed', onPlanNeeded);
      offWaLeads();
      offCallLeads();
      offLead();
      clearInterval(timer);
      clearTimeout(catTimer);
      clearTimeout(live.current.timer);
      live.current.timer = 0;
    };
  }, [loadCategories, queueLive]);

  useEffect(() => {
    if (!ACTIVE.has(status.state)) loadCategories();
  }, [status.state, loadCategories]);

  const active = ACTIVE.has(status.state);
  // Each source on its own: Google Maps and Facebook use the keyword and
  // category, LinkedIn its own search; at least one source must be on.
  const mainSearch = mapsOn || facebookOn;
  const anySource = mainSearch || linkedinOn;
  const canStart =
    !active &&
    anySource &&
    (!mainSearch || (keyword.trim().length >= 2 && formatCategory(category).length >= 2)) &&
    (!linkedinOn || liKeyword.trim().length >= 2);

  async function toggleMaps() {
    const next = !mapsOn;
    setMapsOn(next);
    const res = await api.setMapsSearch(next).catch((e) => ({ ok: false, error: e.message }));
    if (!res.ok) {
      setMapsOn(!next);
      notify({ type: 'error', text: `Could not change Google Maps search: ${res.error}` });
    }
  }

  async function toggleFacebook() {
    const next = !facebookOn;
    setFacebookOn(next);
    const res = await api.setFacebookSearch(next).catch((e) => ({ ok: false, error: e.message }));
    if (!res.ok) {
      setFacebookOn(!next);
      notify({ type: 'error', text: `Could not change Facebook Lead Search: ${res.error}` });
    }
  }

  async function toggleLinkedin() {
    const next = !linkedinOn;
    setLinkedinOn(next);
    const res = await api.setLinkedInSearch(next).catch((e) => ({ ok: false, error: e.message }));
    if (!res.ok) {
      setLinkedinOn(!next);
      notify({ type: 'error', text: `Could not change LinkedIn Lead Search: ${res.error}` });
    }
  }

  async function changeLinkedIn(next) {
    const res = await api.setLinkedInSettings(next).catch((e) => ({ ok: false, error: e.message }));
    if (res.ok) setLiSettings({ modes: res.modes, contact: res.contact, datasets: res.datasets || [] });
    else notify({ type: 'error', text: res.error });
  }

  async function importContacts() {
    const res = await api.importContacts().catch((e) => ({ ok: false, error: e.message }));
    if (res.canceled) return;
    if (!res.ok) return notify({ type: 'error', text: res.error });
    setLiSettings({ modes: res.modes, contact: res.contact, datasets: res.datasets || [] });
    notify({ type: 'ok', text: `Imported ${res.imported} contact${res.imported === 1 ? '' : 's'} from "${res.dataset}"${res.skipped ? ` (${res.skipped} rows without a name or email skipped)` : ''}.` });
  }

  async function deleteDataset(name) {
    const res = await api.deleteContactDataset(name).catch((e) => ({ ok: false, error: e.message }));
    if (res.ok) setLiSettings({ modes: res.modes, contact: res.contact, datasets: res.datasets || [] });
    else notify({ type: 'error', text: res.error });
  }

  async function changeCountry(code) {
    const res = await api.setPhoneCountry(code || null).catch((e) => ({ ok: false, error: e.message }));
    if (res.ok) setCountry(res);
    else notify({ type: 'error', text: `Could not change the phone country: ${res.error}` });
  }

  async function runSearch(kw, cat, li = liKeyword, loc = liLocation) {
    try {
      localStorage.setItem('lf-linkedin-keyword', li);
      localStorage.setItem('lf-linkedin-location', loc);
    } catch {}
    const res = await api.startSearch(kw, cat, websiteFilter, li, liSettings.modes.people ? loc : '');
    if (!res.ok) {
      // No active plan: show the Activate panel with the reason.
      if (!planNeeded(res)) notify({ type: 'error', text: res.error });
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
    if (interrupted.linkedinKeyword) setLiKeyword(interrupted.linkedinKeyword);
    if (interrupted.linkedinLocation) setLiLocation(interrupted.linkedinLocation);
    await runSearch(interrupted.keyword, interrupted.category, interrupted.linkedinKeyword || liKeyword, interrupted.linkedinLocation ?? liLocation);
  }

  async function exportCsv(scope) {
    try {
      const res = await api.exportCsv(scope, filter);
      if (planNeeded(res)) return;
      if (res.ok) notify({ type: 'ok', text: `Exported ${res.count} leads to ${res.filePath}` });
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

  // Filters that can hide leads (besides the date view).
  const narrowed = catFilter !== 'all' || siteView !== 'all' || waView !== 'all' || campaignView !== 'all' || callView !== 'all' || sourceView !== 'all' || Boolean(searchQuery);
  const showAll = () => {
    setCatFilter('all');
    setSiteView('all');
    setWaView('all');
    setCampaignView('all');
    setCallView('all');
    setSourceView('all');
    setTableSearch('');
    setSearchQuery('');
  };

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
            ['podcasts', 'Podcasts', 'mic'],
            ['outreach', 'Outreach', 'send'],
            ['dialer', 'Dialer', 'phone'],
            ['numbers', 'Numbers', 'users'],
            ['messages', 'Messages', 'chat'],
          ].map(([id, label, icon]) => (
            <button key={id} type="button" className={workspace === id ? 'on' : ''} aria-pressed={workspace === id} aria-label={label} title={label} onClick={() => setWorkspace(id)}>
              <Icon name={icon} size={14} /> <span className="ws-label">{label}</span>
            </button>
          ))}
        </nav>
        <div className={`conn ${status.profile && status.phase !== 'connection' ? 'on' : ''}`} title="Chrome profile used for searching">
          <span className="conn-dot" />
          {status.profile ? <span>Chrome · {status.profile}</span> : <span>Chrome not connected</span>}
        </div>
        {(() => {
          const pill = planPill(plan);
          return (
            <button type="button" className={`plan-pill tone-${pill.tone}`} title={statusLine(plan)} onClick={() => setPlansOpen({ notice: null })}>
              <Icon name="crown" size={14} />
              <span>{pill.text}</span>
            </button>
          );
        })()}
        <WhatsAppPanel wa={wa} />
        <ThemeToggle />
        <LockMenu onLock={onLock} onChangePin={() => setChangePin(true)} />
      </header>

      {visited.has('podcasts') && <PodcastsView notify={notify} hidden={workspace !== 'podcasts'} categories={catData.categories} />}
      {visited.has('outreach') && <OutreachView wa={wa} notify={notify} hidden={workspace !== 'outreach'} />}
      {visited.has('dialer') && <DialerView notify={notify} hidden={workspace !== 'dialer'} prefill={dialFill} />}
      {visited.has('numbers') && <NumbersView notify={notify} hidden={workspace !== 'numbers'} onCall={callLead} onMessage={openMessages} />}
      {visited.has('messages') && <MessagesView notify={notify} hidden={workspace !== 'messages'} prefill={smsFill} onCall={callContact} />}
      <main className="content" hidden={workspace !== 'leads'}>
        <section className="panel search-panel">
          <form className="search" onSubmit={start}>
            {mainSearch && (
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
            )}
            {linkedinOn && (
              <div className="field grow">
                <label htmlFor="li-kw">LinkedIn search</label>
                <div className="input-wrap">
                  <span className="field-icon">
                    <Icon name="search" />
                  </span>
                  <input
                    id="li-kw"
                    value={liKeyword}
                    onChange={(e) => setLiKeyword(e.target.value)}
                    placeholder={liSettings.modes.people ? 'e.g. SEO' : 'e.g. Full Stack Developer'}
                    maxLength={120}
                    disabled={active}
                    title={liSettings.modes.people ? 'People on LinkedIn matching this (title, skills, headline)' : 'Jobs, posts and companies on LinkedIn: the companies that need this'}
                  />
                </div>
              </div>
            )}
            {linkedinOn && liSettings.modes.people && (
              <div className="field li-loc">
                <label htmlFor="li-loc">Location</label>
                <input
                  id="li-loc"
                  value={liLocation}
                  onChange={(e) => setLiLocation(e.target.value)}
                  placeholder="e.g. USA"
                  maxLength={80}
                  disabled={active}
                  title="Where the people are: a country (USA, UK, Canada, Pakistan…) uses LinkedIn's location filter; a city is checked on each profile. Empty: anywhere."
                />
              </div>
            )}
            <div className="field cat">
              <label htmlFor="cat">{mainSearch ? 'Category' : 'Category (optional)'}</label>
              <CategoryInput value={category} onChange={setCategory} categories={catData.categories} disabled={active} />
            </div>
            {mapsOn && (
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
            )}
            <div className="buttons">
              <button type="submit" className="btn btn-primary" disabled={!canStart}>
                <Icon name="play" /> Start Search
              </button>
              <button type="button" className="btn" onClick={() => api.stopSearch()} disabled={!active || status.state === 'stopping'}>
                <Icon name="stop" /> Stop Search
              </button>
            </div>
          </form>
          {linkedinOn && (
            <div className="li-options" role="group" aria-label="LinkedIn modes">
              <span className="muted">LinkedIn finds</span>
              {[
                ['people', 'People', 'LinkedIn People search: each profile is opened and the person\'s professional email and phone are discovered'],
                ['jobs', 'Jobs', 'Job listings for the LinkedIn search: the companies hiring'],
                ['posts', 'Posts', 'Posts about hiring, projects or outsourcing for the LinkedIn search'],
                ['companies', 'Companies', 'Companies whose own description matches the LinkedIn search'],
              ].map(([k, label, title]) => (
                <label key={k} className="check-wrap" title={title}>
                  <input
                    type="checkbox"
                    checked={liSettings.modes[k]}
                    disabled={active}
                    aria-label={`LinkedIn ${label}`}
                    onChange={(e) => changeLinkedIn({ modes: { ...liSettings.modes, [k]: e.target.checked } })}
                  />
                  <span>{label}</span>
                </label>
              ))}
              {liSettings.modes.people && (
                <>
                  <span className="li-sep" aria-hidden="true" />
                  <label className="select-wrap provider-select" title={liSettings.contact?.installedIn?.length ? `ContactOut is enabled in your Chrome profile${liSettings.contact.installedIn.length === 1 ? '' : 's'} ${liSettings.contact.installedIn.join(', ')}. Lead Finder must be connected to that profile to use it.` : 'ContactOut is not installed in this computer\'s Chrome.'}>
                    <span>Contacts from</span>
                    <select aria-label="Contacts from" value={liSettings.contact?.provider || 'builtin'} disabled={active} onChange={(e) => changeLinkedIn({ contact: { ...liSettings.contact, provider: e.target.value } })}>
                      <option value="contactout">ContactOut extension</option>
                      <option value="builtin">Built-in discovery</option>
                      <option value="both">ContactOut + built-in</option>
                    </select>
                  </label>
                  {liSettings.contact?.provider !== 'builtin' && (
                    <label className="check-wrap" title="Click ContactOut's View email / View phone buttons, as you would: ContactOut shows emails and phones masked until then. This uses your ContactOut credits, exactly as clicking them yourself does. Off: only what ContactOut shows by itself is read.">
                      <input
                        type="checkbox"
                        checked={Boolean(liSettings.contact?.reveal)}
                        disabled={active}
                        aria-label="Reveal with ContactOut credits"
                        onChange={(e) => changeLinkedIn({ contact: { ...liSettings.contact, reveal: e.target.checked } })}
                      />
                      <span>Reveal with credits</span>
                    </label>
                  )}
                  <label className="check-wrap" title="Ask each email's mail server whether the mailbox exists (no message is sent). Addresses built from a name are kept only when confirmed.">
                    <input
                      type="checkbox"
                      checked={liSettings.contact?.verify !== false}
                      disabled={active}
                      aria-label="Verify emails"
                      onChange={(e) => changeLinkedIn({ contact: { ...liSettings.contact, verify: e.target.checked } })}
                    />
                    <span>Verify emails</span>
                  </label>
                  <div className="menu-anchor">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-expanded={Boolean(contactOpen)}
                      aria-haspopup="dialog"
                      onClick={(e) => {
                        // Placed in the window (the search panel clips its content).
                        const r = e.currentTarget.getBoundingClientRect();
                        setContactOpen((v) => (v ? null : { top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 350)) }));
                      }}
                    >
                      Contact data{liSettings.datasets?.length ? ` (${liSettings.datasets.reduce((n, d) => n + d.records, 0)})` : ''}
                    </button>
                    {contactOpen && (
                      <div className="menu contact-menu" role="dialog" aria-label="Contact data" style={{ top: contactOpen.top, left: contactOpen.left }}>
                        <p className="menu-title">Local contact datasets</p>
                        <p className="menu-note">Contact discovery also searches CSV files you import (name, email, phone, company, website, title, LinkedIn columns) and your saved leads.</p>
                        {(liSettings.datasets || []).map((d) => (
                          <div key={d.dataset} className="dataset-row">
                            <span>
                              {d.dataset} <span className="muted">· {d.records} records</span>
                            </span>
                            <button type="button" className="icon-btn danger" aria-label={`Remove dataset ${d.dataset}`} title="Remove dataset" onClick={() => deleteDataset(d.dataset)}>
                              <Icon name="trash" />
                            </button>
                          </div>
                        ))}
                        <button type="button" className="btn btn-sm" onClick={importContacts}>
                          Import contacts CSV…
                        </button>
                        <label className="menu-field">
                          <span>Self-hosted verifier (optional)</span>
                          <input
                            defaultValue={liSettings.contact?.verifierUrl || ''}
                            placeholder="http://localhost:8080"
                            aria-label="Self-hosted verifier address"
                            onBlur={(e) => e.target.value.trim() !== (liSettings.contact?.verifierUrl || '') && changeLinkedIn({ contact: { ...liSettings.contact, verifierUrl: e.target.value.trim() } })}
                          />
                          <span className="menu-note">A Reacher server (open source), for computers that cannot reach mail servers on port 25. Empty: Lead Finder asks the mail servers itself.</span>
                        </label>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="source-row">
            <span className="source-item" title={mapsOn ? 'Google Maps listings for the keyword and category, with the website filter.' : 'Off: Google Maps is not searched.'}>
              <button
                type="button"
                role="switch"
                aria-checked={mapsOn}
                aria-label="Google Maps search"
                className={`switch ${mapsOn ? 'on' : ''}`}
                disabled={active}
                title={active ? 'Takes effect from the next search' : undefined}
                onClick={toggleMaps}
              >
                <span className="switch-knob" />
              </button>
              <span className="source-label">Google Maps</span>
            </span>
            <span className="source-item" title={facebookOn ? 'Public Facebook posts are searched at the same time as Google Maps, with the same keyword and category (in a separate Chrome window, using your Facebook login).' : 'Off: Facebook is not searched.'}>
              <button
                type="button"
                role="switch"
                aria-checked={facebookOn}
                aria-label="Facebook Lead Search"
                className={`switch ${facebookOn ? 'on' : ''}`}
                disabled={active}
                title={active ? 'Takes effect from the next search' : undefined}
                onClick={toggleFacebook}
              >
                <span className="switch-knob" />
              </button>
              <span className="source-label">Facebook</span>
            </span>
            <span
              className="source-item"
              title={
                linkedinOn
                  ? liSettings.modes.people
                    ? 'People matching the LinkedIn search (and location): each profile is opened, and their professional email and phone are discovered from LinkedIn, local datasets, the company website and its mail server (in a separate Chrome window, using your LinkedIn login).'
                    : 'Companies hiring or asking for the keyword (LinkedIn jobs and posts) are found at the same time, with their public business phone, email and website (in a separate Chrome window, using your LinkedIn login).'
                  : 'Off: LinkedIn is not searched.'
              }
            >
              <button
                type="button"
                role="switch"
                aria-checked={linkedinOn}
                aria-label="LinkedIn Lead Search"
                className={`switch ${linkedinOn ? 'on' : ''}`}
                disabled={active}
                title={active ? 'Takes effect from the next search' : undefined}
                onClick={toggleLinkedin}
              >
                <span className="switch-knob" />
              </button>
              <span className="source-label">LinkedIn</span>
            </span>
            {country && (
              <label className="select-wrap country-select" title="Numbers written without a country code (like 0300 1234567) are read as numbers of this country. Numbers that can't be confirmed are kept and marked to check.">
                <span>Local numbers</span>
                <select aria-label="Country for local phone numbers" value={country.setting || ''} disabled={active} onChange={(e) => changeCountry(e.target.value)}>
                  <option value="">Automatic{country.effective ? ` (${country.countries.find((c) => c.code === country.effective)?.name || country.effective})` : ''}</option>
                  {country.countries.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name} (+{c.callingCode})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className={`muted source-hint ${anySource ? '' : 'warn'}`}>
              {!anySource
                ? 'Turn on at least one source.'
                : [mapsOn && 'Google Maps', facebookOn && 'Facebook', linkedinOn && 'LinkedIn'].filter(Boolean).join(' + ') +
                  ([mapsOn, facebookOn, linkedinOn].filter(Boolean).length > 1 ? ', side by side.' : ' only.')}
            </span>
          </div>

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
            {status.workers && <WorkerRows workers={status.workers} />}
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
            <label className="select-wrap">
              <span>Campaign</span>
              <select aria-label="Show campaign status" value={campaignView} onChange={(e) => setCampaignView(e.target.value)}>
                <option value="all">All leads</option>
                <option value="seen">Seen (message sent)</option>
                <option value="unseen">Unseen (not messaged)</option>
              </select>
            </label>
            <label className="select-wrap">
              <span>Call</span>
              <select aria-label="Show call status" value={callView} onChange={(e) => setCallView(e.target.value)}>
                <option value="all">All leads</option>
                <option value="seen">Call Seen (called)</option>
                <option value="unseen">Call Unseen (not called)</option>
                <option value="dnc">Do not call</option>
              </select>
            </label>
            <label className="select-wrap">
              <span>Source</span>
              <select aria-label="Show source" value={sourceView} onChange={(e) => setSourceView(e.target.value)}>
                <option value="all">All sources</option>
                <option value="maps">Google Maps</option>
                <option value="facebook">Facebook</option>
                <option value="linkedin">LinkedIn</option>
                <option value="podcast">Podcasts</option>
              </select>
            </label>
            <label className="table-search">
              <Icon name="search" size={14} />
              <input type="search" value={tableSearch} placeholder="Name, business or phone" aria-label="Search leads" onChange={(e) => setTableSearch(e.target.value)} />
            </label>
            <label className="select-wrap" title="Show and export numbers by WhatsApp's own check: on WhatsApp, or confirmed not on WhatsApp (to call or SMS instead)">
              <span>WhatsApp</span>
              <select aria-label="Show WhatsApp status" value={waView} onChange={(e) => setWaView(e.target.value)}>
                <option value="all">All numbers</option>
                <option value="available">On WhatsApp</option>
                <option value="unavailable">Not on WhatsApp</option>
              </select>
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
                      <th>Source</th>
                      <th>Campaign</th>
                      <th>Call</th>
                      <th>SMS</th>
                      <th>Discovered</th>
                      <th className="actions-col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.slice(0, shown).map((l) => (
                      <LeadRow
                        key={l.id}
                        lead={l}
                        fresh={freshIds.current.has(l.id)}
                        selected={selected.has(l.id)}
                        pastView={view !== 'today'}
                        onToggle={toggle}
                        onDelete={deleteIds}
                        onWhatsApp={onWhatsAppChanged}
                        onCompose={setComposeLead}
                        onCall={callLead}
                        onText={textLead}
                        waOpen={wa?.state === 'open'}
                        notify={notify}
                      />
                    ))}
                  </tbody>
                </table>
              ) : null}
              {leads.length > shown && (
                <div className="table-more">
                  <span>
                    Showing {shown.toLocaleString()} of {leads.length.toLocaleString()} leads
                  </span>
                  <button type="button" className="btn btn-ghost" onClick={() => setShown((n) => n + ROWS_PER_PAGE)}>
                    Show {Math.min(ROWS_PER_PAGE, leads.length - shown).toLocaleString()} more
                  </button>
                </div>
              )}
              {leads.length > 0 ? null : loading ? (
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
                <EmptyLeads view={view} active={active} filtered={narrowed} onShowAll={showAll} onShowToday={() => setView('today')} />
              )}
            </div>
          </div>
        </section>
      </main>

      {active && <AgentCard status={status} />}
      {summary && !active && <Celebration summary={summary} onClose={() => setSummary(null)} />}
      {plansOpen && <Activation status={plan} notice={plansOpen.notice} notify={notify} onClose={() => setPlansOpen(null)} />}
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
