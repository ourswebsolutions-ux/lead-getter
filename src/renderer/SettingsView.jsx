import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';

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

export default function SettingsView({ hidden, notify, categories = [] }) {
  const [s, setS] = useState(null);
  const [pilot, setPilot] = useState({ engine: 'stopped', tasks: [] });
  const [error, setError] = useState('');
  const [form, setForm] = useState({ keyword: '', category: '', countries: [], websiteFilter: 'without' });
  const [login, setLogin] = useState({ status: null, user: '', password: '', agree: false, busy: false, error: '' });
  const [active, setActive] = useState('background');
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
      ['searches', 'repeat', 'Continuous search'],
      ['new', 'plus', 'New search'],
      ['captcha', 'shield', 'CAPTCHA'],
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

  async function add(e) {
    e.preventDefault();
    const r = await api.autopilotAdd(form);
    if (!r.ok) return setError(r.error);
    setError('');
    setForm({ keyword: '', category: '', countries: [], websiteFilter: form.websiteFilter });
    if (pilot.engine !== 'running') await api.autopilotEngine('start');
    go('searches');
    notify?.({ type: 'ok', text: `Continuous search "${r.task.keyword}" started.` });
  }
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

  const toggleCountry = (c) => setForm((f) => ({ ...f, countries: f.countries.includes(c) ? f.countries.filter((x) => x !== c) : [...f.countries, c] }));
  const engine = pilot.engine;
  const unattended = s && s.background && s.autoResume && s.chrome.profile === 'automation';

  return (
    <section className="settings-page" hidden={hidden} aria-label="Settings">
      <nav className="st-nav" aria-label="Settings sections">
        <div className="st-nav-title">
          <Icon name="gear" size={16} /> Settings
        </div>
        {sections.map(([id, icon, label]) => (
          <button key={id} type="button" className={active === id ? 'on' : ''} aria-current={active === id ? 'true' : undefined} onClick={() => go(id)}>
            <Icon name={icon} size={15} /> <span>{label}</span>
            {id === 'searches' && pilot.tasks.length > 0 && <span className={`st-count ${pilot.engine === 'running' ? 'live' : ''}`}>{pilot.tasks.length}</span>}
          </button>
        ))}
        {s && (
          <div className={`st-readiness ${unattended ? 'ok' : ''}`}>
            <span className="st-dot" />
            <div>
              <strong>{unattended ? 'Ready for unattended use' : 'Attended use'}</strong>
              <span>{unattended ? 'Keeps working after restarts, with nobody at the computer.' : 'Turn on Background engine and Auto resume, and choose the automation profile in Chrome, to run unattended.'}</span>
            </div>
          </div>
        )}
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
            <Section id="background" icon="power" title="Background" lead="Keep Lead Finder working when its window is closed, and after the computer restarts.">
              <div className="st-group">
                <Row icon="laptop" label={win ? 'Start with Windows' : 'Start with the computer'} help="Opens hidden in the tray when you sign in">
                  <Switch label="Start with the computer" on={s.startWithOS} onChange={(v) => change({ startWithOS: v })} />
                </Row>
                <Row icon="power" label="Background engine" help="Closing the window keeps searches and campaigns running. The tray icon reopens it.">
                  <Switch label="Background engine" on={s.background} onChange={(v) => change({ background: v })} disabled={s.startWithOS} />
                </Row>
                <Row icon="refresh" label="Auto resume after restart" help="Resumes searches and WhatsApp campaigns at start, before the PIN. The window stays locked.">
                  <Switch label="Auto resume after restart" on={s.autoResume} onChange={(v) => change({ autoResume: v })} />
                </Row>
                <Row icon="bell" label="Notifications" help="Important events only, never more than one of a kind every few minutes">
                  <Switch label="Notifications" on={s.notifications} onChange={(v) => change({ notifications: v })} />
                </Row>
              </div>
              <div className="st-footer-row">
                <span>Quit stops all background work. Searches keep their place for next time.</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.automationQuit()}>
                  <Icon name="power" size={13} /> Quit Lead Finder
                </button>
              </div>
            </Section>
            )}

            {win && active === 'signin' && (
              <Section id="signin" icon="windows" title="Windows sign-in" lead="Sign in to Windows automatically after a restart or a power cut, so work resumes without anyone at the computer.">
                <div className="st-group">
                  <div className="st-signin-state">
                    <span className={`st-pill ${login.status?.enabled ? 'live' : 'off'}`}>{login.status?.enabled ? 'On' : 'Off'}</span>
                    <span>{login.status?.enabled ? `Windows signs in as ${login.status.domain ? `${login.status.domain}\\` : ''}${login.status.user}.` : 'Windows waits at the sign-in screen after a restart.'}</span>
                  </div>
                  {login.status?.plainTextPassword && <p className="st-note warn">Another tool left a password as plain text in the registry. Turning this on replaces it with Windows’ encrypted storage.</p>}
                  <div className="st-callout">
                    <Icon name="alert" size={15} />
                    <p>
                      <strong>Only for a dedicated computer in a safe place.</strong> Anyone who switches it on gets into your Windows account. Windows keeps the password itself, encrypted, the same way Microsoft’s Autologon tool does; Lead Finder never stores it. Windows asks for administrator permission. To switch on by itself after a power cut, turn on “Restore on AC power loss” in the PC’s BIOS.
                    </p>
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
            <Section id="chrome" icon="globe" title="Chrome" lead="Which Chrome Lead Finder searches with, and how it recovers.">
              <div className="st-choice" role="radiogroup" aria-label="Chrome profile">
                <button type="button" role="radio" aria-checked={s.chrome.profile !== 'automation'} className={s.chrome.profile !== 'automation' ? 'on' : ''} onClick={() => chrome({ profile: 'everyday' })}>
                  <span className="st-radio" />
                  <strong>Your everyday Chrome</strong>
                  <span>Your logins and extensions. Chrome asks you to Allow each new connection, so someone must be at the computer.</span>
                </button>
                <button type="button" role="radio" aria-checked={s.chrome.profile === 'automation'} className={s.chrome.profile === 'automation' ? 'on' : ''} onClick={() => chrome({ profile: 'automation' })}>
                  <span className="st-radio" />
                  <strong>
                    Lead Finder automation profile <span className="st-badge accent">Unattended</span>
                  </strong>
                  <span>A separate Chrome folder that Lead Finder can start and reconnect on its own. Sign in there once if needed. Your everyday Chrome is not touched.</span>
                </button>
              </div>
              <div className="st-group">
                {s.chrome.profile !== 'automation' && (
                  <Row icon="users" label="Profile" help="Used when Lead Finder starts Chrome">
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
                <Row icon="play" label="Auto launch Chrome" help="Start Chrome when a search needs it">
                  <Switch label="Auto launch Chrome" on={s.chrome.autoLaunch} onChange={(v) => chrome({ autoLaunch: v })} />
                </Row>
                <Row icon="link" label="Automatic reconnection" help="Reopen and reconnect after Chrome closes or crashes">
                  <Switch label="Automatic reconnection" on={s.chrome.autoReconnect} onChange={(v) => chrome({ autoReconnect: v })} />
                </Row>
                <Row icon="refresh" label="Recovery without asking" help="Restart Chrome (same profile, tabs restored) when recovery needs it, without a question">
                  <Switch label="Chrome recovery without asking" on={s.chrome.autoRestart} onChange={(v) => chrome({ autoRestart: v })} />
                </Row>
              </div>
              {s.chrome.profile === 'automation' && <p className="st-path">{s.automationProfileDir}</p>}
            </Section>
            )}

            {active === 'searches' && (
            <Section id="searches" icon="repeat" title="Continuous search" lead="A keyword searched country after country, round after round, until you stop it. New businesses are saved the moment they are found.">
              <div className="st-engine">
                <span className={`st-pill ${engine === 'running' ? 'live' : engine === 'paused' ? 'warn' : 'off'}`}>{engine === 'running' ? 'Running' : engine === 'paused' ? 'Paused' : 'Stopped'}</span>
                <span className="st-engine-text">
                  {pilot.tasks.length ? `${pilot.tasks.length} saved search${pilot.tasks.length === 1 ? '' : 'es'}` : 'No searches yet'}
                </span>
                <span className="spacer" />
                {engine === 'running' ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(api.autopilotEngine, 'pause')}>
                    <Icon name="pause" size={12} /> Pause all
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!pilot.tasks.length} onClick={() => act(api.autopilotEngine, 'start')}>
                    <Icon name="play" size={12} /> {engine === 'paused' ? 'Resume all' : 'Start engine'}
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" disabled={engine === 'stopped'} onClick={() => act(api.autopilotEngine, 'stop')} title="Every search keeps its place">
                  <Icon name="stop" size={12} /> Stop engine
                </button>
              </div>

              {pilot.tasks.length === 0 && (
                <div className="st-empty">
                  <span className="st-section-icon">
                    <Icon name="repeat" size={18} />
                  </span>
                  <strong>No continuous searches yet</strong>
                  <span>Choose a keyword and the countries to search, one after another.</span>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => go('new')}>
                    <Icon name="plus" size={12} /> New search
                  </button>
                </div>
              )}
              {pilot.tasks.length > 0 && (
                <ul className="st-tasks">
                  {pilot.tasks.map((t) => {
                    const [label, tone] = STATUS[t.status] || [t.status, 'idle'];
                    const at = t.index % t.countries.length;
                    const live = ['running', 'pending', 'waiting'].includes(t.status);
                    return (
                      <li key={t.id} className={`st-task tone-${tone}`}>
                        <div className="st-task-head">
                          <div className="st-task-title">
                            <strong>{t.keyword}</strong>
                            <span>
                              {t.category} · Round {t.round} · {t.leads} new lead{t.leads === 1 ? '' : 's'}
                            </span>
                          </div>
                          <span className={`st-pill ${tone}`}>{label}</span>
                          <div className="st-task-actions">
                            {live ? (
                              <button type="button" className="icon-btn" aria-label={`Pause ${t.keyword}`} title="Pause" onClick={() => act(api.autopilotPause, t.id)}>
                                <Icon name="pause" size={13} />
                              </button>
                            ) : (
                              <button type="button" className="icon-btn" aria-label={`Resume ${t.keyword}`} title="Resume" onClick={() => act(api.autopilotResume, t.id)}>
                                <Icon name="play" size={13} />
                              </button>
                            )}
                            {t.status !== 'completed' && (
                              <button type="button" className="icon-btn" aria-label={`Stop ${t.keyword}`} title="Stop" onClick={() => act(api.autopilotStop, t.id)}>
                                <Icon name="stop" size={13} />
                              </button>
                            )}
                            <button type="button" className="icon-btn" aria-label={`Delete ${t.keyword}`} title="Delete" disabled={t.status === 'running'} onClick={() => act(api.autopilotRemove, t.id)}>
                              <Icon name="trash" size={13} />
                            </button>
                          </div>
                        </div>
                        <ol className="st-route" aria-label="Countries in order">
                          {t.countries.map((c, i) => (
                            <li key={c} className={i === at ? (t.status === 'running' ? 'now' : 'next') : i < at ? 'done' : ''} title={c}>
                              <span className="st-cc">{CODE[c] || c.slice(0, 2).toUpperCase()}</span>
                              {c}
                            </li>
                          ))}
                        </ol>
                        {(t.reason || t.status === 'running') && (
                          <p className="st-task-reason">
                            {t.status === 'running' ? `Searching “${t.keyword} in ${t.countries[at]}”` : t.reason}
                            {t.status === 'waiting' && t.nextRunAt ? ` · ${when(t.nextRunAt)}` : ''}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="st-group">
                <Row icon="refresh" label="Resume interrupted searches" help="After a crash, restart or power cut, from the country it was on">
                  <Switch label="Resume interrupted searches" on={s.search.resumeInterrupted} onChange={(v) => change({ search: { resumeInterrupted: v } })} />
                </Row>
                <Row icon="copy" label="Duplicate lead prevention" help="A business already saved is skipped without being opened" locked>
                  <Switch label="Duplicate lead prevention" on disabled onChange={() => {}} />
                </Row>
              </div>
            </Section>
            )}

            {active === 'new' && (
            <Section id="new" icon="plus" title="New continuous search" lead="Searched in the order you pick the countries, then again from the first, until you stop it.">
              <form className="st-new" onSubmit={add}>
                <div className="st-new-fields">
                  <label>
                    <span>Keyword</span>
                    <input aria-label="Continuous search keyword" placeholder="e.g. Shoes Shop" value={form.keyword} onChange={(e) => setForm({ ...form, keyword: e.target.value })} maxLength={120} />
                  </label>
                  <label>
                    <span>Category</span>
                    <input aria-label="Continuous search category" placeholder="e.g. Shoes" list="st-cats" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} maxLength={60} />
                    <datalist id="st-cats">
                      {categories.map((c) => (
                        <option key={c.id} value={c.name} />
                      ))}
                    </datalist>
                  </label>
                  <label>
                    <span>Businesses</span>
                    <select className="st-select" aria-label="Which businesses" value={form.websiteFilter} onChange={(e) => setForm({ ...form, websiteFilter: e.target.value })}>
                      <option value="without">Without a website</option>
                      <option value="with">With a website</option>
                      <option value="all">All businesses</option>
                    </select>
                  </label>
                </div>
                <div className="st-countries-head">
                  <span>Countries, in search order</span>
                  {form.countries.length > 0 && (
                    <button type="button" className="st-link" onClick={() => setForm({ ...form, countries: [] })}>
                      Clear ({form.countries.length})
                    </button>
                  )}
                </div>
                <div className="st-countries" role="group" aria-label="Countries">
                  {COUNTRIES.map(([code, name]) => {
                    const n = form.countries.indexOf(name);
                    return (
                      <button key={name} type="button" className={`st-country ${n >= 0 ? 'on' : ''}`} aria-pressed={n >= 0} aria-label={name} onClick={() => toggleCountry(name)}>
                        <span className="st-cc">{n >= 0 ? n + 1 : code}</span>
                        {name}
                      </button>
                    );
                  })}
                </div>
                <div className="st-new-foot">
                  <span>{form.countries.length ? `${form.countries.join(' → ')} → again` : 'Choose one or more countries'}</span>
                  <button type="submit" className="btn btn-primary" disabled={form.keyword.trim().length < 2 || !form.category.trim() || !form.countries.length}>
                    <Icon name="play" size={12} /> Start continuous search
                  </button>
                </div>
              </form>
            </Section>
            )}

            {active === 'captcha' && (
            <Section id="captcha" icon="shield" title="CAPTCHA" lead="Google sometimes asks to confirm you are human. Lead Finder never solves or bypasses it.">
              <div className="st-group">
                <Row icon="eye" label="Detect and pause" help="The search pauses and you are notified. Complete the check in Chrome and it continues by itself." locked>
                  <Switch label="CAPTCHA detection and pause" on disabled onChange={() => {}} />
                </Row>
                <Row icon="refresh" label="Restart Chrome when appropriate" help="If the check stays, Chrome restarts once. A restart never counts as solved.">
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
