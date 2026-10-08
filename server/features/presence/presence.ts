import { HEADS_DOWN, HELPER_TTL_MS, MANUAL_MAX_MS, OTHER_APP, type AppPlatform } from '../../../shared/apps';
import type { ManualApp, PresenceState, PresenceUpdate } from '../../../shared/presence';
import type { PlayerState } from '../../../shared/types';

/** One desktop helper's latest report. */
interface HelperReport {
  app: string | null;
  platform: AppPlatform;
  unsupported: boolean;
  /** Counts until then without another report. */
  until: number;
  /** When its app last changed: of several computers, the one in use wins. */
  changedAt: number;
}

/** What we know about one person (a signed-in user, or a guest's single connection). */
export interface PresenceEntry {
  manual: ManualApp | null;
  /** By helper token id. */
  helpers: Map<string, HelperReport>;
  share: boolean;
  others: boolean;
  /** Last change, for forgetting people who don't come back. */
  touched: number;
}

/** Forget a person's hand-picked status this long after their last change, when they're not around. */
const FORGET_MS = 24 * 60 * 60 * 1000;

/**
 * App presence, kept in memory only (never stored): hand-picked statuses and desktop helper
 * reports, which expire after HELPER_TTL_MS without a heartbeat.
 */
export class PresenceMap {
  private readonly entries = new Map<string, PresenceEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): PresenceEntry | undefined {
    return this.entries.get(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }

  private ensure(key: string): PresenceEntry {
    let e = this.entries.get(key);
    if (!e) {
      // The helper's app stays hidden until the person's client says sharing is on.
      e = { manual: null, helpers: new Map(), share: false, others: true, touched: this.now() };
      this.entries.set(key, e);
    }
    e.touched = this.now();
    return e;
  }

  /** Applies a (sanitized) update from the person's own client. */
  update(key: string, u: PresenceUpdate): void {
    const e = this.ensure(key);
    if (u.manual !== undefined) {
      const now = this.now();
      const until = u.manual?.until == null ? null : Math.min(u.manual.until, now + MANUAL_MAX_MS);
      e.manual = u.manual && (until === null || until > now) ? { app: u.manual.app, until } : null;
    }
    if (u.share !== undefined) e.share = u.share;
    if (u.others !== undefined) e.others = u.others;
  }

  /** A desktop helper reported (its app is already sanitized). */
  report(key: string, tokenId: string, r: { app: string | null; platform: AppPlatform; unsupported: boolean }): void {
    const e = this.ensure(key);
    const now = this.now();
    const prev = e.helpers.get(tokenId);
    const changedAt = prev && prev.until > now && prev.app === r.app ? prev.changedAt : now;
    e.helpers.set(tokenId, { ...r, until: now + HELPER_TTL_MS, changedAt });
  }

  /** A helper was unpaired: forget what it said. Returns whether it had said anything. */
  dropHelper(key: string, tokenId: string): boolean {
    return !!this.entries.get(key)?.helpers.delete(tokenId);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** The helper report that counts now: the computer whose app changed last. */
  helper(e: PresenceEntry): HelperReport | null {
    const now = this.now();
    let best: HelperReport | null = null;
    for (const r of e.helpers.values()) {
      if (r.until <= now) continue;
      // One that knows an app beats one that's locked or can't tell.
      const rank = (x: HelperReport) => (x.app ? 1 : 0);
      if (!best || rank(r) > rank(best) || (rank(r) === rank(best) && r.changedAt > best.changedAt)) best = r;
    }
    return best;
  }

  /** What others see for this player: a hand-picked status wins; away hides everything. */
  effective(e: PresenceEntry | undefined, player: Pick<PlayerState, 'status' | 'focus'>): string | null {
    if (!e || player.status === 'away') return null;
    const now = this.now();
    if (e.manual && (e.manual.until === null || e.manual.until > now)) return e.manual.app;
    // Do not disturb and headphones focus keep what you're doing to yourself.
    if (!e.share || player.status === 'busy' || player.focus) return null;
    const app = this.helper(e)?.app ?? null;
    if (app === HEADS_DOWN || (app === OTHER_APP && !e.others)) return null;
    return app;
  }

  state(e: PresenceEntry | undefined, player: Pick<PlayerState, 'status' | 'focus'>): PresenceState {
    const h = e ? this.helper(e) : null;
    const now = this.now();
    const manual = e?.manual && (e.manual.until === null || e.manual.until > now) ? e.manual : null;
    return {
      app: this.effective(e, player),
      manual,
      helper: h ? { app: h.app, platform: h.platform, unsupported: h.unsupported } : null,
    };
  }

  /**
   * Drops what has expired. Returns the keys whose presence may have changed, and forgets people
   * with nothing left (or nobody around for a day: `isAround` says whether they're online).
   */
  sweep(isAround: (key: string) => boolean): string[] {
    const now = this.now();
    const changed: string[] = [];
    for (const [key, e] of this.entries) {
      let dirty = false;
      if (e.manual && e.manual.until !== null && e.manual.until <= now) {
        e.manual = null;
        dirty = true;
      }
      for (const [id, r] of e.helpers) {
        if (r.until <= now) {
          e.helpers.delete(id);
          dirty = true;
        }
      }
      if (dirty) changed.push(key);
      const around = isAround(key);
      if (!around && ((!e.manual && !e.helpers.size) || now - e.touched > FORGET_MS)) this.entries.delete(key);
    }
    return changed;
  }
}
