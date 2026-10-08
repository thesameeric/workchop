import { useContext, useMemo, type ReactNode } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { OfficeItem } from '../../../../shared/types';
import { isLightOn, surfaceHeight, wallMountZ } from '../../../../shared/world';
import { useStore } from '../../state/store';
import type { ItemModelProps } from '../../world/extensions';
import { Ball, Box, cylGeo, Cyl, mat, OpacityContext, Shape } from '../../world/prims';

// Low-poly models of the plants, the desk lamp and the light switch, in the style of
// world/models.tsx: centred on the footprint, standing on y = 0, facing +z.

type V3 = [number, number, number];

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const dir = new THREE.Vector3();
const quat = new THREE.Quaternion();
const euler = new THREE.Euler();

/** Centre, rotation and length of a part that runs from `a` to `b` along its local `axis`. */
function between(a: V3, b: V3, axis = UP): { p: V3; r: V3; len: number } {
  dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = dir.length() || 1e-6;
  quat.setFromUnitVectors(axis, dir.normalize());
  euler.setFromQuaternion(quat);
  return { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], r: [euler.x, euler.y, euler.z], len };
}

const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A stem or branch from `a` to `b`. */
function Stem({ a, b, rad, c, top = 1 }: { a: V3; b: V3; rad: number; c: string; top?: number }) {
  const { p, r, len } = between(a, b);
  return <Cyl p={p} r={r} rad={rad} h={len} top={top} seg={6} c={c} />;
}

/** A pot, wider at the top, with soil. */
function Pot({ r, h, c, taper = 0.78 }: { r: number; h: number; c: string; taper?: number }) {
  return (
    <>
      <Cyl p={[0, h / 2, 0]} rad={r * taper} top={1 / taper} h={h} c={c} />
      <Cyl p={[0, h - 0.008, 0]} rad={r * 0.93} h={0.02} c="#4a3326" shadow={false} />
    </>
  );
}

// ---------- Leaves and stems, merged ----------

// A plant has dozens of leaves: drawn one by one they'd cost a draw call (and a shadow pass) each.
// Instead each species' leaves and stems are built once into one mesh per material and shared by
// every plant of that species.

/** Leaves, petals and spines: a coarse sphere (flattened, it reads as a leaf). */
const blobGeo = new THREE.SphereGeometry(1, 8, 4);

interface Part {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  c: string;
  roughness?: number;
  shadow: boolean;
}

const compose = (p: V3, r: V3 = [0, 0, 0], s: V3 = [1, 1, 1]) =>
  new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)), new THREE.Vector3(...s));

/** Collects the small parts of a model, placed like JSX in nested groups. */
class Parts {
  list: Part[] = [];
  private frames = [new THREE.Matrix4()];

  private add(geometry: THREE.BufferGeometry, local: THREE.Matrix4, c: string, roughness: number | undefined, shadow: boolean) {
    this.list.push({ geometry, matrix: this.frames[this.frames.length - 1].clone().multiply(local), c, roughness, shadow });
  }

  /** Draws in a frame moved to `p` and turned by `r` (like a <group>). */
  group(p: V3, r: V3 | undefined, draw: () => void) {
    this.frames.push(this.frames[this.frames.length - 1].clone().multiply(compose(p, r)));
    draw();
    this.frames.pop();
  }

  /** Draws in a frame at `a` whose +z points at `b` (leaves are drawn along +z, flat in x). */
  along(a: V3, b: V3, draw: (len: number) => void) {
    const { r, len } = between(a, b, FORWARD);
    this.group(a, r, () => draw(len));
  }

  /** An ellipsoid with radii `s` (a leaf, a petal). */
  blob(p: V3, s: V3, c: string, o: { r?: V3; roughness?: number; shadow?: boolean } = {}) {
    this.add(blobGeo, compose(p, o.r, s), c, o.roughness, o.shadow ?? true);
  }

  /** A plain leaf from `a` to `b`. */
  leaf(a: V3, b: V3, w: number, c: string, gloss = false) {
    this.along(a, b, (len) => this.blob([0, 0, len / 2], [w, 0.01, len / 2], c, { roughness: gloss ? 0.32 : 0.7 }));
  }

