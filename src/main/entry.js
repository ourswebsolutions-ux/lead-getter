'use strict';

// `lead-finder --bridge` runs Lead Finder Bridge (no window): this
// computer's Bluetooth and the phone connected to it are then used by Lead
// Finder on another computer of the local network (see src/bridge).
// Otherwise: the app.
if (process.argv.includes('--bridge')) require('../bridge/run').runInElectron();
else require('./main');
