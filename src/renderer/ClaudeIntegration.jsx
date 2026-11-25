import { useEffect, useState } from 'react';
import Icon from './icons.jsx';

// Settings > AI Integrations > Claude: Lead Finder in Claude Desktop with
// the user's own Claude account. Three states the user sees: Not connected,
// Connecting, Connected (only once Claude itself has reached Lead Finder).

const api = window.leadFinder;

const STATE = {
  not_connected: ['Not connected', 'off'],
  connecting: ['Connecting', 'warn'],
  connected: ['Connected', 'live'],
};

function ago(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function Step({ done, warn, title, text, children }) {
  return (
    <div className={`cl-step ${done ? 'done' : warn ? 'warn' : ''}`}>
      <span className="cl-step-mark" aria-hidden="true">
        <Icon name={done ? 'check' : warn ? 'alert' : 'chevron'} size={13} />
      </span>
      <div className="cl-step-text">
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
      {children && <div className="cl-step-ctl">{children}</div>}
    </div>
  );
}

const EXAMPLES = ['Which of my leads in Lahore have an email but no website?', 'Give me a report of my leads by city and category.', 'Write a short outreach email for lead 12 from its details.', 'How is my latest email campaign doing? Any replies?'];

export default function ClaudeIntegration() {
  const [st, setSt] = useState(null);
  const [msg, setMsg] = useState(null);
  const [working, setWorking] = useState('');

  useEffect(() => {
    let live = true;
    const load = () => api.claudeStatus().then((s) => live && setSt(s)).catch(() => {});
    load();
    const off = api.onClaude((s) => setSt(s));
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      off();
      clearInterval(t);
    };
  }, []);

  // A "restart Claude" note is out of date once Claude has connected.
  const state = st?.state;
  useEffect(() => {
    if (state === 'connected') setMsg((m) => (m?.restart ? null : m));
  }, [state]);

  async function act(what, fn, okText) {
    setWorking(what);
    setMsg(null);
    const r = await fn().catch((e) => ({ ok: false, error: e.message }));
    setWorking('');
    if (r?.status) setSt(r.status);
    if (r?.ok === false) setMsg({ type: 'bad', text: r.error, code: r.code });
    else if (okText) {
      setMsg({ type: 'ok', text: typeof okText === 'function' ? okText(r) : okText, restart: Boolean(r?.restartNeeded) || what === 'restart' });
    }
  }

  if (!st) {
    return (
      <div className="st-skeleton" aria-busy="true">
        <span />
        <span />
      </div>
    );
  }

  const [label, tone] = STATE[st.state] || STATE.not_connected;
  const busy = Boolean(st.busy || working);
  const check = st.server.check;
  const live = st.connection.live;
  const seen = st.connection.lastSeen;
  const total = st.tools.read.length + st.tools.config.length + st.tools.confirm.length;
  const setupText = (r) => (r.restartNeeded ? 'Lead Finder is set up in Claude and checked.' : 'Lead Finder is connected to Claude.');

  return (
    <div className="cl">
      <div className="st-group cl-head">
        <span className="cl-mark" aria-hidden="true">
          <Icon name="sparkle" size={20} />
        </span>
        <div className="cl-head-text">
          <h3>Claude</h3>
          <p>Ask Claude about your leads, campaigns and replies, with your own Claude account. No API key.</p>
        </div>
        <span className={`st-pill ${tone} cl-pill`} role="status" aria-label={`Claude: ${label}`}>
          {working === 'setup' || st.busy === 'setup' ? 'Connecting' : label}
        </span>
      </div>

      <div className="st-group cl-steps">
        <Step
          done={st.claude.installed}
          warn={!st.claude.installed}
          title="Claude Desktop"
          text={st.claude.installed ? 'Installed on this computer' : 'Not found on this computer. Install it and sign in with your Claude account.'}
        >
          {!st.claude.installed && (
            <button type="button" className="btn btn-sm" onClick={() => api.claudeDownload()}>
              <Icon name="external" size={12} /> Download Claude
            </button>
          )}
        </Step>
        <Step
          done={st.enabled && check?.ok}
          warn={st.enabled && check && !check.ok}
          title="Lead Finder in Claude"
          text={!st.enabled ? 'Not set up yet' : check?.ok ? `Set up and checked ${ago(check.at)}${check.tools ? ` · ${check.tools} tools` : ''}` : check ? 'The check failed (see below)' : 'Set up, not checked yet'}
        />
        <Step
          done={st.state === 'connected'}
          warn={st.enabled && st.state === 'connecting'}
          title="Connection"
          text={live.length ? `${live.map((c) => c.client).join(', ')} connected now` : st.state === 'connected' && seen ? `Ready · last used by ${seen.client} ${ago(seen.at)}` : st.enabled && st.state === 'connecting' ? 'Waiting for Claude to load Lead Finder' : 'Not connected'}
        />
      </div>

      {st.detail && st.state === 'not_connected' && <p className={`cl-detail ${st.enabled && st.state === 'not_connected' ? 'bad' : ''}`}>{st.detail}</p>}

      <div className="cl-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !st.claude.installed} onClick={() => act('setup', api.claudeSetup, setupText)}>
          <Icon name={st.enabled ? 'refresh' : 'link'} size={14} /> {working === 'setup' ? 'Connecting…' : st.enabled ? 'Reconnect' : 'Auto Setup & Connect'}
        </button>
        {st.enabled && st.canRestart && st.state !== 'connected' && (
          <button type="button" className="btn" disabled={busy} onClick={() => act('restart', api.claudeRestart, 'Claude is restarting. When it asks, allow Lead Finder’s tools.')}>
            <Icon name="repeat" size={13} /> {working === 'restart' ? 'Restarting Claude…' : 'Restart Claude'}
          </button>
        )}
        {st.enabled && (
          <button type="button" className="btn" disabled={busy} onClick={() => act('test', api.claudeTest, (r) => `Checked: Lead Finder answers Claude (${r.tools} tools).`)}>
            <Icon name="check" size={13} /> {working === 'test' ? 'Checking…' : 'Check connection'}
          </button>
        )}
        {st.enabled && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act('disconnect', api.claudeDisconnect, 'Lead Finder was removed from Claude. Your other Claude settings were kept.')}>
            Disconnect
          </button>
        )}
      </div>

      {msg && (
        <p className={msg.type === 'bad' ? 'st-error' : 'cl-ok'} role={msg.type === 'bad' ? 'alert' : 'status'}>
          <Icon name={msg.type === 'bad' ? 'alert' : 'check'} size={14} /> {msg.text}
          {msg.code === 'no_claude' && (
            <button type="button" className="st-link" onClick={() => api.claudeDownload()}>
              Download Claude Desktop
            </button>
          )}
        </p>
      )}

      {st.enabled && st.state === 'connecting' && !busy && (
        <div className="st-callout info cl-callout">
          <Icon name="repeat" size={15} />
          <p>
            <strong>Last step: restart Claude Desktop.</strong> {st.canRestart ? 'Click Restart Claude, or quit Claude and open it again.' : 'Quit Claude completely (also from its tray icon) and open it again.'} When Claude first uses Lead Finder, it asks you to allow its tools.
          </p>
        </div>
      )}

      <div className="st-group cl-info">
        <div className="cl-info-row">
          <Icon name="key" size={15} />
          <p>
            <strong>Your Claude plan, no API key.</strong> Claude Desktop answers with the Claude account you sign in with (Pro or any plan). Claude needs the internet.
          </p>
        </div>
        <div className="cl-info-row">
          <Icon name="lock" size={15} />
          <p>
            <strong>Your data stays here.</strong> Lead Finder runs on this computer. Claude only gets what it looks up when you ask it something. It never sees passwords, keys or WhatsApp sessions.
          </p>
        </div>
        <div className="cl-info-row">
          <Icon name="shield" size={15} />
          <p>
            <strong>You approve every send.</strong> Sending messages, starting or stopping campaigns, searches, deleting and settings changes wait for you to click Allow in Lead Finder.
          </p>
        </div>
      </div>

      <details className="st-group cl-tools">
        <summary>
          <span>What Claude can do in Lead Finder</span>
          <span className="muted small">{total} tools</span>
        </summary>
        {[
          ['Look up', st.tools.read, ''],
          ['Prepare (sends nothing)', st.tools.config, ''],
          ['Only after you click Allow', st.tools.confirm, 'warn'],
        ].map(([title, list, cls]) => (
          <div key={title} className="cl-tool-group">
            <span className="cl-tool-title">{title}</span>
            <div className="cl-chips">
              {list.map((t) => (
                <span key={t} className={`cl-chip ${cls}`}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        ))}
        <div className="cl-tool-group">
          <span className="cl-tool-title">Try asking Claude</span>
          <ul className="cl-examples">
            {EXAMPLES.map((e) => (
              <li key={e}>“{e}”</li>
            ))}
          </ul>
        </div>
      </details>

      {st.connection.recent.length > 0 && (
        <div className="st-group cl-recent" aria-label="Recent activity from Claude">
          <div className="cl-recent-head">Recent activity</div>
          {st.connection.recent.map((r, i) => (
            <div key={`${r.at}-${i}`} className="cl-recent-row">
              <span className={`st-dot ${r.ok ? 'ok' : 'bad'}`} />
              <span className="cl-recent-what">
                {r.title}
                {r.kind === 'confirm' && <span className={`st-badge ${r.allowed ? 'accent' : ''}`}>{r.allowed ? 'Allowed' : 'Not allowed'}</span>}
                {r.error && <span className="muted"> · {r.error}</span>}
              </span>
              <span className="muted small">
                {r.client} · {ago(r.at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
