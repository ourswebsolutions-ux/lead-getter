import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { planNeeded } from './Activation.jsx';

const api = window.leadFinder;

function initials(name) {
  const parts = String(name || '')
    .replace(/[^\p{L}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return (parts[0]?.[0] || '#').toUpperCase() + (parts[1]?.[0] || '').toUpperCase();
}

function chatTitle(c) {
  return c?.name || c?.leadName || c?.phone || 'Unknown contact';
}

function timeLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

function Avatar({ chat, size = 40 }) {
  return chat?.avatar ? (
    <img className="avatar" src={chat.avatar} alt="" width={size} height={size} />
  ) : (
    <span className="avatar avatar-initials" style={{ width: size, height: size }} aria-hidden="true">
      {initials(chatTitle(chat))}
    </span>
  );
}

// Delivery state of our own messages, as reported by WhatsApp.
function Ticks({ status }) {
  if (!status) return null;
  const label = { pending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not sent' }[status] || status;
  return (
    <span className={`ticks ticks-${status}`} title={label} aria-label={label}>
      {status === 'pending' ? '◷' : status === 'failed' ? '!' : status === 'sent' ? '✓' : '✓✓'}
    </span>
  );
}

export default function ChatsView({ wa, notify, hidden }) {
  const [chats, setChats] = useState([]);
  const [search, setSearch] = useState('');
  const [listState, setListState] = useState({ loading: true, error: '' });
  const [selected, setSelected] = useState(null); // jid
  const [convo, setConvo] = useState(null); // { chat, messages, canLoadOlder }
  const [convoLoading, setConvoLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [older, setOlder] = useState({ busy: false, note: '' });
  const bottom = useRef(null);
  const selectedRef = useRef(null);
  selectedRef.current = selected;
  const connected = wa?.state === 'open';

  const loadList = useCallback(async () => {
    try {
      const r = await api.chatsList(search);
      if (r.ok) {
        setChats(r.chats);
        setListState({ loading: false, error: '' });
      } else setListState({ loading: false, error: r.error });
    } catch (e) {
      setListState({ loading: false, error: e.message });
    }
  }, [search]);

  const openChat = useCallback(async (jid, { quiet = false } = {}) => {
    if (!quiet) setConvoLoading(true);
    try {
      const r = await api.chatsOpen(jid);
      if (selectedRef.current !== jid) return;
      if (r.ok) setConvo({ chat: r.chat, messages: r.messages, canLoadOlder: r.canLoadOlder });
      else notify({ type: 'error', text: r.error });
    } finally {
      setConvoLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    const t = setTimeout(loadList, search ? 200 : 0);
    return () => clearTimeout(t);
  }, [loadList, search]);

  // Live updates from WhatsApp (new messages, receipts, names, pictures).
  useEffect(() => {
    let t = null;
    const off = api.onChats(({ jids }) => {
      clearTimeout(t);
      t = setTimeout(() => {
        loadList();
        if (selectedRef.current && jids.includes(selectedRef.current) && !hidden) openChat(selectedRef.current, { quiet: true });
      }, 250);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [loadList, openChat, hidden]);

  useEffect(() => {
    if (selected) {
      setConvo(null);
      setOlder({ busy: false, note: '' });
      openChat(selected);
    }
  }, [selected, openChat]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [convo?.messages?.length, selected]);

  async function send(e) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || !selected || sending) return;
    setSending(true);
    try {
      const r = await api.chatsSend(selected, text);
      if (r.ok) {
        setDraft('');
        openChat(selected, { quiet: true });
      } else if (!planNeeded(r)) notify({ type: 'error', text: r.error });
    } finally {
      setSending(false);
    }
  }

  async function loadOlder() {
    setOlder({ busy: true, note: '' });
    const r = await api.chatsLoadOlder(selected);
    setOlder({ busy: false, note: r.ok ? 'Asked your phone for older messages. They appear here if WhatsApp sends them.' : r.error });
  }

  const groups = useMemo(() => {
    const out = [];
    for (const m of convo?.messages || []) {
      const day = new Date(m.ts).toDateString();
      if (!out.length || out[out.length - 1].day !== day) out.push({ day, ts: m.ts, list: [] });
      out[out.length - 1].list.push(m);
    }
    return out;
  }, [convo]);

  const current = convo?.chat || chats.find((c) => c.jid === selected) || null;

  return (
    <section className="chats" hidden={hidden} aria-label="WhatsApp chats">
      <aside className="chat-list panel">
        <div className="chat-list-head">
          <div className="input-wrap">
            <span className="field-icon">
              <Icon name="search" />
            </span>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, number or message" aria-label="Search chats" />
          </div>
          <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh chats" onClick={loadList}>
            <Icon name="refresh" />
          </button>
        </div>
        {!connected && (
          <p className="chat-note">{wa?.state === 'unavailable' ? wa.error || 'WhatsApp is not available on this computer.' : 'WhatsApp is not connected. Link it from the WhatsApp button at the top to receive and send messages.'}</p>
        )}
        <ul className="chat-items" role="listbox" aria-label="Chats">
          {listState.loading && <li className="chat-empty">Loading chats…</li>}
          {!listState.loading && listState.error && <li className="chat-empty error">{listState.error}</li>}
          {!listState.loading && !listState.error && chats.length === 0 && (
            <li className="chat-empty">
              {search ? 'No chats match this search.' : 'No chats yet. Messages appear here as they arrive. WhatsApp shares recent chat history only when a device is linked, so older chats show up after linking this device again.'}
            </li>
          )}
          {chats.map((c) => (
            <li key={c.jid} role="option" aria-selected={selected === c.jid}>
              <button type="button" className={`chat-item ${selected === c.jid ? 'on' : ''}`} onClick={() => setSelected(c.jid)}>
                <Avatar chat={c} />
                <span className="chat-item-main">
                  <span className="chat-item-top">
                    <span className="chat-name">{chatTitle(c)}</span>
                    <span className={`chat-time ${c.unread ? 'unread' : ''}`}>{timeLabel(c.lastTs)}</span>
                  </span>
                  <span className="chat-item-sub">
                    {c.phone && c.name && <span className="chat-phone mono">{c.phone}</span>}
                    {c.leadName && <span className="chip chip-soft chat-lead" title="Matches a lead">{c.leadName}</span>}
                  </span>
                  <span className="chat-item-bottom">
                    <span className="chat-last">
                      {c.lastFromMe && <span className="chat-you">You: </span>}
                      {c.lastText ?? <em>No messages loaded</em>}
                    </span>
                    {c.unread > 0 && (
                      <span className="unread-badge" aria-label={`${c.unread} unread`}>
                        {c.unread}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="chat-pane panel">
        {!selected ? (
          <div className="chat-placeholder">
            <Icon name="chat" size={28} />
            <p>Select a chat to read and reply.</p>
            <p className="muted">Messages come from your linked WhatsApp account. Text is stored encrypted on this computer.</p>
          </div>
        ) : (
          <>
            <header className="chat-head">
              <Avatar chat={current} size={36} />
              <div className="chat-head-main">
                <h2>{chatTitle(current)}</h2>
                <p className="muted">
                  {current?.phone || 'Number not shared by WhatsApp'}
                  {current?.leadName && ` · Lead: ${current.leadName}`}
                </p>
              </div>
              <button type="button" className="btn btn-ghost" disabled={!connected || older.busy || !convo?.canLoadOlder} onClick={loadOlder} title="Ask your phone for older messages of this chat">
                <Icon name="refresh" /> Older messages
              </button>
            </header>
            <div className="chat-messages" aria-live="polite">
              {older.note && <p className="chat-note center">{older.note}</p>}
              {convoLoading && <p className="chat-note center">Loading messages…</p>}
              {!convoLoading && convo && convo.messages.length === 0 && <p className="chat-note center">No messages of this chat are stored on this computer yet.</p>}
              {groups.map((g) => (
                <div key={g.day} className="chat-day">
                  <span className="chat-day-label">{dayLabel(g.ts)}</span>
                  {g.list.map((m) => (
                    <div key={m.id} className={`bubble ${m.fromMe ? 'mine' : 'theirs'} kind-${m.kind}`}>
                      {!m.fromMe && m.sender && <span className="bubble-sender">{m.sender}</span>}
                      <span className="bubble-text">{m.text ?? <em>This message can’t be read on this computer.</em>}</span>
                      <span className="bubble-meta">
                        {new Date(m.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                        {m.fromMe && <Ticks status={m.status} />}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
              <div ref={bottom} />
            </div>
            <form className="chat-compose" onSubmit={send}>
              <textarea
                rows={1}
                value={draft}
                maxLength={4000}
                placeholder={connected ? 'Type a message' : 'WhatsApp is not connected'}
                disabled={!connected || sending}
                aria-label="Message"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) send(e);
                }}
              />
              <button type="submit" className="btn btn-primary" disabled={!connected || sending || !draft.trim()}>
                {sending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" />} Send
              </button>
            </form>
          </>
        )}
      </div>
    </section>
  );
}
