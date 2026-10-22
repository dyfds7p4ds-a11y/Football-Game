/**
 * Synthesized stadium sound (no audio files). Layers on a crowd bus whose
 * gains follow the crowd meter (audio/crowdMix.ts):
 *  - murmur: low rumble of a full stadium,
 *  - chatter: three formant bands of noise, each with its own slow, uneven
 *    swell, so it reads as many voices rather than hiss,
 *  - chant: stomp-stomp-clap from many hands above a loud meter.
 * Reactions on top: cheer and roar (vowel-shaped noise swells with high
 * whistles), boo (a low cluster of detuned voices) and silence (the crowd bus
 * ducks, then recovers). Whistle and kick thump bypass the crowd bus. Web Audio
 * needs a user gesture on iOS, so `unlock()` is called from the first tap.
 */
import { AUDIO, layerGains, type Reaction } from './crowdMix';

export class CrowdAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Everything the crowd makes; ducked for silence. */
  private crowd: GainNode | null = null;
  private murmur: GainNode | null = null;
  private chatter: GainNode | null = null;
  private chant: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private brown: AudioBuffer | null = null;
  /** Reaction voices still sounding (cut by silence). */
  private voices: GainNode[] = [];
  private nextBeat = 0;
  private beat = 0;
  private silentUntil = 0;
  private enabled = true;
  private level = 50;

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
    this.master.gain.value = this.enabled ? AUDIO.master : 0;
    this.master.connect(ctx.destination);
    this.crowd = ctx.createGain();
    this.crowd.connect(this.master);
    this.noise = this.makeNoise(false);
    this.brown = this.makeNoise(true);

    // Murmur: brown noise, low-passed.
    this.murmur = ctx.createGain();
    this.murmur.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    this.loop(this.brown, 0).connect(lp).connect(this.murmur).connect(this.crowd);

    // Chatter: vowel formant bands with irregular swells (two LFOs per band).
    this.chatter = ctx.createGain();
    this.chatter.gain.value = 0;
    this.chatter.connect(this.crowd);
    [[520, 1.4, 0.31, 0.83], [1150, 1.8, 0.47, 1.21], [2500, 2.2, 0.66, 1.57]].forEach(([f, q, r1, r2], i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0.6 - i * 0.12;
      for (const rate of [r1, r2]) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = rate;
        const depth = ctx.createGain();
        depth.gain.value = 0.18;
        lfo.connect(depth).connect(g.gain);
        lfo.start();
      }
      this.loop(this.noise!, i * 0.37).connect(bp).connect(g).connect(this.chatter!);
    });

    this.chant = ctx.createGain();
    this.chant.gain.value = 0;
    this.chant.connect(this.crowd);
    this.nextBeat = ctx.currentTime + 0.5;
    this.setLevel(this.level);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? AUDIO.master : 0, this.ctx.currentTime, 0.1);
  }

  /** Crowd meter 0..100 -> layer volumes. Called every frame; also schedules the chant. */
  setLevel(meter: number) {
    this.level = meter;
    if (!this.ctx || !this.murmur || !this.chatter || !this.chant) return;
    const t = this.ctx.currentTime;
    const g = layerGains(meter);
    this.murmur.gain.setTargetAtTime(g.murmur, t, 0.8);
    this.chatter.gain.setTargetAtTime(g.chatter, t, 0.8);
    this.chant.gain.setTargetAtTime(t < this.silentUntil ? 0 : g.chant, t, 0.5);
    this.scheduleChant(g.chant > 0.001 && t >= this.silentUntil);
  }

  /** Play the crowd's reaction (see crowdMix.reactionTo). */
  react(r: Reaction | null) {
    if (!r || !this.ctx) return;
    if (r.kind === 'silence') return this.silence(r.intensity);
    if (this.ctx.currentTime < this.silentUntil) return;
    if (r.kind === 'boo') this.boo(r.intensity);
    else this.cheer(r.kind, r.intensity);
  }

  /** Short swell for in-play moments (kept for kicks and returns). */
  roar(intensity: number) {
    this.react({ kind: intensity >= 0.9 ? 'roar' : 'cheer', intensity });
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
    const v = AUDIO.sfx.whistle;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.02);
    g.gain.setValueAtTime(v, t + 0.32);
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
    g.gain.setValueAtTime(AUDIO.sfx.thump, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  // ---------------------------------------------------------------- reactions

  private cheer(kind: 'cheer' | 'roar', intensity: number) {
    const ctx = this.ctx!;
    const e = AUDIO.reactions[kind];
    const out = this.envelope(e.gain * intensity, e.attack, e.hold * (0.6 + 0.4 * intensity), e.release);
    const t = ctx.currentTime;
    const end = t + e.attack + e.hold + e.release + 0.2;
    // "Aah" vowel: two formants, plus high whistles and screams on top.
    for (const [f, q, gain] of [[750, 2.2, 0.9], [1250, 2.5, 0.7], [3200, 3, kind === 'roar' ? 0.45 : 0.25]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(f * 0.92, t);
      bp.frequency.linearRampToValueAtTime(f * 1.05, t + e.attack + 0.3);
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = gain;
      this.oneShot(this.noise!, end).connect(bp).connect(g).connect(out);
    }
    if (kind === 'roar') {
      // The low end of a stadium on its feet.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300;
      this.oneShot(this.brown!, end).connect(lp).connect(out);
    }
  }

  private boo(intensity: number) {
    const ctx = this.ctx!;
    const e = AUDIO.reactions.boo;
    const out = this.envelope(e.gain * intensity, e.attack, e.hold, e.release);
    const t = ctx.currentTime;
    const end = t + e.attack + e.hold + e.release + 0.2;
    // "Ooo": a cluster of detuned low voices through a dark filter.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    lp.Q.value = 1.2;
    lp.connect(out);
    for (let i = 0; i < 10; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f = 92 + i * 7 + Math.random() * 6;
      o.frequency.setValueAtTime(f * 1.04, t);
      o.frequency.linearRampToValueAtTime(f * 0.96, end);
      const g = ctx.createGain();
      g.gain.value = 0.05;
      o.connect(g).connect(lp);
      o.start(t + Math.random() * 0.15);
      o.stop(end);
    }
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 380;
    nf.Q.value = 1.5;
    this.oneShot(this.noise!, end).connect(nf).connect(out);
  }

  private silence(intensity: number) {
    const ctx = this.ctx!;
    const s = AUDIO.silence;
    const t = ctx.currentTime;
    const crowd = this.crowd!;
    // Cut the reactions still sounding, then duck the whole crowd and let it come back.
    for (const v of this.voices) {
      v.gain.cancelScheduledValues(t);
      v.gain.setTargetAtTime(0, t, 0.08);
    }
    this.voices = [];
    const low = 1 - (1 - s.level) * intensity;
    crowd.gain.cancelScheduledValues(t);
    crowd.gain.setValueAtTime(crowd.gain.value, t);
    crowd.gain.linearRampToValueAtTime(low, t + s.fall);
    crowd.gain.setValueAtTime(low, t + s.fall + s.hold);
    crowd.gain.linearRampToValueAtTime(1, t + s.fall + s.hold + s.recover);
    this.silentUntil = t + s.fall + s.hold;
  }

  // ---------------------------------------------------------------- chant

  /** Stomp, stomp, clap: scheduled a little ahead on the audio clock. */
  private scheduleChant(on: boolean) {
    const ctx = this.ctx!;
    const spb = 60 / AUDIO.chantBpm;
    if (!on) {
      this.nextBeat = Math.max(this.nextBeat, ctx.currentTime + spb);
      this.beat = 0;
      return;
    }
    while (this.nextBeat < ctx.currentTime + 0.25) {
      const step = this.beat % 4;
      if (step < 2) this.stomp(this.nextBeat);
      else if (step === 2) this.clap(this.nextBeat);
      this.nextBeat += spb;
      this.beat++;
    }
  }

  private stomp(t: number) {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1.4, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.connect(lp).connect(g).connect(this.chant!);
    src.start(t, Math.random());
    src.stop(t + 0.3);
  }

  private clap(t: number) {
    const ctx = this.ctx!;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.9;
    bp.connect(this.chant!);
    // Thousands of hands never clap at once: a few smeared bursts.
    for (let i = 0; i < 4; i++) {
      const s = t + i * 0.012 + Math.random() * 0.01;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.5, s + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, s + 0.12);
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.connect(g).connect(bp);
      src.start(s, Math.random());
      src.stop(s + 0.14);
    }
  }

  // ---------------------------------------------------------------- helpers

  private makeNoise(brown: boolean): AudioBuffer {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.04 * w) / 1.04;
        d[i] = last * 3.5;
      } else d[i] = w * 0.5;
    }
    return buf;
  }

  private loop(buf: AudioBuffer, offset: number): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start(0, offset);
    return src;
  }

  private oneShot(buf: AudioBuffer, end: number): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start(this.ctx!.currentTime, Math.random() * 2);
    src.stop(end);
    return src;
  }

  /** Gain envelope routed into the crowd bus; tracked so silence can cut it. */
  private envelope(peak: number, attack: number, hold: number, release: number): GainNode {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.linearRampToValueAtTime(0, t + attack + hold + release);
    g.connect(this.crowd!);
    this.voices.push(g);
    setTimeout(() => {
      this.voices = this.voices.filter((v) => v !== g);
      g.disconnect();
    }, (attack + hold + release + 0.5) * 1000);
    return g;
  }
}
