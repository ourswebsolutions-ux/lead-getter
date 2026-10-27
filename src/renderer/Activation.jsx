import { useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';

// The subscription panel. The customer picks a plan and sends their
// Activation ID to the administrator (WhatsApp or a call); after payment
// the administrator sends back a 4-digit activation code, entered here.
// The code is checked in the main process (activation.js), not here.

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// A refusal for want of a plan (from any feature) opens the Activate panel
// with its reason. Returns true when `res` was one.
export function planNeeded(res) {
  if (!res || res.ok || !res.subscription) return false;
  window.dispatchEvent(new CustomEvent('lead-finder:plan-needed', { detail: res.error }));
  return true;
}

// The plan pill in the app bar: { text, tone }.
export function planPill(st) {
  if (!st) return { text: 'Plan…', tone: 'idle' };
  if (st.state === 'active') return { text: st.expiresAt ? `${st.planName} · ${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'} left` : st.planName, tone: st.expiresAt && st.daysLeft <= 3 ? 'warn' : 'accent' };
  if (st.state === 'expired') return { text: 'Plan ended · Renew', tone: 'danger' };
  return { text: 'Activate', tone: 'warn' };
}

export function statusLine(st) {
  if (!st) return 'Checking plan…';
  if (st.state === 'active') return st.expiresAt ? `${st.planName} until ${fmtDate(st.expiresAt)}` : `${st.planName}, never expires`;
  if (st.state === 'expired') return `${st.planName} ended ${fmtDate(st.expiresAt)}`;
  return 'No plan yet';
}

// Four single-digit boxes: typing moves on, Backspace moves back, pasting
// a code fills all four.
function CodeInput({ value, onChange, onComplete, disabled, invalid }) {
  const refs = useRef([]);
  const set = (next) => {
    const v = next.replace(/\D/g, '').slice(0, 4);
    onChange(v);
    refs.current[Math.min(v.length, 3)]?.focus();
    if (v.length === 4) onComplete?.(v);
  };
  return (
    <div className={`code ${invalid ? 'invalid' : ''}`} role="group" aria-label="Activation code">
      {[0, 1, 2, 3].map((i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          aria-label={`Digit ${i + 1}`}
          value={value[i] || ''}
          disabled={disabled}
          onChange={(e) => {
            const d = e.target.value.replace(/\D/g, '').slice(-1);
            if (d) set(value.slice(0, i) + d + value.slice(i + 1));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault();
              const at = value[i] ? i : Math.max(0, i - 1);
              onChange(value.slice(0, at));
              refs.current[at]?.focus();
            } else if (e.key === 'ArrowLeft') refs.current[Math.max(0, i - 1)]?.focus();
            else if (e.key === 'ArrowRight') refs.current[Math.min(3, i + 1)]?.focus();
          }}
          onPaste={(e) => {
            e.preventDefault();
            set(e.clipboardData.getData('text'));
          }}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}

function CopyButton({ text, label, notify }) {
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={`Copy ${label}`}
      title="Copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          notify({ type: 'ok', text: `${label} copied.` });
        } catch {}
      }}
    >
      <Icon name="copy" size={13} />
    </button>
  );
}

