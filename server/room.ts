import { shouldLink } from '../shared/geometry';
import type { SpotifySession } from '../shared/music';
import type { PlayerState, Zone } from '../shared/types';

export interface LinkChanges {
  added: { a: string; b: string; sid: number }[];
  removed: { a: string; b: string }[];
}

/** For two people: false keeps them apart, true links them wherever they are, null leaves it to the usual rules. */
export type PairRule = (a: PlayerState, b: PlayerState) => boolean | null;

/**
 * A feature's say in who is in a call with whom, asked once per check of an office's calls: the
 * rule for its pairs (look up what it needs once, here), or null for no say in that office.
 */
export type LinkRule = (officeId: string) => PairRule | null;

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Live state for one office: who is in it and which pairs have an open call. */
export class Room {
  readonly players = new Map<string, PlayerState>();
  /** The players (socket ids) who are here as guests, which caps how many there may be. */
  readonly guests = new Set<string>();
  /** Pair key -> session id of that pair's current WebRTC connection. */
  readonly links = new Map<string, number>();
  /** Spotify listen-along sessions by jukebox id. */
  readonly spotify = new Map<string, SpotifySession>();
  private nextSid = 1;

  constructor(
    readonly officeId: string,
    private readonly rules: readonly LinkRule[] = [],
  ) {}

  linkSid(a: string, b: string): number | undefined {
    return this.links.get(pairKey(a, b));
  }

  linkedPeers(id: string): string[] {
    const out: string[] = [];
    for (const key of this.links.keys()) {
      const [a, b] = key.split('|');
      if (a === id) out.push(b);
      else if (b === id) out.push(a);
    }
    return out;
  }

  /** The rules' say about each pair, for one check. A rule that fails is logged and has no say. */
  private pairRules(): PairRule[] {
    const out: PairRule[] = [];
    const failed = (err: unknown) => console.error('[realtime] a link rule failed:', err);
    for (const rule of this.rules) {
      try {
        const pair = rule(this.officeId);
        if (!pair) continue;
        out.push((a, b) => {
          try {
            return pair(a, b);
          } catch (err) {
            failed(err);
            return null;
          }
        });
      } catch (err) {
        failed(err);
      }
    }
    return out;
  }

  /**
   * Re-evaluate links for the given people (or everybody). Each pair is only
   * checked once, and the result says which calls to start or end.
   */
  recompute(zones: Zone[], ids?: Iterable<string>): LinkChanges {
    const changes: LinkChanges = { added: [], removed: [] };
    const subjects = ids ? [...ids] : [...this.players.keys()];
    const seen = new Set<string>();
    const rules = this.pairRules();
    // The rules first (any false: no call; else any true: a call), then distance and private areas.
    const wants = (a: PlayerState, b: PlayerState, linked: boolean) => {
      let forced = false;
      for (const rule of rules) {
        const said = rule(a, b);
        if (said === false) return false;
        if (said === true) forced = true;
      }
      return forced || shouldLink(a, b, zones, linked);
    };
    for (const id of subjects) {
      const a = this.players.get(id);
      if (!a) continue;
      for (const b of this.players.values()) {
        if (b.id === a.id) continue;
        const key = pairKey(a.id, b.id);
        if (seen.has(key)) continue;
        seen.add(key);
        const linked = this.links.has(key);
        const want = wants(a, b, linked);
        if (want && !linked) {
          const sid = this.nextSid++;
          this.links.set(key, sid);
          changes.added.push({ a: a.id, b: b.id, sid });
        } else if (!want && linked) {
          this.links.delete(key);
          changes.removed.push({ a: a.id, b: b.id });
        }
      }
    }
    return changes;
  }

  removePlayer(id: string): LinkChanges {
    this.players.delete(id);
    this.guests.delete(id);
    const changes: LinkChanges = { added: [], removed: [] };
    for (const peer of this.linkedPeers(id)) {
      this.links.delete(pairKey(id, peer));
      changes.removed.push({ a: id, b: peer });
    }
    return changes;
  }
}
