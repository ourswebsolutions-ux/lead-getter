'use strict';

// Voice files attached to outreach campaigns. A file chosen on this
// computer is checked (a format WhatsApp plays, by its content, not only its
// name) and copied byte for byte into the app's data folder, so it is sent
// in its original format even if the original is moved or deleted.
//
// Ogg/Opus files (the format of WhatsApp's own voice notes) are sent as
// voice notes; the others as audio files.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 16 * 1024 * 1024; // WhatsApp's limit for audio
const KEY = 'outreach.audio';

const head = (buf, s, at = 0) => buf.subarray(at, at + s.length).toString('latin1') === s;
// Formats WhatsApp plays: [extension(s), mime type, test on the first bytes, voice note]
const FORMATS = [
  { ext: ['.mp3'], mime: 'audio/mpeg', test: (b) => head(b, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0), label: 'MP3' },
  { ext: ['.m4a', '.mp4', '.m4b'], mime: 'audio/mp4', test: (b) => head(b, 'ftyp', 4), label: 'M4A' },
  { ext: ['.aac'], mime: 'audio/aac', test: (b) => head(b, 'ADIF') || (b[0] === 0xff && (b[1] & 0xf6) === 0xf0), label: 'AAC' },
  { ext: ['.ogg', '.opus', '.oga'], mime: 'audio/ogg; codecs=opus', test: (b) => head(b, 'OggS') && b.subarray(0, 512).includes(Buffer.from('OpusHead')), ptt: true, label: 'Ogg/Opus' },
  { ext: ['.amr'], mime: 'audio/amr', test: (b) => head(b, '#!AMR'), label: 'AMR' },
];
const EXTENSIONS = FORMATS.flatMap((f) => f.ext.map((e) => e.slice(1)));
const SUPPORTED = 'MP3, M4A, AAC, Ogg/Opus or AMR';

class AudioLibrary {
  // dir: where the copies are kept; state: { get, set } (app_state).
  constructor({ dir, state }) {
    this.dir = dir;
    this.state = state;
  }

  all() {
    const m = this.state.get(KEY);
    return m && typeof m === 'object' ? m : {};
  }

  info(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return null;
    const v = this.all()[id];
    return v && fs.existsSync(this.file(v)) ? v : null;
  }

  file(v) {
    return path.join(this.dir, `${v.id}${v.ext}`);
  }

  // Adds a file chosen by the user: { ok, voice } or { ok: false, error }.
  add(filePath) {
    const name = path.basename(String(filePath || ''));
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { ok: false, error: `“${name}” could not be opened.` };
    }
    if (!stat.isFile()) return { ok: false, error: `“${name}” is not a file.` };
    if (!stat.size) return { ok: false, error: `“${name}” is empty.` };
    if (stat.size > MAX_BYTES) return { ok: false, error: `“${name}” is larger than 16 MB, WhatsApp’s limit for audio.` };
    const ext = path.extname(name).toLowerCase();
    const byExt = FORMATS.find((f) => f.ext.includes(ext));
    if (!byExt) return { ok: false, error: `“${name}”: this format isn’t supported. Use ${SUPPORTED}.` };
    let data;
    try {
      data = fs.readFileSync(filePath);
    } catch (err) {
      return { ok: false, error: `“${name}” could not be read (${err.code || err.message}).` };
    }
    if (!byExt.test(data)) {
      const real = FORMATS.find((f) => f.test(data));
      return { ok: false, error: real ? `“${name}” is really ${real.label}: rename it to ${real.ext[0]} and attach it again.` : ext === '.ogg' || ext === '.oga' ? `“${name}” is not Opus audio. WhatsApp plays Ogg files with Opus audio only.` : `“${name}” is not a valid ${byExt.label} file.` };
    }
    const id = crypto.randomBytes(8).toString('hex');
    const voice = { id, name: name.slice(0, 120), ext, mime: byExt.mime, size: stat.size, ptt: Boolean(byExt.ptt), addedAt: Date.now() };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file(voice), data, { mode: 0o600 });
    } catch (err) {
      return { ok: false, error: `“${name}” could not be saved (${err.code || err.message}).` };
    }
    this.state.set(KEY, { ...this.all(), [id]: voice });
    return { ok: true, voice: this.public(voice) };
  }

  public(v) {
    return { id: v.id, name: v.name, mime: v.mime, size: v.size, ptt: v.ptt };
  }

  read(id) {
    const v = this.info(id);
    if (!v) throw Object.assign(new Error('The voice file is no longer available.'), { code: 'missing_audio' });
    return { data: fs.readFileSync(this.file(v)), mime: v.mime, ptt: v.ptt };
  }

  // For the preview player in the window.
  dataUrl(id) {
    const { data, mime } = this.read(id);
    return `data:${mime.split(';')[0]};base64,${data.toString('base64')}`;
  }

  // Deletes the copies no campaign uses any more.
  prune(used) {
    const keep = new Set(used);
    const all = this.all();
    let removed = 0;
    for (const v of Object.values(all)) {
      if (keep.has(v.id)) continue;
      fs.rmSync(this.file(v), { force: true });
      delete all[v.id];
      removed++;
    }
    if (removed) this.state.set(KEY, all);
    return removed;
  }
}

module.exports = { AudioLibrary, FORMATS, EXTENSIONS, MAX_BYTES, SUPPORTED };
