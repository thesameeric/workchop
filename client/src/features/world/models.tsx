import { useMemo, type ReactNode } from 'react';
import * as THREE from 'three';
import type { OfficeItem } from '../../../../shared/types';
import { isLightOn, surfaceHeight, wallMountZ } from '../../../../shared/world';
import { useStore } from '../../state/store';
import type { ItemModelProps } from '../../world/extensions';
import { Ball, Box, cylGeo, Cyl, Shape } from '../../world/prims';

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

/** A group at `a` whose +z points at `b` (leaves are drawn along +z, flat in x). */
function Along({ a, b, children }: { a: V3; b: V3; children: (len: number) => ReactNode }) {
  const { r, len } = between(a, b, FORWARD);
  return (
    <group position={a} rotation={r}>
      {children(len)}
    </group>
  );
}

/** A plain leaf from `a` to `b`. */
function Leaf({ a, b, w, c, gloss }: { a: V3; b: V3; w: number; c: string; gloss?: boolean }) {
  return <Along a={a} b={b}>{(len) => <Ball p={[0, 0, len / 2]} s={[w, 0.01, len / 2]} c={c} roughness={gloss ? 0.32 : 0.7} />}</Along>;
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

function Monstera({ item }: ItemModelProps) {
  const leaves: [number, number, number, number][] = [
    [0, 0.36, 1.0, 1],
    [1.1, 0.4, 0.82, 0.9],
    [2.2, 0.34, 1.16, 1.05],
    [3.1, 0.42, 0.78, 0.85],
    [4.1, 0.32, 0.98, 1],
    [5.2, 0.4, 0.9, 0.95],
    [0.6, 0.12, 1.26, 0.8],
  ];
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.27} h={0.42} c="#e9e4da" />
      {leaves.map(([angle, out, y, k], i) => {
        const dx = Math.sin(angle);
        const dz = Math.cos(angle);
        const tip: V3 = [dx * out, y, dz * out];
        const end: V3 = [dx * (out + 0.42 * k), y - 0.16 * k, dz * (out + 0.42 * k)];
        const c = i % 2 ? '#2f7a45' : '#3a8c50';
        return (
          <group key={i}>
            <Stem a={[dx * 0.04, 0.4, dz * 0.04]} b={tip} rad={0.012} c="#4c7a3a" />
            {/* Two lobes with a gap: the split leaf. */}
            <Along a={tip} b={end}>
              {(len) => (
                <>
                  <Ball p={[-0.075 * k, 0, len * 0.52]} s={[0.085 * k, 0.01, len * 0.5]} c={c} />
                  <Ball p={[0.075 * k, 0, len * 0.52]} s={[0.085 * k, 0.01, len * 0.5]} c={c} />
                  <Ball p={[0, 0.002, len * 0.18]} s={[0.05 * k, 0.01, len * 0.2]} c={c} />
                </>
              )}
            </Along>
          </group>
        );
      })}
    </group>
  );
}

const bladeGeo = cylGeo(0.06, 8);

function SnakePlant({ item }: ItemModelProps) {
  const blades: [number, number, number, number][] = [
    [0, 0.05, 0.78, 0.07],
    [1.3, 0.12, 0.66, 0.065],
    [2.5, 0.08, 0.72, 0.075],
    [3.6, 0.15, 0.58, 0.06],
    [4.7, 0.1, 0.7, 0.07],
    [5.6, 0.18, 0.52, 0.055],
    [0.7, 0.2, 0.48, 0.05],
  ];
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.2} h={0.36} c="#3b3f47" taper={0.88} />
      {blades.map(([angle, lean, h, w], i) => (
        <group key={i} rotation={[0, angle, 0]}>
          <group position={[0, 0.34, 0.05]} rotation={[lean, 0, 0]}>
            <Shape geometry={bladeGeo} p={[0, h / 2, 0]} s={[w, h, 0.012]} c={i % 2 ? '#3d6b3a' : '#466f3c'} />
            {/* Yellow margins, showing at the edges. */}
            <Shape geometry={bladeGeo} p={[0, h / 2 - 0.004, 0]} s={[w * 1.18, h * 1.01, 0.008]} c="#c8bf55" shadow={false} />
          </group>
        </group>
      ))}
    </group>
  );
}

