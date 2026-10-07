import { loadDevices, saveDevices } from './storage';

type Listener = () => void;

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 24, max: 30 },
};

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

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
  audioTrack: MediaStreamTrack | null = null;
  camTrack: MediaStreamTrack | null = null;
  screenTrack: MediaStreamTrack | null = null;
  micOn = false;
  camOn = false;
  error: string | null = null;
  /** Bumped whenever the outgoing video track changes, so UI can re-bind <video> elements. */
  version = 0;
  private listeners = new Set<Listener>();
  private prefs = loadDevices();

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
    this.micOn = wantMic && !!this.audioTrack;
    if (this.audioTrack) this.audioTrack.enabled = this.micOn;
    this.camOn = wantCam && !!this.camTrack;
    this.emit();
  }

  private replaceAudio(track: MediaStreamTrack | null): void {
    if (this.audioTrack && this.audioTrack !== track) this.audioTrack.stop();
    this.audioTrack = track;
    if (track) track.enabled = this.micOn;
  }

  private replaceCam(track: MediaStreamTrack | null): void {
    if (this.camTrack && this.camTrack !== track) this.camTrack.stop();
    this.camTrack = track;
    if (track) track.onended = () => this.setCam(false);
  }

  private async acquireAudio(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...AUDIO_CONSTRAINTS, deviceId: this.prefs.audioIn ? { ideal: this.prefs.audioIn } : undefined },
      });
      this.replaceAudio(stream.getAudioTracks()[0] ?? null);
      return !!this.audioTrack;
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
    if (on && !this.audioTrack && !(await this.acquireAudio())) on = false;
    this.micOn = on;
    if (this.audioTrack) this.audioTrack.enabled = on;
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
    if (kind === 'audioIn') return this.audioTrack?.getSettings().deviceId ?? this.prefs.audioIn;
    if (kind === 'videoIn') return this.camTrack?.getSettings().deviceId ?? this.prefs.videoIn;
    return this.prefs.audioOut;
  }

  async setDevice(kind: 'audioIn' | 'videoIn' | 'audioOut', deviceId: string): Promise<void> {
    this.prefs = { ...this.prefs, [kind]: deviceId };
    saveDevices({ [kind]: deviceId });
    if (kind === 'audioIn' && this.audioTrack) {
      const was = this.micOn;
      await this.acquireAudio();
      this.micOn = was && !!this.audioTrack;
      if (this.audioTrack) this.audioTrack.enabled = this.micOn;
    } else if (kind === 'videoIn' && this.camTrack) {
      await this.acquireCam();
    }
    this.emit();
  }

  stopAll(): void {
    this.audioTrack?.stop();
    this.camTrack?.stop();
    this.screenTrack?.stop();
    this.audioTrack = this.camTrack = this.screenTrack = null;
    this.micOn = this.camOn = false;
    this.emit();
  }
}

export const media = new MediaManager();
