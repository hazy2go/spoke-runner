import { state } from './state';

/** Synthesized sound effects plus one looping soundtrack file. */
class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private thrustGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicStarted = false;

  private ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = state.saved.muted ? 0 : 0.55;
      this.master.connect(this.ctx.destination);
      this.startThrustBed();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  unlock() {
    this.ensure();
    void this.startMusic();
  }

  /** Looping soundtrack (generated with Higgsfield Sonilo). A buffer loop is gapless, unlike <audio loop>. */
  private async startMusic() {
    if (this.musicStarted) return;
    this.musicStarted = true;
    const ctx = this.ensure();
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}audio/theme.m4a`);
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      this.musicGain = ctx.createGain();
      this.musicGain.gain.setValueAtTime(0, ctx.currentTime);
      this.musicGain.gain.linearRampToValueAtTime(0.42, ctx.currentTime + 2.5);
      src.connect(this.musicGain).connect(this.master!);
      src.start();
    } catch {
      this.musicStarted = false; // decoding failed (old browser): play on without music
    }
  }

  /** Lower the soundtrack while the swap widget is open. */
  duck(on: boolean) {
    if (this.musicGain && this.ctx) this.musicGain.gain.setTargetAtTime(on ? 0.1 : 0.42, this.ctx.currentTime, 0.3);
  }

  setMuted(muted: boolean) {
    state.saved.muted = muted;
    state.persist();
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }

  private startThrustBed() {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    this.thrustGain = ctx.createGain();
    this.thrustGain.gain.value = 0;
    src.connect(filter).connect(this.thrustGain).connect(this.master!);
    src.start();
  }

  thrust(level: number) {
    if (!this.ctx || !this.thrustGain) return;
    this.thrustGain.gain.setTargetAtTime(level * 0.35, this.ctx.currentTime, 0.08);
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0, slideTo?: number) {
    const ctx = this.ensure();
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  click() {
    this.tone(880, 0.06, 'triangle', 0.12);
  }
  dock() {
    this.tone(523, 0.18, 'sine', 0.22);
    this.tone(784, 0.26, 'sine', 0.2, 0.09);
  }
  pickup() {
    this.tone(660, 0.12, 'square', 0.08);
    this.tone(990, 0.16, 'square', 0.07, 0.07);
  }
  relay() {
    this.tone(392, 0.4, 'sawtooth', 0.06, 0, 1568);
  }
  deliver() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.16, i * 0.08));
  }
  hit() {
    this.tone(160, 0.35, 'sawtooth', 0.28, 0, 40);
  }
  refuel() {
    this.tone(300, 0.5, 'sine', 0.15, 0, 900);
  }
  warn() {
    this.tone(440, 0.12, 'square', 0.08);
    this.tone(440, 0.12, 'square', 0.08, 0.2);
  }
  fanfare() {
    [392, 523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.4, 'triangle', 0.15, i * 0.07));
  }
  over() {
    [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.45, 'sine', 0.18, i * 0.16));
  }
}

export const sfx = new Sfx();
