import { useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';

// Message composer for one lead. Nothing is sent until the user presses
// Send; the result shown is WhatsApp's actual response.

const MAX = 4000;

export default function Composer({ lead, connected, onClose, notify }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [last, setLast] = useState(null);
  const area = useRef(null);

  useEffect(() => {
    area.current?.focus();
    window.leadFinder.whatsappLastMessage(lead.id).then(setLast).catch(() => {});
    const esc = (e) => e.key === 'Escape' && !sending && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [lead.id, onClose, sending]);

  async function send(e) {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await window.leadFinder.whatsappSend(lead.id, text);
      if (res.ok) {
        notify({ type: 'ok', text: `Message sent to ${lead.name} (${lead.phone}).` });
        onClose();
      } else setError(res.error);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && !sending && onClose()}>
      <form className="composer" role="dialog" aria-modal="true" aria-label={`Message ${lead.name}`} onSubmit={send}>
        <header className="composer-head">
          <span className="composer-icon">
            <Icon name="chat" size={18} />
          </span>
          <div>
            <strong dir="auto">{lead.name}</strong>
            <span className="mono tone-wa">{lead.phone}</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" disabled={sending} onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        {last && (
          <p className="composer-note">
            You last messaged this number on {new Date(last.sentAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.
          </p>
        )}
        <label className="sr-only" htmlFor="wa-text">
          Message
        </label>
        <textarea
          id="wa-text"
          ref={area}
          value={text}
          maxLength={MAX}
          rows={7}
          dir="auto"
          placeholder={`Write your message to ${lead.name}…`}
          onChange={(e) => setText(e.target.value)}
          disabled={sending}
        />
        <div className="composer-meta">
          <span className="muted">Sent from your linked WhatsApp account, to this lead only.</span>
          <span className="num muted">
            {text.length}/{MAX}
          </span>
        </div>
        {!connected && <p className="composer-error">WhatsApp is not connected. Link it from the header first.</p>}
        {error && (
          <p className="composer-error" role="alert">
            {error}
          </p>
        )}
        <footer className="composer-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || sending || !connected}>
            {sending ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" />} {sending ? 'Sending…' : 'Send'}
          </button>
        </footer>
      </form>
    </div>
  );
}
