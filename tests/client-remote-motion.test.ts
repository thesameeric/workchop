import { describe, expect, it } from 'vitest';
import { remoteTargets, setRemoteTarget, type RemoteTarget } from '../client/src/lib/positions';
import { STALE_WALK_MS, stepRemote, type Drawn } from '../client/src/world/remoteMotion';

// How other people are drawn from what the network says: smoothed while walking, never walking on
// the spot once the steps stop coming, and sitting down and getting up as jumps (as they are for
// the one doing it).

const target = (t: Partial<RemoteTarget>): RemoteTarget => ({ x: 0, z: 0, ry: 0, anim: 'idle', at: 0, ...t });

/** Runs `frames` frames of 1/60 s; returns the last one. */
function run(drawn: Drawn | null, t: RemoteTarget, frames: number, start: number) {
  let step = stepRemote(drawn, t, 1 / 60, start);
  for (let i = 1; i < frames; i++) step = stepRemote(step.drawn, t, 1 / 60, start + (i * 1000) / 60);
  return step;
}

describe('remote characters', () => {
  it('walk while steps keep coming, and stand once they stop (a lost last step, a tab in the background)', () => {
    const drawn: Drawn = { x: 0, z: 0, ry: 0, anim: 'idle' };
    const t = target({ x: 0.3, z: 0, anim: 'walk', at: 1000 });
    const fresh = stepRemote(drawn, t, 1 / 60, 1050);
    expect(fresh.anim).toBe('walk');
    expect(fresh.speed).toBeGreaterThanOrEqual(3);
    // Still "walk", but nothing new for a while: drawn where they are, standing.
    const later = run(fresh.drawn, t, 60, 1000 + STALE_WALK_MS);
    expect(later.anim).toBe('idle');
    expect(later.speed).toBeLessThan(0.4);
    expect(later.drawn.x).toBeCloseTo(0.3, 2);
  });

  it('sit down in the seat, facing its way, at once (no sliding through the desk)', () => {
    const drawn: Drawn = { x: 23.1, z: 5.4, ry: -3, anim: 'walk' };
    const step = stepRemote(drawn, target({ x: 23, z: 4, ry: Math.PI, anim: 'sit', at: 10 }), 1 / 60, 20);
    expect(step).toMatchObject({ anim: 'sit', speed: 0, drawn: { x: 23, z: 4, ry: Math.PI, anim: 'sit' } });
  });

  it('get up where they stand up, then walk on smoothly', () => {
    const seated: Drawn = { x: 23, z: 4, ry: Math.PI, anim: 'sit' };
    const up = stepRemote(seated, target({ x: 23, z: 4.8, ry: Math.PI, anim: 'idle', at: 10 }), 1 / 60, 20);
    expect(up).toMatchObject({ anim: 'idle', drawn: { x: 23, z: 4.8, anim: 'idle' } });
    const walking = stepRemote(up.drawn, target({ x: 23, z: 5.1, ry: 0, anim: 'walk', at: 30 }), 1 / 60, 40);
    expect(walking.anim).toBe('walk');
    expect(walking.drawn.z).toBeGreaterThan(4.8);
    expect(walking.drawn.z).toBeLessThan(5.1);
  });

  it('jump when they teleported far away, and appear where they are on the first frame', () => {
    const first = stepRemote(null, target({ x: 5, z: 6, ry: 1, anim: 'walk', at: 0 }), 1 / 60, 0);
    expect(first.drawn).toMatchObject({ x: 5, z: 6, ry: 1 });
    const far = stepRemote(first.drawn, target({ x: 15, z: 6, ry: 1, anim: 'idle', at: 5 }), 1 / 60, 10);
    expect(far.drawn).toMatchObject({ x: 15, z: 6 });
  });
});

describe('where remote people are', () => {
  it('counts a move as news only when something changed, so a repeat (a keyframe) of walking still goes stale', () => {
    remoteTargets.clear();
    setRemoteTarget('p', 1, 2, 0, 'walk', 100);
    setRemoteTarget('p', 1, 2, 0, 'walk', 900);
    expect(remoteTargets.get('p')).toEqual({ x: 1, z: 2, ry: 0, anim: 'walk', at: 100 });
    setRemoteTarget('p', 1, 2, 0, 'sit', 1000);
    expect(remoteTargets.get('p')).toEqual({ x: 1, z: 2, ry: 0, anim: 'sit', at: 1000 });
    remoteTargets.clear();
  });
});
