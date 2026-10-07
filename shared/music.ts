import { getEntry } from './catalog';
import { zoneAt } from './geometry';
import type { Office, OfficeItem, Zone } from './types';

/**
 * Built-in stations are generated live in each browser from the shared clock, so everyone nearby
 * hears the same notes at the same moment, with no licensing or files involved.
 */
export interface Station {
  id: 'lofi' | 'ambient';
  name: string;
  genre: string;
}

export const STATIONS: Station[] = [
  { id: 'lofi', name: 'Workchop Lo-fi', genre: 'Chill beats' },
  { id: 'ambient', name: 'Workchop Ambient', genre: 'Calm, spacious pads' },
];

export function getStation(id: string | null | undefined): Station | undefined {
  return STATIONS.find((s) => s.id === id);
}

/** What a jukebox can play: a built-in station, the office's own tracks, or the office's own live stream. */
export type StationChoice = Station['id'] | 'tracks' | 'stream';

/** An audio file the office has the rights to play, e.g. https://example.com/music/song.mp3. */
export interface Track {
  url: string;
  title: string;
  /** Learned from the first browser that loads the file; needed to keep everyone in sync. */
  durationMs?: number;
}

export const MAX_TRACKS = 50;

export type SpotifyKind = 'track' | 'album' | 'playlist' | 'artist' | 'episode' | 'show' | 'jam';

export interface MusicLink {
  id: string;
  url: string;
  kind: SpotifyKind;
  /** spotify:<kind>:<id> when the link points at a playable item (not for Jams). */
  uri?: string;
  title?: string;
  image?: string;
  /** Name of whoever shared it. */
  by: string;
  byId: string;
  at: number;
}

/** Shared settings of a jukebox, saved with the office. */
export interface JukeboxData {
  /** What's playing; null when the jukebox is off. */
  station: StationChoice | null;
  /** The office's own live stream (set by people who may edit the office). */
  stream?: string;
  /** The office's own tracks, played in order and looped (set by people who may edit the office). */
  tracks?: Track[];
  /** Server time when the current choice started; the track list is timed from here. */
  startedAt?: number;
  /** Spotify links shared on the jukebox's board, newest first. */
  links: MusicLink[];
}

export const MAX_LINKS = 30;
export const MUSIC_RADIUS = 7;

const SPOTIFY_ID = /^[A-Za-z0-9]{10,40}$/;
const KINDS = ['track', 'album', 'playlist', 'artist', 'episode', 'show'] as const;

/** Recognise Spotify share links (and spotify: URIs, and Jam invites); returns a canonical form. */
export function parseSpotifyLink(raw: string): { url: string; kind: SpotifyKind; uri?: string } | null {
  const text = raw.trim();
  const uriMatch = /^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]+)$/.exec(text);
  if (uriMatch && SPOTIFY_ID.test(uriMatch[2])) {
    const [, kind, id] = uriMatch as unknown as [string, (typeof KINDS)[number], string];
    return { url: `https://open.spotify.com/${kind}/${id}`, kind, uri: `spotify:${kind}:${id}` };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname === 'spotify.link' || url.hostname === 'spotify.app.link') {
    const code = url.pathname.slice(1);
    return /^[A-Za-z0-9]{4,40}$/.test(code) ? { url: `https://spotify.link/${code}`, kind: 'jam' } : null;
  }
  if (url.hostname !== 'open.spotify.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0]?.startsWith('intl-')) parts.shift();
  if (parts[0] === 'socialsession' && parts[1] && /^[A-Za-z0-9_-]{4,64}$/.test(parts[1])) {
    return { url: `https://open.spotify.com/socialsession/${parts[1]}`, kind: 'jam' };
  }
  const kind = parts[0] as (typeof KINDS)[number];
  const id = parts[1];
  if (!(KINDS as readonly string[]).includes(kind) || !id || !SPOTIFY_ID.test(id)) return null;
  return { url: `https://open.spotify.com/${kind}/${id}`, kind, uri: `spotify:${kind}:${id}` };
}

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return t || undefined;
}

