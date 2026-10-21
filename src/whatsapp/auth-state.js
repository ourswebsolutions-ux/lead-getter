'use strict';

// Baileys authentication state stored on disk, every file encrypted.
// Modelled on Baileys' useMultiFileAuthState, with three changes: each file
// is encrypted with the injected cipher (Electron safeStorage, i.e. the OS
// keychain), writes are atomic (temp file + rename), and files are only
// readable by the current user.

const fs = require('node:fs/promises');
const path = require('node:path');

function makeLocks() {
  const chains = new Map();
  return (key, fn) => {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(key, next.catch(() => {}));
    return next;
  };
}

// baileys: the imported module ({ initAuthCreds, BufferJSON, proto }).
// cipher: { encrypt(string) -> Buffer, decrypt(Buffer) -> string }.
async function useEncryptedAuthState(dir, cipher, baileys) {
  const { initAuthCreds, BufferJSON, proto } = baileys;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = makeLocks();
  const fileFor = (name) => path.join(dir, `${name.replace(/\//g, '__').replace(/:/g, '-')}.enc`);

  const write = (name, value) =>
    lock(name, async () => {
      const file = fileFor(name);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, cipher.encrypt(JSON.stringify(value, BufferJSON.replacer)), { mode: 0o600 });
      await fs.rename(tmp, file);
    });
  const read = (name) =>
    lock(name, async () => {
      try {
        return JSON.parse(cipher.decrypt(await fs.readFile(fileFor(name))), BufferJSON.reviver);
      } catch {
        return null; // missing or unreadable: treated as absent
      }
    });
  const remove = (name) => lock(name, () => fs.unlink(fileFor(name)).catch(() => {}));

  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
              out[id] = value;
            }),
          );
          return out;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              tasks.push(value ? write(`${category}-${id}`, value) : remove(`${category}-${id}`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds),
    isRegistered: () => Boolean(creds.registered || creds.me),
  };
}

async function hasSession(dir) {
  try {
    await fs.access(path.join(dir, 'creds.enc'));
    return true;
  } catch {
    return false;
  }
}

async function wipeSession(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

module.exports = { useEncryptedAuthState, hasSession, wipeSession };
