/**
 * Built-in radio stations, synthesised live with Web Audio. Every note is derived from the shared
 * server clock and a deterministic hash, so everyone in the lounge hears the same music at the
 * same moment without streaming anything (and without any licensing questions).
 */

export type GeneratedStationId = 'lofi' | 'ambient';

/** Deterministic pseudo-random number in [0, 1) for a tuple of integers. */
function rand(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    // Split large numbers so every bit contributes.
    for (const v of [p % 0x10000, Math.floor(p / 0x10000)]) {
      h = Math.imul(h ^ (v | 0), 0x85ebca6b);
      h = (h ^ (h >>> 13)) | 0;
      h = Math.imul(h, 0xc2b2ae35);
      h ^= h >>> 16;
    }
  }
  return (h >>> 0) / 4294967296;
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

interface Chord {
  /** Voicing (MIDI notes) for the keys/pads. */
  notes: number[];
  /** Bass root (MIDI). */
  root: number;
  /** Notes that sound good as melody over the chord. */
  scale: number[];
}

const c = (notes: number[], root: number, scale: number[]): Chord => ({ notes, root, scale });

// Jazzy seventh/ninth chords in F major / D minor territory.
const LOFI_PROGRESSIONS: Chord[][] = [
  [c([55, 58, 62, 65], 43, [67, 70, 72, 74, 77]), c([52, 55, 58, 62], 48, [67, 69, 72, 74, 76]), c([53, 57, 60, 64], 41, [69, 72, 74, 76, 77]), c([50, 53, 57, 60], 38, [65, 69, 72, 74, 77])],
  [c([53, 57, 60, 64], 41, [69, 72, 74, 76, 77]), c([50, 53, 57, 60], 38, [65, 69, 72, 74, 77]), c([55, 58, 62, 65], 43, [67, 70, 72, 74, 77]), c([52, 55, 58, 62], 48, [67, 69, 72, 74, 76])],
  [c([50, 53, 57, 60], 38, [65, 69, 72, 74, 77]), c([55, 58, 62, 65], 43, [67, 70, 72, 74, 77]), c([52, 57, 60, 64], 45, [64, 67, 69, 72, 76]), c([53, 57, 60, 64], 41, [69, 72, 74, 76, 77])],
  [c([57, 60, 64, 67], 45, [64, 67, 69, 72, 76]), c([50, 53, 57, 60], 38, [65, 69, 72, 74, 77]), c([55, 59, 62, 65], 43, [67, 71, 74, 77, 79]), c([52, 55, 59, 64], 48, [64, 67, 71, 72, 76])],
];

const AMBIENT_PROGRESSIONS: Chord[][] = [
  [c([48, 55, 62, 64, 71], 36, [72, 74, 76, 79, 83]), c([45, 52, 59, 60, 67], 33, [69, 72, 76, 79, 81]), c([41, 48, 55, 57, 64], 29, [69, 72, 76, 77, 81]), c([43, 50, 57, 59, 66], 31, [71, 74, 78, 79, 83])],
  [c([50, 57, 64, 65, 72], 38, [69, 72, 74, 77, 81]), c([46, 53, 60, 62, 69], 34, [70, 74, 77, 79, 81]), c([48, 55, 62, 64, 71], 36, [72, 74, 76, 79, 83]), c([45, 52, 59, 60, 67], 33, [69, 72, 76, 79, 81])],
];

interface StyleConfig {
  bpm: number;
  progressions: Chord[][];
  /** Bars per chord. */
  barsPerChord: number;
  seed: number;
}

const STYLES: Record<GeneratedStationId, StyleConfig> = {
  lofi: { bpm: 72, progressions: LOFI_PROGRESSIONS, barsPerChord: 1, seed: 7 },
  ambient: { bpm: 56, progressions: AMBIENT_PROGRESSIONS, barsPerChord: 2, seed: 13 },
};

