import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';

// The Assistant: talk to Lead Finder in English, Urdu or Roman Urdu. The AI
// (Groq) runs the app's own actions; sending, deleting and settings changes
// wait for the user's Confirm.

const api = window.leadFinder;

const EXAMPLES = ['Software ka current status batao', 'Aaj kitne leads aaye?', 'WhatsApp campaign start karo', 'Email campaign banao real estate leads ke liye', 'Campaign ki progress batao', 'Kitne emails fail huay?'];
const time = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

// **bold**, `code` and line breaks; everything else as plain text.
function Rich({ text }) {
  return String(text || '')
    .split('\n')
    .map((line, i, all) => (
      <Fragment key={i}>
        {line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, j) =>
          part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={j}>{part.slice(2, -2)}</strong> : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={j}>{part.slice(1, -1)}</code> : <Fragment key={j}>{part}</Fragment>,
        )}
        {i < all.length - 1 && <br />}
      </Fragment>
    ));
}

function Actions({ actions }) {
  if (!actions?.length) return null;
  return (
    <ul className="ai-actions" aria-label="Actions">
      {actions.map((a, i) => (
        <li key={i} className={`ai-act k-${a.kind} ${a.ok ? 'ok' : 'bad'}`}>
          <Icon name={!a.ok ? 'alert' : a.kind === 'pending' ? 'lock' : a.kind === 'cancelled' ? 'x' : 'check'} size={12} />
          <span>{a.kind === 'pending' ? `Needs your confirmation: ${a.label}` : a.ok ? a.label : a.error || a.label}</span>
        </li>
      ))}
    </ul>
  );
}

function LiveStrip({ hidden }) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    if (hidden) return undefined;
    let live = true;
    const load = async () => {
      const [em, wa] = await Promise.all([api.emailCampaigns().catch(() => null), api.outreachOverview?.().catch(() => null)]);
      if (!live) return;
      const list = [];
      for (const c of em?.campaigns || []) if (['running', 'paused'].includes(c.status)) list.push({ key: `e${c.id}`, ch: 'mail', name: c.name, status: c.status, text: `${c.counts.sent}/${c.counts.total} sent${c.counts.failed ? ` · ${c.counts.failed} failed` : ''}` });
      for (const c of wa?.campaigns || []) if (['running', 'paused'].includes(c.status) && !c.test) list.push({ key: `w${c.id}`, ch: 'chat', name: c.name, status: c.status, text: `${(c.counts?.done || 0) + (c.counts?.active || 0)}/${c.contacts} contacted${c.counts?.failed ? ` · ${c.counts.failed} failed` : ''}` });
      setItems(list);
    };
    load();
    const t = setInterval(load, 8000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [hidden]);
  if (!items.length) return null;
  return (
    <div className="ai-live" aria-label="Running campaigns">
      {items.map((c) => (
        <span key={c.key} className={`ai-live-item s-${c.status}`}>
          <Icon name={c.ch} size={12} />
          <strong>{c.name}</strong>
          <span>{c.status === 'paused' ? 'Paused' : 'Running'} · {c.text}</span>
        </span>
      ))}
    </div>
  );
}

