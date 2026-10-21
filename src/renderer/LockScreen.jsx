import { useCallback, useEffect, useState } from 'react';
import Icon from './icons.jsx';

// Full-window lock: first-launch PIN creation (with confirmation) or unlock.
// The main process refuses every other request until this succeeds.

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

export default function LockScreen({ configured, onUnlocked }) {
  const [step, setStep] = useState(configured ? 'unlock' : 'create'); // create | confirm | unlock
  const [first, setFirst] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(0);
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!wait) return;
    const t = setInterval(() => setWait((w) => Math.max(0, w - 1000)), 1000);
    return () => clearInterval(t);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (msg, retryAfterMs = 0) => {
    setError(msg);
    setPin('');
    setShake((n) => n + 1);
    if (retryAfterMs) setWait(retryAfterMs);
  };

  const submit = useCallback(
    async (value) => {
      if (busy) return;
      if (step === 'create') {
        setFirst(value);
        setPin('');
        setError('');
        setStep('confirm');
        return;
      }
      setBusy(true);
      let r;
      try {
        r = step === 'confirm' ? await window.leadFinder.lockSetup(first, value) : await window.leadFinder.lockUnlock(value);
      } catch (err) {
        r = { ok: false, error: err.message };
      }
      // Ready for input again before the error shows, so no keystroke is lost.
      setBusy(false);
      if (r.ok) return onUnlocked();
      if (step === 'confirm') {
        fail(r.error);
        setStep('create');
        setFirst('');
      } else {
        fail(r.attemptsLeft != null && r.attemptsLeft > 0 && !r.retryAfterMs ? `${r.error} ${r.attemptsLeft} tries left before a pause.` : r.error, r.retryAfterMs);
      }
    },
    [busy, step, first, onUnlocked],
  );

  const press = useCallback(
    (k) => {
      if (busy || wait) return;
      if (k === 'del') return setPin((p) => p.slice(0, -1));
      if (!/^\d$/.test(k)) return;
      setError('');
      setPin((p) => {
        if (p.length >= 4) return p;
        const next = p + k;
        if (next.length === 4) setTimeout(() => submit(next), 120);
        return next;
      });
    },
    [busy, wait, submit],
  );

  useEffect(() => {
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  const title = { create: 'Create your PIN', confirm: 'Confirm your PIN', unlock: 'Enter your PIN' }[step];
  const sub = {
    create: 'Choose a four-digit PIN to protect Lead Finder. You will need it every time the app opens.',
    confirm: 'Enter the same four digits again.',
    unlock: 'Lead Finder is locked.',
  }[step];

  return (
    <div className="lock">
      <div className="lock-card" role="dialog" aria-modal="true" aria-label={title}>
        <span className="lock-mark">
          <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="1" y="1" width="22" height="22" rx="6" />
            <path d="M8 6.5v11h8" />
            <circle cx="16" cy="8" r="2" />
          </svg>
        </span>
        <h1>{title}</h1>
        <p className="lock-sub">{sub}</p>
        <div className={`pin-dots ${shake ? 'shake' : ''}`} key={shake} aria-label={`${pin.length} of 4 digits entered`} role="status">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={i < pin.length ? 'on' : ''} />
          ))}
        </div>
        <p className="lock-error" role="alert">
          {wait ? `Too many wrong attempts. Try again in ${Math.ceil(wait / 1000)}s.` : error}
        </p>
        <div className="keypad">
          {KEYS.map((k, i) =>
            k ? (
              <button key={i} type="button" className="key" aria-label={k === 'del' ? 'Delete digit' : k} disabled={busy || Boolean(wait)} onClick={() => press(k)}>
                {k === 'del' ? <Icon name="x" /> : k}
              </button>
            ) : (
              <span key={i} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

export function ChangePin({ onClose, notify }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState('');
  const digits = (v) => v.replace(/\D/g, '').slice(0, 4);
  async function save(e) {
    e.preventDefault();
    const r = await window.leadFinder.lockChange(form.current, form.next, form.confirm);
    if (r.ok) {
      notify({ type: 'ok', text: 'PIN changed.' });
      onClose();
    } else setError(r.error);
  }
  const field = (k, label) => (
    <label className="pin-field">
      <span>{label}</span>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        value={form[k]}
        onChange={(e) => setForm({ ...form, [k]: digits(e.target.value) })}
        aria-label={label}
      />
    </label>
  );
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="composer pin-dialog" role="dialog" aria-modal="true" aria-label="Change PIN" onSubmit={save}>
        <header className="composer-head">
          <span className="composer-icon neutral">
            <Icon name="lock" size={18} />
          </span>
          <div>
            <strong>Change PIN</strong>
            <span className="muted">Four digits</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        {field('current', 'Current PIN')}
        {field('next', 'New PIN')}
        {field('confirm', 'Confirm new PIN')}
        {error && (
          <p className="composer-error" role="alert">
            {error}
          </p>
        )}
        <footer className="composer-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={form.current.length !== 4 || form.next.length !== 4 || form.confirm.length !== 4}>
            Save PIN
          </button>
        </footer>
      </form>
    </div>
  );
}
