import { audibleJukebox, sameSource, sourceOf, trackAt, type MusicSource, type Track } from '../../../shared/music';
import { getState, personalMusicVolume, setState, type NowPlaying } from '../state/store';
import { clockOffset, serverNow } from './clock';
import { GenerativeStation } from './genmusic';
import { local } from './positions';

interface Player {
  setVolume(v: number): void;
  stop(): void;
  /** Called on every radio tick. */
  tick?(): void;
  title(): string;
  /** For tests and debugging. */
  media?(): { src: string; time: number; paused: boolean; volume: number };
}

function mediaInfo(audio: HTMLAudioElement) {
  return { src: audio.currentSrc || audio.src, time: audio.currentTime, paused: audio.paused, volume: audio.volume };
}

/** A live stream: everyone listening hears roughly the same moment by nature. */
class StreamPlayer implements Player {
  private readonly audio = new Audio();
  private failedAt = 0;
  private retryMs = 2000;
  private blocked = false;

  constructor(
    private readonly url: string,
    private readonly name: string,
    private readonly onBlocked: () => void,
  ) {
    this.audio.preload = 'none';
    this.audio.volume = 0;
    const failed = () => {
      if (!this.failedAt) this.failedAt = Date.now();
    };
    this.audio.addEventListener('error', failed);
    this.audio.addEventListener('ended', failed);
    this.audio.addEventListener('playing', () => {
      this.failedAt = 0;
      this.retryMs = 2000;
    });
    this.connect();
  }

  private connect() {
    this.audio.src = this.url;
    this.audio.play().catch((err) => {
      if (err?.name === 'NotAllowedError') {
        this.blocked = true;
        this.onBlocked();
      }
    });
  }

  /** Streams drop now and then (server restarts, network changes): reconnect with back-off. */
  tick() {
    if (this.blocked || !this.failedAt || Date.now() - this.failedAt < this.retryMs) return;
    this.failedAt = 0;
    this.retryMs = Math.min(this.retryMs * 2, 60_000);
    this.connect();
  }

  setVolume(v: number) {
    this.audio.volume = v;
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  title() {
    return this.name;
  }

  media() {
    return mediaInfo(this.audio);
  }
}

export interface TrackLength {
  url: string;
  durationMs: number;
}

/** The office's own track list, looped and positioned from the shared clock. */
class TracksPlayer implements Player {
  private readonly audio = new Audio();
  private index = -1;
  private readonly probing = new Set<string>();
  /** Lengths measured here, until the server's copy has them. */
  private readonly measured = new Map<string, number>();
  /** Tracks that couldn't be measured: when to try again (Infinity: never, e.g. a live stream). */
  private readonly failed = new Map<string, { retryAt: number; wait: number }>();
  /** Known lengths we found to be wrong; reported once (editors' corrections are accepted). */
  private readonly corrected = new Set<string>();
  private lastReport = 0;
  private lastSeek = 0;

  constructor(
    private tracks: Track[],
    private readonly startedAt: number,
    private readonly reportDurations: (lengths: TrackLength[]) => void,
    private readonly onBlocked: () => void,
  ) {
    this.audio.preload = 'auto';
    this.audio.volume = 0;
    this.audio.addEventListener('loadedmetadata', () => this.checkLength());
  }

  /** Durations arrive after the first listener measures them. */
  update(tracks: Track[]) {
    this.tracks = tracks;
  }

  /** Measure tracks nobody has measured yet, and report them (again, until the server has them). */
  private measure() {
    const now = Date.now();
    const missing: TrackLength[] = [];
    for (const t of this.tracks) {
      if (t.durationMs) continue;
      const ms = this.measured.get(t.url);
      if (ms) missing.push({ url: t.url, durationMs: ms });
      else if (!this.probing.has(t.url) && now >= (this.failed.get(t.url)?.retryAt ?? 0)) this.probe(t.url);
    }
    if (missing.length && now - this.lastReport > 3000) {
      this.lastReport = now;
      this.reportDurations(missing);
    }
  }

  /** The track we're playing turned out to have a different length than everyone assumes. */
  private checkLength() {
    const track = this.tracks[this.index];
    const real = this.audio.duration * 1000;
    if (!track?.durationMs || !Number.isFinite(real) || Math.abs(real - track.durationMs) < 2000) return;
    if (this.corrected.has(track.url)) return;
    this.corrected.add(track.url);
    this.reportDurations([{ url: track.url, durationMs: Math.round(real) }]);
  }

