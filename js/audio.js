'use strict';
// 8-Bit-Soundeffekte über WebAudio

const Sound = {
  ctx: null,
  muted: false,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) this.ctx = new AC();
  },
  tone(freq, dur, opts) {
    if (!this.ctx || this.muted) return;
    const o = opts || {};
    const t0 = this.ctx.currentTime + (o.delay || 0);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t0 + dur);
    g.gain.setValueAtTime(o.vol || 0.06, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  },
  noise(dur, vol, delay) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + (delay || 0);
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900;
    src.buffer = buf;
    g.gain.value = vol || 0.15;
    src.connect(f).connect(g).connect(this.ctx.destination);
    src.start(t0);
  },
  play(name) {
    switch (name) {
      case 'menu': this.tone(660, 0.04, { vol: 0.04 }); break;
      case 'select': this.tone(520, 0.05); this.tone(880, 0.08, { delay: 0.05 }); break;
      case 'snap': this.tone(300, 0.06, { vol: 0.08 }); this.tone(300, 0.06, { vol: 0.08, delay: 0.12 }); break;
      case 'throw': this.tone(700, 0.18, { type: 'triangle', slide: 1400, vol: 0.07 }); break;
      case 'catch': this.tone(990, 0.06); this.tone(1320, 0.08, { delay: 0.06 }); break;
      case 'juke': this.tone(400, 0.08, { slide: 800, vol: 0.05 }); break;
      case 'bump': this.noise(0.08, 0.12); break;
      case 'hit': this.noise(0.18, 0.25); this.tone(90, 0.15, { type: 'triangle', vol: 0.15 }); break;
      case 'whistle':
        this.tone(2100, 0.35, { type: 'sine', vol: 0.05 });
        this.tone(2300, 0.35, { type: 'sine', vol: 0.03 });
        break;
      case 'inc': this.tone(500, 0.12); this.tone(350, 0.18, { delay: 0.12 }); break;
      case 'kick': this.noise(0.06, 0.2); this.tone(200, 0.1, { type: 'triangle', vol: 0.12 }); break;
      case 'good': [523, 659, 784].forEach((f, i) => this.tone(f, 0.12, { delay: i * 0.1 })); break;
      case 'td':
        [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, 0.14, { delay: i * 0.11, vol: 0.07 }));
        break;
      case 'bad': this.tone(220, 0.2); this.tone(165, 0.3, { delay: 0.2 }); break;
    }
  },
};
