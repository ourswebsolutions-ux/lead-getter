import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

// Strict CSP for the packaged UI. The dev server needs inline scripts for
// hot reload, so the tag is only added to production builds.
const cspPlugin = {
  name: 'lead-finder-csp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
};

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), cspPlugin],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  server: { port: 5199, strictPort: true },
});