const LOOKAHEAD_MS = 1500; // Background tabs only get ~1 timer tick per second.

export class GenerativeStation {
  private readonly out: GainNode;
  private readonly input: GainNode;
  private readonly reverb: ConvolverNode;
  private readonly reverbSend: GainNode;
  private readonly noise: AudioBuffer;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Server time up to which notes have been scheduled. */
  private scheduledUntil = 0;
  private readonly style: StyleConfig;
  private readonly stepMs: number;
  private readonly sources = new Set<AudioScheduledSourceNode>();
  private stopped = false;
  /** Whether anything has been scheduled yet (someone arriving mid-phrase gets the current chord). */
  private primed = false;

  constructor(
    private readonly ctx: AudioContext,
    readonly id: GeneratedStationId,
    private readonly serverNow: () => number,
    destination: AudioNode,
  ) {
    this.style = STYLES[id];
    this.stepMs = 60000 / this.style.bpm / 4;

    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination);

    // Gentle "warm" master: low-pass, then a compressor to keep levels even.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = id === 'lofi' ? 3200 : 5000;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3;
    this.input = ctx.createGain();
    this.input.gain.value = 0.55;
    this.input.connect(tone).connect(comp).connect(this.out);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(id === 'lofi' ? 1.6 : 4);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = id === 'lofi' ? 0.18 : 0.55;
    this.reverbSend.connect(this.reverb).connect(comp);

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  /** Musical position for a server time (exposed for tests and for keeping clients comparable). */
  position(serverTime: number): { bar: number; step: number; chord: number } {
    const step = Math.floor(serverTime / this.stepMs);
    const bar = Math.floor(step / 16);
    const { progression, index } = this.chordIndex(bar);
    return { bar, step: step % 16, chord: progression * 10 + index };
  }

  start(): void {
    this.scheduledUntil = this.serverNow();
    this.tick();
    this.timer = setInterval(() => this.tick(), 250);
  }

