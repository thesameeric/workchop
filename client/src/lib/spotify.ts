import { sessionPosition, type MusicLink, type SpotifySession, type SpotifySessionUpdate } from '../../../shared/music';
import { getState, setState } from '../state/store';
import { serverNow } from './clock';

/*
 * Spotify "listen along": each listener plays the DJ's current track on THEIR OWN Spotify Premium
 * account through the Web Playback SDK, and Workchop keeps everyone on the same track and position.
 * Nothing is ever streamed from one person to another. It is off unless the server sets
 * SPOTIFY_CLIENT_ID, and Spotify limits apps in development mode to a handful of approved accounts.
 */

interface SpotifyTrack {
  uri: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album: { images: { url: string }[] };
}

interface PlayerState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track: SpotifyTrack | null };
}

interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (payload: never) => void): boolean;
  getCurrentState(): Promise<PlayerState | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  activateElement?(): Promise<void>;
}

interface SpotifySDK {
  Player: new (opts: { name: string; getOAuthToken: (cb: (token: string) => void) => void; volume?: number }) => SpotifyPlayer;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: SpotifySDK;
  }
}

interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
}

const AUTHORIZE = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';
const STORAGE = 'workchop:spotify-tokens';

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes = 48): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

let sdkPromise: Promise<SpotifySDK> | null = null;
function loadSdk(): Promise<SpotifySDK> {
  if (window.Spotify) return Promise.resolve(window.Spotify);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify!);
      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true;
      script.onerror = () => {
        sdkPromise = null;
        reject(new Error('Could not load Spotify’s player.'));
      };
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

type DjSender = (itemId: string, update: SpotifySessionUpdate | null, start?: boolean) => void;

export class SpotifyListenAlong {
  private clientId: string | null = null;
  private tokens: Tokens | null = null;
  private player: SpotifyPlayer | null = null;
  private deviceId: string | null = null;
  /** Jukebox we're DJing on, while we are the DJ. */
  private djItemId: string | null = null;
  private djStarting = false;
  private lastSent: { uri: string; paused: boolean; positionMs: number; at: number } | null = null;
  private lastCorrection = 0;
  private lastVolume = -1;
  private followingUri: string | null = null;
  private busy = false;

