import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AVATAR } from '../shared/avatar';
import type { PlayerState, Zone } from '../shared/types';
import { MAX_PREPARED_PEERS, PREPARE_RADIUS, Room, TRANSPORT_REUSE_MS, type LinkChanges } from '../server/room';

const player = (id: string, x: number, z = 0): PlayerState => ({
  id, name: id, avatar: DEFAULT_AVATAR, x, z, ry: 0, status: 'available', anim: 'idle', mic: true, cam: false, screen: false,
});
const pair = (distance = 5, onExpiry?: (changes: LinkChanges) => void) => {
  const room = new Room('office', [], onExpiry);
  room.players.set('a', player('a', 0));
  room.players.set('b', player('b', distance));
  room.preparable.add('a');
  room.preparable.add('b');
  return room;
};
afterEach(() => vi.useRealTimers());

describe('prepared proximity transports', () => {
  it('negotiates nearby idle transport without authorizing media or nearby chat', () => {
    const room = pair();
    const changes = room.recompute([]);
    expect(changes.added).toEqual([{ a: 'a', b: 'b', sid: 1, mediaAllowed: false }]);
    expect(room.transportSid('a', 'b')).toBe(1);
    expect(room.linkSid('a', 'b')).toBeUndefined();
    expect(room.linkedPeers('a')).toEqual([]);
    expect(room.recompute([])).toEqual({ added: [], removed: [] });
  });

  it('keeps the existing audible hysteresis and reuses prepared transport on entry', () => {
    const room = pair();
    room.recompute([]);
    const sid = room.transportSid('a', 'b');
    room.players.get('b')!.x = 4;
    expect(room.recompute([]).media).toBeUndefined();
    room.players.get('b')!.x = 3.9;
    expect(room.recompute([]).media).toEqual([{ a: 'a', b: 'b', sid, mediaAllowed: true }]);
    expect(room.linkSid('a', 'b')).toBe(sid);
    room.players.get('b')!.x = 4.9;
    expect(room.recompute([]).media).toBeUndefined();
    room.players.get('b')!.x = 5;
    expect(room.recompute([]).media).toEqual([{ a: 'a', b: 'b', sid, mediaAllowed: false }]);
    expect(room.linkedPeers('b')).toEqual([]);
  });

  it('reuses a recent conversation on re-entry, and expires it without another movement', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const room = pair(2, expired);
    room.recompute([]);
    const sid = room.linkSid('a', 'b');
    room.players.get('b')!.x = 10;
    room.recompute([]);
    vi.advanceTimersByTime(TRANSPORT_REUSE_MS - 1);
    expect(room.transportSid('a', 'b')).toBe(sid);
    room.players.get('b')!.x = 2;
    expect(room.recompute([]).media).toEqual([{ a: 'a', b: 'b', sid, mediaAllowed: true }]);
    vi.advanceTimersByTime(TRANSPORT_REUSE_MS);
    expect(expired).not.toHaveBeenCalled();
    room.players.get('b')!.x = 10;
    room.recompute([]);
    vi.advanceTimersByTime(TRANSPORT_REUSE_MS);
    expect(expired).toHaveBeenCalledExactlyOnceWith({ added: [], removed: [{ a: 'a', b: 'b' }] });
    expect(room.transportSid('a', 'b')).toBeUndefined();
    expect(room.renew('a', 'b', sid!)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prepares only the closest four idle peers per participant within six units', () => {
    const room = pair(PREPARE_RADIUS);
    expect(room.recompute([]).added).toEqual([]);
    room.players.delete('b');
    for (let i = 1; i <= 8; i++) {
      room.players.set(`p${i}`, player(`p${i}`, 4 + i / 10));
      room.preparable.add(`p${i}`);
    }
    const changes = room.recompute([]);
    const idle = changes.added.filter((link) => link.mediaAllowed === false);
    const peers = idle.filter((link) => link.a === 'a' || link.b === 'a');
    expect(peers.map((link) => link.b)).toEqual(['p1', 'p2', 'p3', 'p4']);
    for (const id of room.players.keys()) {
      expect(idle.filter((link) => link.a === id || link.b === id).length).toBeLessThanOrEqual(MAX_PREPARED_PEERS);
    }
    room.players.get('p1')!.x = 7;
    const changed = room.recompute([], ['p1']);
    expect(changed.removed).toContainEqual({ a: 'p1', b: 'a' });
  });

  it('never prepares across private-zone boundaries and closes on private/Busy changes immediately', () => {
    const room = pair();
    const zones: Zone[] = [{ id: 'private', name: 'Private', x: 4, z: -1, w: 2, d: 2, color: '#fff' }];
    expect(room.recompute(zones).added).toEqual([]);
    room.recompute([]);
    expect(room.recompute(zones).removed).toEqual([{ a: 'a', b: 'b' }]);
    room.recompute([]);
    room.players.get('b')!.status = 'busy';
    expect(room.recompute([]).removed).toEqual([{ a: 'a', b: 'b' }]);
    expect(room.transportSid('a', 'b')).toBeUndefined();
    expect(room.recompute([]).added).toEqual([]);
  });

  it('closes a recently active transport immediately on access/feature denial', () => {
    let allowed = true;
    const room = new Room('office', [() => () => allowed ? null : false]);
    room.players.set('a', player('a', 0));
    room.players.set('b', player('b', 2));
    room.preparable.add('a');
    room.preparable.add('b');
    room.recompute([]);
    room.players.get('b')!.x = 8;
    room.recompute([]);
    allowed = false;
    expect(room.recompute([]).removed).toEqual([{ a: 'a', b: 'b' }]);
    expect(room.transportSid('a', 'b')).toBeUndefined();
  });

  it('preserves forced support links while false rules prevent even preparation', () => {
    const room = new Room('office', [() => (a, b) => a.customer || b.customer ? false : true]);
    room.players.set('staff', { ...player('staff', 0), status: 'busy' });
    room.players.set('helper', player('helper', 30));
    room.players.set('visitor', { ...player('visitor', 5), customer: true });
    expect(room.recompute([]).added).toEqual([{ a: 'staff', b: 'helper', sid: 1 }]);
    expect(room.linkedPeers('staff')).toEqual(['helper']);
    expect(room.transportSid('staff', 'visitor')).toBeUndefined();
  });

  it('renews active and idle sessions once, rejecting stale session ids', () => {
    const room = pair();
    room.recompute([]);
    expect(room.renew('a', 'b', 1)).toEqual({ a: 'a', b: 'b', sid: 2, mediaAllowed: false });
    expect(room.renew('b', 'a', 1)).toBeNull();
    expect(room.linkedPeers('a')).toEqual([]);
    room.players.get('b')!.x = 2;
    room.recompute([]);
    expect(room.renew('b', 'a', 2)).toEqual({ a: 'b', b: 'a', sid: 3 });
    expect(room.linkSid('a', 'b')).toBe(3);
  });

  it('removes active and idle transports when either participant leaves, without leaking expiry timers', () => {
    vi.useFakeTimers();
    const room = pair(2);
    room.players.set('guest', { ...player('guest', 5), userId: undefined });
    room.preparable.add('guest');
    room.recompute([]);
    room.players.get('b')!.x = 10;
    room.recompute([]);
    expect(room.removePlayer('a').removed).toEqual([{ a: 'a', b: 'b' }, { a: 'a', b: 'guest' }]);
    expect(room.linkedPeers('a')).toEqual([]);
    expect(room.transportSid('a', 'guest')).toBeUndefined();
    room.removePlayer('b');
    room.removePlayer('guest');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps legacy clients safe: no idle preparation or retention without both opt-ins', () => {
    const room = pair(5);
    room.preparable.delete('b');
    expect(room.recompute([]).added).toEqual([]);
    room.players.get('b')!.x = 2;
    const sid = room.recompute([]).added[0].sid;
    expect(room.linkSid('a', 'b')).toBe(sid);
    room.players.get('b')!.x = 5;
    expect(room.recompute([]).removed).toEqual([{ a: 'a', b: 'b' }]);
    expect(room.transportSid('a', 'b')).toBeUndefined();
  });
});
