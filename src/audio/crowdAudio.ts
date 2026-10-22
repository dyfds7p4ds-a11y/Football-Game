/**
 * Synthesized stadium sound (no audio files): a crowd bed whose volume and
 * brightness follow the crowd meter, roars on big moments, the referee's
 * whistle and the thump of a kick. Web Audio needs a user gesture on iOS, so
 * `unlock()` is called from the first tap.
 */
export class CrowdAudio {
  private ctx: AudioContext | null = null;
  private bed: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private master: GainNode | null = null;
  private enabled = true;
  private level = 0.5;

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 1 : 0;
    this.master.connect(ctx.destination);
    // Two seconds of brown-ish noise, looped.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.04 * w) / 1.04;
      d[i] = last * 3.5 + w * 0.08;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.Q.value = 0.6;
    this.filter.frequency.value = 700;
    this.bed = ctx.createGain();
    this.bed.gain.value = 0;
    src.connect(this.filter).connect(this.bed).connect(this.master);
    src.start();
    this.setLevel(this.level);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.1);
  }

  /** Crowd meter 0..100 -> bed volume and brightness. */
  setLevel(meter: number) {
    this.level = meter / 100;
    if (!this.ctx || !this.bed || !this.filter) return;
    const t = this.ctx.currentTime;
    this.bed.gain.setTargetAtTime(0.06 + this.level * 0.22, t, 0.8);
    this.filter.frequency.setTargetAtTime(500 + this.level * 900, t, 0.8);
  }

  /** A swell of noise for big moments (0..1). */
  roar(intensity: number) {
    if (!this.ctx || !this.bed) return;
    const t = this.ctx.currentTime;
    const base = 0.06 + this.level * 0.22;
    this.bed.gain.cancelScheduledValues(t);
    this.bed.gain.setValueAtTime(this.bed.gain.value, t);
    this.bed.gain.linearRampToValueAtTime(base + 0.35 * intensity, t + 0.25);
    this.bed.gain.setTargetAtTime(base, t + 1.2, 0.9);
  }

  whistle() {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const trem = ctx.createOscillator();
    const tremGain = ctx.createGain();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 2950;
    trem.frequency.value = 38;
    tremGain.gain.value = 120;
    trem.connect(tremGain).connect(osc.frequency);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.02);
    g.gain.setValueAtTime(0.09, t + 0.32);
    g.gain.linearRampToValueAtTime(0, t + 0.4);
    osc.connect(g).connect(this.master);
    osc.start(t);
    trem.start(t);
    osc.stop(t + 0.45);
    trem.stop(t + 0.45);
  }

  thump() {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.15);
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.22);
  }
}
