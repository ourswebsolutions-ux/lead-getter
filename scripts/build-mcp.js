'use strict';

// Bundles Lead Finder's MCP server (src/claude/bridge.js with the official
// MCP SDK) into one file, dist/claude/lead-finder-mcp.cjs. The app copies
// it to its data folder and Claude Desktop runs it with Lead Finder's own
// program (ELECTRON_RUN_AS_NODE), so the installer needs nothing else.
// Part of `npm run build` and `npm run release`.

const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist', 'claude');
const { version } = require('../package.json');

(async () => {
  const { build } = await import('vite');
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    define: { __LF_VERSION__: JSON.stringify(version) },
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: path.join(root, 'src', 'claude', 'bridge.js'),
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      target: 'node20',
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'lead-finder-mcp.cjs', codeSplitting: false } },
    },
  });
  const file = path.join(outDir, 'lead-finder-mcp.cjs');
  const size = fs.statSync(file).size;
  console.log(`MCP server: ${path.relative(root, file)} (${Math.round(size / 1024)} KB)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
