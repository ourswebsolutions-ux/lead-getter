// Call audio in Lead Finder's window when a bridge carries the call:
// "voice-player" plays the phone's voice (16-bit PCM, 8 kHz mono, in chunks
// from the bridge) at the device's sample rate; "voice-recorder" turns the
// microphone into 20 ms chunks of 8 kHz 16-bit PCM for the bridge.

const RATE = 8000;

class VoicePlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.pos = 0; // fractional read position in queue[0]
    this.buffered = 0;
    this.started = false;
    this.port.onmessage = (e) => {
      const pcm = new Int16Array(e.data);
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      this.queue.push(f);
      this.buffered += f.length;
      // Keep the delay short: drop what is more than 400 ms behind.
      while (this.buffered > RATE * 0.4 && this.queue.length > 1) this.buffered -= this.queue.shift().length;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    // Start after 60 ms are buffered (absorbs network jitter).
    if (!this.started && this.buffered < RATE * 0.06) return true;
    this.started = true;
    const step = RATE / sampleRate;
    for (let i = 0; i < out.length; i++) {
      const cur = this.queue[0];
      if (!cur) {
        out[i] = 0;
        this.started = this.buffered > 0;
        continue;
      }
      const j = Math.floor(this.pos);
      const a = cur[j];
      const b = j + 1 < cur.length ? cur[j + 1] : this.queue[1]?.[0] ?? a;
      out[i] = a + (b - a) * (this.pos - j);
      this.pos += step;
      if (this.pos >= cur.length) {
        this.pos -= cur.length;
        this.buffered -= cur.length;
        this.queue.shift();
      }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

class VoiceRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.acc = 0;
    this.sum = 0;
    this.n = 0;
    this.chunk = new Int16Array(160);
    this.fill = 0;
  }
  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;
    const ratio = sampleRate / RATE;
    for (let i = 0; i < input.length; i++) {
      // Averaging over each output sample's span: a simple low-pass before decimation.
      this.sum += input[i];
      this.n++;
      this.acc += 1;
      if (this.acc >= ratio) {
        this.acc -= ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.n));
        this.sum = 0;
        this.n = 0;
        this.chunk[this.fill++] = v < 0 ? v * 32768 : v * 32767;
        if (this.fill === this.chunk.length) {
          this.port.postMessage(this.chunk.buffer.slice(0));
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('voice-player', VoicePlayer);
registerProcessor('voice-recorder', VoiceRecorder);
