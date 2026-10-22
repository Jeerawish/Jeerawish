// Synthesized sound effects via the Web Audio API — no audio files to download.

export class Sound {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
  }

  /** Audio must be started from a user gesture on mobile browsers. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.5);
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  get ready() {
    return this.enabled && this.ctx && this.ctx.state === 'running';
  }

  tone(freq, dur, { type = 'sine', gain = 0.3, when = 0, attack = 0.004, freqEnd = null } = {}) {
    const t = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  noise(dur, { freq = 2000, q = 1, gain = 0.3, when = 0, type = 'bandpass', freqEnd = null } = {}) {
    const t = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    if (freqEnd) filter.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.3);
    src.stop(t + dur + 0.02);
  }

  play(name, opts = {}) {
    if (!this.ready) return;
    try {
      this[`_${name}`]?.(opts);
    } catch {
      // Audio is decorative; never let it break the game.
    }
  }

  _deal() {
    this.noise(0.07, { freq: 3200, q: 0.8, gain: 0.35 });
    this.noise(0.03, { freq: 6000, q: 2, gain: 0.15, when: 0.02 });
  }

  _flip() {
    this.noise(0.05, { freq: 2500, q: 0.7, gain: 0.3, type: 'highpass' });
  }

  _chip({ count = 2 } = {}) {
    const n = Math.min(4, Math.max(1, count));
    for (let i = 0; i < n; i++) {
      const when = i * 0.045 + Math.random() * 0.01;
      const f = 3600 + Math.random() * 1400;
      this.tone(f, 0.08, { type: 'sine', gain: 0.18, when });
      this.tone(f * 1.48, 0.05, { type: 'sine', gain: 0.08, when });
      this.noise(0.03, { freq: 5000, q: 3, gain: 0.12, when });
    }
  }

  _check() {
    this.tone(190, 0.09, { type: 'sine', gain: 0.5, freqEnd: 80 });
    this.noise(0.05, { freq: 400, q: 0.8, gain: 0.25, type: 'lowpass' });
    this.tone(190, 0.08, { type: 'sine', gain: 0.35, freqEnd: 80, when: 0.11 });
  }

  _fold() {
    this.noise(0.22, { freq: 1600, freqEnd: 300, q: 0.6, gain: 0.25, type: 'lowpass' });
  }

  _turn() {
    this.tone(880, 0.18, { type: 'triangle', gain: 0.18 });
    this.tone(1318, 0.28, { type: 'triangle', gain: 0.14, when: 0.1 });
  }

  _allin() {
    this.tone(110, 0.4, { type: 'sawtooth', gain: 0.08, freqEnd: 55 });
    this._chip({ count: 4 });
  }

  _win() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.tone(f, 0.35, { type: 'triangle', gain: 0.16, when: i * 0.09 });
    });
    this._chip({ count: 4 });
  }

  _lose() {
    this.tone(392, 0.25, { type: 'triangle', gain: 0.12 });
    this.tone(311, 0.4, { type: 'triangle', gain: 0.12, when: 0.18 });
  }

  _levelup() {
    this.tone(660, 0.12, { type: 'square', gain: 0.06 });
    this.tone(990, 0.2, { type: 'square', gain: 0.06, when: 0.12 });
  }
}