/** A leaf that is wider towards its tip (fiddle-leaf fig). */
function FiddleLeaf({ a, b, c }: { a: V3; b: V3; c: string }) {
  return (
    <Along a={a} b={b}>
      {(len) => (
        <>
          <Ball p={[0, 0, len * 0.4]} s={[0.1, 0.012, len * 0.38]} c={c} />
          <Ball p={[0, 0.002, len * 0.68]} s={[0.15, 0.012, len * 0.32]} c={c} />
        </>
      )}
    </Along>
  );
}

function FiddleLeafFig({ item }: ItemModelProps) {
  const trunkTop: V3 = [0.03, 1.75, 0.02];
  const leaves = Array.from({ length: 16 }, (_, i) => {
    const y = 0.95 + i * 0.07;
    const angle = i * golden;
    const at = lerp3([0, 0.45, 0], trunkTop, (y - 0.45) / 1.3);
    const reach = 0.3 - (i / 16) * 0.06;
    return { at, end: [at[0] + Math.sin(angle) * reach, y + 0.14, at[2] + Math.cos(angle) * reach] as V3, c: i % 3 ? '#2e6b35' : '#3b7d42' };
  });
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.25} h={0.45} c="#b98b5e" taper={0.85} />
      <Stem a={[0, 0.44, 0]} b={trunkTop} rad={0.035} top={0.7} c="#7a5a3a" />
      {leaves.map((l, i) => (
        <FiddleLeaf key={i} a={l.at} b={l.end} c={l.c} />
      ))}
      <FiddleLeaf a={trunkTop} b={[0.08, 2.12, 0.05]} c="#4a8c4c" />
      <FiddleLeaf a={trunkTop} b={[-0.1, 2.05, -0.06]} c="#3b7d42" />
    </group>
  );
}

const POTHOS_GREEN = ['#4f9a3c', '#8fbf4f', '#5aa645', '#b9cf63'];

/** A trailing vine of heart-shaped leaves. */
function Vine({ angle, reach, drop, start }: { angle: number; reach: number; drop: number; start: number }) {
  const dx = Math.sin(angle);
  const dz = Math.cos(angle);
  const leaves = [];
  const steps = Math.max(4, Math.round((reach + drop) / 0.06));
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const out = 0.11 + reach * Math.min(1, t * 1.8);
    const y = start - drop * Math.max(0, (t - 0.35) / 0.65) ** 1.3;
    const side = i % 2 ? 1 : -1;
    leaves.push(
      <Ball
        key={i}
        p={[dx * out + dz * side * 0.025, y, dz * out - dx * side * 0.025]}
        r={[0.3 * side, angle, 0]}
        s={[0.035, 0.01, 0.04]}
        c={POTHOS_GREEN[(i + Math.round(angle * 3)) % POTHOS_GREEN.length]}
        shadow={false}
      />,
    );
  }
  return <>{leaves}</>;
}

function Pothos({ item }: ItemModelProps) {
  const surface = useSurface(item);
  const onFloor = surface === 0;
  // On the floor it gets a little plant stand; on a high shelf its vines hang down the front.
  const base = onFloor ? 0.62 : surface;
  const high = surface > 1.2;
  const vines: { angle: number; reach: number; drop: number }[] = high
    ? [-0.5, -0.15, 0.2, 0.55].map((angle, i) => ({ angle, reach: 0.12, drop: 0.45 + (i % 2) * 0.25 }))
    : onFloor
      ? [0, 1.3, 2.5, 3.8, 5].map((angle, i) => ({ angle, reach: 0.1, drop: 0.25 + (i % 3) * 0.1 }))
      : [0.3, 1.9, 3.6, 5.1].map((angle) => ({ angle, reach: 0.12, drop: 0 }));
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
        {Array.from({ length: 9 }, (_, i) => {
          const angle = i * golden;
          return (
            <Ball
              key={i}
              p={[Math.sin(angle) * 0.07, 0.19 + (i % 3) * 0.025, Math.cos(angle) * 0.07]}
              r={[0.4, angle, 0]}
              s={[0.045, 0.012, 0.05]}
              c={POTHOS_GREEN[i % POTHOS_GREEN.length]}
            />
          );
        })}
        {vines.map((v, i) => (
          <Vine key={i} angle={v.angle} reach={v.reach} drop={v.drop} start={v.drop ? 0.15 : 0.03} />
        ))}
      </group>
    </group>
  );
}

