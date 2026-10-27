import { useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';

// The subscription panel: the plan, today's qualified leads, and activation
// (choose a plan -> the administrator gets a 4-digit code and gives it to the
// customer -> enter it). Everything shown comes from the subscription
// server's signed status.

const FALLBACK = {
  plans: [
    { id: 'monthly', name: 'Monthly', priceLabel: 'PKR 3,000', daily: { total: 100 } },
    { id: 'six_months', name: 'Six Months', priceLabel: 'PKR 10,000', daily: { total: 250 } },
    { id: 'lifetime', name: 'One-Time', priceLabel: 'PKR 20,000', daily: null },
  ],
  paymentMethods: [
    { id: 'nayapay', name: 'NayaPay', account: '03245237429' },
    { id: 'jazzcash', name: 'JazzCash', account: '03245237429' },
    { id: 'easypaisa', name: 'Easypaisa', account: '03245237429' },
  ],
};

const UNREACHABLE = new Set(['offline', 'misconfigured', 'unconfigured', 'invalid']);

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const dailyText = (d) => (!d ? 'Unlimited' : d.total !== undefined ? `${d.total} leads a day` : `${d.maps} + ${d.facebook} a day`);

// Leads that can still be saved today (null = no limit).
function leadsLeft(c) {
  if (!c || c.scope === 'blocked') return 0;
  if (c.scope === 'unlimited') return null;
  return c.scope === 'per_source' ? c.maps.remaining + c.facebook.remaining : c.total.remaining;
}

// The plan pill in the app bar: { text, tone, attention }.
export function planPill(st) {
  if (!st) return { text: 'Plan…', tone: 'idle' };
  if (UNREACHABLE.has(st.reason)) return { text: 'Plan · offline', tone: 'warn' };
  const p = st.plan;
  if (p.state === 'suspended') return { text: 'Suspended', tone: 'danger' };
  const left = leadsLeft(st.credits);
  const attention = st.activation?.status === 'pending';
  return { text: left === null ? p.name : `${p.name} · ${left} left`, tone: left === 0 ? 'warn' : p.id !== 'free' ? 'accent' : 'idle', attention };
}

export function statusLine(st) {
  if (!st) return 'Checking subscription…';
  if (st.message) return st.message;
  const p = st.plan;
  return p.expiresAt ? `${p.name} until ${fmtDate(p.expiresAt)}` : p.id === 'free' ? 'Free plan' : `${p.name}, never expires`;
}

function Meter({ label, used, limit }) {
  const full = limit !== null && used >= limit;
  return (
    <div className={`meter ${full ? 'full' : ''}`}>
      <div className="meter-row">
        <span>{label}</span>
        <span className="num">
          {used}
          <span className="meter-of"> / {limit}</span>
        </span>
      </div>
      <div className="meter-bar" role="progressbar" aria-label={`${label} leads used today`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <span style={{ width: `${limit ? Math.min(100, (used / limit) * 100) : 0}%` }} />
      </div>
    </div>
  );
}

function Usage({ credits }) {
  if (!credits || credits.scope === 'blocked') return null;
  if (credits.scope === 'unlimited') {
    return (
      <div className="usage usage-unlimited">
        <span>Unlimited leads</span>
        <span className="num">
          {credits.total.used} today · {(credits.discovered ?? 0).toLocaleString()} found
        </span>
      </div>
    );
  }
  return (
    <div className="usage">
      {credits.scope === 'per_source' ? (
        <>
          <Meter label="Google Maps" {...credits.maps} />
          <Meter label="Facebook" {...credits.facebook} />
        </>
      ) : (
        <Meter label="Today" {...credits.total} />
      )}
      <p className="usage-reset">Resets {fmtTime(credits.resetsAt)}</p>
    </div>
  );
}

// Four single-digit boxes: typing moves on, Backspace moves back, pasting
// a code fills all four.
function CodeInput({ value, onChange, onComplete, disabled, invalid }) {
  const refs = useRef([]);
  useEffect(() => {
    if (!disabled) refs.current[Math.min(value.length, 3)]?.focus();
  }, [disabled]); // eslint-disable-line react-hooks/exhaustive-deps
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
            if (!d) return;
            set(value.slice(0, i) + d + value.slice(i + 1));
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

function Step({ icon, title, children }) {
  return (
    <div className="step">
      <span className="step-icon">
        <Icon name={icon} size={17} />
      </span>
      <div className="step-body">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export default function Subscription({ status: st, notice, onClose, onRefresh, notify }) {
  const [info, setInfo] = useState(FALLBACK);
  const [choosing, setChoosing] = useState(false); // choosing a plan instead of the current state
  const [plan, setPlan] = useState('monthly');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [activated, setActivated] = useState(null);
  const [now, setNow] = useState(Date.now());

  const p = st?.plan;
  const act = st?.activation;

  useEffect(() => {
    window.leadFinder.subscriptionPlans().then((d) => !d?.error && setInfo({ ...FALLBACK, ...d }), () => {});
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  useEffect(() => {
    if (!act) return;
    setPlan(act.plan);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [act?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const paidActive = p && p.state === 'active' && p.id !== 'free';
  let stage;
  if (activated) stage = 'done';
  else if (!st) stage = 'loading';
  else if (UNREACHABLE.has(st.reason)) stage = 'error';
  else if (p.state === 'suspended') stage = 'suspended';
  else if (act && !choosing) stage = 'code';
  else if (choosing || !paidActive) stage = p.id === 'lifetime' && paidActive ? 'plan' : 'choose';
  else stage = 'plan';

  async function run(name, fn) {
    setBusy(name);
    setError('');
    try {
      const r = await fn();
      if (!r.ok) setError(r.error);
      return r;
    } finally {
      setBusy('');
    }
  }

  async function requestCode(e) {
    e.preventDefault();
    const r = await run('request', () => window.leadFinder.requestActivation(plan));
    if (r.ok) {
      setChoosing(false);
      setCode('');
    }
  }

  async function activate(value = code) {
    if (value.length !== 4 || busy) return;
    const r = await run('verify', () => window.leadFinder.verifyActivationCode(value));
    if (r.ok) setActivated({ plan: r.plan, expiresAt: r.expiresAt });
    else setCode('');
  }

  const resendIn = act?.code?.resendAt ? Math.max(0, Math.ceil((Date.parse(act.code.resendAt) - now) / 1000)) : 0;
  const paid = info.plans.filter((x) => x.id !== 'free');
  const planName = (id) => info.plans.find((x) => x.id === id)?.name || '';
  // One line for the payment accounts (they share a number).
  const accounts = Object.entries(info.paymentMethods.reduce((m, x) => ((m[x.account] ||= []).push(x.name), m), {}));
  // The title already says "Free": the chip only marks a state worth noticing.
  const chip = !p ? null : p.state === 'suspended' ? ['Suspended', 'danger'] : p.state === 'expired' ? ['Expired', 'warn'] : paidActive ? ['Active', 'accent'] : null;
  const line = !p
    ? ''
    : p.state === 'expired'
      ? `${planName(p.expiredPlan) || 'Your plan'} ended ${fmtDate(p.expiresAt)}`
      : paidActive
        ? p.expiresAt
          ? `Until ${fmtDate(p.expiresAt)} · ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left`
          : 'Never expires'
        : p.state === 'suspended'
          ? 'Contact Axora Web Solutions to restore access.'
          : '';

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sub-panel" role="dialog" aria-modal="true" aria-label="Subscription">
        <header className="sub-head">
          <div className="sub-title">
            <h2>{p?.name || 'Subscription'}</h2>
            {line && <p className="sub-line">{line}</p>}
          </div>
          {chip && <span className={`sub-chip tone-${chip[1]}`}>{chip[0]}</span>}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>

        {notice && !UNREACHABLE.has(st?.reason) && notice !== st?.message && (
          <p className="sub-notice" role="alert">
            <Icon name="alert" size={14} /> {notice}
          </p>
        )}
        {stage !== 'error' && <Usage credits={st?.credits} />}

        <div className="sub-stage" key={stage}>
          {stage === 'loading' && <p className="muted sub-loading">Checking…</p>}

          {stage === 'error' && (
            <Step icon="alert" title="Can't reach the subscription server">
              <p>{st.message}</p>
              <button type="button" className="btn btn-sm" onClick={onRefresh}>
                Try again
              </button>
            </Step>
          )}

          {stage === 'choose' && (
            <form className="act-form" noValidate onSubmit={requestCode}>
              <div className="plan-options" role="radiogroup" aria-label="Plan">
                {paid.map((x) => (
                  <label key={x.id} className={`plan-opt ${plan === x.id ? 'on' : ''}`}>
                    <input type="radio" name="plan" value={x.id} checked={plan === x.id} onChange={() => setPlan(x.id)} />
                    <span className="po-name">{x.name}</span>
                    <span className="po-daily">{dailyText(x.daily)}</span>
                    <span className="po-price">{x.priceLabel}</span>
                  </label>
                ))}
              </div>
              {accounts.map(([account, names]) => (
                <p key={account} className="pay-line">
                  <span className="muted">Pay to</span>
                  <span className="mono">{account}</span>
                  <span className="muted pay-names">{names.join(' · ')}</span>
                  <CopyButton text={account} label="Account number" notify={notify} />
                </p>
              ))}
              <button type="submit" className="btn btn-primary act-submit" disabled={busy === 'request'}>
                {busy === 'request' ? <span className="spinner" aria-hidden="true" /> : null}
                Get activation code
              </button>
              {choosing && act && (
                <button type="button" className="link-btn" onClick={() => setChoosing(false)}>
                  Back
                </button>
              )}
            </form>
          )}

          {stage === 'code' && (
            <div className="verify">
              <h3>Enter activation code</h3>
              <p className="muted">
                {planName(act.plan)} · <span className="mono">{act.id}</span>
              </p>
              <CodeInput value={code} onChange={(v) => (setCode(v), setError(''))} onComplete={activate} disabled={busy === 'verify'} invalid={Boolean(error)} />
              <button type="button" className="btn btn-primary verify-btn" disabled={code.length !== 4 || busy === 'verify'} onClick={() => activate()}>
                {busy === 'verify' ? <span className="spinner" aria-hidden="true" /> : null}
                Activate
              </button>
              <div className="verify-links">
                <button type="button" className="link-btn" disabled={resendIn > 0 || busy === 'resend'} onClick={() => run('resend', () => window.leadFinder.resendActivationCode()).then((r) => r.ok && setCode(''))}>
                  {resendIn > 0 ? `New code in ${Math.floor(resendIn / 60)}:${String(resendIn % 60).padStart(2, '0')}` : 'New code'}
                </button>
                <button type="button" className="link-btn" onClick={() => (setChoosing(true), setError(''))}>
                  Change plan
                </button>
              </div>
            </div>
          )}

          {stage === 'done' && (
            <div className="act-done">
              <span className="done-mark">
                <Icon name="check" size={20} />
              </span>
              <h3>{planName(activated.plan) || 'Plan'} activated</h3>
              <p className="muted">{activated.expiresAt ? `Until ${fmtDate(activated.expiresAt)}` : 'Never expires'}</p>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          )}

          {stage === 'plan' && p.id !== 'lifetime' && (
            <button type="button" className="link-btn" onClick={() => setChoosing(true)}>
              Renew or upgrade
            </button>
          )}

          {error && (
            <p className="sub-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
