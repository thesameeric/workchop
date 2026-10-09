import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { easeLook, fogRange, lookFrom, newFx } from '../client/src/features/weather/scene/sky';
import { defaultSceneLighting } from '../client/src/world/lighting';

// How the weather scene eases in and keeps the office visible.

describe('the weather scene', () => {
  const themeSky = new THREE.Color('#d7deea');

  it('starts from the scene as it is, so the first look eases in', () => {
    const { current, target } = newFx();
    const daytime = defaultSceneLighting();
    lookFrom(current, daytime, themeSky);
    expect(current.sky.equals(themeSky)).toBe(true);
    expect(current.sunDir.equals(daytime.sunDir)).toBe(true);
    expect(current.sunIntensity).toBe(daytime.sunIntensity);
    expect(current.hemiIntensity).toBe(daytime.hemiIntensity);
    expect(current.clearAir).toBe(1);
    expect(current.windX).toBe(0);
    // A night look: one frame moves only part of the way.
    target.sunIntensity = 0.3;
    target.sky.set('#10152a');
    easeLook(current, target, 0.1);
    expect(current.sunIntensity).toBeCloseTo(1.6 - 0.13);
    expect(current.sky.equals(themeSky)).toBe(false);
    expect(current.sky.equals(target.sky)).toBe(false);
  });

  it('eases cloud cover instead of jumping', () => {
    const { current, target } = newFx();
    current.cloudCover = 0.3;
    target.cloudCover = 0.6;
    easeLook(current, target, 0.25);
    expect(current.cloudCover).toBeCloseTo(0.375);
    easeLook(current, target, 1);
    expect(current.cloudCover).toBe(0.6);
  });

  it('has no wind by default', () => {
    const l = defaultSceneLighting();
    expect(l.windX).toBe(0);
    expect(l.windZ).toBe(0);
  });

  describe('fog', () => {
    const fog = (clearAir: number, distance: number, farthest: number) => {
      const out = { fogNear: 0, fogFar: 0 };
      fogRange(out, clearAir, distance, farthest);
      return out;
    };
    const fogged = ({ fogNear, fogFar }: { fogNear: number; fogFar: number }, depth: number) => THREE.MathUtils.smoothstep(depth, fogNear, fogFar);

    it('is the usual far-away fog in clear air', () => {
      const daytime = defaultSceneLighting();
      expect(fog(1, 12, 25)).toEqual({ fogNear: daytime.fogNear, fogFar: daytime.fogFar });
      expect(fog(1, 70, 140)).toEqual({ fogNear: daytime.fogNear, fogFar: daytime.fogFar });
    });

    it('starts thick fog just in front of you in a small office', () => {
      // The default office, from the default camera: as thick as the report says.
      expect(fog(0, 12.4, 22)).toEqual({ fogNear: 12.4 - 3, fogFar: 12.4 + 22 });
      expect(fogged(fog(0, 12.4, 22), 12.4)).toBeLessThan(0.05);
    });

    it('never hides most of a big office', () => {
      // At one end of an 80 m office, zoomed out: the far corner stays partly visible, the middle mostly.
      for (const [distance, farthest] of [
        [12.4, 95],
        [30, 115],
        [70, 150],
      ]) {
        const f = fog(0, distance, farthest);
        expect(fogged(f, farthest)).toBeLessThan(0.7);
        expect(fogged(f, (distance + farthest) / 2)).toBeLessThan(0.4);
      }
    });
  });
});