function PeaceLily({ item }: ItemModelProps) {
  const surface = useSurface(item);
  return (
    <group position={[0, surface, 0]} rotation={[0, spinOf(item), 0]}>
      <Pot r={0.16} h={0.24} c="#f4f1ea" />
      {Array.from({ length: 11 }, (_, i) => {
        const angle = i * golden;
        const dx = Math.sin(angle);
        const dz = Math.cos(angle);
        const k = 0.8 + (i % 3) * 0.1;
        const mid: V3 = [dx * 0.1 * k, 0.42 * k, dz * 0.1 * k];
        return (
          <group key={i}>
            <Stem a={[0, 0.22, 0]} b={mid} rad={0.007} c="#2f6b3c" />
            <Leaf a={mid} b={[dx * 0.3 * k, 0.4 * k, dz * 0.3 * k]} w={0.055} c={i % 2 ? '#1f5d36' : '#276b3f'} gloss />
          </group>
        );
      })}
      {[0.4, 2.5, 4.4].map((angle, i) => {
        const top: V3 = [Math.sin(angle) * 0.08, 0.62 + i * 0.04, Math.cos(angle) * 0.08];
        return (
          <group key={angle}>
            <Stem a={[0, 0.22, 0]} b={top} rad={0.005} c="#3e7a46" />
            <Ball p={[top[0], top[1] + 0.06, top[2]]} r={[0.2, angle, 0]} s={[0.045, 0.08, 0.02]} c="#fbfbf5" />
            <Cyl p={[top[0], top[1] + 0.05, top[2] + 0.015]} rad={0.008} h={0.06} c="#efe2a6" shadow={false} />
          </group>
        );
      })}
    </group>
  );
}

function ZzPlant({ item }: ItemModelProps) {
  const stems = Array.from({ length: 9 }, (_, i) => {
    const angle = i * golden;
    const h = 0.42 + (i % 4) * 0.08;
    const lean = 0.12 + (i % 3) * 0.06;
    const base: V3 = [0, 0.32, 0];
    const tip: V3 = [Math.sin(angle) * lean, 0.32 + h, Math.cos(angle) * lean];
    return { angle, base, tip };
  });
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.21} h={0.34} c="#2d3038" />
      {stems.map(({ angle, base, tip }, i) => {
        // Leaflets in pairs, sideways from the stem.
        const sx = Math.cos(angle);
        const sz = -Math.sin(angle);
        return (
          <group key={i}>
            <Stem a={base} b={tip} rad={0.016} top={0.45} c="#3d6b32" />
            {[0.3, 0.45, 0.6, 0.75, 0.9].flatMap((t) =>
              [-1, 1].map((side) => {
                const at = lerp3(base, tip, t);
                const len = 0.09 * (1.1 - t * 0.4);
                return <Leaf key={`${t}${side}`} a={at} b={[at[0] + sx * side * len, at[1] + 0.03, at[2] + sz * side * len]} w={0.026} c="#2c6a35" gloss />;
              }),
            )}
          </group>
        );
      })}
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