export function sanitizeStreamUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 500) return undefined;
  try {
    const u = new URL(v.trim());
    // Pages are served over HTTPS, where browsers block plain-http audio.
    return u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeLink(raw: unknown): MusicLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const parsed = typeof r.url === 'string' ? parseSpotifyLink(r.url) : null;
  if (!parsed || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id)) return null;
  const link: MusicLink = {
    id: r.id,
    url: parsed.url,
    kind: parsed.kind,
    by: cleanText(r.by, 32) ?? 'Someone',
    byId: cleanText(r.byId, 64) ?? '',
    at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
  };
  if (parsed.uri) link.uri = parsed.uri;
  const title = cleanText(r.title, 120);
  if (title) link.title = title;
  const image = sanitizeStreamUrl(r.image);
  if (image && /^https:\/\/([a-z0-9-]+\.)*(scdn\.co|spotifycdn\.com)\//.test(image)) link.image = image;
  return link;
}

/** A readable name for an audio URL without a title ("coffee.mp3"). */
function fileName(url: string): string {
  const last = new URL(url).pathname.split('/').pop() || url;
  try {
    return decodeURIComponent(last).slice(0, 120);
  } catch {
    return last.slice(0, 120); // Malformed %-escapes.
  }
}

export function sanitizeTracks(raw: unknown): Track[] {
  if (!Array.isArray(raw)) return [];
  const out: Track[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const url = sanitizeStreamUrl(r.url);
    if (!url || out.some((x) => x.url === url)) continue;
    const track: Track = { url, title: cleanText(r.title, 120) ?? fileName(url) };
    if (typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 1000 && r.durationMs <= 6 * 3600_000) {
      track.durationMs = Math.round(r.durationMs);
    }
    out.push(track);
    if (out.length >= MAX_TRACKS) break;
  }
  return out;
}

export function sanitizeJukeboxData(raw: unknown): JukeboxData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const stream = sanitizeStreamUrl(r.stream);
  const tracks = sanitizeTracks(r.tracks);
  let station: StationChoice | null = null;
  if (r.station === 'stream' && stream) station = 'stream';
  else if (r.station === 'tracks' && tracks.length) station = 'tracks';
  else if (typeof r.station === 'string' && getStation(r.station)) station = r.station as Station['id'];
  const seen = new Set<string>();
  const links = (Array.isArray(r.links) ? r.links : [])
    .map(sanitizeLink)
    .filter((l): l is MusicLink => !!l && !seen.has(l.id) && !!seen.add(l.id))
    .slice(0, MAX_LINKS);
  const data: JukeboxData = { station, links };
  if (stream) data.stream = stream;
  if (tracks.length) data.tracks = tracks;
  if (typeof r.startedAt === 'number' && Number.isFinite(r.startedAt)) data.startedAt = Math.round(r.startedAt);
  return data;
}

export function isJukebox(item: OfficeItem | undefined): item is OfficeItem & { data: JukeboxData } {
  return !!item && getEntry(item.type)?.music === true;
}

export function jukeboxData(item: OfficeItem): JukeboxData {
  return (item.data as JukeboxData | undefined) ?? { station: null, links: [] };
}

/** What a jukebox is playing, in a form the player can act on. */
export type MusicSource =
  | { kind: 'generated'; station: Station }
  | { kind: 'stream'; url: string; name: string }
  | { kind: 'tracks'; tracks: Track[]; startedAt: number };

export function sourceOf(item: OfficeItem): MusicSource | null {
  const data = jukeboxData(item);
  if (data.station === 'stream' && data.stream) return { kind: 'stream', url: data.stream, name: new URL(data.stream).hostname };
  if (data.station === 'tracks' && data.tracks?.length) return { kind: 'tracks', tracks: data.tracks, startedAt: data.startedAt ?? 0 };
  const station = getStation(data.station);
  return station ? { kind: 'generated', station } : null;
}

/** Same thing playing? (Used to avoid restarting playback when unrelated jukebox data changes.) */
export function sameSource(a: MusicSource | null, b: MusicSource | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'generated') return b.kind === 'generated' && a.station.id === b.station.id;
  if (a.kind === 'stream') return b.kind === 'stream' && a.url === b.url;
  return b.kind === 'tracks' && a.startedAt === b.startedAt && a.tracks.map((t) => t.url).join() === b.tracks.map((t) => t.url).join();
}

/**
 * Which track of a looping list should be playing at `serverNow`, and how far into it (`index`
 * is into `tracks`). Tracks whose length isn't known yet (or can't be: broken links) are left
 * out; returns null while no track's length is known.
 */
