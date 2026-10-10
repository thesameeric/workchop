import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Office } from '../shared/types';

// Sitting down and getting up are sent the moment they happen, whatever caused them (a click, E,
// arriving at a chair, a support customer called to a desk), not with the next frame: a tab in the
// background draws none, and others would keep seeing them where they were.

const fake = vi.hoisted(() => ({
  sendMove: vi.fn(),
  nearest: null as unknown,
}));

vi.mock('../client/src/lib/session', () => ({ getSession: () => ({ sendMove: fake.sendMove }) }));
vi.mock('../client/src/features/audio/focus', () => ({ focusHint: () => null }));
vi.mock('../client/src/world/extensions', () => ({ getItemInteraction: () => undefined, nearbyActionFinders: () => [] }));
vi.mock('../client/src/world/input', () => ({ axis: () => ({ x: 0, y: 0, run: false }) }));
vi.mock('../client/src/world/officeCache', () => ({
  officeData: () => ({ colliders: [] }),
  nearestSeat: () => fake.nearest,
}));

const office: Office = {
  id: 'o1',
  settings: { name: 'HQ', width: 30, depth: 30, floor: 'wood', floorColor: '#000', wallColor: '#000', spawn: { x: 5, z: 5 }, buildPolicy: 'members' },
  items: [
    { id: 'chair1', type: 'chair', x: 15, z: 11, rot: 0 },
    { id: 'desk1', type: 'support-desk', x: 20, z: 20, rot: 0 },
  ],
  zones: [],
  createdAt: 0,
  updatedAt: 0,
} as unknown as Office;

vi.mock('../client/src/state/store', () => ({
  getState: () => ({ office, toasts: [], hint: null }),
  setState: () => {},
  toast: () => {},
}));

const { local } = await import('../client/src/lib/positions');
const { interact, sitOn, standUp, stepLocal, walkTo } = await import('../client/src/world/movement');

const camera = { matrixWorld: { elements: new Array(16).fill(0) } } as never;

beforeEach(() => {
  fake.sendMove.mockClear();
  fake.nearest = null;
  Object.assign(local, { x: 10, z: 10, ry: 0, anim: 'idle', seat: null, path: null, pathSeat: null });
});

describe('sitting down and getting up', () => {
  it('are sent at once, without waiting for a frame', () => {
    sitOn({ x: 21, z: 21, ry: Math.PI, itemId: 'desk1' });
    expect(fake.sendMove).toHaveBeenCalledExactlyOnceWith(21, 21, Math.PI, 'sit');
    standUp();
    // Up in front of the desk's seat (it's solid), standing.
    expect(fake.sendMove).toHaveBeenLastCalledWith(local.x, local.z, Math.PI, 'idle');
    expect(Math.hypot(local.x - 21, local.z - 21)).toBeGreaterThan(0.5);
  });

  it('with E', () => {
    fake.nearest = { x: 15, z: 11, ry: 0, itemId: 'chair1', type: 'chair' };
    Object.assign(local, { x: 15.5, z: 11 });
    interact();
    expect(fake.sendMove).toHaveBeenLastCalledWith(15, 11, 0, 'sit');
    interact();
    expect(fake.sendMove).toHaveBeenLastCalledWith(local.x, local.z, 0, 'idle');
  });

  it('on arriving at a chair walked to, in that same frame', () => {
    walkTo(15, 11, { x: 15, z: 11, ry: 0, itemId: 'chair1' });
    expect(local.path?.length).toBeGreaterThan(0);
    let frames = 0;
    while (local.anim !== 'sit' && frames++ < 600) stepLocal(1 / 60, camera);
    expect(local.anim).toBe('sit');
    expect(fake.sendMove).toHaveBeenLastCalledWith(15, 11, 0, 'sit');
  });
});
