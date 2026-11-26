import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';
import ClaudeIntegration from './ClaudeIntegration.jsx';

// Settings page: background running, Windows sign-in, Chrome, continuous
// search and CAPTCHA. A section menu on the left; grouped rows with switches.

const api = window.leadFinder;

export const COUNTRIES = [
  ['PK', 'Pakistan'], ['AE', 'UAE'], ['US', 'USA'], ['GB', 'UK'], ['OM', 'Oman'], ['QA', 'Qatar'], ['SA', 'Saudi Arabia'], ['CA', 'Canada'], ['AU', 'Australia'],
  ['DE', 'Germany'], ['FR', 'France'], ['KW', 'Kuwait'], ['BH', 'Bahrain'], ['IN', 'India'], ['BD', 'Bangladesh'], ['TR', 'Turkey'], ['MY', 'Malaysia'], ['SG', 'Singapore'],
  ['IE', 'Ireland'], ['NL', 'Netherlands'], ['IT', 'Italy'], ['ES', 'Spain'], ['NZ', 'New Zealand'], ['ZA', 'South Africa'], ['EG', 'Egypt'], ['NG', 'Nigeria'], ['KE', 'Kenya'],
];
const CODE = Object.fromEntries(COUNTRIES.map(([c, n]) => [n, c]));

const STATUS = {
  pending: ['Pending', 'idle'],
  running: ['Running', 'live'],
  waiting: ['Waiting', 'idle'],
  paused: ['Paused', 'warn'],
  completed: ['Stopped', 'off'],
  failed: ['Needs attention', 'bad'],
};

