import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';

const api = window.leadFinder;

const KEYS = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

const STATUS = {
  answered: ['Answered', 'ok'],
  missed: ['Missed', 'bad'],
  rejected: ['Rejected', 'bad'],
  no_answer: ['No answer', 'warn'],
  busy: ['Busy', 'warn'],
  cancelled: ['Ended by you', 'soft'],
  failed: ['Failed', 'bad'],
  blocked: ['Blocked', 'bad'],
  skipped: ['Skipped', 'soft'],
  unknown: ['Ended', 'soft'],
  dialing: ['Interrupted', 'soft'],
  ringing: ['Interrupted', 'soft'],
};
const statusOf = (s) => STATUS[s] || STATUS.unknown;

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const when = (ms) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `Today ${time}` : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
};

const initials = (name) =>
  String(name || '')
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '#';

// Only a real click or key press may start a call.
const userActed = () => navigator.userActivation?.isActive !== false;

function useTick(on) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

function linkText(st) {
  if (!st) return ['Starting…', 'soft'];
  if (st.error) return [st.error, 'bad'];
  if (!st.adapter) return ['Looking for Bluetooth…', 'soft'];
  if (!st.adapter.powered) return ['Bluetooth is off', 'warn'];
  if (st.hfRole === 'pipewire') return ['Hands-Free role needed', 'warn'];
  if (st.hfRole === 'error') return [st.hfError || 'Hands-Free is not available', 'bad'];
  if (!st.saved) return ['No phone connected', 'soft'];
  switch (st.link) {
    case 'ready':
      return ['Connected', 'ok'];
    case 'connecting':
      return ['Connecting…', 'soft'];
    case 'error':
      return [st.linkError || 'Could not connect', 'bad'];
    default:
      return [st.linkError || 'Not connected', 'warn'];
  }
}