  setVolume(v: number): void {
    this.out.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.25);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    setTimeout(() => {
      for (const s of this.sources) {
        try {
          s.stop();
        } catch {
          // Already stopped.
        }
      }
      this.sources.clear();
      this.out.disconnect();
    }, 800);
  }

  private chordIndex(bar: number): { progression: number; index: number } {
    const { progressions, barsPerChord, seed } = this.style;
    const section = Math.floor(bar / (barsPerChord * 4 * 2)); // Each progression plays twice.
    const progression = Math.floor(rand(seed, section, 1) * progressions.length);
    const index = Math.floor(bar / barsPerChord) % 4;
    return { progression, index };
  }

  private chordAt(bar: number): Chord {
    const { progression, index } = this.chordIndex(bar);
    return this.style.progressions[progression][index];
  }

  private tick(): void {
    if (this.stopped) return;
    const now = this.serverNow();
    // While the browser keeps audio suspended its clock stands still: queueing notes would only
    // pile them up to all sound at once later.
    if (this.ctx.state !== 'running') {
      this.scheduledUntil = now;
      return;
    }
    if (!this.primed) {
      this.primed = true;
      this.prime(now);
    }
    // After a long pause (e.g. a frozen tab) don't try to catch up on old notes.
    if (this.scheduledUntil < now - 200) this.scheduledUntil = now;
    const until = now + LOOKAHEAD_MS;
    let step = Math.ceil(this.scheduledUntil / this.stepMs);
    for (; step * this.stepMs < until; step++) {
      const at = step * this.stepMs;
      const when = this.ctx.currentTime + (at - now) / 1000;
      if (when < this.ctx.currentTime - 0.01) continue;
      if (this.id === 'lofi') this.lofiStep(step, Math.max(when, this.ctx.currentTime));
      else this.ambientStep(step, Math.max(when, this.ctx.currentTime));
    }
    // Never move backwards (a clock correction mid-way): that would schedule notes twice.
    this.scheduledUntil = Math.max(this.scheduledUntil, until);
  }

  /** Sounds that started before we tuned in: the record crackle, and the ambient chord in progress. */
  private prime(now: number): void {
    if (this.id === 'lofi') {
      this.startCrackle();
      return;
    }
    const bar = Math.floor(now / this.stepMs / 16);
    const chordStart = Math.floor(bar / this.style.barsPerChord) * this.style.barsPerChord;
    const chordEnd = (chordStart + this.style.barsPerChord) * 16 * this.stepMs;
    const left = (chordEnd - now) / 1000;
    if (left < 2) return;
    const chord = this.chordAt(chordStart);
    this.pad(chord.notes, this.ctx.currentTime, left);
    this.drone(chord.root, this.ctx.currentTime, left);
  }

  // --- Lo-fi -----------------------------------------------------------------

  private lofiStep(step: number, when: number): void {
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const chord = this.chordAt(bar);
    const seed = this.style.seed;
    const swing = s % 4 === 2 ? this.stepMs * 0.12 / 1000 : 0;
    const t = when + swing;
    const beat = this.stepMs * 4 / 1000;

    // Drums.
    if (s === 0 || s === 10 || (s === 7 && rand(seed, bar, 2) < 0.35)) this.kick(t, s === 0 ? 0.9 : 0.7);
    if (s === 4 || s === 12) this.snare(t, 0.5);
    if (s % 2 === 0) this.hat(t, 0.05 + rand(seed, bar, s, 3) * 0.05);
    if (s % 2 === 1 && rand(seed, bar, s, 4) < 0.15) this.hat(t, 0.03);

    // Chords on the one, with an occasional push on the "and" of two.
    if (s === 0) this.keysChord(chord.notes, t, beat * 3.6, 0.13);
    if (s === 6 && rand(seed, bar, 5) < 0.45) this.keysChord(chord.notes, t, beat * 1.6, 0.08);

    // Bass.
    if (s === 0) this.bass(chord.root, t, beat * 1.5);
    if (s === 10 && rand(seed, bar, 6) < 0.7) this.bass(chord.root + (rand(seed, bar, 7) < 0.5 ? 7 : 12), t, beat * 0.9);

    // A sparse melody in some bars.
    if (rand(seed, Math.floor(bar / 2), 8) < 0.55 && [2, 5, 8, 11, 14].includes(s) && rand(seed, bar, s, 9) < 0.45) {
      const note = chord.scale[Math.floor(rand(seed, bar, s, 10) * chord.scale.length)];
      this.bell(note, t, beat * 1.2, 0.05);
    }
  }

  // --- Ambient ---------------------------------------------------------------

  private ambientStep(step: number, when: number): void {
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const seed = this.style.seed;
    const beat = this.stepMs * 4 / 1000;
    const chord = this.chordAt(bar);
    if (s === 0 && bar % this.style.barsPerChord === 0) {
      const length = beat * 4 * this.style.barsPerChord;
      this.pad(chord.notes, when, length);
      this.drone(chord.root, when, length);
    }
    if (s % 4 === 0 && rand(seed, bar, s, 11) < 0.28) {
      const note = chord.scale[Math.floor(rand(seed, bar, s, 12) * chord.scale.length)];
      this.bell(note, when, beat * 4, 0.045);
    }
  }

  // --- Instruments -----------------------------------------------------------

  private track<T extends AudioScheduledSourceNode>(node: T, stopAt: number): T {
    this.sources.add(node);
    node.onended = () => this.sources.delete(node);
    node.stop(stopAt);
    return node;
  }

  private envelope(start: number, attack: number, peak: number, release: number, end: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + attack);
    g.gain.setValueAtTime(Math.max(peak, 0.0002), Math.max(start + attack, end - release));
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    return g;
  }

  private keysChord(notes: number[], when: number, dur: number, gain: number): void {
    notes.forEach((n, i) => {
      // A soft electric-piano tone: sine plus a little of the octave, slightly strummed.
      const t = when + i * 0.012;
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(gain, t + 0.01);
      env.gain.exponentialRampToValueAtTime(gain * 0.35, t + 0.4);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      env.connect(this.input);
      env.connect(this.reverbSend);
      const a = this.ctx.createOscillator();
      a.type = 'sine';
      a.frequency.value = mtof(n);
      a.detune.value = (rand(n, 1) - 0.5) * 8;
      a.connect(env);
      a.start(t);
      this.track(a, t + dur + 0.05);
      const b = this.ctx.createOscillator();
      b.type = 'triangle';
      b.frequency.value = mtof(n + 12);
      const bg = this.ctx.createGain();
      bg.gain.value = 0.18;
      b.connect(bg).connect(env);
      b.start(t);
      this.track(b, t + dur + 0.05);
    });
  }

  private bass(note: number, when: number, dur: number): void {
    const env = this.envelope(when, 0.02, 0.32, Math.min(0.3, dur / 2), when + dur);
    env.connect(this.input);
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = mtof(note);
    o.connect(env);
    o.start(when);
    this.track(o, when + dur + 0.05);
  }

  private bell(note: number, when: number, dur: number, gain: number): void {
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(gain, when + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    env.connect(this.input);
    env.connect(this.reverbSend);
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = mtof(note);
    o.connect(env);
    o.start(when);
    this.track(o, when + dur + 0.05);
  }

  private pad(notes: number[], when: number, dur: number): void {
    for (const n of notes) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      const env = this.envelope(when, 2.2, 0.035, 2.5, when + dur + 2.2);
      filter.connect(env);
      env.connect(this.input);
      env.connect(this.reverbSend);
      for (const detune of [-7, 7]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(n);
        o.detune.value = detune;
        o.connect(filter);
        o.start(when);
        this.track(o, when + dur + 2.3);
      }
    }
  }

  private drone(note: number, when: number, dur: number): void {
    const env = this.envelope(when, 2.5, 0.12, 2.5, when + dur + 2);
    env.connect(this.input);
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = mtof(note);
    o.connect(env);
    o.start(when);
    this.track(o, when + dur + 2.1);
  }

  private kick(when: number, gain: number): void {
    const env = this.envelope(when, 0.003, gain, 0.25, when + 0.32);
    env.connect(this.input);
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, when);
    o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    o.connect(env);
    o.start(when);
    this.track(o, when + 0.35);
  }

  private noiseHit(when: number, dur: number, gain: number, type: BiquadFilterType, freq: number, q = 0.7): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = this.envelope(when, 0.002, gain, dur * 0.8, when + dur);
    src.connect(filter).connect(env).connect(this.input);
    src.start(when, Math.random() * 0.5);
    this.track(src, when + dur + 0.02);
  }

  private snare(when: number, gain: number): void {
    this.noiseHit(when, 0.2, gain * 0.6, 'bandpass', 1900, 0.8);
    const env = this.envelope(when, 0.002, gain * 0.25, 0.08, when + 0.1);
    env.connect(this.input);
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 190;
    o.connect(env);
    o.start(when);
    this.track(o, when + 0.12);
  }

  private hat(when: number, gain: number): void {
    this.noiseHit(when, 0.045, gain, 'highpass', 7500);
  }

  /** Quiet vinyl hiss with the odd pop, looped. */
  private startCrackle(): void {
    const len = this.ctx.sampleRate * 3;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * 0.015;
      if (Math.random() < 0.0004) d[i] += (Math.random() * 2 - 1) * 0.5;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2500;
    filter.Q.value = 0.5;
    const g = this.ctx.createGain();
    g.gain.value = 0.25;
    src.connect(filter).connect(g).connect(this.out);
    src.start();
    this.sources.add(src);
  }

  /** Synthetic reverb tail: decaying stereo noise. */
  private impulse(seconds: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

}
