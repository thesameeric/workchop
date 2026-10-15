import { shouldLink, zoneAt } from '../shared/geometry';
import type { SpotifySession } from '../shared/music';
import type { PlayerState, Zone } from '../shared/types';

export interface LinkChanges {
  added: { a: string; b: string; sid: number; mediaAllowed?: boolean }[];
  removed: { a: string; b: string }[];
  media?: { a: string; b: string; sid: number; mediaAllowed: boolean }[];
}

/** Preparation never extends audible range, and consumes at most four idle connections per person. */
export const PREPARE_RADIUS = 6;
export const MAX_PREPARED_PEERS = 4;
export const TRANSPORT_REUSE_MS = 8_000;

interface Transport {
  sid: number;
  /** Only a call that just left proximity gets this short grace period. */
  expires?: number;
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

/** Live office conversations and a bounded set of silent, prepared WebRTC transports. */
export class Room {
  readonly players = new Map<string, PlayerState>();
  /** The players (socket ids) who are here as guests, which caps how many there may be. */
  readonly guests = new Set<string>();
  /** Clients that understand media permissions. Old tabs must never receive an idle transport. */
  readonly preparable = new Set<string>();
  /** Authorized conversations only, never idle prepared connections (chat/support rely on this). */
  readonly links = new Map<string, number>();
  /** Spotify listen-along sessions by jukebox id. */
  readonly spotify = new Map<string, SpotifySession>();
  private nextSid = 1;
  private readonly transports = new Map<string, Transport>();
  private expiryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly officeId: string,
    private readonly rules: readonly LinkRule[] = [],
    private readonly onExpiry?: (changes: LinkChanges) => void,
  ) {}

  linkSid(a: string, b: string): number | undefined {
    return this.links.get(pairKey(a, b));
  }