function Switch({ on, label, onChange, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={Boolean(on)} aria-label={label} className={`switch ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="switch-knob" />
    </button>
  );
}

function Row({ icon, label, help, children, locked }) {
  return (
    <div className="st-row">
      {icon && (
        <span className="st-row-icon" aria-hidden="true">
          <Icon name={icon} size={15} />
        </span>
      )}
      <div className="st-row-text">
        <span className="st-row-label">
          {label}
          {locked && <span className="st-badge">Always on</span>}
        </span>
        {help && <span className="st-row-help">{help}</span>}
      </div>
      <div className="st-row-ctl">{children}</div>
    </div>
  );
}

function Section({ id, icon, title, lead, children }) {
  return (
    <section className="st-section" id={`st-${id}`} aria-labelledby={`st-${id}-h`} data-section={id}>
      <header className="st-section-head">
        <span className="st-section-icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
        <div>
          <h2 id={`st-${id}-h`}>{title}</h2>
          {lead && <p>{lead}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = d.toDateString() === new Date().toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Counts of one search, with the running one's live progress added.
function countsOf(t, live) {
  const run = live && live.id === t.id ? live : null;
  const found = (t.listed || 0) + (run ? Math.max(0, run.listed - (t.curListed || 0)) : 0);
  const checked = (t.processed || 0) + (run ? Math.max(0, run.processed - (t.curProcessed || 0)) : 0);
  return { found, checked, remaining: Math.max(0, found - checked), leads: (t.leads || 0) + (run ? run.newLeads : 0) };
}

function stateOf(t, c) {
  if (t.status === 'completed') return t.exhausted ? ['Completed', 'off'] : ['Stopped', 'off'];
  if (t.status === 'failed') return ['Needs attention', 'bad'];
  if (t.status === 'paused') return ['Paused', 'warn'];
  if (!c.found) return ['Starting', 'live'];
  return c.remaining <= Math.max(5, c.found * 0.1) ? ['Nearly exhausted', 'warn'] : ['Plenty left', 'live'];
}

// Every search (country, category, business; found, checked, remaining,
// new leads) and the pool, in order.
function Inventory({ searches, pool, live, onError }) {
  const act = async (fn) => {
    const r = await fn();
    onError(r?.ok === false ? r.error : '');
  };
  if (!searches.length && !pool.length) return null;
  return (
    <div className="st-inv" role="table" aria-label="Searches">
      {searches.length > 0 && (
        <>
          <div className="st-inv-head" role="row">
            <span>Searches</span>
            <span>Found</span>
            <span>Checked</span>
            <span>Remaining</span>
            <span>New leads</span>
            <span />
          </div>
          {searches.map((t) => {
            const c = countsOf(t, live);
            const [label, tone] = stateOf(t, c);
            const on = ['running', 'pending', 'waiting', 'paused'].includes(t.status);
            return (
              <div key={t.id} className={`st-inv-row ${on ? 'on' : ''}`} role="row" aria-label={`${t.countries.join(', ')} ${t.keyword}`}>
                <div className="st-inv-name">
                  <strong>{t.keyword}</strong>
                  <span>
                    {t.countries.join(', ')} · {t.category}
                  </span>
                </div>
                <span className="st-num">{c.found}</span>
                <span className="st-num">{c.checked}</span>
                <span className="st-num">{c.remaining}</span>
                <span className="st-num strong">{c.leads}</span>
                <div className="st-inv-end">
                  <span className={`st-pill ${tone}`}>{label}</span>
                  {on && t.status !== 'paused' && (
                    <button type="button" className="icon-btn" aria-label={`Pause ${t.keyword}`} title="Pause" onClick={() => act(() => api.autopilotPause(t.id))}>
                      <Icon name="pause" size={13} />
                    </button>
                  )}
                  {t.status === 'paused' && (
                    <button type="button" className="icon-btn" aria-label={`Resume ${t.keyword}`} title="Resume" onClick={() => act(() => api.autopilotResume(t.id))}>
                      <Icon name="play" size={13} />
                    </button>
                  )}
                  {on && (
                    <button type="button" className="icon-btn" aria-label={`Stop ${t.keyword}`} title="Stop" onClick={() => act(() => api.stopSearch())}>
                      <Icon name="stop" size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}
      {pool.length > 0 && (
        <>
          <div className="st-inv-head pool">
            <span>Search pool · starts only when you choose</span>
          </div>
          {pool.map((t, i) => (
            <div key={t.id} className={`st-inv-row pool ${t.held ? 'held' : ''}`}>
              <span className="st-cc">{i + 1}</span>
              <div className="st-inv-name">
                <strong>{t.keyword}</strong>
                <span>
                  {t.countries.join(', ')} · {t.category}
                  {t.held ? ' · paused' : ''}
                </span>
              </div>
              <div className="st-inv-end">
                <button type="button" className="btn btn-ghost btn-sm" aria-label={`Start ${t.keyword}`} onClick={() => act(() => api.autopilotActivate(t.id))}>
                  <Icon name="play" size={12} /> Start
                </button>
                {i > 0 && (
                  <button type="button" className="icon-btn" aria-label={`Move ${t.keyword} up`} title="Move up" onClick={() => act(() => api.autopilotMove(t.id, i))}>
                    <Icon name="chevron" size={13} className="up" />
                  </button>
                )}
                <button type="button" className="icon-btn" aria-label={`Remove ${t.keyword}`} title="Remove" onClick={() => act(() => api.autopilotRemove(t.id))}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// One AI provider: its API key (never shown again once saved), Save, Test, status.
function ProviderKey({ id, label, placeholder, st, onSettings, notify }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const p = st?.[id];
  async function save(e) {
    e.preventDefault();
    setBusy('save');
    const r = await api.aiSaveKey(key, id);
    setBusy('');
    onSettings(r.settings);
    setError(r.ok ? '' : r.error);
    if (r.ok) {
      setKey('');
      notify?.({ type: 'ok', text: `${label} API key saved.` });
    }
  }
  async function test() {
    setBusy('test');
    const r = await api.aiTest(id);
    setBusy('');
    onSettings(r.settings);
    setError(r.ok ? '' : r.error);
  }
  const status = !p?.configured ? ['', 'Not set up'] : p.status === 'connected' ? ['ok', 'Connected'] : p.status === 'failed' ? ['bad', 'Connection failed'] : ['', 'Saved, not tested'];
  return (
    <div className="st-group st-groq" aria-label={`${label} settings`} role="group">
      <form className="st-groq-row" onSubmit={save}>
        <label className="st-groq-field">
          <span>{label} API Key</span>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p?.configured ? '•••••••••••••••• (saved)' : placeholder} autoComplete="off" spellCheck={false} aria-label={`${label} API Key`} maxLength={300} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy === 'save' || !key.trim()}>
          <Icon name="check" size={13} /> Save API Key
        </button>
        <button type="button" className="btn" disabled={busy === 'test' || !p?.configured} onClick={test}>
          <Icon name="refresh" size={13} /> {busy === 'test' ? 'Testing…' : 'Test Connection'}
        </button>
      </form>
      <div className={`st-groq-status ${status[0]}`} role="status">
        <span className="st-dot" /> {status[1]}
        {p?.testedAt && <span className="muted"> · {when(p.testedAt)}</span>}
      </div>
      {error && (
        <p className="st-error" role="alert">
          <Icon name="alert" size={14} /> {error}
        </p>
      )}
    </div>
  );
}

// Groq and OpenRouter: either key works; with both, the main one is used
// and the other takes over when it fails.
function AiKeys({ notify }) {
  const [st, setSt] = useState(null);
  const [modelError, setModelError] = useState('');
  useEffect(() => {
    api.aiSettings().then(setSt).catch(() => {});
  }, []);
  const both = st?.groq?.configured && st?.openrouter?.configured;
  return (
    <>
      <ProviderKey id="groq" label="Groq" placeholder="gsk_…" st={st} onSettings={setSt} notify={notify} />
      <ProviderKey id="openrouter" label="OpenRouter" placeholder="sk-or-v1-…" st={st} onSettings={setSt} notify={notify} />
      {both && (
        <div className="st-group st-groq st-main-ai" role="group" aria-label="Main AI">
          <span className="st-groq-field">Main AI</span>
          <div className="segmented">
            {[
              ['groq', 'Groq'],
              ['openrouter', 'OpenRouter'],
            ].map(([id, label]) => (
              <button key={id} type="button" className={st.main === id ? 'on' : ''} aria-pressed={st.main === id} onClick={async () => setSt((await api.aiSetMain(id)).settings)}>
                {label}
              </button>
            ))}
          </div>
          <span className="muted small">The other one takes over if it fails.</span>
        </div>
      )}
      {st && (
        <div className="st-group st-groq st-email-model" role="group" aria-label="Email writing model">
          <div className="st-groq-row">
            <label className="st-groq-field">
              <span>Model that writes campaign emails</span>
              <select
                className="st-select"
                aria-label="Model that writes campaign emails"
                value={st.emailModel || 'auto'}
                onChange={async (e) => {
                  const r = await api.aiSetEmailModel(e.target.value);
                  setSt(r.settings);
                  setModelError(r.ok ? '' : r.error);
                  if (r.ok) notify?.({ type: 'ok', text: 'Campaign emails will be written with this model.' });
                }}
              >
                {(st.emailModels || []).map((m) => (
                  <option key={m.id} value={m.id} disabled={m.id !== 'auto' && !st.openrouter?.configured}>
                    {m.label} · {m.cost}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <span className="muted small">
            Claude models write each email automatically while a campaign sends, through your OpenRouter key (paid from its credit; a Claude Pro plan cannot be used by other apps). The Assistant keeps the usual models.
            {!st.openrouter?.configured ? ' Save an OpenRouter key above to choose Claude.' : ''}
          </span>
          {modelError && (
            <p className="st-error" role="alert">
              <Icon name="alert" size={14} /> {modelError}
            </p>
          )}
          {st.emailModelLast?.used && (
            <p className={`st-note ${st.emailModelLast.problem ? 'warn' : ''}`} role="status">
              Last email written by {(st.emailModels || []).find((m) => m.id === st.emailModelLast.used)?.label || st.emailModelLast.used} · {new Date(st.emailModelLast.at).toLocaleString()}
              {st.emailModelLast.problem ? `. ${(st.emailModels || []).find((m) => m.id === st.emailModelLast.wanted)?.label || 'The chosen model'} could not be used: ${st.emailModelLast.problem}` : ''}
            </p>
          )}
        </div>
      )}
    </>
  );
}

function AdminNumber({ value, onSave }) {
  const [v, setV] = useState(value || '');
  useEffect(() => setV(value || ''), [value]);
  const dirty = v.replace(/\D/g, '') !== (value || '');
  return (
    <form
      className="st-inline"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(v.replace(/\D/g, ''));
      }}
    >
      <input aria-label="Admin WhatsApp number" inputMode="tel" placeholder="923001234567" value={v} onChange={(e) => setV(e.target.value)} maxLength={20} />
      {dirty && (
        <button type="submit" className="btn btn-primary btn-sm">
          Save
        </button>
      )}
    </form>
  );
}

function AdminEmail({ value, onSave }) {
  const [v, setV] = useState(value || '');
  useEffect(() => setV(value || ''), [value]);
  const dirty = v.trim().toLowerCase() !== (value || '');
  return (
    <form
      className="st-inline"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(v.trim().toLowerCase());
      }}
    >
      <input aria-label="Admin email" type="email" placeholder="you@company.com" value={v} onChange={(e) => setV(e.target.value)} maxLength={254} />
      {dirty && (
        <button type="submit" className="btn btn-primary btn-sm">
          Save
        </button>
      )}
    </form>
  );
}

export default function SettingsView({ hidden, notify, categories = [] }) {
  const [s, setS] = useState(null);
  const [pilot, setPilot] = useState({ engine: 'stopped', tasks: [] });
  const [error, setError] = useState('');
  const [login, setLogin] = useState({ status: null, user: '', password: '', agree: false, busy: false, error: '' });
  const [active, setActive] = useState('background');
  const [aiTab, setAiTab] = useState('claude');
  const scroller = useRef(null);

  useEffect(() => {
    api.automationGet().then(setS).catch((e) => setError(e.message));
    api.autopilotState().then(setPilot).catch(() => {});
    return api.onAutopilot(setPilot);
  }, []);
  useEffect(() => {
    if (s?.platform === 'win32' && !login.status) api.autologonStatus().then((st) => setLogin((l) => ({ ...l, status: st, user: st.user || s.osUser || '' })));
  }, [s?.platform]); // eslint-disable-line react-hooks/exhaustive-deps

  const win = s?.platform === 'win32';
  const sections = useMemo(
    () => [
      ['background', 'power', 'Background'],
      ...(win ? [['signin', 'windows', 'Windows sign-in']] : []),
      ['chrome', 'globe', 'Chrome'],
      ['search', 'repeat', 'Continuous search'],
      ['captcha', 'shield', 'CAPTCHA'],
      ['groq', 'sparkle', 'AI Integrations'],
    ],
    [win],
  );

  // One section at a time: the menu switches the page.
  const go = (id) => {
    setActive(id);
    if (scroller.current) scroller.current.scrollTop = 0;
  };

  async function change(patch) {
    const r = await api.automationSet(patch);
    if (r.settings) setS(r.settings);
    setError(r.ok ? '' : r.error);
  }
  const chrome = (patch) => change({ chrome: patch });

  const act = async (fn, arg) => {
    const r = await fn(arg);
    setError(r?.ok === false ? r.error : '');
  };

  async function autologonOn(e) {
    e.preventDefault();
    setLogin((l) => ({ ...l, busy: true, error: '' }));
    const r = await api.autologonEnable(login.user, login.password).catch((err) => ({ ok: false, error: err.message }));
    setLogin((l) => ({ ...l, busy: false, password: '', agree: false, status: r.status || l.status, error: r.ok ? '' : r.error }));
    if (r.ok) notify?.({ type: 'ok', text: 'Windows signs in automatically after a restart.' });
  }
  async function autologonOff() {
    setLogin((l) => ({ ...l, busy: true, error: '' }));
    const r = await api.autologonDisable().catch((err) => ({ ok: false, error: err.message }));
    setLogin((l) => ({ ...l, busy: false, status: r.status || l.status, error: r.ok ? '' : r.error }));
  }

  const engine = pilot.engine;
  const searches = pilot.tasks.filter((t) => t.status !== 'queued').slice(-8).reverse();
  const pool = pilot.tasks.filter((t) => t.status === 'queued');
  const live = pilot.live;
  const unattended = s && s.background && s.autoResume && s.chrome.profile === 'automation';

  return (
    <section className="settings-page" hidden={hidden} aria-label="Settings">
      <header className="st-hero">
        <span className="st-hero-mark" aria-hidden="true">
          <Icon name="gear" size={20} />
        </span>
        <div className="st-hero-text">
          <h1>Settings</h1>
          <p>Automation, background work and recovery</p>
        </div>
        {s && (
          <div className={`st-readiness ${unattended ? 'ok' : ''}`} title={unattended ? 'Keeps working after restarts, with nobody at the computer.' : 'For unattended use: Background engine and Auto resume on, and the Lead Finder automation profile in Chrome.'}>
            <span className="st-dot" />
            <span>{unattended ? 'Ready for unattended use' : 'Attended use'}</span>
          </div>
        )}
      </header>

      <nav className="st-tabs" aria-label="Settings sections">
        {sections.map(([id, icon, label]) => (
          <button key={id} type="button" className={active === id ? 'on' : ''} aria-current={active === id ? 'true' : undefined} onClick={() => go(id)}>
            <Icon name={icon} size={15} /> <span>{label}</span>
            {id === 'search' && s?.search.continuous && <span className="st-count live">On</span>}
          </button>
        ))}
      </nav>

      <div className="st-main" ref={scroller}>
        {error && (
          <p className="st-error" role="alert">
            <Icon name="alert" size={14} /> {error}
          </p>
        )}
        {!s ? (
          <div className="st-skeleton" aria-busy="true">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <>
            {active === 'background' && (
            <Section id="background" icon="power" title="Background" lead="Keeps working when closed or restarted.">
              <div className="st-group">
                <Row icon="laptop" label={win ? 'Start with Windows' : 'Start with the computer'} help="Opens at sign-in and unlock">
                  <Switch label="Start with the computer" on={s.startWithOS} onChange={(v) => change({ startWithOS: v })} />
                </Row>
                <Row icon="power" label="Background engine" help="Keeps running when the window closes">
                  <Switch label="Background engine" on={s.background} onChange={(v) => change({ background: v })} disabled={s.startWithOS} />
                </Row>
                <Row icon="refresh" label="Auto resume after restart" help="Continues work before the PIN">
                  <Switch label="Auto resume after restart" on={s.autoResume} onChange={(v) => change({ autoResume: v })} />
                </Row>
                <Row icon="chat" label="Admin WhatsApp number" help="Receives updates, sends commands">
                  <AdminNumber value={s.adminNumber} onSave={(v) => change({ adminNumber: v })} />
                </Row>
                <Row icon="mail" label="Admin email" help="Gets WhatsApp replies, can answer">
                  <AdminEmail value={s.adminEmail} onSave={(v) => change({ adminEmail: v })} />
                </Row>
                <Row icon="bell" label="Notifications" help="Important events only">
                  <Switch label="Notifications" on={s.notifications} onChange={(v) => change({ notifications: v })} />
                </Row>
              </div>
              <div className="st-footer-row">
                <span>Stops all background work.</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.automationQuit()}>
                  <Icon name="power" size={13} /> Quit Lead Finder
                </button>
              </div>
            </Section>
            )}

            {win && active === 'signin' && (
              <Section id="signin" icon="windows" title="Windows sign-in" lead="Signs in to Windows after restarts.">
                <div className="st-group">
                  <div className="st-signin-state">
                    <span className={`st-pill ${login.status?.enabled ? 'live' : 'off'}`}>{login.status?.enabled ? 'On' : 'Off'}</span>
                    <span>{login.status?.enabled ? `Signs in as ${login.status.user}` : 'Off after restarts'}</span>
                  </div>
                  {login.status?.plainTextPassword && <p className="st-note warn">A plain-text password exists; turning this on replaces it.</p>}
                  <div className="st-callout">
                    <Icon name="alert" size={15} />
                    <p>
                      <strong>Dedicated PC only.</strong> Anyone who switches it on gets in. Windows keeps the password, encrypted.</p>
                  </div>
                  {login.status?.enabled ? (
                    <div className="st-footer-row inner">
                      <span />
                      <button type="button" className="btn btn-ghost btn-sm" disabled={login.busy} onClick={autologonOff}>
                        {login.busy ? 'Waiting for Windows…' : 'Turn off automatic sign-in'}
                      </button>
                    </div>
                  ) : (
                    <form className="st-form" onSubmit={autologonOn}>
                      <label>
                        <span>Windows user name</span>
                        <input aria-label="Windows Username" value={login.user} onChange={(e) => setLogin({ ...login, user: e.target.value })} autoComplete="off" />
                      </label>
                      <label>
                        <span>Windows password</span>
                        <input aria-label="Windows Password" type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} autoComplete="new-password" />
                      </label>
                      <label className="st-check">
                        <input type="checkbox" checked={login.agree} onChange={(e) => setLogin({ ...login, agree: e.target.checked })} /> I understand the risk
                      </label>
                      <button type="submit" className="btn btn-primary btn-sm" disabled={login.busy || !login.agree || !login.user || !login.password}>
                        <Icon name="key" size={13} /> {login.busy ? 'Waiting for Windows…' : 'Turn on automatic sign-in'}
                      </button>
                    </form>
                  )}
                  {login.error && <p className="st-note bad">{login.error}</p>}
                </div>
              </Section>
            )}

            {active === 'chrome' && (
            <Section id="chrome" icon="globe" title="Chrome" lead="The Chrome used for searching.">
              <div className="st-choice" role="radiogroup" aria-label="Chrome profile">
                <button type="button" role="radio" aria-checked={s.chrome.profile !== 'automation'} className={s.chrome.profile !== 'automation' ? 'on' : ''} onClick={() => chrome({ profile: 'everyday' })}>
                  <span className="st-radio" />
                  <strong>Your everyday Chrome</strong>
                  <span>Asks “Allow” on every connection.</span>
                </button>
                <button type="button" role="radio" aria-checked={s.chrome.profile === 'automation'} className={s.chrome.profile === 'automation' ? 'on' : ''} onClick={() => chrome({ profile: 'automation' })}>
                  <span className="st-radio" />
                  <strong>
                    Lead Finder automation profile <span className="st-badge accent">Unattended</span>
                  </strong>
                  <span>Never asks. Runs unattended.</span>
                </button>
              </div>
              {s.chrome.profile !== 'automation' && (
                <div className="st-callout info">
                  <Icon name="shield" size={15} />
                  <p>
                    <strong>Chrome asks “Allow” for this profile.</strong> The automation profile never asks.</p>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => chrome({ profile: 'automation' })}>
                    Use automation profile
                  </button>
                </div>
              )}
              <div className="st-group">
                {s.chrome.profile !== 'automation' && (
                  <Row icon="users" label="Profile" help="Opened when Chrome starts">
                    <select className="st-select" aria-label="Chrome profile to start" value={s.chrome.profileDir} onChange={(e) => chrome({ profileDir: e.target.value })}>
                      <option value="">Last used</option>
                      {s.profiles.map((p) => (
                        <option key={p.dir} value={p.dir}>
                          {p.name}
                          {p.account ? ` (${p.account})` : ''}
                        </option>
                      ))}
                    </select>
                  </Row>
                )}
                <Row icon="play" label="Auto launch Chrome" help="Starts Chrome when needed">
                  <Switch label="Auto launch Chrome" on={s.chrome.autoLaunch} onChange={(v) => chrome({ autoLaunch: v })} />
                </Row>
                <Row icon="link" label="Automatic reconnection" help="Reconnects after Chrome closes">
                  <Switch label="Automatic reconnection" on={s.chrome.autoReconnect} onChange={(v) => chrome({ autoReconnect: v })} />
                </Row>
                <Row icon="refresh" label="Recovery without asking" help="Restarts Chrome without asking">
                  <Switch label="Chrome recovery without asking" on={s.chrome.autoRestart} onChange={(v) => chrome({ autoRestart: v })} />
                </Row>
              </div>
              {s.chrome.profile === 'automation' && (
                <div className="st-group st-signin">
                  <Row icon="key" label={s.automationAccount ? 'Google account' : 'Google sign-in'} help={s.automationAccount ? s.automationAccount : 'Sign in once, it is remembered'}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={async () => {
                      const r = await api.automationOpenSignIn();
                      setError(r.ok ? '' : r.error);
                      if (r.ok) notify?.({ type: 'ok', text: 'Sign in to Google in the Chrome window, then close it. Lead Finder remembers the sign-in.' });
                    }}>
                      <Icon name="external" size={12} /> {s.automationAccount ? 'Open Chrome' : 'Open Chrome to sign in'}
                    </button>
                  </Row>
                </div>
              )}
              {s.chrome.profile === 'automation' && <p className="st-path">{s.automationProfileDir}</p>}
            </Section>
            )}

            {active === 'search' && (
            <Section id="search" icon="repeat" title="Continuous search" lead="You choose every search.">
              <div className="st-group">
                <Row icon="repeat" label="Continuous search" help="Each country once, then it stops">
                  <Switch label="Continuous search" on={s.search.continuous} onChange={(v) => change({ search: { continuous: v } })} />
                </Row>
              </div>
              <div className="st-new st-countries-card">
                <div className="st-countries-head">
                  <span>Countries, in search order</span>
                  {s.search.countries.length > 0 && (
                    <button type="button" className="st-link" onClick={() => change({ search: { countries: [] } })}>
                      Clear ({s.search.countries.length})
                    </button>
                  )}
                </div>
                <div className="st-countries" role="group" aria-label="Countries">
                  {COUNTRIES.map(([code, name]) => {
                    const list = s.search.countries;
                    const n = list.indexOf(name);
                    return (
                      <button key={name} type="button" className={`st-country ${n >= 0 ? 'on' : ''}`} aria-pressed={n >= 0} aria-label={name} onClick={() => change({ search: { countries: n >= 0 ? list.filter((x) => x !== name) : [...list, name] } })}>
                        <span className="st-cc">{n >= 0 ? n + 1 : code}</span>
                        {name}
                      </button>
                    );
                  })}
                </div>
                <div className="st-new-foot">
                  <span>{s.search.countries.length ? `${s.search.countries.join(' → ')}, then stops` : 'Choose one or more countries'}</span>
                </div>
              </div>
              <Inventory searches={searches} pool={pool} live={live} onError={setError} />
              <div className="st-group">
                <Row icon="refresh" label="Resume interrupted searches" help="Continues after a crash or restart">
                  <Switch label="Resume interrupted searches" on={s.search.resumeInterrupted} onChange={(v) => change({ search: { resumeInterrupted: v } })} />
                </Row>
                <Row icon="copy" label="Duplicate lead prevention" help="Saved businesses are skipped" locked>
                  <Switch label="Duplicate lead prevention" on disabled onChange={() => {}} />
                </Row>
              </div>
            </Section>
            )}

            {active === 'groq' && (
            <Section id="groq" icon="sparkle" title="AI Integrations" lead={aiTab === 'claude' ? 'Use Lead Finder from Claude Desktop.' : 'Groq or OpenRouter powers the Assistant and AI-written messages.'}>
              <div className="segmented st-ai-tabs" role="tablist" aria-label="AI integrations">
                {[
                  ['claude', 'Claude'],
                  ['keys', 'Groq & OpenRouter'],
                ].map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={aiTab === id} className={aiTab === id ? 'on' : ''} onClick={() => setAiTab(id)}>
                    {label}
                  </button>
                ))}
              </div>
              {aiTab === 'claude' ? <ClaudeIntegration /> : <AiKeys notify={notify} />}
            </Section>
            )}
            {active === 'captcha' && (
            <Section id="captcha" icon="shield" title="CAPTCHA" lead="Pauses for Google’s human check.">
              <div className="st-group">
                <Row icon="eye" label="Detect and pause" help="Continues after you complete it" locked>
                  <Switch label="CAPTCHA detection and pause" on disabled onChange={() => {}} />
                </Row>
                <Row icon="refresh" label="Restart Chrome when appropriate" help="One restart if it persists">
                  <Switch label="Chrome restart when appropriate" on={s.captcha.restartChrome} onChange={(v) => change({ captcha: { restartChrome: v } })} />
                </Row>
              </div>
            </Section>
            )}
          </>
        )}
      </div>
    </section>
  );
}
