import { useEffect, useState } from 'react';
import Icon from './icons.jsx';

// Plans and the subscription application form. Applications go to the
// licence server, which emails the administrator; nothing is activated here.

// Built-in copy of the plans and payment accounts, so they are always
// visible. Applying and approval still go through the licence server.
const FALLBACK = {
  plans: [
    { id: 'monthly', name: 'Monthly', priceLabel: 'PKR 3,000', duration: '1 month' },
    { id: 'six_months', name: 'Six Months', priceLabel: 'PKR 10,000', duration: '6 months' },
    { id: 'lifetime', name: 'Lifetime', priceLabel: 'PKR 20,000', duration: 'One-time payment, never expires' },
  ],
  paymentMethods: [
    { id: 'nayapay', name: 'NayaPay', account: '03245237429' },
    { id: 'jazzcash', name: 'JazzCash', account: '03245237429' },
    { id: 'easypaisa', name: 'Easypaisa', account: '03245237429' },
  ],
  paymentInstructions: '',
};

function PaymentBox({ plan, methods, notify }) {
  const copy = async (m) => {
    try {
      await navigator.clipboard.writeText(m.account);
      notify({ type: 'ok', text: `${m.name} number copied.` });
    } catch {}
  };
  return (
    <div className="pay-box">
      <p className="pay-title">
        Send <b>{plan.priceLabel}</b> for the <b>{plan.name}</b> plan to any of these accounts, then upload the payment screenshot.
      </p>
      <ul className="pay-methods">
        {methods.map((m) => (
          <li key={m.id}>
            <span className="pay-name">{m.name}</span>
            <span className="mono pay-account">{m.account}</span>
            <span className="pay-amount">{plan.priceLabel}</span>
            <button type="button" className="icon-btn" aria-label={`Copy ${m.name} number`} title="Copy number" onClick={() => copy(m)}>
              <Icon name="copy" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

export function statusLine(st) {
  if (!st) return 'Checking subscription…';
  const sub = st.subscription || {};
  if (st.reason === 'active') return sub.expiresAt ? `${planName(sub.plan)} · active until ${fmtDate(sub.expiresAt)}` : `${planName(sub.plan)} · lifetime access`;
  if (st.reason === 'trial') return `Free trial: ${st.trial.remaining} of ${st.trial.limit} free searches left.`;
  return st.message;
}

const planName = (id) => ({ monthly: 'Monthly', six_months: 'Six Months', lifetime: 'Lifetime' })[id] || id || '';

export default function Plans({ status, notice, onClose, notify }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(''); // submitting
  const [loadError, setLoadError] = useState(''); // plans could not be fetched
  const [plan, setPlan] = useState(null); // selected for applying
  const [shot, setShot] = useState(null);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    window.leadFinder.subscriptionPlans().then((d) => {
      if (d.error) {
        setLoadError(d.error);
        setData(FALLBACK);
      } else setData({ ...FALLBACK, ...d });
    });
    const esc = (e) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, busy]);

  const pendingCount = status?.pendingApplications || 0;

  async function pick() {
    const r = await window.leadFinder.pickScreenshot();
    if (r.ok) setShot(r);
    else if (!r.canceled) notify({ type: 'error', text: r.error });
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await window.leadFinder.applySubscription({ plan: plan.id, message, email });
      if (r.ok) setDone(r);
      else setError(r.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="plans" role="dialog" aria-modal="true" aria-label="Subscription plans">
        <header className="plans-head">
          <div>
            <h2>{done ? 'Application submitted' : plan ? `Apply for ${plan.name}` : 'Subscription plans'}</h2>
            <p className={`plans-status reason-${status?.reason || 'none'}`}>{statusLine(status)}</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>

        {notice && notice !== status?.message && !done && !plan && <p className="plans-notice">{notice}</p>}

        {done ? (
          <div className="plans-done">
            <span className="celebration-icon">
              <Icon name="check" size={18} />
            </span>
            <div>
              <p>
                Your application <b className="mono">{done.applicationId}</b> has been submitted and is <b>Pending Approval</b>.
              </p>
              <p className="muted">
                You can keep this window closed; access starts automatically once it is approved.
                {done.emailVerificationSent ? ' Check your inbox to confirm your email address for notifications.' : ''}
              </p>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : !plan ? (
          <>
            {!data && <p className="muted plans-loading">Loading plans…</p>}
            {loadError && <p className="composer-error">{loadError}</p>}
            {pendingCount > 0 && status.application?.status === 'pending' && (
              <p className="plans-notice">
                {pendingCount === 1 ? 'Application' : `${pendingCount} applications are awaiting approval; the latest,`} <b className="mono">{status.application.id}</b> ({planName(status.application.plan)}), was submitted on{' '}
                {fmtDate(status.application.createdAt)}
                {pendingCount === 1 ? ' and is awaiting approval' : ''}. You can still submit another request.
              </p>
            )}
            {data && (
              <div className="plan-grid">
                {data.plans.map((p) => (
                  <article key={p.id} className={`plan-card ${p.id === 'lifetime' ? 'featured' : ''}`}>
                    <h3>{p.name}</h3>
                    <p className="plan-price">{p.priceLabel}</p>
                    <p className="plan-duration">{p.duration}</p>
                    <button type="button" className={`btn ${p.id === 'lifetime' ? 'btn-primary' : ''}`} onClick={() => setPlan(p)}>
                      Apply for Subscription
                    </button>
                  </article>
                ))}
              </div>
            )}
          </>
        ) : (
          <form className="apply-form" onSubmit={submit}>
            <fieldset className="plan-choice">
              <legend>Plan</legend>
              {data.plans.map((p) => (
                <label key={p.id} className={plan.id === p.id ? 'on' : ''}>
                  <input type="radio" name="plan" checked={plan.id === p.id} onChange={() => setPlan(p)} />
                  <span>{p.name}</span>
                  <b>{p.priceLabel}</b>
                </label>
              ))}
            </fieldset>
            <PaymentBox plan={plan} methods={data.paymentMethods} notify={notify} />
            {data.paymentInstructions && <p className="plans-notice pre">{data.paymentInstructions}</p>}
            <div className="shot-field">
              <span className="field-label">Payment screenshot</span>
              <div className="shot-row">
                {shot ? <img src={shot.preview} alt="Payment screenshot preview" /> : <span className="shot-empty">PNG, JPEG or WebP, up to 5 MB</span>}
                <button type="button" className="btn" onClick={pick}>
                  {shot ? 'Change…' : 'Choose image…'}
                </button>
              </div>
              {shot && <span className="muted shot-name">{shot.name}</span>}
            </div>
            <label className="apply-field">
              <span className="field-label">Message or transaction ID (optional)</span>
              <textarea rows={2} maxLength={1000} value={message} placeholder={`e.g. Paid ${plan.priceLabel} by JazzCash`} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <label className="apply-field">
              <span className="field-label">Email (optional, for approval notifications)</span>
              <input type="email" value={email} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} />
            </label>
            {error && (
              <p className="composer-error" role="alert">
                {error}
              </p>
            )}
            <footer className="composer-actions">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPlan(null)}>
                Back
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !shot}>
                {busy ? <span className="spinner" aria-hidden="true" /> : null} {busy ? 'Submitting…' : 'Submit application'}
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}
