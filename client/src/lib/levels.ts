interface Entry {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Float32Array<ArrayBuffer>;
  speaking: boolean;
  lastLoud: number;
  trackId: string;
}

const THRESHOLD = 0.018;
const HOLD_MS = 350;

/**
 * Detects who is talking by sampling the loudness of each audio stream.
 * Calls `onChange(id, speaking)` only when someone starts or stops.
 */
export class SpeakingDetector {
  private ctx: AudioContext | null = null;
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onChange: (id: string, speaking: boolean) => void) {}

  private context(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Start (or re-point) monitoring for `id`. Pass null to stop. */
  watch(id: string, track: MediaStreamTrack | null): void {
    const existing = this.entries.get(id);
    if (existing && existing.trackId === track?.id) return;
    if (existing) this.unwatch(id);
    if (!track) return;
    const ctx = this.context();
    if (!ctx) return;
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.entries.set(id, {
        source,
        analyser,
        data: new Float32Array(analyser.fftSize),
        speaking: false,
        lastLoud: 0,
        trackId: track.id,
      });
      this.ensureLoop();
    } catch {
      // Some browsers refuse remote streams in WebAudio; we simply won't show a speaking ring.
    }
  }

  unwatch(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.source.disconnect();
    this.entries.delete(id);
    if (e.speaking) this.onChange(id, false);
  }

  private ensureLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 100);
  }

  private tick(): void {
    const now = performance.now();
    for (const [id, e] of this.entries) {
      e.analyser.getFloatTimeDomainData(e.data);
      let sum = 0;
      for (let i = 0; i < e.data.length; i++) sum += e.data[i] * e.data[i];
      const rms = Math.sqrt(sum / e.data.length);
      if (rms > THRESHOLD) e.lastLoud = now;
      const speaking = now - e.lastLoud < HOLD_MS;
      if (speaking !== e.speaking) {
        e.speaking = speaking;
        this.onChange(id, speaking);
      }
    }
  }

  close(): void {
    for (const id of [...this.entries.keys()]) this.unwatch(id);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
