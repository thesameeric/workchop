import { MicPipeline, NoiseError, type NoiseMode } from './noise';
import { loadDevices, saveDevices } from './storage';

type Listener = () => void;

export type CaptureState = 'idle' | 'requesting' | 'ready' | 'denied' | 'unavailable' | 'error';
export interface CaptureStatus {
  microphone: CaptureState;
  camera: CaptureState;
}

interface CaptureRequest {
  promise: Promise<boolean>;
  cancel(): void;
}

function captureFailure(err: unknown): CaptureState {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'unavailable';
  return 'error';
}

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 24, max: 30 },
};

// Echo cancellation stays on with enhanced noise suppression too: RNNoise can't remove echo.
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: { ideal: 1 },
};

export interface NoiseState {
  mode: NoiseMode;
  /** Enhanced only: loading RNNoise, waiting for a click to start audio, running, or failed (`error` says why). */
  status: 'off' | 'loading' | 'waiting' | 'on' | 'failed';
  error: string | null;
}

function describe(err: unknown, what: string): string {
  if (!navigator.mediaDevices?.getUserMedia) return 'Camera and microphone need a secure (https) connection.';
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return `${what} permission was denied.`;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${what.toLowerCase()} found.`;
  if (name === 'NotReadableError') return `Your ${what.toLowerCase()} is in use by another app.`;
  return `Could not start ${what.toLowerCase()}.`;
}

/**
 * Owns the local microphone, camera and screen-share tracks. Peers read the
 * current tracks from here and re-sync whenever a listener fires.
 */
export class MediaManager {
  /** What we send as audio: the microphone, through enhanced noise suppression when that runs. */
  audioTrack: MediaStreamTrack | null = null;
  /** The microphone itself (from getUserMedia). */
  micTrack: MediaStreamTrack | null = null;
  camTrack: MediaStreamTrack | null = null;
  screenTrack: MediaStreamTrack | null = null;
  micOn = false;
  camOn = false;
  error: string | null = null;
  /** Bumped whenever the outgoing video track changes, so UI can re-bind <video> elements. */
  version = 0;
  private listeners = new Set<Listener>();
  private prefs = loadDevices();
  noise: NoiseState = { mode: this.prefs.noise === 'enhanced' ? 'enhanced' : 'standard', status: 'off', error: null };
  /** RNNoise, once Enhanced was chosen; kept until stopAll() (its worklet can't be freed any other way). */
  private pipeline: MicPipeline | null = null;
  private loading: Promise<MicPipeline> | null = null;
  private desiredMic = false;
  private desiredCam = false;
  private audioGeneration = 0;
  private cameraGeneration = 0;
  private screenGeneration = 0;
  private audioRequest: CaptureRequest | null = null;
  private cameraRequest: CaptureRequest | null = null;
  private capture: CaptureStatus = { microphone: 'idle', camera: 'idle' };

  /** Acquisition state only, without exposing tracks, device ids or permission details. */
  get captureStatus(): Readonly<CaptureStatus> {
    return { ...this.capture };
  }

  get screenOn(): boolean {
    return this.screenTrack !== null;
  }

  /** What we send as video: a screen share wins over the camera. */
  get videoTrack(): MediaStreamTrack | null {
    return this.screenTrack ?? (this.camOn ? this.camTrack : null);
  }

  get audioOutputId(): string | undefined {
    return this.prefs.audioOut;
  }

  get supported(): boolean {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /**
   * Start the microphone and camera independently: a slow camera or its permission prompt must
   * never hold a ready microphone disabled. Only microphone acquisition delays joining; video
   * publishes through the usual subscription when it becomes ready.
   */
  async start(wantMic = this.prefs.micOn ?? true, wantCam = this.prefs.camOn ?? true): Promise<void> {
    this.error = null;
    this.desiredMic = wantMic;
    this.desiredCam = wantCam;
    this.micOn = wantMic && this.micTrack?.readyState === 'live';
    if (wantMic) this.startPipeline();
    if (!wantCam) this.releaseCamera();
    this.route();
    const microphone = wantMic && !this.micTrack ? this.acquireAudio() : Promise.resolve(true);
    if (wantCam && !this.camTrack) void this.acquireCam();
    else this.camOn = wantCam && this.camTrack?.readyState === 'live';
    this.emit();
    await microphone;
  }

  private replaceAudio(track: MediaStreamTrack | null): void {
    const old = this.micTrack;
    if (old && old !== track) {
      old.onended = null;
      old.stop();
    }
    this.micTrack = track;
    if (track) track.onended = () => void this.micLost(track);
    this.route();
  }

  /** The mic was unplugged or taken by another app: get it (or another one) back. */
  private async micLost(track: MediaStreamTrack): Promise<void> {
    if (this.micTrack !== track) return;
    this.replaceAudio(null);
    this.micOn = false;
    this.capture.microphone = 'idle';
    this.emit();
    if (this.desiredMic) await this.acquireAudio();
  }

  /** Standard (the browser's) or Enhanced (RNNoise on top) noise suppression. Call it from a click. */
  setNoise(mode: NoiseMode): void {
    saveDevices({ noise: mode });
    this.noise = { mode, status: 'off', error: null };
    const p = this.pipeline;
    // Kept while switching back and forth, but paused while unused.
    if (p) void (mode === 'enhanced' ? p.ctx.resume() : p.ctx.suspend()).catch(() => {});
    else this.startPipeline();
    this.route();
    this.emit();
  }

  /** Loads RNNoise when Enhanced is chosen. Its audio context is created right away, inside the click. */
  private startPipeline(): void {
    if (this.noise.mode !== 'enhanced' || this.noise.error || this.pipeline || this.loading) return;
    const loading = MicPipeline.create({
      failed: (reason) => this.pipelineFailed(reason),
      changed: () => {
        this.route();
        this.emit();
      },
    });
    this.loading = loading;
    loading.then(
      (p) => {
        // Stopped in the meantime.
        if (this.loading !== loading) return p.close();
        this.loading = null;
        this.pipeline = p;
        // Switched back to Standard while it loaded: pause it, as setNoise() would have.
        if (this.noise.mode !== 'enhanced') void p.ctx.suspend().catch(() => {});
        else if (!p.running) this.resumeOnGesture(p);
        this.route();
        this.emit();
      },
      (err: unknown) => {
        if (this.loading !== loading) return;
        this.loading = null;
        this.pipelineFailed(err instanceof NoiseError ? err.message : 'Couldn’t start enhanced noise suppression.');
      },
    );
    this.route();
  }

  /** Browsers only start audio after a click or key press (when the lobby opened without one). */
  private resumeOnGesture(p: MicPipeline): void {
    const resume = () => {
      window.removeEventListener('pointerdown', resume, true);
      window.removeEventListener('keydown', resume, true);
      if (this.pipeline === p && this.noise.mode === 'enhanced') void p.ctx.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
  }

  private pipelineFailed(reason: string): void {
    this.pipeline?.close();
    this.pipeline = null;
    this.noise = { ...this.noise, error: reason };
    this.error = `${reason} Using standard noise suppression.`;
    this.route();
    this.emit();
  }

  /**
   * Sends the mic through RNNoise when Enhanced is on and its audio runs (otherwise peers would hear
   * silence), else the mic itself. Muting disables the track that is sent.
   */
  private route(): void {
    const mic = this.micTrack;
    const p = this.pipeline;
    let sent = mic;
    if (mic && p && this.noise.mode === 'enhanced' && p.running) {
      try {
        p.setSource(mic);
        sent = p.track;
      } catch {
        // Older Firefox can't connect a mic to a context running at another sample rate.
        const reason = 'This browser can’t run enhanced noise suppression.';
        p.close();
        this.pipeline = null;
        this.noise = { ...this.noise, error: reason };
        this.error = `${reason} Using standard noise suppression.`;
      }
    }
    this.audioTrack = sent;
    if (mic) mic.enabled = sent !== mic || this.micOn;
    if (sent && sent !== mic) sent.enabled = this.micOn;
    this.noise = { ...this.noise, status: this.noiseStatus(sent !== mic) };
  }

  private noiseStatus(processing: boolean): NoiseState['status'] {
    if (this.noise.mode === 'standard') return 'off';
    if (this.noise.error) return 'failed';
    if (this.loading) return 'loading';
    if (!this.pipeline) return 'off';
    return this.pipeline.running ? (processing || !this.micTrack ? 'on' : 'off') : 'waiting';
  }

  private replaceCam(track: MediaStreamTrack | null): void {
    if (this.camTrack && this.camTrack !== track) {
      this.camTrack.onended = null;
      this.camTrack.stop();
    }
    this.camTrack = track;
    if (track) track.onended = () => void this.camLost(track);
  }

  /** The camera stopped by itself (unplugged, taken by another app, the computer slept): get it back, or turn it off. */
  private async camLost(track: MediaStreamTrack): Promise<void> {
    if (this.camTrack !== track) return;
    this.replaceCam(null);
    this.camOn = false;
    this.capture.camera = 'idle';
    this.emit();
    if (this.desiredCam) await this.acquireCam();
  }

  private acquireAudio(): Promise<boolean> {
    return this.acquire('microphone');
  }

  private acquireCam(): Promise<boolean> {
    return this.acquire('camera');
  }

  private acquire(kind: keyof CaptureStatus): Promise<boolean> {
    const audio = kind === 'microphone';
    const pending = audio ? this.audioRequest : this.cameraRequest;
    if (pending) return pending.promise;
    const generation = audio ? this.audioGeneration : this.cameraGeneration;
    const current = () => generation === (audio ? this.audioGeneration : this.cameraGeneration);
    this.capture[kind] = 'requesting';
    const deviceId = audio ? this.prefs.audioIn : this.prefs.videoIn;
    const constraints = { ...(audio ? AUDIO_CONSTRAINTS : VIDEO_CONSTRAINTS), deviceId: deviceId ? { ideal: deviceId } : undefined };
    // Defer the request by a microtask so its guard exists even if a browser/mock throws synchronously.
    const capture = Promise.resolve().then(async () => {
      if (!current()) return false;
      try {
        if (!this.supported) throw new DOMException('Media capture is unavailable.', 'NotFoundError');
        const stream = await navigator.mediaDevices.getUserMedia(audio ? { audio: constraints } : { video: constraints });
        if (!current()) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }
        const track = (audio ? stream.getAudioTracks() : stream.getVideoTracks())[0];
        stream.getTracks().forEach((extra) => { if (extra !== track) extra.stop(); });
        if (!track) throw new DOMException('The device returned no track.', 'NotFoundError');
        this.capture[kind] = 'ready';
        if (audio) {
          this.micOn = this.desiredMic;
          this.replaceAudio(track);
        } else {
          this.camOn = this.desiredCam;
          this.replaceCam(track);
        }
        this.emit();
        return true;
      } catch (err) {
        if (!current()) return false;
        const track = audio ? this.micTrack : this.camTrack;
        this.capture[kind] = track?.readyState === 'live' ? 'ready' : captureFailure(err);
        this.error = describe(err, audio ? 'Microphone' : 'Camera');
        this.emit();
        return false;
      } finally {
        if (current()) {
          if (audio) this.audioRequest = null;
          else this.cameraRequest = null;
        }
      }
    });
    // getUserMedia cannot be cancelled, but callers leaving the office must not stay blocked on
    // its permission dialog. Its eventual stream is still stopped by the generation guard above.
    let cancel!: () => void;
    const cancelled = new Promise<boolean>((resolve) => { cancel = () => resolve(false); });
    const promise = Promise.race([capture, cancelled]);
    const request = { promise, cancel };
    if (audio) this.audioRequest = request;
    else this.cameraRequest = request;
    this.emit();
    return promise;
  }

  private releaseCamera(): void {
    this.cameraGeneration++;
    this.cameraRequest?.cancel();
    this.cameraRequest = null;
    this.replaceCam(null);
    this.camOn = false;
    this.capture.camera = 'idle';
  }

  async setMic(on: boolean): Promise<void> {
    this.error = null;
    this.desiredMic = on;
    this.prefs = { ...this.prefs, micOn: on };
    saveDevices({ micOn: on });
    if (on) this.startPipeline();
    this.micOn = on && this.micTrack?.readyState === 'live';
    this.route();
    this.emit();
    if (on && !this.micTrack) await this.acquireAudio();
  }

  async setCam(on: boolean): Promise<void> {
    this.error = null;
    this.desiredCam = on;
    this.prefs = { ...this.prefs, camOn: on };
    saveDevices({ camOn: on });
    if (on) {
      this.camOn = this.camTrack?.readyState === 'live';
      if (!this.camTrack) await this.acquireCam();
    } else this.releaseCamera();
    this.emit();
  }

  async startScreen(): Promise<void> {
    const generation = ++this.screenGeneration;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.error = 'Screen sharing is not supported in this browser.';
      this.emit();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      if (generation !== this.screenGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      this.stopScreen(false);
      track.contentHint = 'detail';
      track.onended = () => this.stopScreen();
      this.screenTrack = track;
      this.emit();
    } catch (err) {
      if (generation !== this.screenGeneration) return;
      if ((err as { name?: string })?.name !== 'NotAllowedError') this.error = 'Could not share your screen.';
      this.emit();
    }
  }

  stopScreen(notify = true): void {
    this.screenGeneration++;
    if (!this.screenTrack) return;
    this.screenTrack.onended = null;
    this.screenTrack.stop();
    this.screenTrack = null;
    if (notify) this.emit();
  }

  async listDevices(): Promise<MediaDeviceInfo[]> {
    try {
      return await navigator.mediaDevices.enumerateDevices();
    } catch {
      return [];
    }
  }

  selectedDevice(kind: 'audioIn' | 'videoIn' | 'audioOut'): string | undefined {
    if (kind === 'audioIn') return this.micTrack?.getSettings().deviceId ?? this.prefs.audioIn;
    if (kind === 'videoIn') return this.camTrack?.getSettings().deviceId ?? this.prefs.videoIn;
    return this.prefs.audioOut;
  }

  async setDevice(kind: 'audioIn' | 'videoIn' | 'audioOut', deviceId: string): Promise<void> {
    this.prefs = { ...this.prefs, [kind]: deviceId };
    saveDevices({ [kind]: deviceId });
    if (kind === 'audioIn' && (this.micTrack || this.audioRequest)) {
      this.audioGeneration++;
      this.audioRequest?.cancel();
      this.audioRequest = null;
      await this.acquireAudio();
    } else if (kind === 'videoIn' && (this.camTrack || this.cameraRequest)) {
      this.cameraGeneration++;
      this.cameraRequest?.cancel();
      this.cameraRequest = null;
      await this.acquireCam();
    }
    this.emit();
  }

  stopAll(): void {
    this.audioGeneration++;
    this.cameraGeneration++;
    this.screenGeneration++;
    this.audioRequest?.cancel();
    this.cameraRequest?.cancel();
    this.audioRequest = this.cameraRequest = null;
    this.desiredMic = this.desiredCam = false;
    if (this.micTrack) this.micTrack.onended = null;
    if (this.camTrack) this.camTrack.onended = null;
    if (this.screenTrack) this.screenTrack.onended = null;
    this.micTrack?.stop();
    this.camTrack?.stop();
    this.screenTrack?.stop();
    this.loading = null;
    this.pipeline?.close();
    this.pipeline = null;
    this.audioTrack = this.micTrack = this.camTrack = this.screenTrack = null;
    this.micOn = this.camOn = false;
    this.capture = { microphone: 'idle', camera: 'idle' };
    this.noise = { mode: this.noise.mode, status: 'off', error: null };
    this.emit();
  }
}

export const media = new MediaManager();