  constructor(private readonly sendDj: DjSender) {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) this.tokens = JSON.parse(raw) as Tokens;
    } catch {
      this.tokens = null;
    }
  }

  get enabled(): boolean {
    return !!this.clientId;
  }

  private setStatus(status: ReturnType<typeof getState>['spotify']['status'], error: string | null = null): void {
    setState({ spotify: { status, error } });
  }

  configure(clientId: string | null): void {
    this.clientId = clientId;
    if (!clientId) {
      this.setStatus('disabled');
      return;
    }
    this.setStatus('disconnected');
    // Reconnect quietly if this browser connected before.
    if (this.tokens) void this.startPlayer().catch(() => {});
  }

  /** Must be called from a click: the sign-in popup is opened synchronously. */
  async connect(): Promise<void> {
    if (!this.clientId) return;
    if (this.tokens) {
      await this.startPlayer();
      return;
    }
    const popup = window.open('about:blank', 'workchop-spotify', 'width=480,height=720');
    if (!popup) {
      this.setStatus('error', 'Your browser blocked the Spotify sign-in window. Allow pop-ups for this site and try again.');
      return;
    }
    this.setStatus('connecting');
    try {
      this.tokens = await this.authorize(popup);
      this.saveTokens();
      await this.startPlayer();
    } catch (err) {
      popup.close();
      this.setStatus('error', (err as Error).message);
    }
  }

  disconnect(): void {
    this.stopDj(true);
    this.player?.disconnect();
    this.player = null;
    this.deviceId = null;
    this.tokens = null;
    this.followingUri = null;
    this.lastVolume = -1;
    try {
      localStorage.removeItem(STORAGE);
    } catch {
      // ignore
    }
    setState((s) => ({ music: { ...s.music, spotifyPlaying: false } }));
    this.setStatus(this.clientId ? 'disconnected' : 'disabled');
  }

  private saveTokens(): void {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(this.tokens));
    } catch {
      // Not remembered across reloads; fine.
    }
  }

  private async authorize(popup: Window): Promise<Tokens> {
    const verifier = randomString(64);
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const state = randomString(16);
    const redirectUri = `${location.origin}/spotify-callback.html`;
    const url = new URL(AUTHORIZE);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId!,
      scope: SCOPES,
      redirect_uri: redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
    }).toString();
    popup.location.href = url.toString();

    const code = await new Promise<string>((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        if (e.origin !== location.origin || e.data?.type !== 'workchop-spotify') return;
        cleanup();
        if (e.data.error) reject(new Error(e.data.error === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed (${e.data.error}).`));
        else if (e.data.state !== state || !e.data.code) reject(new Error('Spotify sign-in failed. Please try again.'));
        else resolve(e.data.code as string);
      };
      const closed = setInterval(() => {
        if (popup.closed) {
          cleanup();
          reject(new Error('Spotify sign-in window was closed.'));
        }
      }, 500);
      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        clearInterval(closed);
      };
      window.addEventListener('message', onMessage);
    });

    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.clientId!,
      code_verifier: verifier,
    });
  }

  private async tokenRequest(params: Record<string, string>): Promise<Tokens> {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`Spotify sign-in failed (${body.error ?? res.status}).`);
    return {
      access: body.access_token,
      refresh: body.refresh_token ?? this.tokens?.refresh ?? '',
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
  }

  private async accessToken(): Promise<string> {
    if (!this.tokens) throw new Error('Not connected to Spotify.');
    if (Date.now() > this.tokens.expiresAt - 60_000) {
      try {
        this.tokens = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh, client_id: this.clientId! });
        this.saveTokens();
      } catch (err) {
        this.disconnect();
        this.setStatus('error', 'Your Spotify sign-in expired. Please connect again.');
        throw err;
      }
    }
    return this.tokens.access;
  }

  private async api(method: string, path: string, body?: unknown): Promise<void> {
    const send = async () =>
      fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res = await send();
    if (res.status === 401 && this.tokens) {
      this.tokens.expiresAt = 0;
      res = await send();
    }
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string; reason?: string } };
      if (res.status === 403) throw new Error('Spotify refused playback. Listening along needs Spotify Premium, and this account may need to be approved by the office admin.');
      throw new Error(detail.error?.message ?? `Spotify error ${res.status}`);
    }
  }

  private async startPlayer(): Promise<void> {
    if (this.player) return;
    this.setStatus('connecting');
    this.lastVolume = -1; // A new player starts silent.
    let sdk: SpotifySDK;
    try {
      sdk = await loadSdk();
    } catch (err) {
      this.setStatus('error', (err as Error).message);
      return;
    }
    const player = new sdk.Player({
      name: 'Workchop lounge',
      volume: 0,
      getOAuthToken: (cb) => {
        this.accessToken().then(cb, () => {});
      },
    });
    this.player = player;
    player.addListener('ready', ({ device_id }: { device_id: string }) => {
      this.deviceId = device_id;
      this.setStatus('ready');
    });
    player.addListener('not_ready', () => {
      this.deviceId = null;
    });
    player.addListener('initialization_error', ({ message }: { message: string }) => {
      this.player = null;
      this.setStatus('error', `This browser can’t play Spotify here (${message}). Try Chrome, Edge or Firefox on a computer.`);
    });
    player.addListener('authentication_error', () => {
      this.disconnect();
      this.setStatus('error', 'Spotify didn’t accept the sign-in. Please connect again.');
    });
    player.addListener('account_error', () => {
      this.stopDj(true);
      this.player?.disconnect();
      this.player = null;
      this.setStatus('error', 'Listening along needs Spotify Premium.');
    });
    player.addListener('playback_error', ({ message }: { message: string }) => console.warn('[spotify]', message));
    player.addListener('player_state_changed', (state: PlayerState | null) => this.onState(state));
    const ok = await player.connect();
    if (!ok) this.setStatus('error', 'Could not start Spotify in this browser.');
  }

  /** Start playing a shared link for everyone at this jukebox, with us as the DJ. */
  async playForEveryone(itemId: string, link: MusicLink): Promise<void> {
    if (!this.player || !this.deviceId || !link.uri) return;
    await this.player.activateElement?.();
    // One session per DJ: moving to another jukebox ends the one we were running.
    if (this.djItemId && this.djItemId !== itemId) this.sendDj(this.djItemId, null);
    const body = link.kind === 'track' || link.kind === 'episode' ? { uris: [link.uri] } : { context_uri: link.uri };
    this.djItemId = itemId;
    this.djStarting = true;
    this.lastSent = null;
    try {
      await this.api('PUT', `/me/player/play?device_id=${encodeURIComponent(this.deviceId)}`, body);
    } catch (err) {
      this.djItemId = null;
      this.djStarting = false;
      this.setStatus('ready', (err as Error).message);
      throw err;
    }
  }

  /** Stop the session (anyone at the jukebox may). */
  stopForEveryone(itemId: string): void {
    if (this.djItemId === itemId) this.stopDj(false);
    this.sendDj(itemId, null);
  }

  /** Stop being the DJ (and stop playing); `tellRoom` ends the session for the listeners too. */
  private stopDj(tellRoom: boolean): void {
    const itemId = this.djItemId;
    if (!itemId) return;
    this.djItemId = null;
    this.djStarting = false;
    void this.player?.pause().catch(() => {});
    setState((s) => ({ music: { ...s.music, spotifyPlaying: false } }));
    if (tellRoom) this.sendDj(itemId, null);
  }

  /**
   * After reconnecting to the office: the server ended our session when the connection dropped,
   * so start it again, unless someone else has taken the jukebox over meanwhile.
   */
  rejoined(): void {
    const itemId = this.djItemId;
    if (!itemId || !this.player) return;
    if (getState().spotifySessions[itemId]) {
      this.djItemId = null;
      this.followingUri = this.lastSent?.uri ?? 'dj';
      return;
    }
    this.djStarting = true;
    this.lastSent = null;
    void this.player
      .getCurrentState()
      .then((state) => (state?.track_window.current_track ? this.onState(state) : this.stopDj(false)))
      .catch(() => this.stopDj(false));
  }

  /** As DJ, tell the room whenever our playback changes in a way listeners need to follow. */
  private onState(state: PlayerState | null): void {
    const playing = !!state && !state.paused && !!state.track_window.current_track;
    if (this.djItemId || this.followingUri) setState((s) => ({ music: { ...s.music, spotifyPlaying: playing } }));
    if (!this.djItemId || !state?.track_window.current_track) return;
    const track = state.track_window.current_track;
    const now = Date.now();
    const last = this.lastSent;
    const expected = last ? (last.paused ? last.positionMs : last.positionMs + (now - last.at)) : 0;
    const changed =
      this.djStarting || !last || last.uri !== track.uri || last.paused !== state.paused || Math.abs(state.position - expected) > 2500;
    if (!changed) return;
    const start = this.djStarting;
    this.djStarting = false;
    this.lastSent = { uri: track.uri, paused: state.paused, positionMs: state.position, at: now };
    this.sendDj(
      this.djItemId,
      {
        uri: track.uri,
        name: track.name,
        artists: track.artists.map((a) => a.name).join(', '),
        image: track.album.images[0]?.url,
        durationMs: state.duration || track.duration_ms,
        positionMs: state.position,
        paused: state.paused,
      },
      start,
    );
  }

  /**
   * Keep our own player in line with the session at the jukebox we can hear. Called about once a
   * second with the session (or null) and how loud the music should be for us (0..1).
   */
  async follow(session: SpotifySession | null, volume: number): Promise<void> {
    const player = this.player;
    if (!player || !this.deviceId || this.busy) return;
    this.busy = true;
    try {
      // Someone else took over (or stopped the session): we're no longer the DJ. Allow a moment
      // for the server to echo a session we just started.
      if (this.djItemId && !this.djStarting && Date.now() - (this.lastSent?.at ?? 0) > 3000) {
        const mine = getState().spotifySessions[this.djItemId];
        if (!mine || mine.dj !== getState().selfId) {
          this.djItemId = null;
          // Our player is still playing what we chose: from now on it follows like anyone else's
          // (pausing if the session was stopped, switching if someone else took over).
          this.followingUri = this.lastSent?.uri ?? 'dj';
        }
      }
      await this.applyVolume(volume);
      if (this.djItemId) return;

      if (!session || volume === 0) {
        if (this.followingUri) {
          this.followingUri = null;
          await player.pause().catch(() => {});
          setState((s) => ({ music: { ...s.music, spotifyPlaying: false } }));
        }
        return;
      }
      const target = sessionPosition(session, serverNow());
      const state = await player.getCurrentState();
      const sameTrack = state?.track_window.current_track?.uri === session.uri;
      if (session.paused) {
        if (state && !state.paused) await player.pause();
        return;
      }
      if (!sameTrack) {
        if (Date.now() - this.lastCorrection < 4000) return;
        this.lastCorrection = Date.now();
        this.followingUri = session.uri;
        await this.api('PUT', `/me/player/play?device_id=${encodeURIComponent(this.deviceId)}`, {
          uris: [session.uri],
          position_ms: Math.round(target),
        });
        return;
      }
      this.followingUri = session.uri;
      if (Math.abs(state!.position - target) > 2500 && Date.now() - this.lastCorrection > 4000) {
        this.lastCorrection = Date.now();
        await player.seek(Math.round(target));
      }
      if (state!.paused) await player.resume();
    } catch (err) {
      setState({ spotify: { status: 'ready', error: (err as Error).message } });
    } finally {
      this.busy = false;
    }
  }

  private async applyVolume(v: number): Promise<void> {
    if (!this.player || Math.abs(v - this.lastVolume) < 0.02) return;
    this.lastVolume = v;
    await this.player.setVolume(Math.max(0, Math.min(1, v))).catch(() => {});
  }

  /** The jukebox this browser is DJing on, if any. */
  get djJukebox(): string | null {
    return this.djItemId;
  }

  close(): void {
    this.stopDj(false); // The server ends our sessions when we leave.
    this.player?.disconnect();
    this.player = null;
    this.deviceId = null;
    this.followingUri = null;
    setState((s) => ({ music: { ...s.music, spotifyPlaying: false } }));
  }
}
