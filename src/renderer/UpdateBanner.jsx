import { useEffect, useState } from 'react';

// Automatic update progress. Quiet for routine checks; shown while an update
// downloads, waits for a search, restarts, or (macOS) needs downloading.
export default function UpdateBanner() {
  const [st, setSt] = useState(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    window.leadFinder.updateStatus().then(setSt).catch(() => {});
    return window.leadFinder.onUpdate((s) => {
      setSt(s);
      setHidden(false);
    });
  }, []);
  if (!st || hidden) return null;
  const v = st.available ? `Lead Finder ${st.available}` : 'An update';
  const text = {
    downloading: `Downloading ${v}${st.percent ? ` (${st.percent}%)` : ''}…`,
    ready: st.error || `${v} is ready and installs automatically.`,
    waiting: `${v} is ready. Lead Finder restarts to install it when the current search finishes.`,
    restarting: `Restarting to install ${v}…`,
    available: `${v} is available.`,
    error: `The update could not be completed (${st.error}). Lead Finder keeps working and tries again later.`,
  }[st.state];
  if (!text) return null;
  return (
    <div className={`update-banner update-${st.state}`} role="status" aria-live="polite">
      <span>{text}</span>
      {st.state === 'available' && (
        <button type="button" className="btn" onClick={() => window.leadFinder.openUpdateDownload()}>
          Download
        </button>
      )}
      {(st.state === 'error' || st.state === 'available') && (
        <button type="button" className="btn btn-ghost" onClick={() => setHidden(true)}>
          Dismiss
        </button>
      )}
    </div>
  );
}
