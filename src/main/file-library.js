'use strict';

// Files attached to campaigns (email attachments; images and documents sent
// on WhatsApp) and to the assistant's conversation. A file chosen on this
// computer is checked (its type by its content where that is possible) and
// copied into the app's data folder, so it is sent as it was even if the
// original is moved or deleted.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEY = 'files.library';
const MAX_BYTES = 16 * 1024 * 1024; // WhatsApp's limit for media; email servers rarely take more

const head = (buf, s, at = 0) => buf.subarray(at, at + s.length).toString('latin1') === s;
const zip = (b) => b[0] === 0x50 && b[1] === 0x4b;
const ole = (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
const any = () => true;
// [extensions, mime, kind, content test, label]
const TYPES = [
  { ext: ['.jpg', '.jpeg'], mime: 'image/jpeg', kind: 'image', test: (b) => b[0] === 0xff && b[1] === 0xd8, label: 'JPEG' },
  { ext: ['.png'], mime: 'image/png', kind: 'image', test: (b) => head(b, '\x89PNG'), label: 'PNG' },
  { ext: ['.webp'], mime: 'image/webp', kind: 'image', test: (b) => head(b, 'RIFF') && head(b, 'WEBP', 8), label: 'WebP' },
  { ext: ['.gif'], mime: 'image/gif', kind: 'image', test: (b) => head(b, 'GIF8'), label: 'GIF' },
  { ext: ['.pdf'], mime: 'application/pdf', kind: 'document', test: (b) => head(b, '%PDF'), label: 'PDF' },
  { ext: ['.docx'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document', test: zip, label: 'Word' },
  { ext: ['.xlsx'], mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'document', test: zip, label: 'Excel' },
  { ext: ['.pptx'], mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'document', test: zip, label: 'PowerPoint' },
  { ext: ['.doc'], mime: 'application/msword', kind: 'document', test: ole, label: 'Word' },
  { ext: ['.xls'], mime: 'application/vnd.ms-excel', kind: 'document', test: ole, label: 'Excel' },
  { ext: ['.ppt'], mime: 'application/vnd.ms-powerpoint', kind: 'document', test: ole, label: 'PowerPoint' },
  { ext: ['.zip'], mime: 'application/zip', kind: 'document', test: zip, label: 'ZIP' },
  { ext: ['.txt'], mime: 'text/plain', kind: 'document', test: any, label: 'text' },
  { ext: ['.csv'], mime: 'text/csv', kind: 'document', test: any, label: 'CSV' },
  { ext: ['.mp3'], mime: 'audio/mpeg', kind: 'audio', test: (b) => head(b, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0), label: 'MP3' },
  { ext: ['.m4a', '.mp4', '.m4b'], mime: 'audio/mp4', kind: 'audio', test: (b) => head(b, 'ftyp', 4), label: 'M4A' },
  { ext: ['.aac'], mime: 'audio/aac', kind: 'audio', test: (b) => head(b, 'ADIF') || (b[0] === 0xff && (b[1] & 0xf6) === 0xf0), label: 'AAC' },
  { ext: ['.ogg', '.opus', '.oga'], mime: 'audio/ogg; codecs=opus', kind: 'audio', test: (b) => head(b, 'OggS'), label: 'Ogg' },
  { ext: ['.amr'], mime: 'audio/amr', kind: 'audio', test: (b) => head(b, '#!AMR'), label: 'AMR' },
  { ext: ['.wav'], mime: 'audio/wav', kind: 'audio', test: (b) => head(b, 'RIFF') && head(b, 'WAVE', 8), label: 'WAV' },
];
const EXTENSIONS = TYPES.flatMap((t) => t.ext.map((e) => e.slice(1)));

class FileLibrary {
  constructor({ dir, state, now = () => Date.now() }) {
    Object.assign(this, { dir, state, now });
  }

  all() {
    const m = this.state.get(KEY);
    return m && typeof m === 'object' ? m : {};
  }

  file(f) {
    return path.join(this.dir, `${f.id}${f.ext}`);
  }

  info(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return null;
    const f = this.all()[id];
    return f && fs.existsSync(this.file(f)) ? f : null;
  }

  public(f) {
    return { id: f.id, name: f.name, mime: f.mime, size: f.size, kind: f.kind };
  }

  list() {
    return Object.values(this.all())
      .filter((f) => fs.existsSync(this.file(f)))
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((f) => this.public(f));
  }

  // { ok, file } | { ok: false, error }.
  add(filePath, { name: given } = {}) {
    const name = path.basename(String(given || filePath || '')).slice(0, 120);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { ok: false, error: `“${name}” could not be opened.` };
    }
    if (!stat.isFile()) return { ok: false, error: `“${name}” is not a file.` };
    if (!stat.size) return { ok: false, error: `“${name}” is empty.` };
    if (stat.size > MAX_BYTES) return { ok: false, error: `“${name}” is larger than 16 MB.` };
    let data;
    try {
      data = fs.readFileSync(filePath);
    } catch (err) {
      return { ok: false, error: `“${name}” could not be read (${err.code || err.message}).` };
    }
    return this.addData(data, name);
  }

  // A file received as bytes (e.g. sent on WhatsApp): checked the same way.
  addData(data, rawName) {
    const name = path.basename(String(rawName || 'file')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
    if (!Buffer.isBuffer(data) || !data.length) return { ok: false, error: `“${name}” is empty.` };
    if (data.length > MAX_BYTES) return { ok: false, error: `“${name}” is larger than 16 MB.` };
    const ext = path.extname(name).toLowerCase();
    const type = TYPES.find((t) => t.ext.includes(ext));
    if (!type) return { ok: false, error: `“${name}”: this file type isn’t supported. Use an image (JPG, PNG, WebP, GIF), a document (PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP) or audio (MP3, M4A, AAC, Ogg/Opus, AMR, WAV).` };
    if (!type.test(data)) return { ok: false, error: `“${name}” is not a valid ${type.label} file.` };
    const id = crypto.randomBytes(8).toString('hex');
    const f = { id, name, ext, mime: type.mime, kind: type.kind, size: data.length, addedAt: this.now() };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file(f), data, { mode: 0o600 });
    } catch (err) {
      return { ok: false, error: `“${name}” could not be saved (${err.code || err.message}).` };
    }
    this.state.set(KEY, { ...this.all(), [id]: f });
    return { ok: true, file: this.public(f) };
  }

  // The saved copy's path (to hand to another library, e.g. voice files).
  pathOf(id) {
    const f = this.info(id);
    return f ? this.file(f) : null;
  }

  read(id) {
    const f = this.info(id);
    if (!f) throw Object.assign(new Error('The file is no longer available.'), { code: 'missing_file' });
    return { data: fs.readFileSync(this.file(f)), mime: f.mime, name: f.name, kind: f.kind };
  }
}

module.exports = { FileLibrary, TYPES, EXTENSIONS, MAX_BYTES };
