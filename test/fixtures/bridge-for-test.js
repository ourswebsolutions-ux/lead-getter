'use strict';
// A Lead Finder Bridge for end-to-end tests: the scripted phone
// (fake-bt-helper.py), pairing allowed without asking, its own data folder
// and discovery port. Prints "port <n>" when it listens.
const path = require('node:path');
const { runBridge } = require('../../src/bridge/run');
const { BridgeServer } = require('../../src/bridge/server');
const { Bluetooth } = require('../../src/dialer/bluetooth');

(async () => {
  const server = new BridgeServer({
    bluetooth: new Bluetooth({ script: path.join(__dirname, 'fake-bt-helper.py') }),
    dir: process.argv[2],
    name: 'Test bridge',
    confirm: async () => true,
    discoveryPort: Number(process.argv[3]),
    log: (m) => console.log(`[bridge] ${m}`),
  });
  const port = await server.start();
  console.log(`port ${port}`);
  process.on('SIGTERM', () => (server.stop(), process.exit(0)));
})();
void runBridge;
