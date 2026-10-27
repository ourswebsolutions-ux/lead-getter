import { useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';

// The subscription panel. Choose a plan and click Activate: the app emails
// a 6-digit code to the administrator (never to you). Contact the
// administrator by WhatsApp or phone, pay, receive the code, and enter it
// here. Codes are made and checked in the main process (activation.js); the
// window never sees them.

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const LEN = 6;

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

// Single-digit boxes: typing moves on, Backspace moves back, pasting a code
// fills them all.
function CodeInput({ value, onChange, disabled, invalid }) {
  const refs = useRef([]);
  useEffect(() => {
    refs.current[0]?.focus();
  }, []);
  const set = (next) => {
    const v = next.replace(/\D/g, '').slice(0, LEN);
    onChange(v);
    refs.current[Math.min(v.length, LEN - 1)]?.focus();
  };
  return (
    <div className={`code ${invalid ? 'invalid' : ''}`} role="group" aria-label="Activation code">
      {Array.from({ length: LEN }, (_, i) => (
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
            else if (e.key === 'ArrowRight') refs.current[Math.min(LEN - 1, i + 1)]?.focus();
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

async function copy(text, label, notify) {
  try {
    await navigator.clipboard.writeText(text);
    notify({ type: 'ok', text: `${label} copied.` });
  } catch {}
}

export default function Activation({ status: st, notice, onClose, notify }) {
  const [choosing, setChoosing] = useState(false); // renewing, or changing plan after a request
  const [plan, setPlan] = useState(st?.pending?.plan || st?.plan || 'monthly');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(''); // '' | 'request' | 'verify'
  const [error, setError] = useState('');
  const [activated, setActivated] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, busy]);
  const pending = st?.pending && st.pending.plan === plan ? st.pending : null;
  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending?.expiresAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const plans = st?.plans || [];
  const planInfo = plans.find((x) => x.id === plan);
  const codeExpired = Boolean(pending) && Date.parse(pending.expiresAt) <= now;
  let stage;
  if (activated) stage = 'done';
  else if (!st) stage = 'loading';
  else if (!st.configured) stage = 'unconfigured';
  else if (st.state === 'active' && (!st.expiresAt || (!choosing && !st.pending))) stage = 'plan';
  else if (pending && !choosing) stage = 'code';
  else stage = 'choose';

  const message = st && planInfo
    ? [
        'Hello, I would like to activate Lead Finder.',
        `Activation ID: ${st.activationId}`,
        `Plan: ${planInfo.name} (${planInfo.priceLabel})`,
        st.state === 'active' && st.expiresAt ? `My current plan ends on ${st.expiresAt.slice(0, 10)}.` : null,
      ].filter(Boolean).join('\n')
    : '';

  async function requestCode() {
    if (busy) return;
    setBusy('request');
    setError('');
    setCode('');
    try {
      const r = await window.leadFinder.requestActivation(plan);
      if (r.ok) setChoosing(false);
      else setError(r.error);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function verify(e) {
    e.preventDefault();
    if (code.length !== LEN || busy) return;
    setBusy('verify');
    setError('');
    try {
      const r = await window.leadFinder.verifyActivation(code, plan);
      if (r.ok) setActivated(r);
      else {
        setError(r.error);
        setCode('');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function contact(kind) {
    const r = await window.leadFinder.contactAdmin(kind, message).catch(() => ({ ok: false }));
    if (!r.ok) notify({ type: 'error', text: 'No contact number is set up in this copy of Lead Finder.' });
  }

  const chip = !st ? null : st.state === 'active' ? ['Active', 'accent'] : st.state === 'expired' ? ['Ended', 'danger'] : null;
  const line = !st || st.state === 'none' ? 'Choose a plan to use Lead Finder' : st.state === 'expired' ? `${st.planName} ended ${fmtDate(st.expiresAt)}` : st.expiresAt ? `Until ${fmtDate(st.expiresAt)} · ${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'} left` : 'Never expires';
  const minsLeft = pending ? Math.max(0, Math.ceil((Date.parse(pending.expiresAt) - now) / 60_000)) : 0;

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sub-panel" role="dialog" aria-modal="true" aria-label="Subscription">
        <header className="sub-head">
          <div className="sub-title">
            <h2>{st?.state === 'active' || st?.state === 'expired' ? `${st.planName} plan` : 'Activate Lead Finder'}</h2>
            <p className="sub-line">{line}</p>
          </div>
          {chip && <span className={`sub-chip tone-${chip[1]}`}>{chip[0]}</span>}
          <button type="button" className="icon-btn" aria-label="Close" disabled={Boolean(busy)} onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>

        {notice && stage !== 'done' && (
          <p className="sub-notice" role="alert">
            <Icon name="alert" size={14} /> {notice}
          </p>
        )}

        <div className="sub-stage" key={stage}>
          {stage === 'loading' && <p className="muted">Checking…</p>}

          {stage === 'unconfigured' && (
            <p className="sub-notice" role="alert">
              <Icon name="alert" size={14} />
              <span>
                Activation can't send codes yet: these settings are missing: <b>{st.missing?.join(', ') || 'email settings'}</b>. Set them in tools/activation/.env (see .env.example) and restart the app. Until then, contact us on WhatsApp{st.contact?.phone ? ` ${st.contact.phone}` : ''}.
              </span>
            </p>
          )}

          {stage === 'plan' && (
            <>
              <p className="act-id">
                <span className="muted">Activation ID</span>
                <span className="mono">{st.activationId}</span>
              </p>
              {st.expiresAt && (
                <button type="button" className="link-btn" onClick={() => setChoosing(true)}>
                  Renew or upgrade
                </button>
              )}
            </>
          )}

          {stage === 'choose' && (
            <div className="act-form">
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
                  <h3>Your Activation ID</h3>
                  <p className="act-id">
                    <span className="mono" data-testid="activation-id">{st.activationId}</span>
                    <button type="button" className="icon-btn" aria-label="Copy Activation ID" title="Copy" onClick={() => copy(st.activationId, 'Activation ID', notify)}>
                      <Icon name="copy" size={13} />
                    </button>
                  </p>
                  <p className="muted act-help">Click Activate to request a 6-digit code for this computer and plan. The code goes to us, not to you: you receive it from us after payment.</p>
                </div>
              </div>
              <button type="button" className="btn btn-primary act-submit" disabled={Boolean(busy)} onClick={requestCode}>
                {busy === 'request' ? <span className="spinner" aria-hidden="true" /> : null}
                {busy === 'request' ? 'Sending request…' : `Activate ${planInfo?.name}`}
              </button>
              {choosing && (st.state === 'active' || st.pending) && (
                <button type="button" className="link-btn" onClick={() => (setChoosing(false), setPlan(st.pending?.plan || plan), setError(''))}>
                  Back
                </button>
              )}
            </div>
          )}

          {stage === 'code' && (
            <form className="act-form" noValidate onSubmit={verify}>
              <div className="act-sent" role="status">
                <h3>
                  Request sent: {pending.planName} ({planInfo?.priceLabel})
                </h3>
                <p>
                  Contact us on <b>WhatsApp {st.contact?.phone}</b> or call to pay and receive your 6-digit code. Send your Activation ID <span className="mono">{st.activationId}</span> and plan.
                </p>
                <p className={`act-timer ${codeExpired ? 'expired' : ''}`}>
                  {codeExpired ? 'This code has expired. Send a new code below.' : `The code expires at ${fmtTime(pending.expiresAt)} (${minsLeft} min) · ${pending.triesLeft} ${pending.triesLeft === 1 ? "try" : "tries"} left`}
                </p>
              </div>
              {st.contact && (
                <div className="act-contact">
                  <button type="button" className="btn btn-sm" onClick={() => contact('whatsapp')}>
                    <Icon name="send" size={13} /> WhatsApp
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => contact('call')}>
                    Call
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => copy(message, 'Activation ID and plan', notify)}>
                    <Icon name="copy" size={13} /> Copy ID & plan
                  </button>
                </div>
              )}
              <div>
                <h3 className="act-h">Enter the code</h3>
                <CodeInput value={code} onChange={(v) => (setCode(v), setError(''))} disabled={Boolean(busy) || codeExpired} invalid={Boolean(error)} />
              </div>
              <button type="submit" className="btn btn-primary act-submit" disabled={code.length !== LEN || Boolean(busy) || codeExpired}>
                {busy === 'verify' ? <span className="spinner" aria-hidden="true" /> : null}
                Verify & Activate
              </button>
              <div className="act-links">
                <button type="button" className="link-btn" disabled={Boolean(busy)} onClick={requestCode}>
                  {busy === 'request' ? 'Sending…' : 'Send a new code'}
                </button>
                <button type="button" className="link-btn" disabled={Boolean(busy)} onClick={() => (setChoosing(true), setError(''))}>
                  Change plan
                </button>
              </div>
            </form>
          )}

          {error && (
            <p className="sub-error" role="alert">
              {error}
            </p>
          )}

          {stage === 'done' && (
            <div className="act-done">
              <span className="done-mark">
                <Icon name="check" size={20} />
              </span>
              <h3>{activated.planName} plan activated</h3>
              <p className="muted">{activated.expiresAt ? `Valid until ${fmtDate(activated.expiresAt)}` : 'Never expires'}</p>
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
