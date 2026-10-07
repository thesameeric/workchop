import {
  getStation,
  isJukebox,
  jukeboxData,
  MAX_LINKS,
  parseSpotifyLink,
  sanitizeStreamUrl,
  sanitizeTracks,
  type JukeboxData,
  type MusicLink,
  type MusicOp,
} from '../shared/music';
import { applyOp, OpError } from '../shared/office';
import type { Office, OfficeItem } from '../shared/types';
import { randomId } from './officeStore';

export interface MusicActor {
  id: string;
  name: string;
  /** Allowed to edit the office (needed for custom stream URLs and removing others' links). */
  canEdit: boolean;
  /** Edits made by the server itself (e.g. link titles). */
  server?: boolean;
}

export type MusicResult = { office: Office; item: OfficeItem; added?: MusicLink } | { error: string };

/** Apply a jukebox change; returns the new office or a message for the person who tried. */
export function applyMusicOp(office: Office, op: MusicOp, actor: MusicActor): MusicResult {
  if (!op || typeof op !== 'object' || typeof op.itemId !== 'string') return { error: 'Unknown jukebox.' };
  const item = office.items.find((i) => i.id === op.itemId);
  if (!isJukebox(item)) return { error: 'That jukebox is gone.' };
  const data = jukeboxData(item);
  let next: JukeboxData;
  let added: MusicLink | undefined;

  switch (op.t) {
    case 'station': {
      const startedAt = Date.now();
      if (op.station === null) {
        next = { ...data, station: null };
      } else if (op.station === 'stream') {
        const changing = op.stream !== undefined;
        if (changing && !actor.canEdit) return { error: 'Only people who can edit this office can change its stream.' };
        const stream = changing ? sanitizeStreamUrl(op.stream) : data.stream;
        if (!stream) return { error: 'Enter an https:// address of a live audio stream.' };
        next = { ...data, station: 'stream', stream, startedAt };
      } else if (op.station === 'tracks') {
        const changing = op.tracks !== undefined;
        if (changing && !actor.canEdit) return { error: 'Only people who can edit this office can change its tracks.' };
        // Keep durations already learned for tracks that stay on the list.
        const known = new Map((data.tracks ?? []).map((t) => [t.url, t.durationMs]));
        const tracks = changing
          ? sanitizeTracks(op.tracks).map((t) => ({ ...t, durationMs: t.durationMs ?? known.get(t.url) }))
          : (data.tracks ?? []);
        if (!tracks.length) return { error: 'Add at least one https:// audio file (MP3, OGG, M4A…).' };
        next = { ...data, station: 'tracks', tracks, startedAt };
      } else if (typeof op.station === 'string' && getStation(op.station)) {
        next = { ...data, station: op.station, startedAt };
      } else {
        return { error: 'Unknown station.' };
      }
      break;
    }
    case 'track:duration': {
      // Any listener can report a duration, but only once per track and only for listed tracks.
      const ms = typeof op.durationMs === 'number' && Number.isFinite(op.durationMs) ? Math.round(op.durationMs) : 0;
      if (ms < 1000 || ms > 6 * 3600_000) return { error: 'Invalid duration.' };
      const track = data.tracks?.find((t) => t.url === op.url);
      if (!track || track.durationMs) return { error: '' };
      next = { ...data, tracks: data.tracks!.map((t) => (t.url === op.url ? { ...t, durationMs: ms } : t)) };
      break;
    }
    case 'link:add': {
      const parsed = typeof op.url === 'string' ? parseSpotifyLink(op.url) : null;
      if (!parsed) return { error: 'Paste a Spotify link to a track, album, playlist, artist, podcast or Jam.' };
      if (data.links.some((l) => l.url === parsed.url)) return { error: 'That link is already on the board.' };
      added = { id: randomId(10), ...parsed, by: actor.name, byId: actor.id, at: Date.now() };
      next = { ...data, links: [added, ...data.links].slice(0, MAX_LINKS) };
      break;
    }
    case 'link:remove': {
      const link = data.links.find((l) => l.id === op.linkId);
      if (!link) return { error: 'That link was already removed.' };
      if (link.byId !== actor.id && !actor.canEdit) return { error: 'Only whoever shared a link (or an editor) can remove it.' };
      next = { ...data, links: data.links.filter((l) => l.id !== op.linkId) };
      break;
    }
    case 'link:meta': {
      if (!actor.server) return { error: 'Not allowed.' };
      next = {
        ...data,
        links: data.links.map((l) => (l.id === op.linkId ? { ...l, title: op.title ?? l.title, image: op.image ?? l.image } : l)),
      };
      break;
    }
    default:
      return { error: 'Unknown change.' };
  }

  try {
    const updated = applyOp(office, { t: 'update', item: { ...item, data: next } });
    return { office: updated, item: updated.items.find((i) => i.id === item.id)!, added };
  } catch (err) {
    return { error: err instanceof OpError ? err.message : 'Could not update the jukebox.' };
  }
}

/** Title and cover art for a shared link, from Spotify's public oEmbed endpoint (best effort). */
export async function fetchLinkMeta(url: string): Promise<{ title?: string; image?: string }> {
  try {
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(4000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return {};
    const body = (await res.json()) as { title?: unknown; thumbnail_url?: unknown };
    return {
      title: typeof body.title === 'string' ? body.title : undefined,
      image: typeof body.thumbnail_url === 'string' ? body.thumbnail_url : undefined,
    };
  } catch {
    return {};
  }
}