function Bars({ level }) {
  return (
    <span className="dl-bars" aria-label={`Signal ${level} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= level ? 'on' : ''} style={{ height: `${3 + i * 2}px` }} />
      ))}
    </span>
  );
}

function useRunner(notify) {
  const [busy, setBusy] = useState(null);
  const run = async (key, fn) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r && r.ok === false && r.error) notify({ type: 'error', text: r.error });
      return r;
    } finally {
      setBusy(null);
    }
  };
  return [busy, run];
}

// The call's audio in the window while a bridge carries the call: the phone's
// voice is played here and the microphone (with echo cancellation) goes back.
function useBridgeVoice(on) {
  useEffect(() => {
    if (!on) return undefined;
    let ctx;
    let stream;
    let stopped = false;
    let off = () => {};
    (async () => {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('./voice-worklet.js');
      if (stopped) return;
      const player = new AudioWorkletNode(ctx, 'voice-player', { outputChannelCount: [2] });
      player.connect(ctx.destination);
      off = api.onDialerVoice((buf) => {
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        player.port.postMessage(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
      });
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      if (stopped) return;
      const recorder = new AudioWorkletNode(ctx, 'voice-recorder');
      recorder.port.onmessage = (e) => api.dialerMic(new Uint8Array(e.data));
      ctx.createMediaStreamSource(stream).connect(recorder);
    })().catch(() => {});
    return () => {
      stopped = true;
      off();
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    };
  }, [on]);
}

const AUDIO_LABEL = { verified: 'Two-way audio verified', supported: 'Supported (verified after the first call)', unavailable: 'Not available' };

// Where the phone link comes from: this computer, or a bridge found on the network.
function BridgeCard({ bridge, notify }) {
  const [busy, run] = useRunner(notify);
  if (!bridge) return null;
  const a = bridge.active;
  const others = bridge.bridges.filter((b) => !b.active);
  const rec = bridge.reconnect?.state === 'reconnecting' ? 'Reconnecting: looking for another bridge…' : a ? 'Connected' : bridge.discovery ? 'Searching the network…' : 'Off';
  return (
    <section className="panel dl-card dl-bridge" aria-label="Bluetooth source">
      <header className="dl-bridge-head">
        <div>
          <strong>Bluetooth source</strong>
          <span className="dl-sub">{a ? (a.key === 'local' ? 'This computer' : a.name) : 'None yet'}</span>
        </div>
        <label className="dl-bridge-switch">
          <span>Automatic device discovery</span>
          <button type="button" role="switch" aria-checked={bridge.discovery} aria-label="Automatic device discovery" className={`dl-switch small ${bridge.discovery ? 'on' : ''}`} onClick={() => run('d', () => api.bridgeDiscovery(!bridge.discovery))}>
            <span />
          </button>
        </label>
      </header>
      {a && (
        <dl className="dl-bridge-facts">
          <div><dt>Device</dt><dd>{a.deviceType}{a.host ? <span className="muted mono"> · {a.host}</span> : null}</dd></div>
          <div><dt>Bluetooth</dt><dd className={a.bluetooth ? 'dl-ok' : 'dl-warn'}>{a.bluetooth ? (a.hfRole === 'ok' ? 'On · hands-free ready' : 'On · hands-free not available') : 'Off'}</dd></div>
          <div><dt>Mobile</dt><dd className={a.phone ? 'dl-ok' : 'dl-warn'}>{a.phone ? `${a.phone} connected` : 'No phone connected'}</dd></div>
          <div><dt>Call audio</dt><dd>{AUDIO_LABEL[a.audio] || AUDIO_LABEL.unavailable}{a.key !== 'local' && a.audio !== 'unavailable' ? ' · played here' : ''}</dd></div>
          {a.key !== 'local' && <div><dt>Connection</dt><dd>{a.quality ? `${a.quality[0].toUpperCase()}${a.quality.slice(1)}${a.rtt != null ? ` · ${a.rtt} ms` : ''}` : 'Measuring…'}</dd></div>}
          <div><dt>Reconnect</dt><dd>{rec}</dd></div>
        </dl>
      )}
      {!a && <p className="dl-hint dl-bridge-hint">{rec}. Run <b>Lead Finder Bridge</b> on a Linux laptop on this network (<span className="mono">lead-finder --bridge</span>); it appears here by itself.</p>}
      {others.length > 0 && (
        <ul className="dl-bridge-list">
          {others.map((b) => (
            <li key={b.fingerprint}>
              <span className="dl-dev-name">
                {b.name}
                <span className="muted">
                  {b.state === 'ready' ? 'Ready' : b.state === 'busy' ? 'In use by another Lead Finder' : b.state === 'denied' ? 'Pairing refused' : b.trusted ? b.error || 'Connecting…' : 'New: pair it once'}
                  {b.status?.phone ? ` · ${b.status.phone.name}` : ''}
                </span>
              </span>
              {!b.trusted ? (
                <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => run(b.fingerprint, () => api.bridgePair(b.fingerprint))} aria-label={`Pair ${b.name}`}>Pair</button>
              ) : b.state === 'ready' ? (
                <button type="button" className="btn btn-sm btn-ghost" disabled={Boolean(busy)} onClick={() => run(b.fingerprint, () => api.bridgeChoose(b.fingerprint))}>Use</button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {a && a.key !== 'local' && (
        <button type="button" className="btn btn-sm btn-ghost btn-danger-text dl-bridge-forget" onClick={() => window.confirm(`Forget the bridge "${a.name}"? It must be paired again to be used.`) && run('f', () => api.bridgeForget(a.key))}>
          Forget this bridge
        </button>
      )}
    </section>
  );
}

// The phone, and the SIM it calls with (what Bluetooth Hands-Free shows).
function PhoneCard({ st, notify }) {
  const [scanning, setScanning] = useState(false);
  const [busy, run] = useRunner(notify);
  const [text, tone] = linkText(st);
  const phone = st?.phone;
  const ready = st?.link === 'ready';
  const roleOk = st?.hfRole === 'ok';
  const showList = roleOk && (scanning || !st?.saved);
  const devices = (st?.devices || []).filter((d) => d.paired || d.rssi != null || scanning);
  const scan = async (on) => {
    setScanning(on);
    await run('scan', () => api.dialerScan(on));
  };
  useEffect(() => () => void (scanning && api.dialerScan(false)), [scanning]);
  const numbers = phone?.numbers?.length ? phone.numbers : phone?.number ? [phone.number] : [];

  return (
    <section className="panel dl-card dl-phone" aria-label="Phone">
      <header className="dl-device">
        <span className={`dl-device-icon tone-${tone}`} aria-hidden="true">
          <Icon name="phone" size={18} />
        </span>
        <div className="dl-device-text">
          <strong>{st?.saved?.name || 'Your phone'}</strong>
          <span className={`dl-pill tone-${tone}`} role="status">
            <span className="dl-pill-dot" />
            {text}
          </span>
        </div>
        {roleOk && st?.saved && !ready && st.link !== 'connecting' && (
          <button type="button" className="btn btn-sm" disabled={Boolean(busy) || !st.adapter?.powered} onClick={() => run('re', () => api.dialerReconnect())}>
            Reconnect
          </button>
        )}
        {st?.saved && (ready || st.link === 'connecting') && (
          <button type="button" className="btn btn-sm btn-ghost" disabled={Boolean(busy)} onClick={() => run('dc', () => api.dialerDisconnect())}>
            Disconnect
          </button>
        )}
      </header>

      {ready && phone && (
        <div className="dl-device-stats">
          <span title="Signal">{phone.service ? <Bars level={phone.signal ?? 0} /> : <span className="dl-warn">No service</span>}</span>
          {phone.battery != null && (
            <span title="Phone battery">
              <span className="dl-battery" aria-hidden="true"><span style={{ width: `${Math.max(4, phone.battery)}%` }} /></span>
              {phone.battery}%
            </span>
          )}
          {phone.roam && <span className="dl-warn">Roaming</span>}
        </div>
      )}

      {st?.adapter && !st.adapter.powered && (
        <div className="dl-note">
          <span>Bluetooth is off on this computer.</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => run('pw', () => api.dialerPower(true))}>
            Turn on
          </button>
        </div>
      )}

      {st?.hfRole === 'pipewire' && (
        <div className="dl-callout" role="alert">
          <strong>Use this computer as your phone's hands-free</strong>
          <span>Calls go through Bluetooth Hands-Free, as with a car kit. The sound server (PipeWire) holds that role now but cannot dial. Bluetooth headsets keep working, microphones included. This can be undone (see README).</span>
          <button type="button" className="btn btn-sm btn-primary" disabled={Boolean(busy)} onClick={() => run('hf', () => api.dialerTakeHandsFree())}>
            {busy === 'hf' ? <><span className="spinner" aria-hidden="true" /> Setting up…</> : 'Use this computer for calls'}
          </button>
        </div>
      )}

      {ready && phone && (
        <div className="dl-sim" aria-label="SIM for calls">
          <div className="dl-sim-card">
            <span className="dl-sim-chipset" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
            <div className="dl-sim-text">
              <span className="dl-sim-label">Calls go out on</span>
              <strong>{phone.operator || 'The phone’s calling SIM'}</strong>
              {numbers.map((n) => (
                <span key={n} className="mono dl-sim-number">{n}</span>
              ))}
            </div>
            <button type="button" className="icon-btn" aria-label="Check the SIM again" title="Check the SIM again" disabled={Boolean(busy)} onClick={() => run('sim', () => api.dialerRefreshSim())}>
              {busy === 'sim' ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
            </button>
          </div>
          <p className="dl-sim-note">
            Bluetooth Hands-Free has no SIM choice: the phone calls on its <b>default SIM for calls</b>. To switch SIM, change it on the phone (Settings → SIM → Calls), then check again here. Lead Finder also checks before every call.
          </p>
        </div>
      )}

      {showList && st?.adapter?.powered && (
        <div className="dl-devices">
          <div className="dl-devices-head">
            <span>{scanning ? 'Nearby devices' : 'Connect your phone'}</span>
            <button type="button" className="btn btn-sm" onClick={() => scan(!scanning)}>
              {scanning ? <><span className="spinner" aria-hidden="true" /> Stop</> : <><Icon name="search" size={14} /> Find phone</>}
            </button>
          </div>
          {!scanning && devices.length === 0 && <p className="dl-hint">Turn on Bluetooth on your phone, open its Bluetooth settings so it can be found, then press Find phone. Nothing is installed on the phone.</p>}
          <ul>
            {devices.map((d) => (
              <li key={d.address}>
                <Icon name={d.icon === 'phone' ? 'phone' : 'sliders'} size={15} />
                <span className="dl-dev-name">
                  {d.name}
                  <span className="muted mono">{d.paired ? 'Paired' : d.address}</span>
                </span>
                {st.saved?.address === d.address && ready ? (
                  <span className="chip chip-accent">Connected</span>
                ) : (
                  <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => run(d.address, () => api.dialerConnect(d.address)).then(() => setScanning(false))} aria-label={`Connect ${d.name}`}>
                    {busy === d.address ? <span className="spinner" aria-hidden="true" /> : d.paired ? 'Connect' : 'Pair'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-sm btn-ghost dl-visible" onClick={() => run('vis', () => api.dialerVisible(true)).then((r) => r?.ok && notify({ type: 'info', text: `This computer (${st.adapter.name}) can be found from the phone for 3 minutes.` }))}>
            Pair from the phone instead
          </button>
        </div>
      )}
      {roleOk && st?.saved && !showList && (
        <div className="dl-foot">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => scan(true)}>
            Use another phone
          </button>
          <button type="button" className="btn btn-sm btn-ghost btn-danger-text" onClick={() => run('forget', () => api.dialerForget(st.saved.address))}>
            Forget
          </button>
        </div>
      )}
    </section>
  );
}

function AudioCard({ st }) {
  const [open, setOpen] = useState(true);
  const devs = st?.audioDevices || { outputs: [], inputs: [] };
  const prefs = st?.audioPrefs || {};
  const nameOf = (list, name, def) => list.find((d) => d.name === (name || def))?.description || 'System default';
  return (
    <section className="panel dl-card dl-audio" aria-label="Call audio">
      <button type="button" className="dl-audio-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="sliders" size={15} />
        <span className="dl-audio-summary">
          <strong>Audio</strong>
          <span>
            {nameOf(devs.outputs, prefs.output, devs.defaultOutput)} · {nameOf(devs.inputs, prefs.input, devs.defaultInput)}
          </span>
        </span>
        <Icon name="chevron" size={14} className={open ? 'dl-flip' : ''} />
      </button>
      {st?.audioAvailable === false && <p className="dl-audio-state tone-bad">{st.audioError}</p>}
      {open && (
        <div className="dl-audio-body">
          <label className="dl-select">
            <span>Speaker or headphones</span>
            <select value={prefs.output || ''} onChange={(e) => api.dialerSetAudio({ output: e.target.value })} aria-label="Speaker or headphones">
              <option value="">System default</option>
              {devs.outputs.map((d) => (
                <option key={d.name} value={d.name}>{d.description}</option>
              ))}
            </select>
          </label>
          <label className="dl-select">
            <span>Microphone</span>
            <select value={prefs.input || ''} onChange={(e) => api.dialerSetAudio({ input: e.target.value })} aria-label="Microphone">
              <option value="">System default</option>
              {devs.inputs.map((d) => (
                <option key={d.name} value={d.name}>{d.description}</option>
              ))}
            </select>
          </label>
          <label className="dl-check">
            <input type="checkbox" checked={prefs.echoCancel !== false} onChange={(e) => api.dialerSetAudio({ echoCancel: e.target.checked })} />
            <span>Echo cancellation (use with speakers)</span>
          </label>
          <p className="dl-fine">Nothing is recorded.</p>
        </div>
      )}
    </section>
  );
}

function CallCard({ st, number, setNumber, lead, setLead, notify }) {
  const call = st?.call;
  const live = call && call.state !== 'ended';
  useTick(live && call.state === 'active');
  const ready = st?.link === 'ready';
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [tones, setTones] = useState('');
  const [padOpen, setPadOpen] = useState(false);
  useEffect(() => {
    if (!live) {
      setTones('');
      setPadOpen(false);
    }
  }, [live]);

  const act = async (fn) => {
    const r = await fn();
    if (r && !r.ok) notify({ type: 'error', text: r.error });
    return r;
  };
  const press = (k) => {
    if (live) {
      if (call.state !== 'active') return;
      setTones((t) => (t + k).slice(-20));
      act(() => api.dialerDtmf(k));
      return;
    }
    setNumber((n) => (n + k).slice(0, 24));
    input.current?.focus();
  };
  const dial = async () => {
    if (!userActed()) return;
    setBusy(true);
    const r = await api.dialerCall(number, { leadId: lead?.leadId, numberId: lead?.numberId });
    setBusy(false);
    if (!r.ok) notify({ type: 'error', text: r.error });
  };

  const who = (call ? [call.name, call.business] : [lead?.name, lead?.business]).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  let stateText = '';
  let stateTone = 'soft';
  if (call) {
    if (call.state === 'requesting') stateText = 'Dialing';
    else if (call.state === 'dialing') stateText = 'Calling';
    else if (call.state === 'alerting') stateText = 'Ringing';
    else if (call.state === 'ringing') (stateText = 'Incoming call'), (stateTone = 'ok');
    else if (call.state === 'active') (stateText = 'Connected'), (stateTone = 'ok');
    else if (call.state === 'ended') {
      const [label, t] = statusOf(call.status);
      stateText = call.status === 'failed' ? `Failed${call.error ? `: ${call.error}` : ''}` : `${label}${call.duration ? ` · ${formatDuration(call.duration)}` : ''}`;
      stateTone = t;
    }
  }
  const pending = live && ['requesting', 'dialing', 'alerting'].includes(call.state);
  const elapsed = call?.answeredAt ? (Date.now() - call.answeredAt) / 1000 : 0;
  const onComputer = call?.audio?.state === 'computer';
  const showPad = !call || (live && call.state === 'active' && padOpen);

  return (
    <section className={`panel dl-card dl-call ${live ? 'live' : ''} ${call?.state === 'ringing' ? 'ringing' : ''}`} aria-label="Dial pad">
      {call ? (
        <div className="dl-stage">
          <div className={`dl-avatar ${pending || call.state === 'ringing' ? 'pulse' : ''} tone-${stateTone}`} aria-hidden="true">
            {initials(who[0])}
          </div>
          {who[0] ? <strong className="dl-stage-name">{who[0]}</strong> : null}
          {who[1] && <span className="dl-stage-sub">{who[1]}</span>}
          <span className="dl-stage-number mono" aria-label="Number">{call.number || 'Unknown number'}</span>
          <div className={`dl-state tone-${stateTone}`} role="status" aria-live="polite">
            {stateText}
            {pending && <span className="dl-dots" aria-hidden="true"><i /><i /><i /></span>}
            {call.state === 'active' && <span className="dl-timer mono">{formatDuration(elapsed)}</span>}
          </div>
          <div className="dl-tags">
            {call.operator && <span className="dl-tag"><Icon name="phone" size={11} /> {call.operator}</span>}
            {call.auto && live && <span className="dl-tag accent">Auto Dialer</span>}
          </div>
          {tones && <div className="dl-tones mono" aria-label="Tones sent">{tones}</div>}
        </div>
      ) : (
        <div className="dl-display">
          {who.length > 0 && (
            <div className="dl-who">
              <strong>{who[0]}</strong>
              {who[1] && <span>{who[1]}</span>}
            </div>
          )}
          <div className="dl-input-row">
            <input
              ref={input}
              className="dl-number-input mono"
              style={{ fontSize: number.length > 16 ? 22 : number.length > 12 ? 26 : 32 }}
              value={number}
              placeholder="Enter a number"
              aria-label="Phone number"
              inputMode="tel"
              onChange={(e) => {
                setNumber(e.target.value.replace(/[^\d+*#\s()-]/g, '').slice(0, 24));
                if (lead) setLead(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ready && number) dial();
              }}
            />
            {number && (
              <button type="button" className="icon-btn dl-back" aria-label="Delete last digit" onClick={() => setNumber((n) => n.slice(0, -1))} onDoubleClick={() => (setNumber(''), setLead(null))}>
                <Icon name="backspace" />
              </button>
            )}
          </div>
          <div className="dl-ready" role="status">
            {ready ? (st.phone?.operator ? <>Calls go out on <b>{st.phone.operator}</b></> : 'Ready') : 'Connect your phone to call'}
          </div>
        </div>
      )}

      {live && call.state !== 'ringing' && (
        <div className="dl-actions">
          <button type="button" className={`dl-action ${call.muted ? 'on' : ''}`} aria-label={call.muted ? 'Unmute' : 'Mute'} aria-pressed={Boolean(call.muted)} disabled={!onComputer} title={onComputer ? undefined : 'The call audio is on the phone'} onClick={() => act(() => api.dialerMute(!call.muted))}>
            <Icon name={call.muted ? 'mic-off' : 'mic'} size={18} />
            <span>{call.muted ? 'Unmute' : 'Mute'}</span>
          </button>
          <button type="button" className={`dl-action ${padOpen ? 'on' : ''}`} aria-label="Keypad" aria-pressed={padOpen} disabled={call.state !== 'active'} onClick={() => setPadOpen((o) => !o)}>
            <Icon name="grid" size={18} />
            <span>Keypad</span>
          </button>
          <button
            type="button"
            className={`dl-action ${onComputer ? 'on' : ''}`}
            aria-label={onComputer ? 'Move the call audio to the phone' : 'Move the call audio to this computer'}
            disabled={call.audio?.state === 'connecting'}
            onClick={() => act(() => api.dialerAudioTo(onComputer ? 'phone' : 'computer'))}
          >
            <Icon name={onComputer ? 'laptop' : 'phone'} size={18} />
            <span>{call.audio?.state === 'connecting' ? 'Moving…' : onComputer ? 'On computer' : 'On phone'}</span>
          </button>
        </div>
      )}
      {live && call.audio?.error && <p className="dl-audio-state tone-bad">{call.audio.error}</p>}

      {showPad && (
        <div className="dl-pad" role="group" aria-label="Keypad">
          {KEYS.map(([k, sub]) => (
            <button key={k} type="button" className="dl-key" onClick={() => press(k)} onContextMenu={(e) => !live && k === '0' && (e.preventDefault(), press('+'))} aria-label={k === '0' && !live ? '0 (right-click for +)' : k}>
              <span className="dl-key-main">{k}</span>
              <span className="dl-key-sub">{sub}</span>
            </button>
          ))}
        </div>
      )}

      <div className="dl-controls">
        {call?.state === 'ringing' ? (
          <>
            <button type="button" className="dl-round dl-end" aria-label="Reject" disabled={!st.phone?.canReject} onClick={() => act(api.dialerReject)}>
              <Icon name="phone-off" size={24} />
            </button>
            <button type="button" className="dl-round dl-go pulse" aria-label="Answer" onClick={() => act(api.dialerAnswer)}>
              <Icon name="phone" size={24} />
            </button>
          </>
        ) : live ? (
          <button type="button" className="dl-round dl-end" aria-label="End call" onClick={() => act(() => api.dialerHangup())}>
            <Icon name="phone-off" size={24} />
          </button>
        ) : (
          <button type="button" className="dl-round dl-go" aria-label="Call" disabled={!ready || !number.trim() || busy || Boolean(call)} onClick={dial}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="phone" size={24} />}
          </button>
        )}
      </div>
    </section>
  );
}

const AUTO_STATUS = {
  off: ['Off', 'soft'],
  running: ['Running', 'ok'],
  calling: ['Calling', 'ok'],
  waiting: ['Next call soon', 'ok'],
  paused: ['Paused', 'warn'],
};

function AutoDialerCard({ st, auto, notify }) {
  const [busy, run] = useRunner(notify);
  const [showSettings, setShowSettings] = useState(false);
  const [lists, setLists] = useState([]);
  useTick(auto?.status === 'waiting');
  useEffect(() => {
    const load = () => api.numberLists().then((l) => setLists(l || []));
    load();
    return api.onNumbersChanged(load);
  }, []);
  if (!auto) return null;
  const on = auto.status !== 'off';
  const ready = st?.link === 'ready';
  const [label, tone] = AUTO_STATUS[auto.status] || AUTO_STATUS.off;
  const secs = auto.nextAt ? Math.max(0, Math.ceil((auto.nextAt - Date.now()) / 1000)) : null;
  const total = auto.total || 0;
  const done = Math.min(auto.processed + auto.skipped, total);
  const set = auto.settings;
  const toggle = () => run('t', () => (on ? api.autoDialStop() : api.autoDialStart()));

  return (
    <section className={`panel dl-card dl-auto ${on ? 'on' : ''}`} aria-label="Auto Dialer">
      <header className="dl-auto-head">
        <div className="dl-auto-title">
          <strong>Auto Dialer</strong>
          <span className={`dl-pill tone-${tone}`}>
            <span className="dl-pill-dot" />
            {label}
          </span>
        </div>
        <button type="button" role="switch" aria-checked={on} aria-label="Auto Dialer" className={`dl-switch ${on ? 'on' : ''}`} disabled={Boolean(busy) || (!on && !ready)} onClick={toggle} title={!on && !ready ? 'Connect your phone first' : undefined}>
          <span />
        </button>
      </header>

      <div className="dl-auto-facts">
        <label className="dl-auto-source">
          <span>Calls</span>
          <select
            aria-label="Auto Dialer calls"
            value={set.source.kind === 'list' ? String(set.source.listId) : 'leads'}
            disabled={on}
            onChange={(e) => run('src', () => api.autoDialSettings({ source: e.target.value === 'leads' ? { kind: 'leads' } : { kind: 'list', listId: Number(e.target.value) } }))}
          >
            <option value="leads">Leads (Call Unseen)</option>
            {lists.map((l) => (
              <option key={l.id} value={String(l.id)}>
                {l.name} · {l.unseen} unseen
              </option>
            ))}
          </select>
        </label>
        <span className="dl-auto-sim" title="The phone's default SIM for calls">
          <Icon name="phone" size={12} /> {st?.phone?.operator ? `SIM: ${st.phone.operator}` : 'SIM: phone not connected'}
        </span>
      </div>

      {!on && (
        <p className="dl-auto-intro">
          Calls the <b>Call Unseen</b> {set.source.kind === 'list' ? 'numbers of this category' : 'leads'} with a mobile number, one by one. 60 seconds after each answered call ends, it dials the next. It never calls a number twice.
          {auto.eligible != null && <> <b>{auto.eligible}</b> ready.</>}
        </p>
      )}

      {on && (
        <>
          <div className="dl-progress" aria-label={`${done} of ${total} leads`}>
            <div className="dl-progress-bar"><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
            <span className="mono">{done} / {total}</span>
          </div>
          {auto.lead && (
            <div className="dl-auto-lead">
              <span className="dl-avatar small" aria-hidden="true">{initials(auto.lead.name)}</span>
              <span>
                <strong>{auto.lead.name}</strong>
                <span className="mono">{auto.lead.number}</span>
              </span>
            </div>
          )}
          {auto.status === 'waiting' && secs != null && <p className="dl-auto-reason">Next call in <b className="mono">{secs}s</b></p>}
          {auto.reason && <p className={`dl-auto-reason tone-${auto.status === 'paused' ? 'warn' : 'soft'}`}>{auto.reason}</p>}
          <div className="dl-auto-buttons">
            {auto.status === 'paused' ? (
              <button type="button" className="btn btn-sm btn-primary" disabled={Boolean(busy) || !ready} onClick={() => run('r', () => api.autoDialResume())}>
                <Icon name="play" size={13} /> Continue
              </button>
            ) : (
              <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => run('p', () => api.autoDialPause())}>
                <Icon name="pause" size={13} /> Pause
              </button>
            )}
            <button type="button" className="btn btn-sm btn-danger dl-stop" disabled={Boolean(busy)} onClick={() => run('s', () => api.autoDialStop())}>
              <Icon name="stop" size={13} /> Stop
            </button>
          </div>
        </>
      )}
      {!on && auto.reason && <p className="dl-auto-reason tone-soft">{auto.reason}</p>}

      {auto.log?.length > 0 && (
        <ul className="dl-auto-log" aria-label="Auto Dialer results">
          {auto.log.slice(0, 3).map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <span className={`dl-status s-${statusOf(e.outcome)[1]}`}>{statusOf(e.outcome)[0]}</span>
              <span className="dl-auto-log-text">
                <b>{e.name || e.number}</b>
                <span>{e.reason}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="dl-settings-toggle" aria-expanded={showSettings} onClick={() => setShowSettings((o) => !o)}>
        Calling rules <Icon name="chevron" size={12} className={showSettings ? 'dl-flip' : ''} />
      </button>
      {showSettings && (
        <div className="dl-auto-settings">
          <label>
            <span>Calling hours</span>
            <span className="dl-hours">
              <input type="checkbox" aria-label="Only within calling hours" checked={set.hours.on} onChange={(e) => api.autoDialSettings({ hours: { on: e.target.checked } })} />
              <input type="time" aria-label="Calling hours from" value={set.hours.from} disabled={!set.hours.on} onChange={(e) => api.autoDialSettings({ hours: { from: e.target.value } })} />
              <span>–</span>
              <input type="time" aria-label="Calling hours to" value={set.hours.to} disabled={!set.hours.on} onChange={(e) => api.autoDialSettings({ hours: { to: e.target.value } })} />
            </span>
          </label>
          <label>
            <span>Ring for at most</span>
            <span><input type="number" min="15" max="120" aria-label="Ring seconds" value={set.ringSeconds} onChange={(e) => api.autoDialSettings({ ringSeconds: Number(e.target.value) })} /> s</span>
          </label>
          <label>
            <span>Gap between calls</span>
            <span><input type="number" min="5" max="600" aria-label="Gap seconds" value={set.gapSeconds} onChange={(e) => api.autoDialSettings({ gapSeconds: Number(e.target.value) })} /> s</span>
          </label>
          <label className="dl-check">
            <input type="checkbox" checked={set.mobileOnly} onChange={(e) => api.autoDialSettings({ mobileOnly: e.target.checked })} />
            <span>Mobile numbers only</span>
          </label>
          <p className="dl-fine">After an answered call ends (from the computer or the phone), or one you end before it is answered, the next call is 60 seconds later. Do-not-call, opted-out and already-called numbers are never called.</p>
        </div>
      )}
    </section>
  );
}

// The last two calls only (all calls stay saved).
function RecentCalls({ onRedial, ready, refreshKey }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let off = false;
    const load = () => api.dialerHistory({ limit: 2 }).then((r) => !off && setRows(r || []));
    load();
    const unsub = api.onDialerHistory(load);
    return () => {
      off = true;
      unsub();
    };
  }, [refreshKey]);

  return (
    <section className="panel dl-card dl-recent" aria-label="Recent calls">
      <h2 className="dl-card-title">Recent calls</h2>
      {rows.length === 0 ? (
        <p className="dl-empty">Your last two calls appear here.</p>
      ) : (
        <ul>
          {rows.map((c) => {
            const [label, tone] = statusOf(c.status);
            const name = c.name || c.business;
            return (
              <li key={c.id}>
                <span className={`dl-dir-icon ${c.direction}`} aria-label={c.direction === 'incoming' ? 'Incoming' : 'Outgoing'}>
                  <Icon name={c.direction === 'incoming' ? 'call-in' : 'call-out'} size={14} />
                </span>
                <span className="dl-recent-main">
                  <strong>{name || c.number || 'Unknown number'}</strong>
                  {name && <span className="mono">{c.number || 'Hidden number'}</span>}
                  <span className="dl-recent-meta">
                    {c.direction === 'incoming' ? 'Incoming' : 'Outgoing'}
                    {c.sim ? ` · ${c.sim}` : ''} · {when(c.startedAt)}
                  </span>
                </span>
                <span className="dl-recent-side">
                  <span className={`dl-status s-${tone}`} title={c.detail || undefined}>{label}</span>
                  {c.duration > 0 && <span className="mono dl-dur">{formatDuration(c.duration)}</span>}
                </span>
                {c.number && (
                  <button type="button" className="icon-btn" aria-label={`Call ${name || c.number} again`} title={ready ? 'Call again' : 'Connect your phone to call'} disabled={!ready} onClick={() => onRedial(c)}>
                    <Icon name="phone" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// prefill: { number, leadId, name, business, nonce } from a lead's Call button.
export default function DialerView({ notify, hidden, prefill }) {
  const [st, setSt] = useState(null);
  const [bridge, setBridge] = useState(null);
  const [auto, setAuto] = useState(null);
  const [number, setNumber] = useState('');
  const [lead, setLead] = useState(null);
  const [historyKey, setHistoryKey] = useState(0);

  useEffect(() => {
    api.dialerState().then((s) => s && setSt(s));
    api.autoDialState().then((s) => s && setAuto(s));
    api.bridgeState().then((b) => b && setBridge(b));
    const off1 = api.onDialerState(setSt);
    const off2 = api.onAutoDialState(setAuto);
    const off3 = api.onBridgeState(setBridge);
    return () => {
      off1();
      off2();
      off3();
    };
  }, []);
  // A bridge carries the call and its audio is on the computer: the window plays and records it.
  const remote = Boolean(bridge?.active && bridge.active.key !== 'local');
  useBridgeVoice(remote && st?.call?.state !== 'ended' && st?.call?.audio?.state === 'computer');
  // The number of leads ready is counted again when the Dialer is opened.
  useEffect(() => {
    if (!hidden) api.autoDialState().then((s) => s && setAuto(s));
  }, [hidden]);
  useEffect(() => {
    if (!prefill) return;
    setNumber(prefill.number || '');
    setLead(prefill.leadId || prefill.numberId ? { leadId: prefill.leadId || null, numberId: prefill.numberId || null, name: prefill.name, business: prefill.business } : null);
  }, [prefill]);
  const ended = st?.call?.state === 'ended';
  useEffect(() => {
    if (ended) setHistoryKey((k) => k + 1);
  }, [ended]);

  const redial = async (c) => {
    if (!userActed()) return;
    setNumber(c.number);
    setLead(c.leadId || c.numberId ? { leadId: c.leadId, numberId: c.numberId, name: c.name, business: c.business } : null);
    const r = await api.dialerCall(c.number, { leadId: c.leadId, numberId: c.numberId });
    if (!r.ok) notify({ type: 'error', text: r.error });
  };

  const pairing = st?.pairing;
  const busyLine = Boolean(st?.call && st.call.state !== 'ended');
  return (
    <section className="dialer" hidden={hidden} aria-label="Dialer">
      <div className="dl-grid">
        <aside className="dl-col dl-left">
          <AutoDialerCard st={st} auto={auto} notify={notify} />
          <RecentCalls onRedial={redial} ready={st?.link === 'ready' && !busyLine && (!auto || auto.status === 'off')} refreshKey={historyKey} />
        </aside>
        <div className="dl-right">
          <CallCard st={st} number={number} setNumber={setNumber} lead={lead} setLead={setLead} notify={notify} />
          <div className="dl-col">
            <BridgeCard bridge={bridge} notify={notify} />
            <PhoneCard st={st} notify={notify} />
            <AudioCard st={st} />
          </div>
        </div>
      </div>
      {bridge?.pairing && (
        <div className="modal-scrim">
          <div className="composer dl-pair" role="dialog" aria-label="Pair bridge">
            <header className="composer-head">
              <span className="composer-icon neutral"><Icon name="lock" /></span>
              <div>
                <strong>Pair with the bridge “{bridge.pairing.name}”</strong>
                <span className="muted">Check that the bridge shows the same code, then confirm here and on the bridge.</span>
              </div>
            </header>
            <div className="dl-code big mono">{bridge.pairing.code}</div>
            <div className="dl-pair-actions">
              <button type="button" className="btn" onClick={() => api.bridgeConfirm(bridge.pairing.fingerprint, false)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => api.bridgeConfirm(bridge.pairing.fingerprint, true)}>Codes match</button>
            </div>
          </div>
        </div>
      )}
      {pairing && (
        <div className="modal-scrim">
          <div className="composer dl-pair" role="dialog" aria-label="Pair phone">
            <header className="composer-head">
              <span className="composer-icon neutral"><Icon name="lock" /></span>
              <div>
                <strong>Pair with {st.devices.find((d) => d.address === pairing.address)?.name || 'your phone'}</strong>
                <span className="muted">{pairing.passkey ? 'Check that the phone shows the same code, then confirm on both.' : 'Allow this phone to pair with this computer?'}</span>
              </div>
            </header>
            {pairing.passkey && <div className="dl-code big mono">{pairing.passkey}</div>}
            {!pairing.display && (
              <div className="dl-pair-actions">
                <button type="button" className="btn" onClick={() => api.dialerConfirmPairing(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" onClick={() => api.dialerConfirmPairing(true)}>
                  {pairing.passkey ? 'Codes match' : 'Pair'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// The lead row's Call button (one click): calls through the phone when it is
// connected, otherwise opens the Dialer with the number filled in.
export function useLeadCall({ onOpenDialer, notify }) {
  return useMemo(
    () => async (lead) => {
      const person = lead.kind === 'person';
      // An imported number (numberEntry) or a lead.
      const fill = lead.numberEntry
        ? { number: lead.phone, numberId: lead.id, name: lead.name || lead.business, business: lead.business, nonce: Date.now() }
        : { number: lead.phone, leadId: lead.id, name: person ? lead.name : lead.contactName || lead.name, business: person ? lead.companyName : lead.name, nonce: Date.now() };
      onOpenDialer(fill);
      if (!userActed()) return;
      const st = await api.dialerState();
      if (st?.link !== 'ready') return notify({ type: 'info', text: 'Connect your phone in the Dialer to call this number.' });
      const r = await api.dialerCall(lead.phone, lead.numberEntry ? { numberId: lead.id } : { leadId: lead.id });
      if (!r.ok) notify({ type: 'error', text: r.error });
    },
    [onOpenDialer, notify],
  );
}