export default function Activation({ status: st, notice, onClose, notify }) {
  const [renewing, setRenewing] = useState(false);
  const [plan, setPlan] = useState(st?.plan || 'monthly');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activated, setActivated] = useState(null);

  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const plans = st?.plans || [];
  const planInfo = plans.find((x) => x.id === plan);
  let stage;
  if (activated) stage = 'done';
  else if (!st) stage = 'loading';
  else if (!st.configured) stage = 'unconfigured';
  else if (st.state === 'active' && !renewing) stage = 'plan';
  else stage = 'choose';

  const message = st && planInfo
    ? [
        `Hello, I would like the Lead Finder ${planInfo.name} plan (${planInfo.priceLabel}).`,
        `Activation ID: ${st.activationId}`,
        st.state === 'active' && st.expiresAt ? `My current plan ends on ${st.expiresAt.slice(0, 10)}.` : null,
      ].filter(Boolean).join('\n')
    : '';

  async function activate(e, value = code) {
    e?.preventDefault();
    if (value.length !== 4 || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await window.leadFinder.activate(value, plan);
      if (r.ok) setActivated(r);
      else {
        setError(r.error);
        setCode('');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function contact(kind) {
    const r = await window.leadFinder.contactAdmin(kind, message).catch(() => ({ ok: false }));
    if (!r.ok) notify({ type: 'error', text: 'No contact number is set up in this copy of Lead Finder.' });
  }

  const chip = !st ? null : st.state === 'active' ? ['Active', 'accent'] : st.state === 'expired' ? ['Ended', 'danger'] : null;
  const line = !st || st.state === 'none' ? 'Choose a plan to use Lead Finder' : st.state === 'expired' ? `${st.planName} ended ${fmtDate(st.expiresAt)}` : st.expiresAt ? `Until ${fmtDate(st.expiresAt)} · ${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'} left` : 'Never expires';

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sub-panel" role="dialog" aria-modal="true" aria-label="Subscription">
        <header className="sub-head">
          <div className="sub-title">
            <h2>{st?.state === 'active' || st?.state === 'expired' ? `${st.planName} plan` : 'Activate Lead Finder'}</h2>
            <p className="sub-line">{line}</p>
          </div>
          {chip && <span className={`sub-chip tone-${chip[1]}`}>{chip[0]}</span>}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>

        {notice && (
          <p className="sub-notice" role="alert">
            <Icon name="alert" size={14} /> {notice}
          </p>
        )}

        <div className="sub-stage" key={stage}>
          {stage === 'loading' && <p className="muted">Checking…</p>}

          {stage === 'unconfigured' && <p className="muted">Activation is not set up in this copy of Lead Finder. Please install the latest version.</p>}

          {stage === 'plan' && (
            <>
              <p className="act-id">
                <span className="muted">Activation ID</span>
                <span className="mono">{st.activationId}</span>
              </p>
              {st.expiresAt && (
                <button type="button" className="link-btn" onClick={() => setRenewing(true)}>
                  Renew or upgrade
                </button>
              )}
            </>
          )}

          {stage === 'choose' && (
            <form className="act-form" noValidate onSubmit={activate}>
              <div className="act-step">
                <span className="act-num">1</span>
                <div>
                  <h3>Choose a plan</h3>
                  <div className="plan-options" role="radiogroup" aria-label="Plan">
                    {plans.map((x) => (
                      <label key={x.id} className={`plan-opt ${plan === x.id ? 'on' : ''}`}>
                        <input type="radio" name="plan" value={x.id} checked={plan === x.id} onChange={() => (setPlan(x.id), setError(''))} />
                        <span className="po-name">{x.name}</span>
                        <span className="po-daily">{x.months ? `${x.months} month${x.months === 1 ? '' : 's'}` : 'Never expires'}</span>
                        <span className="po-price">{x.priceLabel}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="act-step">
                <span className="act-num">2</span>
                <div>
                  <h3>Send us your Activation ID</h3>
                  <p className="act-id">
                    <span className="mono" data-testid="activation-id">{st.activationId}</span>
                    <CopyButton text={st.activationId} label="Activation ID" notify={notify} />
                  </p>
                  <p className="muted act-help">Pay for the plan, then send this ID and your plan. You get a 4-digit activation code for this computer.</p>
                  {st.contact && (
                    <div className="act-contact">
                      <button type="button" className="btn btn-sm" onClick={() => contact('whatsapp')}>
                        <Icon name="send" size={13} /> WhatsApp
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => contact('call')}>
                        Call {st.contact.phone}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="act-step">
                <span className="act-num">3</span>
                <div>
                  <h3>Enter the 4-digit code</h3>
                  <CodeInput value={code} onChange={(v) => (setCode(v), setError(''))} onComplete={(v) => activate(null, v)} disabled={busy} invalid={Boolean(error)} />
                </div>
              </div>

              <button type="submit" className="btn btn-primary act-submit" disabled={code.length !== 4 || busy}>
                {busy ? <span className="spinner" aria-hidden="true" /> : null}
                Activate {planInfo?.name}
              </button>
              {renewing && (
                <button type="button" className="link-btn" onClick={() => (setRenewing(false), setError(''))}>
                  Back
                </button>
              )}
              {error && (
                <p className="sub-error" role="alert">
                  {error}
                </p>
              )}
            </form>
          )}

          {stage === 'done' && (
            <div className="act-done">
              <span className="done-mark">
                <Icon name="check" size={20} />
              </span>
              <h3>{activated.planName} plan activated</h3>
              <p className="muted">{activated.expiresAt ? `Until ${fmtDate(activated.expiresAt)}` : 'Never expires'}</p>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
