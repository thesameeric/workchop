import { describe, expect, it } from 'vitest';
import {
  CONNECT_RADIUS,
  DISCONNECT_RADIUS,
  buildColliders,
  findFreeSpot,
  findPath,
  isBlocked,
  moveWithCollision,
  proximityVolume,
  shouldLink,
  zoneAt,
} from '../shared/geometry';
import type { OfficeItem, Zone } from '../shared/types';

const bounds = { width: 20, depth: 20 };
const desk: OfficeItem = { id: 'd', type: 'desk', x: 10, z: 10, rot: 0 };

describe('collision', () => {
  const colliders = buildColliders({ items: [desk, { id: 'r', type: 'rug', x: 4, z: 4, rot: 0 }] });

  it('only solid items collide', () => {
    expect(colliders).toHaveLength(1);
    expect(isBlocked(10, 10, colliders, bounds)).toBe(true);
    expect(isBlocked(4, 4, colliders, bounds)).toBe(false);
  });

  it('treats the floor edge as a wall', () => {
    expect(isBlocked(0.1, 5, colliders, bounds)).toBe(true);
    expect(isBlocked(5, 19.95, colliders, bounds)).toBe(true);
  });

  it('rotated items swap their footprint', () => {
    const rotated = buildColliders({ items: [{ ...desk, rot: 1 }] });
    expect(rotated[0].maxX - rotated[0].minX).toBeCloseTo(1);
    expect(rotated[0].maxZ - rotated[0].minZ).toBeCloseTo(2);
  });

  it('slides along obstacles instead of stopping dead', () => {
    // Walking diagonally into the desk's top edge keeps the sideways motion.
    const start = { x: 10, z: 8.9 };
    const end = moveWithCollision(start.x, start.z, 0.5, 0.5, colliders, bounds);
    expect(end.x).toBeCloseTo(10.5);
    expect(end.z).toBeLessThan(9.5 - 0.27);
  });

  it('finds a free spot next to a blocked one', () => {
    const spot = findFreeSpot(10, 10, colliders, bounds);
    expect(isBlocked(spot.x, spot.z, colliders, bounds)).toBe(false);
    expect(Math.hypot(spot.x - 10, spot.z - 10)).toBeLessThan(1.5);
  });
});

describe('pathfinding', () => {
  it('walks around a wall of desks', () => {
    const items: OfficeItem[] = [2, 4, 6, 8, 10, 12, 14].map((x, i) => ({ id: `d${i}`, type: 'desk', x, z: 10, rot: 0 }));
    const colliders = buildColliders({ items });
    const path = findPath({ x: 5, z: 5 }, { x: 5, z: 15 }, colliders, bounds);
    expect(path).not.toBeNull();
    let prev = { x: 5, z: 5 };
    for (const p of path!) {
      // Every leg of the path is walkable.
      for (let t = 0; t <= 1; t += 0.05) {
        expect(isBlocked(prev.x + (p.x - prev.x) * t, prev.z + (p.z - prev.z) * t, colliders, bounds)).toBe(false);
      }
      prev = p;
    }
    expect(prev).toEqual({ x: 5, z: 15 });
  });

  it('returns null when the goal is sealed off', () => {
    const items: OfficeItem[] = [];
    for (let x = 1; x < 20; x += 2) items.push({ id: `w${x}`, type: 'wall', x, z: 10, rot: 0 });
    const path = findPath({ x: 5, z: 5 }, { x: 5, z: 15 }, buildColliders({ items }), bounds);
    expect(path).toBeNull();
  });
});

describe('proximity', () => {
  const zones: Zone[] = [{ id: 'z', name: 'Room', x: 0, z: 0, w: 5, d: 5, color: '#ffffff' }];
  const at = (x: number, z: number, status: 'available' | 'busy' | 'away' = 'available') => ({ x, z, status });

  it('connects nearby people and keeps them connected a little further (hysteresis)', () => {
    expect(shouldLink(at(10, 10), at(10 + CONNECT_RADIUS - 0.1, 10), zones, false)).toBe(true);
    expect(shouldLink(at(10, 10), at(10 + CONNECT_RADIUS + 0.1, 10), zones, false)).toBe(false);
    expect(shouldLink(at(10, 10), at(10 + CONNECT_RADIUS + 0.5, 10), zones, true)).toBe(true);
    expect(shouldLink(at(10, 10), at(10 + DISCONNECT_RADIUS + 0.1, 10), zones, true)).toBe(false);
  });

  it('private zones isolate conversations', () => {
    expect(zoneAt(zones, 1, 1)?.id).toBe('z');
    // Both inside: connected even far apart.
    expect(shouldLink(at(0.5, 0.5), at(4.5, 4.5), zones, false)).toBe(true);
    // One inside, one just outside: not connected, even though they're close.
    expect(shouldLink(at(4.5, 4.5), at(5.5, 4.5), zones, false)).toBe(false);
    expect(proximityVolume(at(4.5, 4.5), at(5.5, 4.5), zones)).toBe(0);
  });

  it('busy people only connect inside private zones', () => {
    expect(shouldLink(at(10, 10, 'busy'), at(11, 10), zones, false)).toBe(false);
    expect(shouldLink(at(1, 1, 'busy'), at(2, 2), zones, false)).toBe(true);
  });

  it('volume fades with distance', () => {
    expect(proximityVolume(at(10, 10), at(11, 10), zones)).toBe(1);
    const mid = proximityVolume(at(10, 10), at(13, 10), zones);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(proximityVolume(at(10, 10), at(10 + DISCONNECT_RADIUS, 10), zones)).toBe(0);
  });
});