export default function AssistantView({ hidden, notify, onOpenSettings }) {
  const [settings, setSettings] = useState(null);
  const [display, setDisplay] = useState([]);
  const [pending, setPending] = useState(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('');
  const scroller = useRef(null);
  const input = useRef(null);

  const load = useCallback(async () => {
    const [s, h] = await Promise.all([api.aiSettings(), api.aiHistory()]);
    setSettings(s);
    if (h.ok) {
      setDisplay(h.display || []);
      setPending(h.pending);
    }
  }, []);
  useEffect(() => {
    if (!hidden) load();
  }, [hidden, load]);
  useEffect(
    () =>
      api.onAiEvent((e) => {
        if (e.channel !== 'app') return;
        if (e.type === 'thinking') setActivity('Thinking…');
        else if (e.type === 'tool') setActivity(e.label ? `Running: ${e.label}` : `Working: ${String(e.tool || '').replace(/_/g, ' ')}`);
        else if (e.type === 'done') setActivity('');
      }),
    [],
  );
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [display, busy]);

  async function send(raw) {
    const msg = String(raw ?? text).trim();
    if ((!msg && !files.length) || busy) return;
    setBusy(true);
    setActivity('Thinking…');
    const at = Date.now();
    setDisplay((d) => [...d, { role: 'user', text: msg, files, at, local: true }]);
    setText('');
    const ids = files.map((f) => f.id);
    setFiles([]);
    const r = await api.aiSend(msg, ids).catch((e) => ({ ok: false, error: e.message }));
    setBusy(false);
    setActivity('');
    if (r.display) {
      setDisplay(r.display);
      setPending(r.pending);
    } else if (!r.ok) setDisplay((d) => [...d, { role: 'error', text: r.error, at: Date.now() }]);
    requestAnimationFrame(() => input.current?.focus());
  }

  async function attach() {
    const r = await api.aiAttach();
    if (r.canceled) return;
    if (r.error) notify?.({ type: 'error', text: r.error });
    if (r.files?.length) setFiles((f) => [...f, ...r.files].slice(0, 10));
  }

  async function clear() {
    if (!window.confirm('Start a new conversation? The assistant forgets this one (campaigns stay as they are).')) return;
    const r = await api.aiClear();
    setDisplay(r.display || []);
    setPending(null);
  }

  const ready = settings?.configured;
  return (
    <section className="ai-page" hidden={hidden} aria-label="Assistant">
      <header className="ai-head">
        <span className="ai-mark" aria-hidden="true">
          <Icon name="sparkle" size={18} />
        </span>
        <div className="ai-head-text">
          <h1>Assistant</h1>
          <p>Tell Lead Finder what to do, in your own words</p>
        </div>
        {settings && (
          <span className={`ai-conn ${ready && settings.status === 'connected' ? 'ok' : ready && settings.status === 'failed' ? 'bad' : ''}`}>
            <span className="st-dot" />
            {(() => {
              const name = settings.main === 'openrouter' ? 'OpenRouter' : 'Groq';
              return !ready ? 'No AI key' : settings.status === 'connected' ? `${name} connected` : settings.status === 'failed' ? `${name} connection failed` : `${name} key saved`;
            })()}
          </span>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={clear} disabled={busy || !display.length}>
          <Icon name="refresh" size={13} /> New chat
        </button>
      </header>
      <LiveStrip hidden={hidden} />

      <div className="ai-scroll" ref={scroller}>
        {!ready && settings && (
          <div className="ai-empty">
            <Icon name="key" size={26} />
            <h2>Add an AI key</h2>
            <p>The assistant uses Groq or OpenRouter. Save a key in Settings → AI to start.</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={onOpenSettings}>
              <Icon name="gear" size={13} /> Open AI settings
            </button>
          </div>
        )}
        {ready && !display.length && (
          <div className="ai-empty">
            <Icon name="sparkle" size={26} />
            <h2>What should Lead Finder do?</h2>
            <p>Ask about leads and campaigns, or set up a WhatsApp or email campaign step by step.</p>
            <div className="ai-examples">
              {EXAMPLES.map((e) => (
                <button key={e} type="button" className="em-chip" onClick={() => send(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {display.map((m, i) => (
          <div key={i} className={`ai-msg r-${m.role}`}>
            {m.role === 'user' ? (
              <div className="ai-bubble user">
                {m.text && <Rich text={m.text} />}
                {m.files?.length > 0 && (
                  <div className="ai-files">
                    {m.files.map((f) => (
                      <span key={f.id} className="em-file">
                        <Icon name={f.kind === 'image' ? 'image' : f.kind === 'audio' ? 'audio' : 'file'} size={12} /> {f.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : m.role === 'error' ? (
              <div className="ai-bubble error">
                <Icon name="alert" size={13} /> {m.text}
                <Actions actions={m.actions} />
              </div>
            ) : (
              <div className="ai-bubble bot">
                <Actions actions={m.actions} />
                <Rich text={m.text} />
              </div>
            )}
            <span className="ai-time">{time(m.at)}</span>
          </div>
        ))}
        {pending && !busy && (
          <div className="ai-confirm" role="group" aria-label="Confirm action">
            <Icon name="lock" size={14} />
            <span>{pending.summary}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => send('no')}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => send('yes')}>
              <Icon name="check" size={13} /> Confirm
            </button>
          </div>
        )}
        {busy && (
          <div className="ai-msg r-assistant">
            <div className="ai-bubble bot ai-typing" aria-live="polite">
              <span className="ai-dots">
                <i />
                <i />
                <i />
              </span>
              {activity || 'Thinking…'}
            </div>
          </div>
        )}
      </div>

      <form
        className="ai-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {files.length > 0 && (
          <div className="ai-files pending">
            {files.map((f) => (
              <span key={f.id} className="em-file">
                <Icon name={f.kind === 'image' ? 'image' : f.kind === 'audio' ? 'audio' : 'file'} size={12} /> {f.name}
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="ai-input-row">
          <button type="button" className="icon-btn ai-clip" title="Attach image, document or audio" aria-label="Attach files" disabled={!ready || busy} onClick={attach}>
            <Icon name="clip" size={16} />
          </button>
          <textarea
            ref={input}
            rows={1}
            value={text}
            disabled={!ready}
            placeholder={ready ? 'Message the assistant… (e.g. "garments leads ko WhatsApp campaign bhejo")' : 'Add a Groq or OpenRouter key in Settings first'}
            aria-label="Message"
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="submit" className="btn btn-primary ai-send" disabled={!ready || busy || (!text.trim() && !files.length)} aria-label="Send">
            <Icon name="send" size={15} />
          </button>
        </div>
      </form>
    </section>
  );
}
