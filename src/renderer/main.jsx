import { createRoot } from 'react-dom/client';
// Bundled locally: the app works offline and stays within its CSP.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import App from './App.jsx';
import { initTheme } from './theme.js';
import './styles.css';

initTheme(); // before the first paint, so the right theme shows immediately
createRoot(document.getElementById('root')).render(<App />);
