'use strict';

// Only one program can be a computer's Bluetooth Hands-Free unit. PipeWire's
// WirePlumber takes that role (hfp_hf) by default but offers no way to dial,
// so the Dialer asks the user, then gives WirePlumber a user setting without
// hfp_hf (its other headset roles stay, so Bluetooth headsets keep their
// microphones) and restarts it. Removing the files gives the role back.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const NAME = '51-lead-finder-hfp';

function files(home = os.homedir()) {
  const base = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'wireplumber');
  return {
    // WirePlumber 0.4 (Lua) and 0.5 (SPA-JSON) read different folders; both are written.
    lua: path.join(base, 'bluetooth.lua.d', `${NAME}.lua`),
    conf: path.join(base, 'wireplumber.conf.d', `${NAME}.conf`),
  };
}

const LUA = `-- Written by Lead Finder (Dialer): Lead Finder is this computer's Hands-Free
-- unit for phones, so WirePlumber keeps its other headset roles but not hfp_hf.
-- Delete this file and restart WirePlumber to give the role back.
bluez_monitor.properties["bluez5.headset-roles"] = "[ hsp_hs hsp_ag hfp_ag ]"
`;
const CONF = `# Written by Lead Finder (Dialer): Lead Finder is this computer's Hands-Free
# unit for phones, so WirePlumber keeps its other roles but not hfp_hf.
# Delete this file and restart WirePlumber to give the role back.
monitor.bluez.properties = {
  bluez5.roles = [ a2dp_sink a2dp_source bap_sink bap_source hsp_hs hsp_ag hfp_ag ]
}
`;

function handedOver(home) {
  const f = files(home);
  return fs.existsSync(f.lua) || fs.existsSync(f.conf);
}

function restartWirePlumber(exec = execFile) {
  return new Promise((resolve, reject) => {
    exec('systemctl', ['--user', 'restart', 'wireplumber'], { timeout: 20_000 }, (err, _out, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve()));
  });
}

async function takeOver({ home, exec } = {}) {
  const f = files(home);
  fs.mkdirSync(path.dirname(f.lua), { recursive: true });
  fs.mkdirSync(path.dirname(f.conf), { recursive: true });
  fs.writeFileSync(f.lua, LUA);
  fs.writeFileSync(f.conf, CONF);
  await restartWirePlumber(exec);
}

async function giveBack({ home, exec } = {}) {
  const f = files(home);
  fs.rmSync(f.lua, { force: true });
  fs.rmSync(f.conf, { force: true });
  await restartWirePlumber(exec);
}

module.exports = { files, handedOver, takeOver, giveBack };
