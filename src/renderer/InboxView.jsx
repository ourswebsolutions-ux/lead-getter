import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';

// Outreach > Inbox: only the leads who replied to a campaign, by email or
// WhatsApp. Read the conversation and answer on the channel they used.

const api = window.leadFinder;
const when = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const VIA = { campaign: 'Campaign message', app: 'Sent from Lead Finder', 'admin-whatsapp': 'Sent by you on WhatsApp', 'admin-email': 'Sent by you by email', assistant: 'Sent by the assistant' };

function Text({ text }) {
  return String(text || '')
    .split('\n')
    .map((l, i, all) => (
      <Fragment key={i}>
        {l}
        {i < all.length - 1 && <br />}
      </Fragment>
    ));
}

export default function InboxView({ hidden, notify }) {
  const [threads, setThreads] = useState([]);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [conv, setConv] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);

  const load = useCallback(() => api.inboxThreads().then((r) => r.ok && setThreads(r.threads)), []);
  const open = useCallback((id) => {
    if (!id) return setConv(null);
    api.inboxThread(id).then((r) => setConv(r.ok ? r : null));
  }, []);
  useEffect(() => {
    if (!hidden) load();
  }, [hidden, load]);
  useEffect(() => open(selected), [selected, open]);
  useEffect(
    () =>
      api.onInbox((e) => {
        load();
        if (selected && (e?.id == null || e.id === selected) && !hidden) open(selected);
      }),
    [selected, load, open, hidden],
  );
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv]);

  const shown = threads.filter((t) => filter === 'all' || t.channel === filter);
  async function sendReply(e) {
    e.preventDefault();
    if (!text.trim() || !conv) return;
    setBusy(true);
    const r = await api.inboxReply(conv.thread.id, text);
    setBusy(false);
    if (!r.ok) return notify({ type: 'error', text: r.error });
    setText('');
    open(conv.thread.id);
    load();
  }

  return (
    <section className="outreach or-grid ib-view" hidden={hidden} aria-label="Inbox">
      <aside className="or-side">
        <section className="panel em-card ib-list-card" aria-label="Conversations">
          <div className="or-card-head">
            <h3>
              <Icon name="inbox" size={14} /> Replies <span className="or-count">{threads.length}</span>
            </h3>
          </div>
          <div className="segmented ib-filter" role="group" aria-label="Show">
            {[
              ['all', 'All'],
              ['email', 'Email'],
              ['whatsapp', 'WhatsApp'],
            ].map(([id, label]) => (
              <button key={id} type="button" className={filter === id ? 'on' : ''} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
          {!shown.length ? (
            <p className="muted small">No replies yet. Leads who answer a campaign appear here.</p>
          ) : (
            <ul className="ib-threads">
              {shown.map((t) => (
                <li key={t.id}>
                  <button type="button" className={`${selected === t.id ? 'on' : ''} ${t.unread ? 'unread' : ''}`} onClick={() => setSelected(t.id)}>
                    <span className={`ib-ch ${t.channel}`}>
                      <Icon name={t.channel === 'email' ? 'mail' : 'chat'} size={13} />
                    </span>
                    <span className="ib-t-main">
                      <span className="ib-t-top">
                        <strong>{t.name || t.address}</strong>
                        <span className="ib-t-time">{when(t.lastAt)}</span>
                      </span>
                      <span className="ib-t-last">
                        {t.last?.direction === 'out' && 'You: '}
                        {t.last?.text.split('\n')[0]}
                      </span>
                    </span>
                    {t.unread > 0 && <span className="ib-unread">{t.unread}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
      <div className="or-main ib-main">
        {!conv ? (
          <div className="panel or-blank">
            <Icon name="inbox" size={28} />
            <p>{threads.length ? 'Choose a conversation' : 'Replies to your WhatsApp and email campaigns show up here'}</p>
          </div>
        ) : (
          <section className="panel ib-conv" aria-label="Conversation">
            <header className="ib-head">
              <span className={`ib-ch big ${conv.thread.channel}`}>
                <Icon name={conv.thread.channel === 'email' ? 'mail' : 'chat'} size={16} />
              </span>
              <div className="ib-head-text">
                <h2>{conv.thread.name || conv.thread.address}</h2>
                <p>
                  {conv.thread.address}
                  {conv.thread.campaignName && ` · ${conv.thread.campaignName}`} · #{conv.thread.id}
                </p>
              </div>
              <button
                type="button"
                className="icon-btn"
                title="Remove from the Inbox"
                aria-label="Remove conversation"
                onClick={async () => {
                  if (!window.confirm('Remove this conversation from the Inbox? (The lead is kept.)')) return;
                  await api.inboxDelete(conv.thread.id);
                  setSelected(null);
                  load();
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </header>
            <div className="ib-msgs" ref={scroller}>
              {conv.messages.map((m) => (
                <div key={m.id} className={`ib-msg ${m.direction}`}>
                  <div className={`ib-bubble ${m.direction} ${m.via === 'campaign' ? 'campaign' : ''}`}>
                    {m.subject && m.direction === 'in' && <strong className="ib-subj">{m.subject}</strong>}
                    <Text text={m.text} />
                  </div>
                  <span className="ib-meta">
                    {m.direction === 'out' ? VIA[m.via] || 'Sent' : 'Reply'} · {when(m.at)}
                  </span>
                </div>
              ))}
            </div>
            <form className="ib-compose" onSubmit={sendReply}>
              <textarea
                rows={2}
                value={text}
                aria-label="Your answer"
                placeholder={`Answer on ${conv.thread.channel === 'email' ? 'email' : 'WhatsApp'}…`}
                maxLength={4000}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendReply(e);
                }}
              />
              <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
                <Icon name="send" size={14} /> {busy ? 'Sending…' : 'Send'}
              </button>
            </form>
          </section>
        )}
      </div>
    </section>
  );
}