  tick() {
    this.measure();
    const at = trackAt(this.tracks, this.startedAt, serverNow());
    if (!at) return;
    const track = this.tracks[at.index];
    if (at.index !== this.index || this.audio.src !== track.url) {
      this.index = at.index;
      this.audio.src = track.url;
      this.seekTo(at.offsetMs);
      this.audio.play().catch((err) => err?.name === 'NotAllowedError' && this.onBlocked());
      return;
    }
    const drift = this.audio.currentTime * 1000 - at.offsetMs;
    if (Math.abs(drift) > 1500 && Date.now() - this.lastSeek > 3000 && this.audio.readyState >= 1) this.seekTo(at.offsetMs);
    if (this.audio.paused && this.audio.readyState >= 2) this.audio.play().catch(() => {});
  }

  private seekTo(ms: number) {
    this.lastSeek = Date.now();
    const apply = () => {
      this.audio.currentTime = ms / 1000;
    };
    if (this.audio.readyState >= 1) apply();
    else this.audio.addEventListener('loadedmetadata', apply, { once: true });
  }

  private probe(url: string) {
    this.probing.add(url);
    const a = new Audio();
    a.preload = 'metadata';
    const done = (ms: number | null) => {
      this.probing.delete(url);
      a.removeAttribute('src');
      a.load();
      if (ms !== null) {
        this.measured.set(url, ms);
        this.failed.delete(url);
        return;
      }
      // Broken link or not a file: try again later, less and less often.
      const wait = Math.min((this.failed.get(url)?.wait ?? 15_000) * 2, 10 * 60_000);
      this.failed.set(url, { retryAt: Date.now() + wait, wait });
    };
    a.addEventListener('loadedmetadata', () => {
      const ms = a.duration * 1000;
      if (Number.isFinite(ms) && ms >= 1000) done(Math.round(ms));
      else {
        // A live stream (no end) or a sound too short to loop: never playable as a track.
        this.probing.delete(url);
        this.failed.set(url, { retryAt: Infinity, wait: Infinity });
        a.removeAttribute('src');
        a.load();
      }
    }, { once: true });
    a.addEventListener('error', () => done(null), { once: true });
    a.src = url;
  }

  setVolume(v: number) {
    this.audio.volume = v;
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  title() {
    const track = this.tracks[this.index];
    if (track) return track.title;
    const pending = this.tracks.some((t) => !t.durationMs && this.failed.get(t.url)?.retryAt !== Infinity);
    return pending ? 'Loading…' : 'None of the tracks can be played';
  }

  media() {
    return mediaInfo(this.audio);
  }
}

/** A built-in station generated in this browser. */
class GeneratedPlayer implements Player {
  private readonly station: GenerativeStation;
  /** The clock correction it started with: a big change means restarting in step. */
  readonly offset = clockOffset();
  readonly startedAt = Date.now();

  constructor(
    readonly ctx: AudioContext,
    private readonly source: Extract<MusicSource, { kind: 'generated' }>,
    destination: AudioNode,
  ) {
    this.station = new GenerativeStation(ctx, source.station.id, serverNow, destination);
    this.station.start();
  }

  setVolume(v: number) {
    this.station.setVolume(v);
  }

  stop() {
    this.station.stop();
  }

  title() {
    return this.source.station.name;
  }

