import { MicPipeline, NoiseError, type NoiseMode } from './noise';
import { loadDevices, saveDevices } from './storage';

type Listener = () => void;

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
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return `${what} permission was denied.`;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${what.toLowerCase()} found.`;
  if (name === 'NotReadableError') return `Your ${what.toLowerCase()} is in use by another app.`;
  if (!navigator.mediaDevices) return 'Camera and microphone need a secure (https) connection.';
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

  /** Ask for mic and camera together, so the browser shows a single permission prompt. */
  async start(wantMic = this.prefs.micOn ?? true, wantCam = this.prefs.camOn ?? true): Promise<void> {
    if (wantMic) this.startPipeline();
    if (!this.supported) {
      this.error = describe(null, 'Camera');
      this.emit();
      return;
    }
    this.error = null;
    if (wantMic || wantCam) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: wantMic ? { ...AUDIO_CONSTRAINTS, deviceId: this.prefs.audioIn ? { ideal: this.prefs.audioIn } : undefined } : false,
          video: wantCam ? { ...VIDEO_CONSTRAINTS, deviceId: this.prefs.videoIn ? { ideal: this.prefs.videoIn } : undefined } : false,
        });
        this.replaceAudio(stream.getAudioTracks()[0] ?? null);
        this.replaceCam(stream.getVideoTracks()[0] ?? null);
      } catch {
        // One of the two may be missing or blocked; try them separately.
        if (wantMic) await this.acquireAudio();
        if (wantCam) await this.acquireCam();
      }
    }
    this.micOn = wantMic && !!this.micTrack;
    this.route();
    this.camOn = wantCam && !!this.camTrack;
    this.emit();
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
    if (!(await this.acquireAudio()) && this.micTrack === track) {
      this.replaceAudio(null);
      this.micOn = false;
      this.error = 'Your microphone was disconnected.';
    }
    this.route();
    this.emit();
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
    if (this.camTrack && this.camTrack !== track) this.camTrack.stop();
    this.camTrack = track;
    if (track) track.onended = () => void this.camLost(track);
  }

  /** The camera stopped by itself (unplugged, taken by another app, the computer slept): get it back, or turn it off. */
  private async camLost(track: MediaStreamTrack): Promise<void> {
    if (this.camTrack !== track) return;
    if (this.camOn && (await this.acquireCam())) {
      this.emit();
      return;
    }
    if (this.camTrack !== track) return;
    track.onended = null;
    this.camTrack = null;
    this.camOn = false;
    this.error ??= 'Your camera was disconnected.';
    this.emit();
  }

  private async acquireAudio(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...AUDIO_CONSTRAINTS, deviceId: this.prefs.audioIn ? { ideal: this.prefs.audioIn } : undefined },
      });
      this.replaceAudio(stream.getAudioTracks()[0] ?? null);
      return !!this.micTrack;
    } catch (err) {
      this.error = describe(err, 'Microphone');
      return false;
    }
  }

  private async acquireCam(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { ...VIDEO_CONSTRAINTS, deviceId: this.prefs.videoIn ? { ideal: this.prefs.videoIn } : undefined },
      });
      this.replaceCam(stream.getVideoTracks()[0] ?? null);
      return !!this.camTrack;
    } catch (err) {
      this.error = describe(err, 'Camera');
      return false;
    }
  }

  async setMic(on: boolean): Promise<void> {
    this.error = null;
    if (on) this.startPipeline();
    if (on && !this.micTrack && !(await this.acquireAudio())) on = false;
    this.micOn = on;
    this.route();
    saveDevices({ micOn: on });
    this.emit();
  }

  async setCam(on: boolean): Promise<void> {
    this.error = null;
    if (on) {
      if (!this.camTrack && !(await this.acquireCam())) on = false;
    } else if (this.camTrack) {
      // Release the camera entirely so its light turns off.
      this.camTrack.onended = null;
      this.camTrack.stop();
      this.camTrack = null;
    }
    this.camOn = on;
    saveDevices({ camOn: on });
    this.emit();
  }

  async startScreen(): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.error = 'Screen sharing is not supported in this browser.';
      this.emit();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      this.stopScreen(false);
      track.contentHint = 'detail';
      track.onended = () => this.stopScreen();
      this.screenTrack = track;
      this.emit();
    } catch (err) {
      if ((err as { name?: string })?.name !== 'NotAllowedError') this.error = 'Could not share your screen.';
      this.emit();
    }
  }

  stopScreen(notify = true): void {
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
    if (kind === 'audioIn' && this.micTrack) {
      const was = this.micOn;
      await this.acquireAudio();
      this.micOn = was && !!this.micTrack;
      this.route();
    } else if (kind === 'videoIn' && this.camTrack) {
      await this.acquireCam();
    }
    this.emit();
  }

  stopAll(): void {
    if (this.micTrack) this.micTrack.onended = null;
    this.micTrack?.stop();
    this.camTrack?.stop();
    this.screenTrack?.stop();
    this.loading = null;
    this.pipeline?.close();
    this.pipeline = null;
    this.audioTrack = this.micTrack = this.camTrack = this.screenTrack = null;
    this.micOn = this.camOn = false;
    this.noise = { mode: this.noise.mode, status: 'off', error: null };
    this.emit();
  }
}

export const media = new MediaManager();
