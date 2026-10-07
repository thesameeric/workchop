import * as THREE from 'three';
import type { FloorStyle } from '../../../shared/types';
import { shade } from '../lib/color';

const cache = new Map<string, THREE.CanvasTexture>();

/** Small deterministic PRNG so textures look the same on every client. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** Procedural floor texture covering 2x2 world units. */
export function floorTexture(style: FloorStyle, color: string): THREE.CanvasTexture {
  const key = `${style}:${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const rand = rng(42);
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);

  if (style === 'wood') {
    const rows = 8;
    const h = size / rows;
    for (let r = 0; r < rows; r++) {
      const offset = rand() * size;
      for (let x = -offset; x < size; x += size * 0.75) {
        g.fillStyle = shade(color, (rand() - 0.5) * 0.18);
        g.fillRect(x, r * h, size * 0.75, h);
        // Grain lines.
        g.strokeStyle = shade(color, -0.12);
        g.globalAlpha = 0.25;
        for (let i = 0; i < 3; i++) {
          const y = r * h + 3 + rand() * (h - 6);
          g.beginPath();
          g.moveTo(x, y);
          g.bezierCurveTo(x + 60, y + (rand() - 0.5) * 4, x + 120, y + (rand() - 0.5) * 4, x + size * 0.75, y);
          g.stroke();
        }
        g.globalAlpha = 1;
        g.fillStyle = shade(color, -0.35);
        g.fillRect(x, r * h, 1.5, h);
      }
      g.fillStyle = shade(color, -0.35);
      g.fillRect(0, r * h, size, 1.5);
    }
  } else if (style === 'tile') {
    const n = 2;
    const s = size / n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        g.fillStyle = shade(color, (i + j) % 2 ? 0.06 : -0.04);
        g.fillRect(i * s, j * s, s, s);
      }
    }
    g.fillStyle = shade(color, -0.3);
    for (let i = 0; i <= n; i++) {
      g.fillRect(i * s - 1.5, 0, 3, size);
      g.fillRect(0, i * s - 1.5, size, 3);
    }
  } else {
    // Carpet and concrete: speckled noise at different scales.
    const dots = style === 'carpet' ? 5000 : 1800;
    for (let i = 0; i < dots; i++) {
      g.fillStyle = shade(color, (rand() - 0.5) * (style === 'carpet' ? 0.25 : 0.12));
      const r = style === 'carpet' ? 1.2 : 1 + rand() * 3;
      g.fillRect(rand() * size, rand() * size, r, r);
    }
    if (style === 'concrete') {
      g.strokeStyle = shade(color, -0.2);
      g.lineWidth = 2;
      g.strokeRect(0, 0, size, size);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}
