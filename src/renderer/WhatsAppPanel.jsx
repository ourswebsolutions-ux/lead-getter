import { useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';

// Header control for the linked WhatsApp account: status pill plus a small
// popover with the QR code, connection state and check progress.

const LABEL = {
  open: 'WhatsApp connected',
  qr: 'Scan QR code',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  qr_expired: 'QR expired',
  logged_out: 'WhatsApp not linked',
  disconnected: 'WhatsApp off',
  error: 'WhatsApp error',
  unavailable: 'WhatsApp unavailable',
};

export default function WhatsAppPanel({ wa }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const s = wa?.state || 'disconnected';

  // Show the QR as soon as one is issued.
  useEffect(() => {
    if (s === 'qr') setOpen(true);
  }, [s]);

  useEffect(() => {
    if (!open) return;
    const away = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const run = (fn) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const tone = s === 'open' ? 'ok' : ['qr', 'connecting', 'reconnecting'].includes(s) ? 'wait' : s === 'error' ? 'bad' : '';
  const p = wa?.progress;

  return (
    <div className="wa-panel" ref={ref}>
      <button type="button" className={`wa-pill ${tone}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <Icon name="chat" size={14} />
        <span>{LABEL[s] || 'WhatsApp'}</span>
      </button>
      {open && (
        <div className="menu wa-menu" role="dialog" aria-label="WhatsApp connection">
          <div className="menu-head">
            <span className="menu-title">WhatsApp</span>
            <span className="menu-state">
              {s === 'open' && wa.account ? `Linked to +${wa.account.id}${wa.account.name ? ` · ${wa.account.name}` : ''}` : LABEL[s]}
            </span>
          </div>

          {s === 'unavailable' && <p className="menu-note wa-err">{wa?.error || 'WhatsApp is not available on this computer.'}</p>}

          {s === 'qr' && wa.qr && (
            <div className="wa-qr">
              <img src={wa.qr} alt="WhatsApp linking QR code" width="232" height="232" />
              <ol>
                <li>Open WhatsApp on your phone</li>
                <li>Settings → Linked devices → Link a device</li>
                <li>Scan this code. It refreshes automatically.</li>
              </ol>
            </div>
          )}

          {(s === 'connecting' || s === 'reconnecting') && (
            <p className="menu-note wa-wait">
              <span className="spinner" aria-hidden="true" />
              {wa.error || 'Connecting to WhatsApp…'}
            </p>
          )}

          {s === 'open' && p && (
            <dl className="wa-progress">
              <div>
                <dt>Checked</dt>
                <dd className="num">
                  {p.checked} / {p.total}
                </dd>
              </div>
              <div>
                <dt>On WhatsApp</dt>
                <dd className="num tone-wa">{p.available}</dd>
              </div>
              <div>
                <dt>Failed</dt>
                <dd className="num">{p.failed}</dd>
              </div>
            </dl>
          )}

          {(s === 'error' || s === 'qr_expired' || (s === 'logged_out' && wa.error)) && (
            <p className="menu-note wa-err">{s === 'qr_expired' ? 'The QR code expired before it was scanned.' : wa.error}</p>
          )}

          {['disconnected', 'logged_out', 'qr_expired', 'error'].includes(s) && (
            <>
              <p className="menu-note">
                Links your own WhatsApp account through WhatsApp Web (Baileys). This is <b>not an official WhatsApp API</b>: WhatsApp may restrict accounts used this way, especially for messages to
                people who don't know you. Saved lead numbers are then checked automatically; messages are only sent when you press Send.
              </p>
              <button type="button" className="btn btn-primary wa-link" disabled={busy} onClick={run(() => window.leadFinder.whatsappConnect())}>
                {s === 'qr_expired' ? 'Show a new QR code' : s === 'disconnected' && wa.account ? 'Reconnect' : 'Link WhatsApp'}
              </button>
            </>
          )}

          {(s === 'open' || s === 'qr' || s === 'reconnecting') && (
            <div className="wa-actions">
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={run(() => window.leadFinder.whatsappDisconnect())}>
                {s === 'qr' ? 'Cancel' : 'Disconnect'}
              </button>
              {s !== 'qr' && (
                <button type="button" className="btn btn-sm btn-ghost btn-danger-text" disabled={busy} onClick={run(() => window.leadFinder.whatsappLogout())}>
                  Unlink device
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
