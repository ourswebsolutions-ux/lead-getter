import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';
import CampaignsView from './CampaignsView.jsx';

const api = window.leadFinder;

const STATE = {
  off: ['Connect your phone in the Dialer to send and receive SMS.', 'soft'],
  connecting: ['Connecting to the phone’s messages…', 'soft'],
  ready: ['SMS through your phone (Bluetooth Message Access)', 'ok'],
  denied: ['The phone refused message access.', 'bad'],
  error: ['Messages are not available.', 'bad'],
};
const SENT = { sending: 'Sending…', submitted: 'Submitted to phone', sent: 'Sent', delivered: 'Delivered', failed: 'Failed', received: '' };

const time = (ms) => {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
};

function render(text, contact) {
  return String(text || '')
    .replace(/\{name\}/gi, contact?.name || '')
    .replace(/\{business\}/gi, contact?.business || contact?.name || '')
    .replace(/[ \t]+([,.!?])/g, '$1')
    .trim();
}

function Templates({ templates, onClose, notify }) {
  const [list, setList] = useState(templates.length ? templates : [{ id: '', name: '', text: '' }]);
  const set = (i, k, v) => setList((l) => l.map((t, j) => (j === i ? { ...t, [k]: v } : t)));
  const save = async () => {
    const r = await api.smsTemplates(list.filter((t) => t.name.trim() && t.text.trim()));
    if (!r?.ok) return notify({ type: 'error', text: 'The templates could not be saved.' });
    onClose();
  };
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="composer ms-templates" role="dialog" aria-label="SMS templates">
        <header className="composer-head">
          <span className="composer-icon neutral"><Icon name="edit" /></span>
          <div>
            <strong>SMS templates</strong>
            <span className="muted">{'{name}'} and {'{business}'} are filled in for each contact.</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="ms-tpl-list">
          {list.map((t, i) => (
            <div key={i} className="ms-tpl">
              <input aria-label="Template name" placeholder="Name, e.g. First contact" value={t.name} maxLength={60} onChange={(e) => set(i, 'name', e.target.value)} />
              <textarea aria-label="Template text" rows={3} placeholder="Hi {name}, …" value={t.text} maxLength={1600} onChange={(e) => set(i, 'text', e.target.value)} />
              <button type="button" className="icon-btn danger" aria-label="Remove template" onClick={() => setList((l) => l.filter((_, j) => j !== i))}><Icon name="trash" /></button>
            </div>
          ))}
        </div>
        <div className="dl-pair-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setList((l) => [...l, { id: '', name: '', text: '' }])}>Add template</button>
          <button type="button" className="btn btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

// prefill: { phone, leadId, numberId, name, nonce } from a lead's or a number's SMS button.
export default function MessagesView({ notify, hidden, prefill, onCall }) {
  const [st, setSt] = useState({ state: 'off', templates: [] });
  const [threads, setThreads] = useState([]);
  const [phone, setPhone] = useState(null);
  const [target, setTarget] = useState(null); // { leadId, numberId, name } for a new conversation
  const [conv, setConv] = useState({ messages: [], contact: null });
  const [text, setText] = useState('');
  const [newTo, setNewTo] = useState(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [tab, setTab] = useState('conversations'); // conversations | campaigns
  const bottom = useRef(null);

  const loadThreads = useCallback(() => api.smsThreads().then((t) => setThreads(t || [])), []);
  const loadConv = useCallback(() => (phone ? api.smsMessages(phone).then((c) => setConv(c || { messages: [] })) : setConv({ messages: [], contact: null })), [phone]);
  useEffect(() => {
    api.smsState().then(setSt);
    loadThreads();
    const a = api.onSmsState(setSt);
    const b = api.onSmsChanged((e) => {
      loadThreads();
      if (!e?.phone || e.phone === phone) loadConv();
    });
    const c = api.onSmsOpen((e) => e?.phone && setPhone(e.phone));
    return () => (a(), b(), c());
  }, [loadThreads, loadConv, phone]);
  useEffect(() => {
    loadConv();
  }, [loadConv]);
  useEffect(() => {
    if (!prefill?.phone) return;
    setTab('conversations');
    setPhone(prefill.phone);
    setTarget({ leadId: prefill.leadId || null, numberId: prefill.numberId || null, name: prefill.name || null });
    setNewTo(null);
  }, [prefill]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [conv.messages.length, phone]);

  const contact = conv.contact || (target?.name ? { name: target.name } : null);
  const send = async () => {
    const to = phone || newTo;
    if (!to || !text.trim()) return;
    setBusy(true);
    const r = await api.smsSend(to, text, { leadId: target?.leadId, numberId: target?.numberId });
    setBusy(false);
    if (!r.ok) return notify({ type: 'error', text: r.error });
    setText('');
    if (!phone) setPhone(to.replace(/[\s\-().]/g, ''));
    setNewTo(null);
    loadThreads();
    loadConv();
  };
  const [msg, tone] = STATE[st.state] || STATE.off;
  const shown = threads.filter((t) => !filter || `${t.contact?.name || ''} ${t.contact?.business || ''} ${t.phone}`.toLowerCase().includes(filter.toLowerCase()));
  const ready = st.state === 'ready';

  return (
    <section className="messages" hidden={hidden} aria-label="Messages">
      <div className={`panel ms-status tone-${tone}`} role="status">
        <span className="dl-pill-dot" />
        <span>
          <b>{msg}</b>
          {st.error ? ` ${st.error}` : ''}
          {ready && ' The phone sends with its default SMS SIM (Bluetooth cannot choose a SIM). Separate from WhatsApp.'}
        </span>
        {(st.state === 'error' || st.state === 'denied') && (
          <button type="button" className="btn btn-sm" onClick={async () => { const r = await api.smsRetry(); if (!r.ok) notify({ type: 'error', text: r.error }); }}>
            <Icon name="refresh" size={13} /> Try again
          </button>
        )}
        {ready && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={async () => { const r = await api.smsSync(); if (!r.ok) notify({ type: 'error', text: r.error }); }}>
            <Icon name="refresh" size={13} /> Check for new
          </button>
        )}
      </div>
      <nav className="segmented ms-tabs" aria-label="Messages view">
        {[
          ['conversations', 'Conversations', 'chat'],
          ['campaigns', 'Campaigns', 'send'],
        ].map(([id, label, icon]) => (
          <button key={id} type="button" className={tab === id ? 'on' : ''} aria-pressed={tab === id} onClick={() => setTab(id)}>
            <Icon name={icon} size={13} /> {label}
          </button>
        ))}
      </nav>
      {tab === 'campaigns' && <CampaignsView notify={notify} smsState={st} />}
      <div className="ms-grid" hidden={tab !== 'conversations'}>
        <aside className="panel ms-threads" aria-label="Conversations">
          <header className="ms-threads-head">
            <label className="table-search">
              <Icon name="search" size={14} />
              <input type="search" placeholder="Search" aria-label="Search conversations" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => (setPhone(null), setTarget(null), setNewTo(''))}>
              <Icon name="edit" size={13} /> New
            </button>
          </header>
          {shown.length === 0 ? (
            <p className="nm-empty">{ready ? 'No messages yet.' : 'Messages appear here once the phone is connected.'}</p>
          ) : (
            <ul>
              {shown.map((t) => (
                <li key={t.phone}>
                  <button type="button" className={`ms-thread ${t.phone === phone ? 'on' : ''}`} onClick={() => (setPhone(t.phone), setTarget(null), setNewTo(null))}>
                    <span className="dl-avatar small" aria-hidden="true">{(t.contact?.name || t.phone).replace(/^\+/, '').slice(0, 2).toUpperCase()}</span>
                    <span className="ms-thread-main">
                      <strong>{t.contact?.name || t.contact?.business || t.phone}</strong>
                      <span>{t.lastDirection === 'out' ? 'You: ' : ''}{t.last}</span>
                    </span>
                    <span className="ms-thread-side">
                      <span className="muted">{time(t.at)}</span>
                      {t.unread > 0 && <span className="ms-unread">{t.unread}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="panel ms-conv" aria-label="Conversation">
          {phone || newTo != null ? (
            <>
              <header className="ms-conv-head">
                {newTo != null && !phone ? (
                  <input className="ms-to" aria-label="To" placeholder="Phone number" value={newTo} onChange={(e) => setNewTo(e.target.value.replace(/[^\d+\s()-]/g, ''))} />
                ) : (
                  <>
                    <div>
                      <strong>{contact?.name || contact?.business || phone}</strong>
                      <span className="mono muted">{phone}</span>
                    </div>
                    <button type="button" className="icon-btn call" aria-label={`Call ${phone}`} title="Call" onClick={() => onCall({ phone, leadId: conv.contact?.kind === 'lead' ? conv.contact.id : target?.leadId, numberId: conv.contact?.kind === 'number' ? conv.contact.id : target?.numberId, name: contact?.name })}>
                      <Icon name="phone" />
                    </button>
                  </>
                )}
              </header>
              <div className="ms-bubbles">
                {conv.messages.map((m) => (
                  <div key={m.id} className={`ms-bubble ${m.direction} ${m.status}`}>
                    <p>{m.body}</p>
                    <span>
                      {time(m.at)}
                      {m.direction === 'out' && SENT[m.status] ? ` · ${SENT[m.status]}` : ''}
                      {m.error ? ` · ${m.error}` : ''}
                    </span>
                  </div>
                ))}
                <div ref={bottom} />
              </div>
              <footer className="ms-compose">
                <div className="ms-compose-tools">
                  <select aria-label="Use a template" value="" onChange={(e) => e.target.value && setText(render(st.templates.find((t) => t.id === e.target.value)?.text, contact))}>
                    <option value="">Template…</option>
                    {st.templates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTplOpen(true)}>Templates</button>
                  <span className="muted ms-len">{text.length} characters{text.length > 160 ? ` · ${Math.ceil(text.length / 153)} SMS` : ''}</span>
                </div>
                <div className="ms-compose-row">
                  <textarea aria-label="Message" rows={2} placeholder={ready ? 'Write an SMS' : 'Messages are not connected'} value={text} maxLength={1600} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && send()} />
                  <button type="button" className="btn btn-primary" disabled={!ready || busy || !text.trim() || !(phone || newTo)} onClick={send}>
                    {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={14} />} Send
                  </button>
                </div>
              </footer>
            </>
          ) : (
            <div className="nm-welcome">
              <Icon name="chat" size={28} />
              <h2>SMS from your computer</h2>
              <p>Texts go out through your connected phone and its SIM, over Bluetooth. Nothing is installed on the phone. On the phone, allow message access for this computer (Bluetooth settings → this computer → Text messages).</p>
            </div>
          )}
        </section>
      </div>
      {tplOpen && <Templates templates={st.templates} notify={notify} onClose={() => setTplOpen(false)} />}
    </section>
  );
}