  position() {
    return this.station.position(serverNow());
  }
}

/**
 * Plays whatever the jukebox you can hear is playing, at a volume that depends on where you stand,
 * your own volume setting, and whether you're listening to Spotify (which mutes the radio).
 */
export class LoungeRadio {
  private ctx: AudioContext | null = null;
  /** Taps the generated stations' output so the level can be checked (tests, debugging). */
  private meter: AnalyserNode | null = null;
  private player: Player | null = null;
  private source: MusicSource | null = null;
  private itemId: string | null = null;
  private silentSince = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly reportDurations: (itemId: string, lengths: TrackLength[]) => void) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), 250);
    this.tick();
  }

  private audioContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.meter = this.ctx.createAnalyser();
      this.meter.fftSize = 1024;
      this.meter.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Loudness (RMS) of the generated station output right now. */
  private level(): number {
    if (!this.meter) return 0;
    const data = new Float32Array(this.meter.fftSize);
    this.meter.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    return Math.sqrt(sum / data.length);
  }

  /** Retry after the browser blocked playback (needs to run inside a click handler). */
  unblock(): void {
    // Create the audio context inside the click if there isn't one yet, so it's allowed to start.
    void this.audioContext().resume().catch(() => {});
    const { source, itemId } = this;
    this.stopPlayer();
    this.source = source;
    this.itemId = itemId;
    setState((s) => ({ music: { ...s.music, blocked: false } }));
  }

  private onBlocked = () => setState((s) => ({ music: { ...s.music, blocked: true } }));

  private stopPlayer(): void {
    this.player?.stop();
    this.player = null;
    this.source = null;
    this.itemId = null;
  }

  tick(): void {
    const st = getState();
    const office = st.office;
    const heard = office ? audibleJukebox(office, local.x, local.z) : null;
    const source = heard ? sourceOf(heard.item) : null;
    const personal = personalMusicVolume(st);
    // Someone listening along to a Spotify session at this jukebox hears that instead, rather than
    // both playing over each other.
    const onSpotify = !!heard && st.music.spotifyPlaying && !!st.spotifySessions[heard.item.id];
    const volume = heard && source && !onSpotify ? heard.volume * personal * personal : 0;

    if (!sameSource(source, this.source) || (heard?.item.id ?? null) !== this.itemId) this.stopPlayer();
    // The shared clock was corrected noticeably: restart the generated station in step.
    if (this.player instanceof GeneratedPlayer && Math.abs(clockOffset() - this.player.offset) > 120) this.stopPlayer();

    if (volume > 0 && source && !this.player) {
      this.source = source;
      this.itemId = heard!.item.id;
      const id = heard!.item.id;
      if (source.kind === 'generated') {
        const ctx = this.audioContext();
        this.player = new GeneratedPlayer(ctx, source, this.meter!);
      }
      else if (source.kind === 'stream') this.player = new StreamPlayer(source.url, source.name, this.onBlocked);
      else this.player = new TracksPlayer(source.tracks, source.startedAt, (lengths) => this.reportDurations(id, lengths), this.onBlocked);
    }
    if (this.player && source?.kind === 'tracks' && this.player instanceof TracksPlayer) this.player.update(source.tracks);

    // Browsers may keep audio suspended until a click (Safari, iOS): offer an "Enable sound" button.
    const p = this.player;
    if (p instanceof GeneratedPlayer && volume > 0 && p.ctx.state === 'suspended' && Date.now() - p.startedAt > 1000 && !st.music.blocked) {
      this.onBlocked();
    }

    if (this.player) {
      this.player.setVolume(volume);
      this.player.tick?.();
      if (volume > 0) this.silentSince = 0;
      else if (!this.silentSince) this.silentSince = Date.now();
      else if (Date.now() - this.silentSince > 3000) this.stopPlayer();
    }

    const now: NowPlaying | null =
      heard && source
        ? { itemId: heard.item.id, title: this.player?.title() ?? sourceTitle(source), kind: source.kind, near: heard.volume }
        : heard
          ? { itemId: heard.item.id, title: 'Jukebox is off', kind: 'off', near: heard.volume }
          : null;
    const prev = st.music.nowPlaying;
    if (now?.itemId !== prev?.itemId || now?.title !== prev?.title || now?.kind !== prev?.kind || Math.abs((now?.near ?? 0) - (prev?.near ?? 0)) > 0.05) {
      setState((s) => ({ music: { ...s.music, nowPlaying: now } }));
    }
  }

  /** For tests and debugging: what is playing right now. */
  debug() {
    return {
      itemId: this.itemId,
      kind: this.source?.kind ?? null,
      level: this.level(),
      position: this.player instanceof GeneratedPlayer ? this.player.position() : undefined,
      media: this.player?.media?.(),
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.stopPlayer();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.meter = null;
    setState((s) => ({ music: { ...s.music, nowPlaying: null, blocked: false } }));
  }
}

function sourceTitle(source: MusicSource): string {
  if (source.kind === 'generated') return source.station.name;
  if (source.kind === 'stream') return source.name;
  return source.tracks[0]?.title ?? 'Tracks';
}
