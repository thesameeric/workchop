import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  getUserMedia: vi.fn(),
  getDisplayMedia: vi.fn(),
  saveDevices: vi.fn(),
  pipeline: vi.fn(),
  prefs: {} as { micOn?: boolean; camOn?: boolean; noise?: 'standard' | 'enhanced' },
}));

vi.mock('../client/src/lib/storage', () => ({
  loadDevices: () => ({ ...fake.prefs }),
  saveDevices: fake.saveDevices,
}));
vi.mock('../client/src/lib/noise', () => ({
  MicPipeline: { create: fake.pipeline },
  NoiseError: class NoiseError extends Error {},
}));

const { MediaManager } = await import('../client/src/lib/media');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type TestTrack = MediaStreamTrack & { stop: ReturnType<typeof vi.fn>; lose(): void };
function track(kind: 'audio' | 'video', id: string = kind): TestTrack {
  const result = {
    kind, id, enabled: true, readyState: 'live', onended: null,
    getSettings: () => ({ deviceId: id }),
    stop: vi.fn(),
  } as unknown as TestTrack;
  const end = () => Object.defineProperty(result, 'readyState', { value: 'ended', configurable: true });
  result.stop.mockImplementation(end);
  result.lose = () => {
    end();
    result.onended?.call(result, new Event('ended'));
  };
  return result;
}

function stream(...tracks: TestTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((item) => item.kind === 'audio'),
    getVideoTracks: () => tracks.filter((item) => item.kind === 'video'),
  } as unknown as MediaStream;
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const managers: InstanceType<typeof MediaManager>[] = [];
function manager() {
  const media = new MediaManager();
  managers.push(media);
  return media;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.getUserMedia.mockReset();
  fake.getDisplayMedia.mockReset();
  fake.pipeline.mockReset();
  fake.prefs = {};
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: fake.getUserMedia, getDisplayMedia: fake.getDisplayMedia } });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

afterEach(() => {
  managers.splice(0).forEach((media) => media.stopAll());
  vi.unstubAllGlobals();
});

describe('independent microphone and camera startup', () => {
  it('publishes an enabled microphone and resolves startup while the camera is still pending', async () => {
    const mic = track('audio');
    const camera = deferred<MediaStream>();
    fake.getUserMedia.mockImplementation((constraints: MediaStreamConstraints) => constraints.audio ? Promise.resolve(stream(mic)) : camera.promise);
    const media = manager();
    const snapshots: { microphone: string; camera: string; audio: MediaStreamTrack | null }[] = [];
    media.subscribe(() => snapshots.push({ ...media.captureStatus, audio: media.audioTrack }));

    await media.start(true, true);

    expect(fake.getUserMedia).toHaveBeenCalledTimes(2);
    expect(fake.getUserMedia.mock.calls.every(([request]) => !(request.audio && request.video))).toBe(true);
    expect(media.audioTrack).toBe(mic);
    expect(mic.enabled).toBe(true);
    expect(media.micOn).toBe(true);
    expect(media.camOn).toBe(false);
    expect(media.captureStatus).toEqual({ microphone: 'ready', camera: 'requesting' });
    expect(snapshots).toContainEqual({ microphone: 'ready', camera: 'requesting', audio: mic });

    const cam = track('video');
    camera.resolve(stream(cam));
    await flush();
    expect(media.videoTrack).toBe(cam);
    expect(media.camOn).toBe(true);
  });

  it.each(['NotAllowedError', 'NotFoundError', 'NotReadableError'])('keeps a ready microphone active when the camera fails with %s', async (reason) => {
    const mic = track('audio');
    fake.getUserMedia.mockImplementation((constraints: MediaStreamConstraints) => constraints.audio ? Promise.resolve(stream(mic)) : Promise.reject(new DOMException('', reason)));
    const media = manager();

    await media.start(true, true);
    await flush();

    expect(media.micOn).toBe(true);
    expect(media.audioTrack).toBe(mic);
    expect(mic.enabled).toBe(true);
    expect(media.captureStatus.camera).toBe(reason === 'NotAllowedError' ? 'denied' : reason === 'NotFoundError' ? 'unavailable' : 'error');
  });

  it('can publish video even while microphone permission is pending', async () => {
    const microphone = deferred<MediaStream>();
    const cam = track('video');
    fake.getUserMedia.mockImplementation((constraints: MediaStreamConstraints) => constraints.audio ? microphone.promise : Promise.resolve(stream(cam)));
    const media = manager();
    let joined = false;
    const starting = media.start(true, true).then(() => { joined = true; });
    await flush();

    expect(joined).toBe(false);
    expect(media.videoTrack).toBe(cam);
    expect(media.captureStatus.microphone).toBe('requesting');

    microphone.reject(new DOMException('', 'NotAllowedError'));
    await starting;
    expect(media.captureStatus.microphone).toBe('denied');
    expect(media.micOn).toBe(false);
    expect(media.camOn).toBe(true);
  });

  it('does not delay camera-only startup or request a microphone', async () => {
    fake.getUserMedia.mockReturnValue(new Promise(() => {}));
    const media = manager();

    await media.start(false, true);

    expect(fake.getUserMedia).toHaveBeenCalledTimes(1);
    expect(fake.getUserMedia.mock.calls[0][0].audio).toBeUndefined();
    expect(media.captureStatus).toEqual({ microphone: 'idle', camera: 'requesting' });
  });

  it('shares in-flight acquisitions across concurrent startup and enable requests', async () => {
    const microphone = deferred<MediaStream>();
    const camera = deferred<MediaStream>();
    fake.getUserMedia.mockImplementation((constraints: MediaStreamConstraints) => constraints.audio ? microphone.promise : camera.promise);
    const media = manager();
    const starts = [media.start(true, true), media.start(true, true), media.setMic(true), media.setCam(true)];
    await flush();
    expect(fake.getUserMedia).toHaveBeenCalledTimes(2);

    const mic = track('audio');
    const cam = track('video');
    microphone.resolve(stream(mic));
    camera.resolve(stream(cam));
    await Promise.all(starts);

    await media.start(true, true);
    expect(fake.getUserMedia).toHaveBeenCalledTimes(2);
    expect(mic.stop).not.toHaveBeenCalled();
    expect(cam.stop).not.toHaveBeenCalled();
  });

  it('reports insecure or unavailable capture without hanging startup', async () => {
    vi.stubGlobal('navigator', {});
    const media = manager();
    await media.start(true, true);
    await flush();
    expect(media.captureStatus).toEqual({ microphone: 'unavailable', camera: 'unavailable' });
    expect(media.error).toContain('secure');
  });
});

