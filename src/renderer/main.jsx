import { createRoot } from 'react-dom/client';
// Bundled locally: the app works offline and stays within its CSP.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import { useEffect, useState } from 'react';
import App from './App.jsx';
import LockScreen from './LockScreen.jsx';
import { initTheme } from './theme.js';
import './styles.css';

initTheme(); // before the first paint, so the right theme shows immediately
// The app is only mounted after the PIN is accepted by the main process.
function Root() {
  const [lock, setLock] = useState(null);
  useEffect(() => {
    window.leadFinder.lockState().then(setLock);
  }, []);
  if (!lock) return null;
  if (!lock.unlocked) return <LockScreen configured={lock.configured} onUnlocked={() => setLock({ configured: true, unlocked: true })} />;
  return (
    <App
      onLock={async () => {
        await window.leadFinder.lockNow();
        setLock({ configured: true, unlocked: false });
      }}
    />
  );
}

createRoot(document.getElementById('root')).render(<Root />);