  /** A stem or branch from `a` to `b`, `top` times as thick at its end. */
  stem(a: V3, b: V3, rad: number, c: string, top = 1) {
    const { p, r, len } = between(a, b);
    this.add(cylGeo(top, 6), compose(p, r, [rad, len, rad]), c, undefined, true);
  }

  /** Any geometry, scaled by `s`. */
  shape(geometry: THREE.BufferGeometry, p: V3, s: V3, c: string, o: { r?: V3; shadow?: boolean } = {}) {
    this.add(geometry, compose(p, o.r, s), c, undefined, o.shadow ?? true);
  }
}

interface Merged {
  key: string;
  geometry: THREE.BufferGeometry;
  c: string;
  roughness?: number;
  shadow: boolean;
}

const merged = new Map<string, Merged[]>();

/** A model's parts, merged by material; built on first use and kept for every plant of the kind. */
function mergedParts(id: string, build: (parts: Parts) => void): Merged[] {
  let out = merged.get(id);
  if (!out) {
    const parts = new Parts();
    build(parts);
    const groups = new Map<string, { part: Part; geometries: THREE.BufferGeometry[] }>();
    for (const part of parts.list) {
      const key = `${part.c}|${part.roughness ?? ''}|${part.shadow}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { part, geometries: [] }));
      g.geometries.push(part.geometry.clone().applyMatrix4(part.matrix));
    }
    out = [...groups].map(([key, { part, geometries }]) => {
      const geometry = mergeGeometries(geometries)!;
      for (const g of geometries) g.dispose();
      return { key, geometry, c: part.c, roughness: part.roughness, shadow: part.shadow };
    });
    merged.set(id, out);
  }
  return out;
}

/** Draws a model's merged parts. They are outlined by pushing them out along their normals. */
function Foliage({ id, build }: { id: string; build: (parts: Parts) => void }) {
  const opacity = useContext(OpacityContext);
  const opaque = opacity >= 0.99;
  return (
    <>
      {mergedParts(id, build).map((m) => (
        <mesh
          key={m.key}
          geometry={m.geometry}
          material={mat(m.c, { opacity, roughness: m.roughness })}
          castShadow={m.shadow && opaque}
          receiveShadow={opaque}
          userData={{ hull: true }}
        />
      ))}
    </>
  );
}

// ---------- Plants ----------

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/** A turn of its own for each plant, so a row of them doesn't look copy-pasted. */
const spinOf = (item: OfficeItem) => ((hash(item.id) % 360) * Math.PI) / 180;

/** The height of the desk, table or shelf under an item that stands on surfaces (0 on the floor). */
function useSurface(item: Pick<OfficeItem, 'id' | 'x' | 'z'>): number {
  return useStore((s) => (s.office ? surfaceHeight(s.office.items, item) : 0));
}

const golden = 2.39996;

function monstera(parts: Parts) {
  const leaves: [number, number, number, number][] = [
    [0, 0.36, 1.0, 1],
    [1.1, 0.4, 0.82, 0.9],
    [2.2, 0.34, 1.16, 1.05],
    [3.1, 0.42, 0.78, 0.85],
    [4.1, 0.32, 0.98, 1],
    [5.2, 0.4, 0.9, 0.95],
    [0.6, 0.12, 1.26, 0.8],
  ];
  leaves.forEach(([angle, out, y, k], i) => {
    const dx = Math.sin(angle);
    const dz = Math.cos(angle);
    const tip: V3 = [dx * out, y, dz * out];
    const end: V3 = [dx * (out + 0.42 * k), y - 0.16 * k, dz * (out + 0.42 * k)];
    const c = i % 2 ? '#2f7a45' : '#3a8c50';
    parts.stem([dx * 0.04, 0.4, dz * 0.04], tip, 0.012, '#4c7a3a');
    // Two lobes with a gap: the split leaf.
    parts.along(tip, end, (len) => {
      parts.blob([-0.075 * k, 0, len * 0.52], [0.085 * k, 0.01, len * 0.5], c);
      parts.blob([0.075 * k, 0, len * 0.52], [0.085 * k, 0.01, len * 0.5], c);
      parts.blob([0, 0.002, len * 0.18], [0.05 * k, 0.01, len * 0.2], c);
    });
  });
}

function Monstera({ item }: ItemModelProps) {
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.27} h={0.42} c="#e9e4da" />
      <Foliage id="monstera" build={monstera} />
    </group>
  );
}

const bladeGeo = cylGeo(0.06, 8);

function snakePlant(parts: Parts) {
  const blades: [number, number, number, number][] = [
    [0, 0.05, 0.78, 0.07],
    [1.3, 0.12, 0.66, 0.065],
    [2.5, 0.08, 0.72, 0.075],
    [3.6, 0.15, 0.58, 0.06],
    [4.7, 0.1, 0.7, 0.07],
    [5.6, 0.18, 0.52, 0.055],
    [0.7, 0.2, 0.48, 0.05],
  ];
  blades.forEach(([angle, lean, h, w], i) => {
    parts.group([0, 0, 0], [0, angle, 0], () =>
      parts.group([0, 0.34, 0.05], [lean, 0, 0], () => {
        parts.shape(bladeGeo, [0, h / 2, 0], [w, h, 0.012], i % 2 ? '#3d6b3a' : '#466f3c');
        // Yellow margins, showing at the edges.
        parts.shape(bladeGeo, [0, h / 2 - 0.004, 0], [w * 1.18, h * 1.01, 0.008], '#c8bf55', { shadow: false });
      }),
    );
  });
}

function SnakePlant({ item }: ItemModelProps) {
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.2} h={0.36} c="#3b3f47" taper={0.88} />
      <Foliage id="snake-plant" build={snakePlant} />
    </group>
  );
}

/** A leaf that is wider towards its tip (fiddle-leaf fig). */
function fiddleLeaf(parts: Parts, a: V3, b: V3, c: string) {
  parts.along(a, b, (len) => {
    parts.blob([0, 0, len * 0.4], [0.1, 0.012, len * 0.38], c);
    parts.blob([0, 0.002, len * 0.68], [0.15, 0.012, len * 0.32], c);
  });
}

function fiddleLeafFig(parts: Parts) {
  const trunkTop: V3 = [0.03, 1.75, 0.02];
  parts.stem([0, 0.44, 0], trunkTop, 0.035, '#7a5a3a', 0.7);
  for (let i = 0; i < 16; i++) {
    const y = 0.95 + i * 0.07;
    const angle = i * golden;
    const at = lerp3([0, 0.45, 0], trunkTop, (y - 0.45) / 1.3);
    const reach = 0.3 - (i / 16) * 0.06;
    fiddleLeaf(parts, at, [at[0] + Math.sin(angle) * reach, y + 0.14, at[2] + Math.cos(angle) * reach], i % 3 ? '#2e6b35' : '#3b7d42');
  }
  fiddleLeaf(parts, trunkTop, [0.08, 2.12, 0.05], '#4a8c4c');
  fiddleLeaf(parts, trunkTop, [-0.1, 2.05, -0.06], '#3b7d42');
}

function FiddleLeafFig({ item }: ItemModelProps) {
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.25} h={0.45} c="#b98b5e" taper={0.85} />
      <Foliage id="fiddle-leaf" build={fiddleLeafFig} />
    </group>
  );
}

const POTHOS_GREEN = ['#4f9a3c', '#8fbf4f', '#5aa645', '#b9cf63'];

/** A trailing vine of heart-shaped leaves. */
function vine(parts: Parts, { angle, reach, drop, start }: { angle: number; reach: number; drop: number; start: number }) {
  const dx = Math.sin(angle);
  const dz = Math.cos(angle);
  const steps = Math.max(4, Math.round((reach + drop) / 0.06));
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const out = 0.11 + reach * Math.min(1, t * 1.8);
    const y = start - drop * Math.max(0, (t - 0.35) / 0.65) ** 1.3;
    const side = i % 2 ? 1 : -1;
    parts.blob([dx * out + dz * side * 0.025, y, dz * out - dx * side * 0.025], [0.035, 0.01, 0.04], POTHOS_GREEN[(i + Math.round(angle * 3)) % POTHOS_GREEN.length], {
      r: [0.3 * side, angle, 0],
      shadow: false,
    });
  }
}

type PothosStyle = 'floor' | 'high' | 'low';

/** Pothos leaves: a tuft in the pot and vines that trail along a desk or hang from a high shelf. */
const pothos = (style: PothosStyle) => (parts: Parts) => {
  for (let i = 0; i < 9; i++) {
    const angle = i * golden;
    parts.blob([Math.sin(angle) * 0.07, 0.19 + (i % 3) * 0.025, Math.cos(angle) * 0.07], [0.045, 0.012, 0.05], POTHOS_GREEN[i % POTHOS_GREEN.length], { r: [0.4, angle, 0] });
  }
  const vines =
    style === 'high'
      ? [-0.5, -0.15, 0.2, 0.55].map((angle, i) => ({ angle, reach: 0.12, drop: 0.45 + (i % 2) * 0.25 }))
      : style === 'floor'
        ? [0, 1.3, 2.5, 3.8, 5].map((angle, i) => ({ angle, reach: 0.1, drop: 0.25 + (i % 3) * 0.1 }))
        : [0.3, 1.9, 3.6, 5.1].map((angle) => ({ angle, reach: 0.12, drop: 0 }));
  for (const v of vines) vine(parts, { ...v, start: v.drop ? 0.15 : 0.03 });
};

const POTHOS: Record<PothosStyle, (parts: Parts) => void> = { floor: pothos('floor'), high: pothos('high'), low: pothos('low') };

function Pothos({ item }: ItemModelProps) {
  const surface = useSurface(item);
  const onFloor = surface === 0;
  // On the floor it gets a little plant stand; on a high shelf its vines hang down the front.
  const base = onFloor ? 0.62 : surface;
  const style: PothosStyle = onFloor ? 'floor' : surface > 1.2 ? 'high' : 'low';
  return (
    <group>
      {onFloor && (
        <>
          <Cyl p={[0, base - 0.02, 0]} rad={0.19} h={0.04} c="#a47148" />
          {[0, 1, 2].map((i) => (
            <Stem key={i} a={[Math.sin(i * 2.09) * 0.17, 0, Math.cos(i * 2.09) * 0.17]} b={[Math.sin(i * 2.09) * 0.1, base - 0.04, Math.cos(i * 2.09) * 0.1]} rad={0.015} c="#7d5434" />
          ))}
        </>
      )}
      <group position={[0, base, 0]}>
        <Pot r={0.13} h={0.16} c="#f2efe9" taper={0.85} />
        <Foliage id={`pothos-${style}`} build={POTHOS[style]} />
      </group>
    </group>
  );
}

function peaceLily(parts: Parts) {
  for (let i = 0; i < 11; i++) {
    const angle = i * golden;
    const dx = Math.sin(angle);
    const dz = Math.cos(angle);
    const k = 0.8 + (i % 3) * 0.1;
    const mid: V3 = [dx * 0.1 * k, 0.42 * k, dz * 0.1 * k];
    parts.stem([0, 0.22, 0], mid, 0.007, '#2f6b3c');
    parts.leaf(mid, [dx * 0.3 * k, 0.4 * k, dz * 0.3 * k], 0.055, i % 2 ? '#1f5d36' : '#276b3f', true);
  }
  [0.4, 2.5, 4.4].forEach((angle, i) => {
    const top: V3 = [Math.sin(angle) * 0.08, 0.62 + i * 0.04, Math.cos(angle) * 0.08];
    parts.stem([0, 0.22, 0], top, 0.005, '#3e7a46');
    parts.blob([top[0], top[1] + 0.06, top[2]], [0.045, 0.08, 0.02], '#fbfbf5', { r: [0.2, angle, 0] });
    parts.shape(cylGeo(1, 8), [top[0], top[1] + 0.05, top[2] + 0.015], [0.008, 0.06, 0.008], '#efe2a6', { shadow: false });
  });
}

function PeaceLily({ item }: ItemModelProps) {
  const surface = useSurface(item);
  return (
    <group position={[0, surface, 0]} rotation={[0, spinOf(item), 0]}>
      <Pot r={0.16} h={0.24} c="#f4f1ea" />
      <Foliage id="peace-lily" build={peaceLily} />
    </group>
  );
}

function zzPlant(parts: Parts) {
  for (let i = 0; i < 9; i++) {
    const angle = i * golden;
    const h = 0.42 + (i % 4) * 0.08;
    const lean = 0.12 + (i % 3) * 0.06;
    const base: V3 = [0, 0.32, 0];
    const tip: V3 = [Math.sin(angle) * lean, 0.32 + h, Math.cos(angle) * lean];
    parts.stem(base, tip, 0.016, '#3d6b32', 0.45);
    // Leaflets in pairs, sideways from the stem.
    const sx = Math.cos(angle);
    const sz = -Math.sin(angle);
    for (const t of [0.3, 0.45, 0.6, 0.75, 0.9]) {
      const at = lerp3(base, tip, t);
      const len = 0.09 * (1.1 - t * 0.4);
      for (const side of [-1, 1]) parts.leaf(at, [at[0] + sx * side * len, at[1] + 0.03, at[2] + sz * side * len], 0.026, '#2c6a35', true);
    }
  }
}

function ZzPlant({ item }: ItemModelProps) {
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.21} h={0.34} c="#2d3038" />
      <Foliage id="zz-plant" build={zzPlant} />
    </group>
  );
}

/** A sphere with ribs, for the barrel cactus. */
const ribbed = (() => {
  const g = new THREE.SphereGeometry(1, 42, 16);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 1 + 0.07 * Math.cos(14 * Math.atan2(v.z, v.x)) * Math.sqrt(1 - v.y * v.y);
    pos.setXYZ(i, v.x * k, v.y, v.z * k);
  }
  g.computeVertexNormals();
  return g;
})();

function cactusSpines(parts: Parts) {
  for (let rib = 0; rib < 14; rib++) {
    const a = (rib / 14) * Math.PI * 2;
    for (const el of [0.35, 0.7, 1.05]) {
      const r = 0.128 * Math.cos(el - 0.35) + 0.004;
      parts.blob([Math.cos(a) * r * 1.07, 0.2 + Math.sin(el) * 0.1, Math.sin(a) * r * 1.07], [0.008, 0.008, 0.008], '#f0cd5a', { shadow: false });
    }
  }
}

function Cactus({ item }: ItemModelProps) {
  const surface = useSurface(item);
  return (
    <group position={[0, surface, 0]}>
      <Pot r={0.14} h={0.12} c="#c96f43" taper={0.85} />
      <Cyl p={[0, 0.118, 0]} rad={0.128} h={0.01} c="#d8c39a" shadow={false} />
      <Shape geometry={ribbed} p={[0, 0.2, 0]} s={[0.125, 0.11, 0.125]} c="#4c9a4f" roughness={0.6} />
      <Foliage id="cactus" build={cactusSpines} />
      <Ball p={[0, 0.305, 0]} s={[0.035, 0.012, 0.035]} c="#e9d48a" />
    </group>
  );
}

function Bonsai({ item }: ItemModelProps) {
  const surface = useSurface(item);
  const bark = '#6e5a48';
  return (
    <group position={[0, surface, 0]}>
      <Box p={[0, 0.04, 0]} s={[0.38, 0.06, 0.26]} c="#41566e" roughness={0.35} />
      {[-0.15, 0.15].flatMap((x) => [-0.09, 0.09].map((z) => <Box key={`${x}${z}`} p={[x, 0.005, z]} s={[0.03, 0.01, 0.03]} c="#2e3d4f" />))}
      <Box p={[0, 0.072, 0]} s={[0.34, 0.01, 0.22]} c="#5b7f3a" shadow={false} />
      <Ball p={[0.12, 0.08, -0.06]} s={[0.03, 0.02, 0.025]} c="#9a9a92" />
      <Stem a={[-0.04, 0.07, 0]} b={[0.02, 0.16, 0.01]} rad={0.024} top={0.8} c={bark} />
      <Stem a={[0.02, 0.16, 0.01]} b={[-0.03, 0.25, -0.01]} rad={0.019} top={0.75} c={bark} />
      <Stem a={[-0.03, 0.25, -0.01]} b={[0.03, 0.33, 0]} rad={0.014} top={0.7} c={bark} />
      <Stem a={[0.02, 0.16, 0.01]} b={[0.12, 0.2, 0.03]} rad={0.01} c={bark} />
      <Stem a={[-0.03, 0.25, -0.01]} b={[-0.13, 0.27, 0.02]} rad={0.009} c={bark} />
      <Ball p={[0.13, 0.22, 0.03]} s={[0.08, 0.035, 0.06]} c="#2f6b3a" />
      <Ball p={[-0.14, 0.29, 0.02]} s={[0.07, 0.03, 0.055]} c="#2f6b3a" />
      <Ball p={[0.03, 0.36, 0]} s={[0.09, 0.045, 0.07]} c="#3a7d45" />
      <Ball p={[0.07, 0.3, -0.06]} s={[0.05, 0.025, 0.045]} c="#3a7d45" />
    </group>
  );
}

function birdOfParadise(parts: Parts) {
  const leaves: [number, number, number][] = [
    [0, 0.14, 1.85],
    [0.9, 0.24, 1.55],
    [1.8, 0.18, 1.75],
    [2.8, 0.28, 1.4],
    [3.7, 0.2, 1.65],
    [4.6, 0.26, 1.45],
    [5.5, 0.16, 1.7],
  ];
  leaves.forEach(([angle, out, top], i) => {
    const dx = Math.sin(angle);
    const dz = Math.cos(angle);
    const joint: V3 = [dx * out, top - 0.5, dz * out];
    const c = i % 2 ? '#3f7f45' : '#4a8c4f';
    parts.stem([dx * 0.03, 0.44, dz * 0.03], joint, 0.014, '#58824a');
    // Paddle leaves, torn along their veins.
    parts.along(joint, [dx * (out + 0.1), top, dz * (out + 0.1)], (len) => {
      parts.blob([-0.04, 0, len / 2], [0.055, 0.01, len / 2], c);
      parts.blob([0.04, 0, len / 2], [0.055, 0.01, len / 2], c);
    });
  });
  // The flower: a beak-like bract with orange petals and a blue "tongue".
  parts.stem([0.04, 0.44, 0], [0.08, 1.15, 0.05], 0.01, '#58824a');
  parts.leaf([0.08, 1.15, 0.05], [0.32, 1.17, 0.13], 0.025, '#5d6b3c');
  [
    [0.14, 0.02],
    [0.2, -0.03],
    [0.24, 0.04],
  ].forEach(([t, lean], i) => parts.leaf([0.1 + t * 0.5, 1.18, 0.07 + t * 0.2], [0.12 + t * 0.6, 1.33 - i * 0.02, 0.06 + lean], 0.014, '#ff8a1f'));
  parts.leaf([0.2, 1.19, 0.09], [0.3, 1.27, 0.12], 0.01, '#3557d6');
}

function BirdOfParadise({ item }: ItemModelProps) {
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.27} h={0.46} c="#ece6dc" />
      <Foliage id="bird-of-paradise" build={birdOfParadise} />
    </group>
  );
}

function rubberPlant(parts: Parts) {
  const top: V3 = [0.02, 1.62, 0];
  const colors = ['#24402c', '#2f4f36', '#3b2b31'];
  parts.stem([0, 0.41, 0], top, 0.028, '#6b4f3f', 0.6);
  for (let i = 0; i < 12; i++) {
    const y = 0.72 + i * 0.075;
    const angle = i * golden;
    const at = lerp3([0, 0.41, 0], top, (y - 0.41) / 1.21);
    const reach = 0.28 - i * 0.008;
    parts.along(at, [at[0] + Math.sin(angle) * reach, y + 0.12, at[2] + Math.cos(angle) * reach], (len) =>
      parts.blob([0, 0, len * 0.55], [0.1, 0.012, len * 0.55], colors[i % 3], { roughness: 0.28 }),
    );
  }
  // The red sheath of a new leaf at the top.
  parts.shape(cylGeo(0.1, 8), [0.02, 1.69, 0], [0.02, 0.14, 0.02], '#a3333a');
}

function RubberPlant({ item }: ItemModelProps) {
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.24} h={0.42} c="#2f3238" />
      <Foliage id="rubber-plant" build={rubberPlant} />
    </group>
  );
}

function lavender(parts: Parts) {
  for (let i = 0; i < 14; i++) {
    const angle = i * golden;
    const r = 0.02 + (i % 4) * 0.015;
    const tip: V3 = [Math.sin(angle) * r * 2.4, 0.4 + (i % 3) * 0.03, Math.cos(angle) * r * 2.4];
    const from: V3 = lerp3([Math.sin(angle) * r, 0.18, Math.cos(angle) * r], tip, 0.72);
    parts.stem([Math.sin(angle) * r, 0.17, Math.cos(angle) * r], from, 0.004, '#7c9a6e');
    parts.along(from, tip, (len) => parts.blob([0, 0, len / 2], [0.014, 0.014, len / 2 + 0.006], i % 2 ? '#8d68c4' : '#7a57b8', { shadow: false }));
  }
}

function Lavender({ item }: ItemModelProps) {
  const surface = useSurface(item);
  return (
    <group position={[0, surface, 0]} rotation={[0, spinOf(item), 0]}>
      <Pot r={0.12} h={0.15} c="#c96f43" taper={0.8} />
      <Ball p={[0, 0.17, 0]} s={[0.1, 0.05, 0.1]} c="#8aa585" />
      {[0, 2.1, 4.2].map((a) => (
        <Ball key={a} p={[Math.sin(a) * 0.05, 0.2, Math.cos(a) * 0.05]} s={[0.05, 0.035, 0.05]} c="#9db697" />
      ))}
      <Foliage id="lavender" build={lavender} />
    </group>
  );
}

const DARK = '#2d2f36';
const METAL = '#5b5f66';

/** Where a desk lamp's bulb is (local, above whatever it stands on). */
export const DESK_LAMP_BULB: V3 = [0.12, 0.3, 0.1];

function DeskLamp({ item, c }: ItemModelProps) {
  const surface = useSurface(item);
  const on = isLightOn(item);
  return (
    <group position={[0, surface, 0]}>
      <Cyl p={[0, 0.012, 0]} rad={0.075} h={0.024} c={DARK} />
      <Stem a={[0, 0.02, 0]} b={[-0.04, 0.25, -0.02]} rad={0.009} c={METAL} />
      <Ball p={[-0.04, 0.25, -0.02]} rad={0.016} c={DARK} />
      <Stem a={[-0.04, 0.25, -0.02]} b={[0.12, 0.39, 0.046]} rad={0.008} c={METAL} />
      {/* Shade, tipped forward; open side down. */}
      <Cyl p={[0.12, 0.34, 0.08]} r={[-0.6, 0, 0]} rad={0.08} top={0.4} h={0.12} c={c} />
      <Ball p={DESK_LAMP_BULB} rad={0.028} c={on ? '#fff3c4' : '#d9d4c5'} emissive={on ? '#ffd27a' : undefined} emissiveIntensity={2} shadow={false} />
    </group>
  );
}

/** Catches clicks around small things without being drawn. */
const hitArea = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });

function LightSwitch({ item }: ItemModelProps) {
  const back = useStore((s) => (s.office ? wallMountZ(s.office.items, item) : -0.25));
  const on = isLightOn(item);
  return (
    <group position={[0, 1.15, back]}>
      <Box p={[0, 0, 0.009]} s={[0.17, 0.25, 0.018]} c="#f3f1ea" roughness={0.4} />
      <Box p={[0, 0.01, 0.022]} r={[on ? -0.28 : 0.28, 0, 0]} s={[0.065, 0.11, 0.016]} c="#ffffff" roughness={0.35} />
      {/* A small light, amber when the lights are off, so the switch is easy to find in the dark. */}
      <Ball p={[0, -0.085, 0.02]} rad={0.009} c={on ? '#9bd27a' : '#ffb347'} emissive={on ? '#6fbf4a' : '#ff9f1c'} emissiveIntensity={1.5} shadow={false} />
      {/* The switch is small: a bigger area around it takes the click. */}
      <mesh position={[0, 0, 0.12]} scale={[0.45, 0.6, 0.24]} material={hitArea} userData={{ hitArea: true }}>
        <boxGeometry />
      </mesh>
    </group>
  );
}

export const PLANT_MODELS: Record<string, (props: ItemModelProps) => ReactNode> = {
  monstera: Monstera,
  'snake-plant': SnakePlant,
  'fiddle-leaf': FiddleLeafFig,
  pothos: Pothos,
  'peace-lily': PeaceLily,
  'zz-plant': ZzPlant,
  cactus: Cactus,
  bonsai: Bonsai,
  'bird-of-paradise': BirdOfParadise,
  'rubber-plant': RubberPlant,
  lavender: Lavender,
};

export { DeskLamp, LightSwitch };

/** Where a lamp's bulb is, in its local coordinates (a desk lamp's depends on what it stands on). */
export function useBulb(item: OfficeItem): V3 {
  const surface = useSurface(item);
  return useMemo(() => (item.type === 'desk-lamp' ? [DESK_LAMP_BULB[0], surface + DESK_LAMP_BULB[1], DESK_LAMP_BULB[2]] : [0, 1.52, 0]), [item.type, surface]);
}
