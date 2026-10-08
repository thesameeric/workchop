import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Fx } from './sky';

// Soft cloud shadows drifting over the floor and the ground: a tiling noise texture on a dark, see-through
// plane just above them, scrolled with the wind.

const SIZE = 128;
/** Metres of ground per texture tile. */
const TILE = 40;

/** Tiling value noise in four octaves, roughly 0–1. */
function cloudNoise(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (const [cells, weight] of [
    [4, 0.5],
    [8, 0.27],
    [16, 0.15],
    [32, 0.08],
  ] as const) {
    const grid = Float32Array.from({ length: cells * cells }, Math.random);
    const step = SIZE / cells;
    for (let y = 0; y < SIZE; y++) {
      const gy = y / step;
      const y0 = Math.floor(gy);
      const y1 = (y0 + 1) % cells;
      const ty = smooth(gy - y0);
      for (let x = 0; x < SIZE; x++) {
        const gx = x / step;
        const x0 = Math.floor(gx);
        const x1 = (x0 + 1) % cells;
        const tx = smooth(gx - x0);
        const top = grid[y0 * cells + x0] + (grid[y0 * cells + x1] - grid[y0 * cells + x0]) * tx;
        const bottom = grid[y1 * cells + x0] + (grid[y1 * cells + x1] - grid[y1 * cells + x0]) * tx;
        out[y * SIZE + x] += weight * (top + (bottom - top) * ty);
      }
    }
  }
  return out;
}

/** Shades `cover` (0–1) of the texture, with soft edges. */
function paint(data: Uint8Array, noise: Float32Array, sorted: Float32Array, cover: number): void {
  const edge = sorted[Math.min(sorted.length - 1, Math.floor((1 - cover) * sorted.length))];
  for (let i = 0; i < noise.length; i++) {
    data[i * 4 + 3] = 255 * THREE.MathUtils.smoothstep(noise[i], edge - 0.05, edge + 0.05);
  }
}

export function CloudShadows({ fx, width, depth, still }: { fx: Fx; width: number; depth: number; still: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const cover = useRef(-1);
  const { texture, data, noise, sorted } = useMemo(() => {
    const noise = cloudNoise();
    const sorted = noise.slice().sort();
    // White, with the shadow in the alpha channel.
    const data = new Uint8Array(SIZE * SIZE * 4).fill(255);
    const texture = new THREE.DataTexture(data, SIZE, SIZE);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    return { texture, data, noise, sorted };
  }, []);
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#1d2333', map: texture, transparent: true, depthWrite: false, opacity: 0 }),
    [texture],
  );

  useEffect(
    () => () => {
      texture.dispose();
      material.dispose();
    },
    [texture, material],
  );
  useEffect(() => void texture.repeat.set((width + 60) / TILE, (depth + 60) / TILE), [texture, width, depth]);

  useFrame((_, dt) => {
    const look = fx.current;
    if (Math.abs(look.cloudCover - cover.current) > 0.01) {
      cover.current = look.cloudCover;
      paint(data, noise, sorted, cover.current);
      texture.needsUpdate = true;
    }
    material.opacity = look.cloudShadow;
    if (mesh.current) mesh.current.visible = look.cloudShadow > 0.005;
    if (still) return;
    // They drift with the wind, slowed down, and a little even when it's calm.
    const wind = Math.hypot(look.windX, look.windZ);
    const speed = Math.min(0.25 + 0.25 * wind, 3) * Math.min(dt, 0.1);
    const x = wind > 0.01 ? look.windX / wind : 1;
    const z = wind > 0.01 ? look.windZ / wind : 0;
    // The texture's u runs east (+x), its v north (-z).
    texture.offset.set((texture.offset.x - (x * speed) / TILE) % 1, (texture.offset.y + (z * speed) / TILE) % 1);
  });

  return (
    <mesh ref={mesh} material={material} rotation={[-Math.PI / 2, 0, 0]} position={[width / 2, 0.03, depth / 2]} renderOrder={-1}>
      <planeGeometry args={[width + 60, depth + 60]} />
    </mesh>
  );
}
