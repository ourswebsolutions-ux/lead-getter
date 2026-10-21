'use strict';

// `npm run dev`: Vite dev server + Electron pointed at it.
// `npm start` (--prod): Electron loading the built UI from dist/.

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const prod = process.argv.includes('--prod');

function launchElectron(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  // Set by VS Code's integrated terminal; it would make Electron run as Node.
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(require('electron'), ['.'], { cwd: root, stdio: 'inherit', env });
}

(async () => {
  if (prod) {
    launchElectron({}).on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: path.join(root, 'vite.config.mjs') });
  await server.listen();
  const child = launchElectron({ VITE_DEV_SERVER_URL: server.resolvedUrls.local[0] });
  child.on('exit', async (code) => {
    await server.close();
    process.exit(code ?? 0);
  });
})();