function Cactus({ item }: ItemModelProps) {
  const surface = useSurface(item);
  const spines = [];
  for (let rib = 0; rib < 14; rib++) {
    const a = (rib / 14) * Math.PI * 2;
    for (const [el, i] of [[0.35, 0], [0.7, 1], [1.05, 2]] as const) {
      const r = 0.128 * Math.cos(el - 0.35) + 0.004;
      spines.push(
        <Ball key={`${rib}-${i}`} p={[Math.cos(a) * r * 1.07, 0.2 + Math.sin(el) * 0.1, Math.sin(a) * r * 1.07]} rad={0.008} c="#f0cd5a" shadow={false} />,
      );
    }
  }
  return (
    <group position={[0, surface, 0]}>
      <Pot r={0.14} h={0.12} c="#c96f43" taper={0.85} />
      <Cyl p={[0, 0.118, 0]} rad={0.128} h={0.01} c="#d8c39a" shadow={false} />
      <Shape geometry={ribbed} p={[0, 0.2, 0]} s={[0.125, 0.11, 0.125]} c="#4c9a4f" roughness={0.6} />
      {spines}
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

function BirdOfParadise({ item }: ItemModelProps) {
  const leaves: [number, number, number][] = [
    [0, 0.14, 1.85],
    [0.9, 0.24, 1.55],
    [1.8, 0.18, 1.75],
    [2.8, 0.28, 1.4],
    [3.7, 0.2, 1.65],
    [4.6, 0.26, 1.45],
    [5.5, 0.16, 1.7],
  ];
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.27} h={0.46} c="#ece6dc" />
      {leaves.map(([angle, out, top], i) => {
        const dx = Math.sin(angle);
        const dz = Math.cos(angle);
        const joint: V3 = [dx * out, top - 0.5, dz * out];
        const c = i % 2 ? '#3f7f45' : '#4a8c4f';
        return (
          <group key={i}>
            <Stem a={[dx * 0.03, 0.44, dz * 0.03]} b={joint} rad={0.014} c="#58824a" />
            {/* Paddle leaves, torn along their veins. */}
            <Along a={joint} b={[dx * (out + 0.1), top, dz * (out + 0.1)]}>
              {(len) => (
                <>
                  <Ball p={[-0.04, 0, len / 2]} s={[0.055, 0.01, len / 2]} c={c} />
                  <Ball p={[0.04, 0, len / 2]} s={[0.055, 0.01, len / 2]} c={c} />
                </>
              )}
            </Along>
          </group>
        );
      })}
      {/* The flower: a beak-like bract with orange petals and a blue "tongue". */}
      <Stem a={[0.04, 0.44, 0]} b={[0.08, 1.15, 0.05]} rad={0.01} c="#58824a" />
      <Leaf a={[0.08, 1.15, 0.05]} b={[0.32, 1.17, 0.13]} w={0.025} c="#5d6b3c" />
      {[
        [0.14, 0.02],
        [0.2, -0.03],
        [0.24, 0.04],
      ].map(([t, lean], i) => (
        <Leaf key={i} a={[0.1 + t * 0.5, 1.18, 0.07 + t * 0.2]} b={[0.12 + t * 0.6, 1.33 - i * 0.02, 0.06 + lean]} w={0.014} c="#ff8a1f" />
      ))}
      <Leaf a={[0.2, 1.19, 0.09]} b={[0.3, 1.27, 0.12]} w={0.01} c="#3557d6" />
    </group>
  );
}

function RubberPlant({ item }: ItemModelProps) {
  const top: V3 = [0.02, 1.62, 0];
  const colors = ['#24402c', '#2f4f36', '#3b2b31'];
  return (
    <group rotation={[0, spinOf(item), 0]}>
      <Pot r={0.24} h={0.42} c="#2f3238" />
      <Stem a={[0, 0.41, 0]} b={top} rad={0.028} top={0.6} c="#6b4f3f" />
      {Array.from({ length: 12 }, (_, i) => {
        const y = 0.72 + i * 0.075;
        const angle = i * golden;
        const at = lerp3([0, 0.41, 0], top, (y - 0.41) / 1.21);
        const reach = 0.28 - i * 0.008;
        return (
          <Along key={i} a={at} b={[at[0] + Math.sin(angle) * reach, y + 0.12, at[2] + Math.cos(angle) * reach]}>
            {(len) => <Ball p={[0, 0, len * 0.55]} s={[0.1, 0.012, len * 0.55]} c={colors[i % 3]} roughness={0.28} />}
          </Along>
        );
      })}
      <Cyl p={[0.02, 1.69, 0]} rad={0.02} top={0.1} h={0.14} c="#a3333a" />
    </group>
  );
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
      {Array.from({ length: 14 }, (_, i) => {
        const angle = i * golden;
        const r = 0.02 + (i % 4) * 0.015;
        const tip: V3 = [Math.sin(angle) * r * 2.4, 0.4 + (i % 3) * 0.03, Math.cos(angle) * r * 2.4];
        const from: V3 = lerp3([Math.sin(angle) * r, 0.18, Math.cos(angle) * r], tip, 0.72);
        return (
          <group key={i}>
            <Stem a={[Math.sin(angle) * r, 0.17, Math.cos(angle) * r]} b={from} rad={0.004} c="#7c9a6e" />
            <Along a={from} b={tip}>
              {(len) => <Ball p={[0, 0, len / 2]} s={[0.014, 0.014, len / 2 + 0.006]} c={i % 2 ? '#8d68c4' : '#7a57b8'} shadow={false} />}
            </Along>
          </group>
        );
      })}
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
