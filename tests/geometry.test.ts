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
import { getEntry, seatsOf } from '../shared/catalog';
import { createFromTemplate } from '../shared/templates';
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

  /** Every leg of the path is walkable and it ends on the goal. */
  function expectWalkable(start: { x: number; z: number }, goal: { x: number; z: number }, colliders: ReturnType<typeof buildColliders>, b = bounds) {
    const path = findPath(start, goal, colliders, b);
    expect(path, `from (${start.x}, ${start.z})`).not.toBeNull();
    let prev = start;
    for (const p of path!) {
      for (let t = 0; t <= 1; t += 0.05) {
        expect(isBlocked(prev.x + (p.x - prev.x) * t, prev.z + (p.z - prev.z) * t, colliders, b)).toBe(false);
      }
      prev = p;
    }
    expect(prev).toEqual(goal);
  }

  it('sets off from a gap too tight for the grid (between the lounge sofa and coffee table)', () => {
    const office = createFromTemplate('startup', 'o', 'Office');
    const colliders = buildColliders(office);
    const goal = office.settings.spawn;
    // Where "Go to" and standing up from the sofa put people.
    for (const start of [{ x: 5.807, z: 17.154 }, { x: 5, z: 17 }, { x: 5.5, z: 15 }]) {
      expect(isBlocked(start.x, start.z, colliders, office.settings)).toBe(false);
      expectWalkable(start, goal, colliders, office.settings);
      expectWalkable(start, { x: 15, z: 11 }, colliders, office.settings);
    }
    // A goal next to you in the same tight gap.
    expectWalkable({ x: 5.807, z: 17.154 }, { x: 5.9, z: 17.1 }, colliders, office.settings);
  });

  it('gets out of, and into, a tight gap whose nearest open cell leads nowhere', () => {
    const b = { width: 6, depth: 6 };
    // A desk end and a cabinet against the wall: your own cell is too close to the desk, the nearest
    // open one (in the corner between both) has no way on, the one the other way does.
    const colliders = [
      { minX: 1, maxX: 3, minZ: 2, maxZ: 2.5 },
      { minX: 0, maxX: 0.5, minZ: 3, maxZ: 5 },
    ];
    const gap = { x: 0.58, z: 2.44 };
    expect(isBlocked(gap.x, gap.z, colliders, b)).toBe(false);
    expect(isBlocked(0.75, 2.25, colliders, b)).toBe(true);
    expectWalkable(gap, { x: 2, z: 1 }, colliders, b);
    expectWalkable({ x: 2, z: 1 }, gap, colliders, b);
  });

  it('walks straight along a passage too narrow for the grid', () => {
    const b = { width: 6, depth: 6 };
    // 0.6 wide: room to walk, but no cell's middle is clear.
    const colliders = [
      { minX: 0.5, maxX: 5.5, minZ: 0, maxZ: 1 },
      { minX: 0.5, maxX: 5.5, minZ: 1.6, maxZ: 6 },
    ];
    expect(findPath({ x: 2, z: 1.3 }, { x: 4, z: 1.3 }, colliders, b)).toEqual([{ x: 4, z: 1.3 }]);
  });

  it('gets you to every seat of the startup office and back to the entrance', () => {
    const office = createFromTemplate('startup', 'o', 'Office');
    const colliders = buildColliders(office);
    for (const item of office.items) {
      for (const seat of seatsOf(item)) {
        // Close enough to sit down on arrival (SIT_RANGE in movement.ts).
        const there = findPath(office.settings.spawn, seat, colliders, office.settings);
        expect(there, `to ${item.type} ${item.id}`).not.toBeNull();
        const last = there![there!.length - 1];
        expect(Math.hypot(last.x - seat.x, last.z - seat.z)).toBeLessThan(1.3);
        // Where standing up puts you (movement.ts standUp).
        const spot = getEntry(item.type)?.solid
          ? findFreeSpot(seat.x + Math.sin(seat.ry) * 0.8, seat.z + Math.cos(seat.ry) * 0.8, colliders, office.settings)
          : isBlocked(seat.x, seat.z, colliders, office.settings) ? findFreeSpot(seat.x, seat.z, colliders, office.settings) : seat;
        expectWalkable({ x: spot.x, z: spot.z }, office.settings.spawn, colliders, office.settings);
      }
    }
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