  /** Signaling may prepare an idle connection, but that never authorizes media or nearby chat. */
  transportSid(a: string, b: string): number | undefined {
    return this.transports.get(pairKey(a, b))?.sid;
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    let soonest = Infinity;
    for (const transport of this.transports.values()) {
      if (transport.expires !== undefined) soonest = Math.min(soonest, transport.expires);
    }
    if (soonest === Infinity) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      const changes: LinkChanges = { added: [], removed: [] };
      const now = Date.now();
      for (const [key, transport] of this.transports) {
        if (transport.expires === undefined || transport.expires > now) continue;
        this.transports.delete(key);
        const [a, b] = key.split('|');
        changes.removed.push({ a, b });
      }
      if (changes.removed.length) this.onExpiry?.(changes);
      this.scheduleExpiry();
    }, Math.max(1, soonest - Date.now()));
    this.expiryTimer.unref?.();
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
   * Re-evaluate conversations for the given people (or everybody), checking each pair once.
   * An idle transport negotiates early or briefly waits for re-entry, without conversation access.
   */
  recompute(zones: Zone[], ids?: Iterable<string>): LinkChanges {
    const changes: LinkChanges = { added: [], removed: [] };
    const subjects = ids ? [...ids] : [...this.players.keys()];
    const seen = new Set<string>();
    const rules = this.pairRules();
    // The rules first (any false: no call; else any true: a call), then distance and private areas.
    const decision = (a: PlayerState, b: PlayerState, linked: boolean) => {
      let forced = false;
      for (const rule of rules) {
        const said = rule(a, b);
        if (said === false) return { active: false, mayPrepare: false };
        if (said === true) forced = true;
      }
      return {
        active: forced || shouldLink(a, b, zones, linked),
        // Private-zone and Busy boundaries close immediately, even during a reuse grace period.
        mayPrepare: this.preparable.has(a.id) && this.preparable.has(b.id)
          && !zoneAt(zones, a.x, a.z) && !zoneAt(zones, b.x, b.z) && a.status !== 'busy' && b.status !== 'busy',
      };
    };
    const candidates = new Map<string, { a: string; b: string; distance: number }>();
    const close = (key: string, a: string, b: string) => {
      this.links.delete(key);
      if (this.transports.delete(key)) changes.removed.push({ a, b });
    };
    const permit = (a: string, b: string, sid: number, mediaAllowed: boolean) => {
      (changes.media ??= []).push({ a, b, sid, mediaAllowed });
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
        const { active, mayPrepare } = decision(a, b, linked);
        const transport = this.transports.get(key);
        const distance = Math.hypot(a.x - b.x, a.z - b.z);
        if (active) {
          if (!transport) {
            const sid = this.nextSid++;
            this.transports.set(key, { sid });
            this.links.set(key, sid);
            changes.added.push({ a: a.id, b: b.id, sid });
          } else if (!linked) {
            delete transport.expires;
            this.links.set(key, transport.sid);
            permit(a.id, b.id, transport.sid, true);
          }
        } else if (linked && transport && mayPrepare) {
          this.links.delete(key);
          transport.expires = Date.now() + TRANSPORT_REUSE_MS;
          permit(a.id, b.id, transport.sid, false);
        } else if (!mayPrepare || (transport && transport.expires === undefined && distance >= PREPARE_RADIUS)) {
          close(key, a.id, b.id);
        } else if (!transport && distance < PREPARE_RADIUS) {
          candidates.set(key, { a: a.id, b: b.id, distance });
        }
      }
    }
    // Select closest pairs globally so neither endpoint can exceed its idle-transport budget.
    for (const [key] of this.transports) {
      if (this.links.has(key)) continue;
      const [a, b] = key.split('|');
      const pa = this.players.get(a);
      const pb = this.players.get(b);
      if (pa && pb) candidates.set(key, { a, b, distance: Math.hypot(pa.x - pb.x, pa.z - pb.z) });
    }
    const counts = new Map<string, number>();
    const kept = new Set<string>();
    for (const [key, candidate] of [...candidates].sort((a, b) => a[1].distance - b[1].distance || a[0].localeCompare(b[0]))) {
      const { a, b } = candidate;
      if ((counts.get(a) ?? 0) >= MAX_PREPARED_PEERS || (counts.get(b) ?? 0) >= MAX_PREPARED_PEERS) continue;
      kept.add(key);
      counts.set(a, (counts.get(a) ?? 0) + 1);
      counts.set(b, (counts.get(b) ?? 0) + 1);
      if (this.transports.has(key)) continue;
      const sid = this.nextSid++;
      this.transports.set(key, { sid });
      changes.added.push({ a, b, sid, mediaAllowed: false });
    }
    for (const key of this.transports.keys()) {
      if (this.links.has(key) || kept.has(key)) continue;
      const [a, b] = key.split('|');
      close(key, a, b);
    }
    this.scheduleExpiry();
    return changes;
  }

  /**
   * Starts a stalled transport over with its existing media permission. A stale/expired session
   * cannot renew or authorize itself; idle transports stay outside linkedPeers.
   */
  renew(a: string, b: string, sid: number): LinkChanges['added'][number] | null {
    const key = pairKey(a, b);
    const transport = this.transports.get(key);
    if (!transport || transport.sid !== sid || (transport.expires !== undefined && transport.expires <= Date.now())) return null;
    const next = this.nextSid++;
    transport.sid = next;
    if (this.links.has(key)) {
      this.links.set(key, next);
      return { a, b, sid: next };
    }
    return { a, b, sid: next, mediaAllowed: false };
  }

  removePlayer(id: string): LinkChanges {
    this.players.delete(id);
    this.guests.delete(id);
    this.preparable.delete(id);
    const changes: LinkChanges = { added: [], removed: [] };
    for (const key of this.transports.keys()) {
      const [a, b] = key.split('|');
      if (a !== id && b !== id) continue;
      this.links.delete(key);
      this.transports.delete(key);
      changes.removed.push({ a, b });
    }
    this.scheduleExpiry();
    return changes;
  }
}
