/** Standard: the browser's own noise suppression. Enhanced: RNNoise on top of it. */
export type NoiseMode = 'standard' | 'enhanced';

/** A reason enhanced noise suppression can't run, worded for people. */
export class NoiseError extends Error {}

// RNNoise is trained on 48 kHz audio and its worklet assumes that rate.
const RATE = 48_000;

export interface PipelineEvents {
  /** It stopped working and closed itself; send the plain mic instead. */
  failed(reason: string): void;
  /** The audio context started or stopped running. */
  changed(): void;
}

/** Largest sample in an analyser's current window. */
function peak(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  return max;
}

/**
 * The microphone through RNNoise: mic track → mono → RNNoise → `track`, which is what gets sent.
 * One per media session: the worklet can't be reliably destroyed, so it lives until close().
 */
export class MicPipeline {
  /** The processed microphone. It never ends by itself, even when the mic is unplugged. */
  readonly track: MediaStreamTrack;
  private source: MediaStreamAudioSourceNode | null = null;
  private sourceId: string | null = null;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  private constructor(
    readonly ctx: AudioContext,
    private readonly mono: GainNode,
    private readonly denoiser: AudioWorkletNode,
    dest: MediaStreamAudioDestinationNode,
    private readonly events: PipelineEvents,
  ) {
    this.track = dest.stream.getAudioTracks()[0];
    this.track.contentHint = 'speech';
    denoiser.onprocessorerror = () => this.fail('Enhanced noise suppression stopped working.');
    ctx.onstatechange = () => !this.closed && events.changed();
  }

  /**
   * Call it from a click: the audio context is created before anything is awaited, so browsers let
   * it play. Rejects with a NoiseError when this browser or device can't run RNNoise.
   */
  static async create(events: PipelineEvents): Promise<MicPipeline> {
    if (typeof AudioWorkletNode === 'undefined' || typeof WebAssembly === 'undefined') {
      throw new NoiseError('This browser can’t run enhanced noise suppression.');
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
    } catch {
      throw new NoiseError('This device can’t run enhanced noise suppression.');
    }
    try {
      if (ctx.sampleRate !== RATE) throw new NoiseError('This device can’t run enhanced noise suppression.');
      void ctx.resume().catch(() => {});
      const lib = await import('./rnnoise');
      const [, wasm] = await Promise.all([
        ctx.audioWorklet.addModule(lib.workletUrl),
        lib.loadRnnoise({ url: lib.wasmUrl, simdUrl: lib.simdUrl }),
      ]);
      // The loader doesn't check the response: an error page would only fail inside the worklet.
      if (!WebAssembly.validate(wasm)) throw new Error('not WebAssembly');
      // RNNoise processes one channel: mix stereo mics down first (Safari ignores channelCount).
      const mono = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
      const denoiser = new lib.RnnoiseWorkletNode(ctx, { wasmBinary: wasm, maxChannels: 1 });
      const dest = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
      mono.connect(denoiser).connect(dest);
      return new MicPipeline(ctx, mono, denoiser, dest, events);
    } catch (err) {
      void ctx.close().catch(() => {});
      if (err instanceof NoiseError) throw err;
      throw new NoiseError('Couldn’t load enhanced noise suppression. Check your connection and try again.');
    }
  }

  /** Audio only flows while the context runs (browsers suspend it until a click, or during calls on iOS). */
  get running(): boolean {
    return !this.closed && this.ctx.state === 'running';
  }

  /** Feeds `mic` in (replacing the previous one). Throws when the browser can't (older Firefox at other rates). */
  setSource(mic: MediaStreamTrack): void {
    if (this.sourceId === mic.id) return;
    this.source?.disconnect();
    this.source = null;
    this.sourceId = null;
    this.source = this.ctx.createMediaStreamSource(new MediaStream([mic]));
    this.source.connect(this.mono);
    this.sourceId = mic.id;
    this.watch();
  }

  /**
   * RNNoise outputs silence (rather than passing sound through) when its WebAssembly didn't load in
   * the worklet. If the mic has sound but nothing comes out for a while, give up on it.
   */
  private watch(): void {
    clearInterval(this.watchdog);
    const pre = new AnalyserNode(this.ctx, { fftSize: 2048 });
    const post = new AnalyserNode(this.ctx, { fftSize: 2048 });
    const buf = new Float32Array(2048);
    this.mono.connect(pre);
    this.denoiser.connect(post);
    let silentWithSound = 0;
    let checks = 0;
    const stop = () => {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
      try {
        this.mono.disconnect(pre);
        this.denoiser.disconnect(post);
      } catch {
        // Already disconnected by close().
      }
    };
    this.watchdog = setInterval(() => {
      if (!this.running) return;
      if (peak(post, buf) > 0) return stop();
      if (peak(pre, buf) > 0.002) silentWithSound++;
      if (silentWithSound >= 8) {
        stop();
        this.fail('Enhanced noise suppression stopped working.');
      } else if (++checks > 80) {
        stop(); // The mic stayed silent (muted, or nobody talking): nothing to judge by.
      }
    }, 250);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.close();
    this.events.failed(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    this.ctx.onstatechange = null;
    this.denoiser.onprocessorerror = null;
    this.source?.disconnect();
    this.mono.disconnect();
    this.denoiser.disconnect();
    this.track.stop();
    // The worklet ignores its destroy message, so closing the context is what frees it.
    void this.ctx.close().catch(() => {});
  }
}