describe('capture lifecycle and current user choices', () => {
  it('keeps a microphone muted when its permission result arrives after mute', async () => {
    const pending = deferred<MediaStream>();
    fake.getUserMedia.mockReturnValue(pending.promise);
    const media = manager();
    const starting = media.start(true, false);
    await flush();
    await media.setMic(false);
    const mic = track('audio');
    pending.resolve(stream(mic));
    await starting;

    expect(media.micOn).toBe(false);
    expect(mic.enabled).toBe(false);
    expect(fake.saveDevices).toHaveBeenLastCalledWith({ micOn: false });
    await media.start();
    expect(media.micOn).toBe(false);
    expect(mic.enabled).toBe(false);
  });

  it('stops a late camera result after the user switches the camera off', async () => {
    const pending = deferred<MediaStream>();
    fake.getUserMedia.mockReturnValue(pending.promise);
    const media = manager();
    const enabling = media.setCam(true);
    await flush();
    await media.setCam(false);
    const cam = track('video');
    pending.resolve(stream(cam));
    await enabling;

    expect(cam.stop).toHaveBeenCalledOnce();
    expect(media.videoTrack).toBeNull();
    expect(media.captureStatus.camera).toBe('idle');
  });

  it('stops all late acquisition results after leaving and does not publish them', async () => {
    const microphone = deferred<MediaStream>();
    const camera = deferred<MediaStream>();
    fake.getUserMedia.mockImplementation((constraints: MediaStreamConstraints) => constraints.audio ? microphone.promise : camera.promise);
    const media = manager();
    const starting = media.start(true, true);
    await flush();
    media.stopAll();
    await starting;
    const changed = vi.fn();
    media.subscribe(changed);
    const mic = track('audio');
    const cam = track('video');
    microphone.resolve(stream(mic));
    camera.resolve(stream(cam));
    await starting;
    await flush();

    expect(mic.stop).toHaveBeenCalledOnce();
    expect(cam.stop).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    expect(media.audioTrack).toBeNull();
    expect(media.videoTrack).toBeNull();
    expect(media.captureStatus).toEqual({ microphone: 'idle', camera: 'idle' });
  });

  it('can start a fresh session without being overwritten by the old pending request', async () => {
    const old = deferred<MediaStream>();
    const currentMic = track('audio', 'current');
    fake.getUserMedia.mockReturnValueOnce(old.promise).mockResolvedValueOnce(stream(currentMic));
    const media = manager();
    const first = media.start(true, false);
    await flush();
    media.stopAll();
    await media.start(true, false);
    const oldMic = track('audio', 'old');
    old.resolve(stream(oldMic));
    await first;
    expect(media.audioTrack).toBe(currentMic);
    expect(media.micOn).toBe(true);
    expect(oldMic.stop).toHaveBeenCalledOnce();
    expect(currentMic.stop).not.toHaveBeenCalled();
  });

  it.each(['audioIn', 'videoIn'] as const)('only publishes the latest requested %s device', async (kind) => {
    const old = deferred<MediaStream>();
    const recent = deferred<MediaStream>();
    const audio = kind === 'audioIn';
    fake.getUserMedia.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
    const media = manager();
    const starting = audio ? media.start(true, false) : media.setCam(true);
    await flush();
    const switching = media.setDevice(kind, 'recent-device');
    await flush();
    const currentTrack = track(audio ? 'audio' : 'video', 'recent-device');
    recent.resolve(stream(currentTrack));
    await switching;
    const outdated = track(audio ? 'audio' : 'video', 'outdated-device');
    old.resolve(stream(outdated));
    await starting;

    expect(audio ? media.audioTrack : media.videoTrack).toBe(currentTrack);
    expect(media.selectedDevice(kind)).toBe('recent-device');
    expect(outdated.stop).toHaveBeenCalledOnce();
    expect(media.error).toBeNull();
  });

  it('preserves mute during an input-device switch', async () => {
    const first = track('audio');
    const next = deferred<MediaStream>();
    fake.getUserMedia.mockResolvedValueOnce(stream(first)).mockReturnValueOnce(next.promise);
    const media = manager();
    await media.start(true, false);
    const changing = media.setDevice('audioIn', 'new-microphone');
    await flush();
    await media.setMic(false);
    const replacement = track('audio', 'new-microphone');
    next.resolve(stream(replacement));
    await changing;

    expect(first.stop).toHaveBeenCalledOnce();
    expect(media.micOn).toBe(false);
    expect(replacement.enabled).toBe(false);
  });

  it('keeps the working microphone if changing devices fails', async () => {
    const mic = track('audio');
    fake.getUserMedia.mockResolvedValueOnce(stream(mic)).mockRejectedValueOnce(new DOMException('', 'NotReadableError'));
    const media = manager();
    await media.start(true, false);
    await media.setDevice('audioIn', 'busy-device');

    expect(media.audioTrack).toBe(mic);
    expect(media.micOn).toBe(true);
    expect(media.captureStatus.microphone).toBe('ready');
    expect(media.error).toContain('in use');
  });

  it('does not reacquire a deliberately muted microphone when it is unplugged', async () => {
    const mic = track('audio');
    fake.getUserMedia.mockResolvedValue(stream(mic));
    const media = manager();
    await media.start(true, false);
    await media.setMic(false);
    mic.lose();
    await flush();
    expect(fake.getUserMedia).toHaveBeenCalledTimes(1);
    expect(media.audioTrack).toBeNull();
    expect(media.micOn).toBe(false);
  });

  it('discards a microphone reconnect after the user leaves', async () => {
    const original = track('audio');
    const recovered = deferred<MediaStream>();
    fake.getUserMedia.mockResolvedValueOnce(stream(original)).mockReturnValueOnce(recovered.promise);
    const media = manager();
    await media.start(true, false);
    original.lose();
    await flush();
    media.stopAll();
    const late = track('audio', 'late');
    recovered.resolve(stream(late));
    await flush();
    expect(late.stop).toHaveBeenCalledOnce();
    expect(media.audioTrack).toBeNull();
    expect(media.micOn).toBe(false);
  });

  it('discards a camera reconnect when the camera is switched off', async () => {
    const original = track('video');
    const recovered = deferred<MediaStream>();
    fake.getUserMedia.mockResolvedValueOnce(stream(original)).mockReturnValueOnce(recovered.promise);
    const media = manager();
    await media.setCam(true);
    original.lose();
    await flush();
    await media.setCam(false);
    const late = track('video', 'late');
    recovered.resolve(stream(late));
    await flush();
    expect(late.stop).toHaveBeenCalledOnce();
    expect(media.camOn).toBe(false);
    expect(media.videoTrack).toBeNull();
  });

  it('stops a pending screen-share result after leaving', async () => {
    const picker = deferred<MediaStream>();
    fake.getDisplayMedia.mockReturnValue(picker.promise);
    const media = manager();
    const sharing = media.startScreen();
    media.stopAll();
    const late = track('video');
    picker.resolve(stream(late));
    await sharing;
    expect(late.stop).toHaveBeenCalledOnce();
    expect(media.screenOn).toBe(false);
  });
});

describe('enhanced suppression does not gate voice startup', () => {
  it('uses the plain microphone while RNNoise is loading and respects mute when it becomes ready', async () => {
    const mic = track('audio');
    const processed = track('audio', 'processed');
    const enhancement = deferred<unknown>();
    fake.prefs = { noise: 'enhanced' };
    fake.pipeline.mockReturnValue(enhancement.promise);
    fake.getUserMedia.mockResolvedValue(stream(mic));
    const media = manager();
    await media.start(true, false);
    expect(media.audioTrack).toBe(mic);
    expect(mic.enabled).toBe(true);
    await media.setMic(false);
    enhancement.resolve({
      track: processed, running: true, setSource: vi.fn(), close: vi.fn(),
      ctx: { suspend: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(undefined) },
    });
    await flush();
    expect(media.audioTrack).toBe(processed);
    expect(processed.enabled).toBe(false);
    expect(media.micOn).toBe(false);
  });
});
