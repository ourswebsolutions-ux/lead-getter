'use strict';

// Payment screenshots as files under DATA_DIR/uploads, readable only by
// this server (and only through a valid action link).

const fs = require('node:fs/promises');
const path = require('node:path');

const NAME_RE = /^applications\/LF-[0-9A-F]{10}\/[0-9a-f]{16}\.(png|jpg|webp)$/;

class Uploads {
  constructor(dir) {
    this.dir = dir;
  }

  file(name) {
    if (!NAME_RE.test(name)) throw new Error('Invalid upload name');
    return path.join(this.dir, ...name.split('/'));
  }

  async upload(name, data) {
    const file = this.file(name);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
  }

  download(name) {
    return fs.readFile(this.file(name));
  }

  async remove(names) {
    for (const name of names) {
      const file = this.file(name);
      await fs.rm(file, { force: true });
      await fs.rmdir(path.dirname(file)).catch(() => {});
    }
  }
}

module.exports = { Uploads };
