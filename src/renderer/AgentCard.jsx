import { useEffect, useRef, useState } from 'react';

// Compact "agent" status card shown while a search runs. Each headline is
// tied to a real event from the search (never shown ahead of it); headlines
// stay at least MIN_DWELL ms so quick steps are still readable.

const HEADLINES = {
  online: 'Your agent is online',
  connecting: 'Initializing Chrome connection…',
  connected: 'Your agent is now working',
  searching: 'Searching for potential clients…',
  analyzing: 'Analyzing business listings…',
  qualifying: 'Finding businesses without websites…',
  paused: 'Your agent is waiting for you',
  stopping: 'Stopping safely…',
};
const MIN_DWELL = 900;

export function stepOf(status) {
  if (status.state === 'paused') return 'paused';
  if (status.state === 'stopping') return 'stopping';
  if (status.state === 'connecting') return status.step === 'connected' ? 'connected' : 'connecting';
  if (status.state === 'running') return status.step || 'searching';
  return null;
}

// Mounted when the app has accepted a search, which is what "online" means.
// Every status event is queued as it arrives (not only the states React
// happens to render), so a short-lived step such as "connected" is never
// skipped; each headline stays at least MIN_DWELL ms.
export default function AgentCard({ status }) {
  const target = stepOf(status);
  const [shown, setShown] = useState('online');
  // The event that caused this card to mount is the first queued step.
  const queue = useRef(target ? [target] : []);
  const since = useRef(Date.now());

  useEffect(() => {
    let timer = 0;
    const pump = () => {
      timer = 0;
      if (!queue.current.length) return;
      const wait = MIN_DWELL - (Date.now() - since.current);
      if (wait > 0) {
        timer = setTimeout(pump, wait);
        return;
      }
      // When several steps are waiting, show "connected" (a milestone) and
      // then jump to the most recent step.
      const q = queue.current;
      const next = q.includes('connected') ? 'connected' : q[q.length - 1];
      queue.current = q.slice(q.indexOf(next) + 1);
      setShown(next);
      since.current = Date.now();
      if (queue.current.length) timer = setTimeout(pump, MIN_DWELL);
    };
    const off = window.leadFinder.onStatus((s) => {
      const step = stepOf(s);
      if (!step) return;
      const q = queue.current;
      if (q[q.length - 1] !== step) q.push(step);
      if (!timer) pump();
    });
    pump();
    return () => {
      off();
      clearTimeout(timer);
    };
  }, []);

  if (!target) return null;
  const paused = target === 'paused';
  return (
    <div className={`agent-card ${paused ? 'is-paused' : ''}`} role="status" aria-live="polite">
      <span className="agent-orb" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="agent-text">
        <span className="agent-headline" key={shown}>
          {HEADLINES[shown] || HEADLINES.searching}
        </span>
        <span className="agent-detail">{status.message}</span>
      </span>
      <span className="agent-count" title="Qualified leads in this search">
        <b className="num">{status.leads ?? 0}</b>
        <small>leads</small>
      </span>
    </div>
  );
}
