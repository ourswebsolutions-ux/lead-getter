import { useEffect, useState } from 'react';
import Icon from './icons.jsx';

// Settings: Windows, Chrome, Search and CAPTCHA automation in four compact
// sections, plus the continuous searches (keyword, category, countries).

const api = window.leadFinder;

export const COUNTRIES = ['Pakistan', 'UAE', 'USA', 'UK', 'Oman', 'Qatar', 'Saudi Arabia', 'Canada', 'Australia', 'Germany', 'France', 'Kuwait', 'Bahrain', 'India', 'Bangladesh', 'Turkey', 'Malaysia', 'Singapore', 'Ireland', 'Netherlands', 'Italy', 'Spain', 'New Zealand', 'South Africa', 'Egypt', 'Nigeria', 'Kenya'];

const STATUS = { pending: ['Pending', ''], running: ['Running', 'accent'], waiting: ['Waiting', ''], paused: ['Paused', 'warn'], completed: ['Stopped', ''], failed: ['Needs attention', 'danger'] };

function Switch({ on, label, onChange, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={Boolean(on)} aria-label={label} className={`switch ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="switch-knob" />
    </button>
  );
}

function Row({ label, help, children }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <span className="set-label">{label}</span>
        {help && <span className="set-help">{help}</span>}
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}

function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function AutomationSettings({ onClose, notify, categories = [] }) {
  const [s, setS] = useState(null);
  const [pilot, setPilot] = useState({ engine: 'stopped', tasks: [] });
  const [error, setError] = useState('');
  const [form, setForm] = useState({ keyword: '', category: '', countries: [] });
  const [login, setLogin] = useState({ status: null, user: '', password: '', agree: false, busy: false, error: '' });

  useEffect(() => {
    api.automationGet().then(setS).catch((e) => setError(e.message));
    api.autopilotState().then(setPilot).catch(() => {});
    return api.onAutopilot(setPilot);
  }, []);
  useEffect(() => {
    if (s?.platform === 'win32' && !login.status) api.autologonStatus().then((st) => setLogin((l) => ({ ...l, status: st, user: st.user || s.osUser || '' })));
  }, [s?.platform]); // eslint-disable-line react-hooks/exhaustive-deps

  async function change(patch) {
    const r = await api.automationSet(patch);
    if (r.settings) setS(r.settings);
    setError(r.ok ? '' : r.error);
  }
  const chrome = (patch) => change({ chrome: patch });

  async function add(e) {
    e.preventDefault();
    const r = await api.autopilotAdd({ ...form, websiteFilter: 'without' });
    if (!r.ok) return setError(r.error);
    setError('');
    setForm({ keyword: '', category: '', countries: [] });
    if (pilot.engine !== 'running') await api.autopilotEngine('start');
    notify?.({ type: 'ok', text: `Continuous search "${r.task.keyword}" started.` });
  }
  const act = async (fn, id) => {
    const r = await fn(id);
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
  const win = s?.platform === 'win32';
  const engineOn = pilot.engine === 'running';

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="composer settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
        <header className="composer-head">
          <span className="composer-icon neutral">
            <Icon name="sliders" size={18} />
          </span>
          <div>
            <strong>Settings</strong>
            <span className="muted">Automation</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        {error && (
          <p className="composer-error" role="alert">
            {error}
          </p>
        )}
        {!s ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="set-body">
            <section className="set-section" aria-label={win ? 'Windows Automation' : 'Background'}>
              <h3>{win ? 'Windows Automation' : 'Background'}</h3>
              <Row label={win ? 'Start with Windows' : 'Start with the computer'} help={s.startsWithOS ? 'Starts hidden in the tray when you sign in' : 'Starts hidden in the tray when you sign in'}>
                <Switch label="Start with the computer" on={s.startWithOS} onChange={(v) => change({ startWithOS: v })} />
              </Row>
              <Row label="Background engine" help="Closing the window keeps searches and campaigns running. Reopen from the tray icon; Quit there stops everything.">
                <Switch label="Background engine" on={s.background} onChange={(v) => change({ background: v })} disabled={s.startWithOS} />
              </Row>
              <Row label="Auto resume after restart" help="Resumes continuous searches and WhatsApp campaigns when Lead Finder starts, before the PIN is entered. The window stays locked.">
                <Switch label="Auto resume after restart" on={s.autoResume} onChange={(v) => change({ autoResume: v })} />
              </Row>
              <Row label="Notifications" help="Important events only, at most once every few minutes each">
                <Switch label="Notifications" on={s.notifications} onChange={(v) => change({ notifications: v })} />
              </Row>
              {win && (
                <div className="set-sub">
                  <span className="set-label">Windows Auto Login</span>
                  <span className="set-help">
                    {login.status?.enabled ? `On: Windows signs in as ${login.status.domain ? `${login.status.domain}\\` : ''}${login.status.user} after a restart.` : 'Off: after a restart Windows waits at the sign-in screen.'}
                    {login.status?.plainTextPassword ? ' Warning: a password is stored as plain text in the registry by another tool; turning this on replaces it with Windows’ encrypted storage.' : ''}
                  </span>
                  <p className="set-warn">
                    <Icon name="alert" size={13} /> Anyone who can switch this computer on gets into your Windows account without a password. Use it only on a dedicated computer in a safe place. The password is kept by Windows itself, encrypted (as Microsoft’s Autologon tool does), never by Lead Finder. Windows asks for administrator permission. The PC turning itself on after a power cut is a BIOS/UEFI setting (“Restore on AC power loss”).
                  </p>
                  {login.status?.enabled ? (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={login.busy} onClick={autologonOff}>
                      {login.busy ? 'Waiting for Windows…' : 'Turn off Auto Login'}
                    </button>
                  ) : (
                    <form className="set-login" onSubmit={autologonOn}>
                      <input aria-label="Windows Username" placeholder="Windows user name" value={login.user} onChange={(e) => setLogin({ ...login, user: e.target.value })} autoComplete="off" />
                      <input aria-label="Windows Password" type="password" placeholder="Windows password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} autoComplete="new-password" />
                      <label className="set-agree">
                        <input type="checkbox" checked={login.agree} onChange={(e) => setLogin({ ...login, agree: e.target.checked })} /> I understand
                      </label>
                      <button type="submit" className="btn btn-primary btn-sm" disabled={login.busy || !login.agree || !login.user || !login.password}>
                        {login.busy ? 'Waiting for Windows…' : 'Turn on Auto Login'}
                      </button>
                    </form>
                  )}
                  {login.error && (
                    <p className="composer-error" role="alert">
                      {login.error}
                    </p>
                  )}
                </div>
              )}
            </section>

            <section className="set-section" aria-label="Chrome Automation">
              <h3>Chrome Automation</h3>
              <Row label="Chrome profile" help={s.chrome.profile === 'automation' ? `Lead Finder’s own Chrome folder (${s.automationProfileDir}). Works unattended; sign in there once if needed. Your everyday Chrome is not touched.` : 'Your everyday Chrome. Chrome asks you to Allow each new connection, so it cannot reconnect with nobody at the computer.'}>
                <select aria-label="Chrome profile" value={s.chrome.profile === 'automation' ? 'automation' : `p:${s.chrome.profileDir}`} onChange={(e) => (e.target.value === 'automation' ? chrome({ profile: 'automation' }) : chrome({ profile: 'everyday', profileDir: e.target.value.slice(2) }))}>
                  <option value="p:">Everyday Chrome (last used profile)</option>
                  {s.profiles.map((p) => (
                    <option key={p.dir} value={`p:${p.dir}`}>
                      Everyday Chrome: {p.name}
                      {p.account ? ` (${p.account})` : ''}
                    </option>
                  ))}
                  <option value="automation">Lead Finder automation profile (unattended)</option>
                </select>
              </Row>
              <Row label="Auto launch Chrome" help="Start Chrome when a search needs it">
                <Switch label="Auto launch Chrome" on={s.chrome.autoLaunch} onChange={(v) => chrome({ autoLaunch: v })} />
              </Row>
              <Row label="Automatic reconnection" help="Reopen and reconnect after Chrome closes or crashes">
                <Switch label="Automatic reconnection" on={s.chrome.autoReconnect} onChange={(v) => chrome({ autoReconnect: v })} />
              </Row>
              <Row label="Chrome recovery without asking" help="Restart Chrome (same profile, tabs restored) when recovery needs it, without a question">
                <Switch label="Chrome recovery without asking" on={s.chrome.autoRestart} onChange={(v) => chrome({ autoRestart: v })} />
              </Row>
            </section>

            <section className="set-section" aria-label="Search Automation">
              <h3>Search Automation</h3>
              <Row label="Resume interrupted searches" help="Continuous searches carry on after a crash, restart or power cut, from the country they were on">
                <Switch label="Resume interrupted searches" on={s.search.resumeInterrupted} onChange={(v) => change({ search: { resumeInterrupted: v } })} />
              </Row>
              <Row label="Duplicate lead prevention" help="Always on: a business already saved is skipped without being opened">
                <Switch label="Duplicate lead prevention" on disabled onChange={() => {}} />
              </Row>
              <div className="set-sub">
                <div className="set-engine">
                  <span className="set-label">Continuous search</span>
                  <span className={`sub-chip tone-${engineOn ? 'accent' : ''}`}>{engineOn ? 'Running' : pilot.engine === 'paused' ? 'Paused' : 'Stopped'}</span>
                  <span className="spacer" />
                  {engineOn ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(api.autopilotEngine, 'pause')}>
                      <Icon name="pause" size={12} /> Pause all
                    </button>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={!pilot.tasks.length} onClick={() => act(api.autopilotEngine, 'start')}>
                      <Icon name="play" size={12} /> {pilot.engine === 'paused' ? 'Resume all' : 'Start'}
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" disabled={pilot.engine === 'stopped'} onClick={() => act(api.autopilotEngine, 'stop')} title="Stops the background engine’s searches; each keeps its place">
                    <Icon name="stop" size={12} /> Stop engine
                  </button>
                </div>
                {pilot.tasks.length > 0 && (
                  <ul className="set-tasks">
                    {pilot.tasks.map((t) => {
                      const [label, tone] = STATUS[t.status] || [t.status, ''];
                      const country = t.countries[t.index % t.countries.length];
                      return (
                        <li key={t.id}>
                          <div className="set-task-top">
                            <strong>{t.keyword}</strong>
                            <span className={`sub-chip tone-${tone}`}>{label}</span>
                            <span className="spacer" />
                            {['running', 'pending', 'waiting'].includes(t.status) ? (
                              <button type="button" className="icon-btn" aria-label={`Pause ${t.keyword}`} title="Pause" onClick={() => act(api.autopilotPause, t.id)}>
                                <Icon name="pause" size={12} />
                              </button>
                            ) : (
                              <button type="button" className="icon-btn" aria-label={`Resume ${t.keyword}`} title="Resume" onClick={() => act(api.autopilotResume, t.id)}>
                                <Icon name="play" size={12} />
                              </button>
                            )}
                            {t.status !== 'completed' && (
                              <button type="button" className="icon-btn" aria-label={`Stop ${t.keyword}`} title="Stop" onClick={() => act(api.autopilotStop, t.id)}>
                                <Icon name="stop" size={12} />
                              </button>
                            )}
                            <button type="button" className="icon-btn" aria-label={`Delete ${t.keyword}`} title="Delete" disabled={t.status === 'running'} onClick={() => act(api.autopilotRemove, t.id)}>
                              <Icon name="trash" size={12} />
                            </button>
                          </div>
                          <span className="set-help">
                            {t.category} · round {t.round} · {t.status === 'running' ? `searching ${country}` : `${country} (${(t.index % t.countries.length) + 1} of ${t.countries.length})`} · {t.leads} new lead{t.leads === 1 ? '' : 's'}
                          </span>
                          {t.reason && (
                            <span className="set-help">
                              {t.reason}
                              {t.status === 'waiting' && t.nextRunAt ? ` · ${when(t.nextRunAt)}` : ''}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <form className="set-add" onSubmit={add}>
                  <div className="set-add-row">
                    <input aria-label="Continuous search keyword" placeholder="Keyword, e.g. Shoes Shop" value={form.keyword} onChange={(e) => setForm({ ...form, keyword: e.target.value })} maxLength={120} />
                    <input aria-label="Continuous search category" placeholder="Category" list="set-cats" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} maxLength={60} />
                    <datalist id="set-cats">
                      {categories.map((c) => (
                        <option key={c.id} value={c.name} />
                      ))}
                    </datalist>
                  </div>
                  <div className="set-countries" role="group" aria-label="Countries">
                    {COUNTRIES.map((c) => (
                      <button key={c} type="button" className={`chip ${form.countries.includes(c) ? 'on' : ''}`} aria-pressed={form.countries.includes(c)} onClick={() => toggleCountry(c)}>
                        {c}
                      </button>
                    ))}
                  </div>
                  <div className="set-add-row">
                    <span className="set-help">Searched in this order, one after another, then again from the first, until you stop it. New businesses are saved as they are found.</span>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={form.keyword.trim().length < 2 || !form.category.trim() || !form.countries.length}>
                      <Icon name="play" size={12} /> Start continuous search
                    </button>
                  </div>
                </form>
              </div>
            </section>

            <section className="set-section" aria-label="CAPTCHA Handling">
              <h3>CAPTCHA Handling</h3>
              <Row label="CAPTCHA detection and pause" help="Always on: the search pauses, you are notified, and it continues by itself once you complete the check in Chrome. Lead Finder never solves or bypasses it.">
                <Switch label="CAPTCHA detection and pause" on disabled onChange={() => {}} />
              </Row>
              <Row label="Chrome restart when appropriate" help="If the check stays, Chrome is restarted once (same profile). A restart never counts as solved: the search waits until Google no longer asks.">
                <Switch label="Chrome restart when appropriate" on={s.captcha.restartChrome} onChange={(v) => change({ captcha: { restartChrome: v } })} />
              </Row>
            </section>

            <footer className="composer-actions">
              <button type="button" className="btn btn-ghost" onClick={() => api.automationQuit()} title="Stops all background work and closes Lead Finder">
                Quit Lead Finder
              </button>
              <span className="spacer" />
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