export function trackAt(tracks: Track[], startedAt: number, serverNow: number): { index: number; offsetMs: number } | null {
  const total = tracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  if (!total) return null;
  let offset = (((serverNow - startedAt) % total) + total) % total;
  for (let i = 0; i < tracks.length; i++) {
    const d = tracks[i].durationMs;
    if (!d) continue;
    if (offset < d) return { index: i, offsetMs: offset };
    offset -= d;
  }
  return null;
}

/**
 * Where a jukebox can be heard: everywhere in the private area it stands in (and nowhere else),
 * or within MUSIC_RADIUS of it when it stands in the open.
 */
export function musicArea(office: Pick<Office, 'zones'>, item: OfficeItem): { zone?: Zone; radius: number } {
  const zone = zoneAt(office.zones, item.x, item.z);
  return zone ? { zone, radius: Infinity } : { radius: MUSIC_RADIUS };
}

/** 0..1 loudness of a jukebox for someone standing at (x, z). */
export function musicVolumeAt(office: Pick<Office, 'zones'>, item: OfficeItem, x: number, z: number): number {
  const { zone, radius } = musicArea(office, item);
  const here = zoneAt(office.zones, x, z);
  if (zone) return here?.id === zone.id ? 1 : 0;
  if (here) return 0; // Private areas keep outside sound out.
  const d = Math.hypot(item.x - x, item.z - z);
  const full = Math.min(3, radius / 2);
  if (d <= full) return 1;
  if (d >= radius) return 0;
  const t = (d - full) / (radius - full);
  return Math.max(0, 1 - t * t);
}

/** The jukebox someone at (x, z) hears loudest (with its volume), if any. */
export function audibleJukebox(office: Office, x: number, z: number): { item: OfficeItem; volume: number } | null {
  let best: { item: OfficeItem; volume: number } | null = null;
  for (const item of office.items) {
    if (!isJukebox(item)) continue;
    const volume = musicVolumeAt(office, item, x, z);
    if (volume > 0 && (!best || volume > best.volume)) best = { item, volume };
  }
  return best;
}

export type MusicOp =
  | { t: 'station'; itemId: string; station: StationChoice | null; stream?: string; tracks?: { url: string; title?: string }[] }
  | { t: 'track:durations'; itemId: string; durations: { url: string; durationMs: number }[] }
  | { t: 'link:add'; itemId: string; url: string }
  | { t: 'link:remove'; itemId: string; linkId: string }
  | { t: 'link:meta'; itemId: string; linkId: string; title?: string; image?: string };

/** A synced "listen along" session: the DJ's Spotify playback that listeners mirror on their own accounts. */
export interface SpotifySession {
  itemId: string;
  dj: string;
  djName: string;
  /** spotify:track:… currently playing for the DJ. */
  uri: string;
  name: string;
  artists: string;
  image?: string;
  durationMs: number;
  /** Playback position at server time `at`. */
  positionMs: number;
  at: number;
  paused: boolean;
}

export type SpotifySessionUpdate = Pick<SpotifySession, 'uri' | 'name' | 'artists' | 'image' | 'durationMs' | 'positionMs' | 'paused'>;

export function sanitizeSessionUpdate(raw: unknown): SpotifySessionUpdate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.uri !== 'string' || !/^spotify:(track|episode):[A-Za-z0-9]{10,40}$/.test(r.uri)) return null;
  const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
  const image = sanitizeStreamUrl(r.image);
  return {
    uri: r.uri,
    name: cleanText(r.name, 120) ?? 'Unknown track',
    artists: cleanText(r.artists, 160) ?? '',
    image: image && /^https:\/\/([a-z0-9-]+\.)*(scdn\.co|spotifycdn\.com)\//.test(image) ? image : undefined,
    durationMs: num(r.durationMs, 6 * 3600_000),
    positionMs: num(r.positionMs, 6 * 3600_000),
    paused: r.paused === true,
  };
}

/** Where the DJ's track should be now, given the server-clock time. */
export function sessionPosition(s: Pick<SpotifySession, 'positionMs' | 'at' | 'paused' | 'durationMs'>, serverNow: number): number {
  const pos = s.paused ? s.positionMs : s.positionMs + Math.max(0, serverNow - s.at);
  return s.durationMs > 0 ? Math.min(pos, s.durationMs) : pos;
}
