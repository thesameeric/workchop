import { useFrame } from '@react-three/fiber';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { deskLabels } from '../../../../shared/support';
import type { OfficeItem } from '../../../../shared/types';
import { sanitizeBoardData } from '../../../../shared/world';
import { shade } from '../../lib/color';
import { useStore } from '../../state/store';
import type { ItemModelProps } from '../../world/extensions';
import { Chair } from '../../world/models';
import { Ball, Box, boxGeo, Cyl, mat, OpacityContext } from '../../world/prims';
import { FISH } from './fish';

// Models for support lobbies (and any office): the support desk, fish tanks and info boards. Like
// world/models.tsx they're centred on the footprint, stand on y = 0 and face +z.

const DARK = '#2d2f36';
const METAL = '#5b5f66';
const BRAND = '#5b6cff';
const noRaycast = () => null;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ---------- Support desk ----------

/** A plain chair with four legs, for visitors. */
function VisitorChair({ c }: { c: string }) {
  return (
    <group>
      {[-0.19, 0.19].flatMap((x) => [-0.17, 0.17].map((z) => <Box key={`${x}${z}`} p={[x, 0.17, z]} s={[0.035, 0.34, 0.035]} c={METAL} />))}
      <Box p={[0, 0.37, 0]} s={[0.48, 0.07, 0.44]} c={c} rounded />
      <Box p={[0, 0.66, -0.21]} s={[0.46, 0.44, 0.06]} c={c} rounded />
    </group>
  );
}

let labelsFor: OfficeItem[] | null = null;
let labels = new Map<string, string>();

/** A support desk's number ("Desk 2"), the same as staff and customers are told. */
function useDeskLabel(itemId: string): string | undefined {
  return useStore((s) => {
    const items = s.office?.items;
    if (!items) return undefined;
    if (items !== labelsFor) {
      labelsFor = items;
      labels = deskLabels(items);
    }
    return labels.get(itemId);
  });
}

const signMaterials = new Map<string, THREE.Material[]>();

/** The number sign's faces (front and back), one per label. */
function signMaterial(label: string): THREE.Material[] {
  let m = signMaterials.get(label);
  if (!m) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 112;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = BRAND;
    ctx.fillRect(0, 0, 256, 112);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 60px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(label, 128, 60, 236);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    const face = new THREE.MeshStandardMaterial({ map, roughness: 0.5 });
    const edge = mat(DARK);
    m = [edge, edge, edge, edge, face, face];
    signMaterials.set(label, m);
  }
  return m;
}

/** A sign on a post with the desk's number, readable from both sides. */
function DeskSign({ itemId }: { itemId: string }) {
  const label = useDeskLabel(itemId);
  if (!label) return null;
  return (
    <group position={[0.78, 0, 0.3]}>
      <Cyl p={[0, 1.0, 0]} rad={0.015} h={0.76} c={METAL} />
      <mesh geometry={boxGeo} material={signMaterial(label)} position={[0, 1.5, 0]} scale={[0.64, 0.28, 0.03]} castShadow />
    </group>
  );
}

/**
 * A help desk used from both sides: staff sit at the back (-z) facing the customer's chair across
 * it. The monitor stands to one side, so they see each other, and its number stands on a sign.
 */
export function SupportDesk({ item, c }: ItemModelProps) {
  return (
    <group>
      <Box p={[0, 0.6, 0]} s={[2, 0.05, 0.85]} c={c} />
      {[-0.95, 0.95].map((x) => (
        <Box key={x} p={[x, 0.29, 0]} s={[0.06, 0.58, 0.8]} c={shade(c, -0.15)} />
      ))}
      {/* The customer's side is closed, with a stripe. */}
      <Box p={[0, 0.33, 0.37]} s={[1.84, 0.5, 0.04]} c={shade(c, -0.08)} />
      <Box p={[0, 0.47, 0.393]} s={[1.84, 0.05, 0.008]} c={BRAND} emissive={BRAND} emissiveIntensity={0.5} shadow={false} />
      {/* Monitor, turned towards the staff seat. */}
      <group position={[-0.55, 0.625, -0.1]} rotation={[0, -0.45, 0]}>
        <Box p={[0, 0.01, 0]} s={[0.24, 0.02, 0.15]} c={DARK} />
        <Box p={[0, 0.13, 0.02]} s={[0.05, 0.22, 0.04]} c={DARK} />
        <Box p={[0, 0.36, 0]} s={[0.64, 0.38, 0.04]} c="#1d1f24" />
        <Box p={[0, 0.36, -0.022]} s={[0.58, 0.32, 0.004]} c="#2b3a67" emissive="#3a5fd9" emissiveIntensity={0.45} shadow={false} />
      </group>
      <Box p={[0, 0.635, -0.27]} s={[0.46, 0.02, 0.14]} c="#e8e8ee" />
      <Box p={[0.36, 0.632, -0.25]} s={[0.07, 0.015, 0.11]} c="#e8e8ee" />
      <Cyl p={[0.72, 0.675, -0.25]} rad={0.045} h={0.1} c="#ef476f" />
      {/* A bell on the customer's side, and the desk's number. */}
      <Cyl p={[0.5, 0.632, 0.22]} rad={0.07} h={0.02} c={DARK} />
      <Ball p={[0.5, 0.645, 0.22]} s={[0.06, 0.05, 0.06]} c="#ffd166" metalness={0.6} roughness={0.3} />
      <DeskSign itemId={item.id} />
      <group position={[0, 0, -1]}>
        <Chair c="#2b2d42" />
      </group>
      <group position={[0, 0, 1]} rotation={[0, Math.PI, 0]}>
        <VisitorChair c={BRAND} />
      </group>
    </group>
  );
}

// ---------- Aquarium ----------

/** A fish facing +x: a body and a flat tail. */
const fishGeo = (() => {
  const body = new THREE.SphereGeometry(1, 10, 6).scale(1, 0.5, 0.3);
  const tail = new THREE.ConeGeometry(0.5, 0.6, 4)
    .rotateZ(-Math.PI / 2)
    .scale(1, 1, 0.15)
    .translate(-1.15, 0, 0);
  const g = mergeGeometries([body.toNonIndexed(), tail.toNonIndexed()])!;
  body.dispose();
  tail.dispose();
  return g;
})();
const bubbleGeo = new THREE.SphereGeometry(1, 8, 6);

interface Swimmer {
  species: number;
  scale: [number, number, number];
  /** Swims back and forth over ±rx, weaving ±rz about cz, at height y. */
  y: number;
  rx: number;
  cz: number;
  rz: number;
  speed: number;
  phase: number;
}

// A school of tetras, some guppies and angelfish in the middle, and corydoras along the bottom.
const SWIMMERS: Swimmer[] = [
  ...[0, 1, 2, 3, 4, 5].map((i) => ({ species: 0, scale: [0.085, 0.085, 0.09] as Swimmer['scale'], y: 1.16 + (i % 3) * 0.06, rx: 1.05, cz: -0.06 + (i % 2) * 0.12, rz: 0.12, speed: 0.55, phase: i * 0.1 })),
  ...[0, 1, 2].map((i) => ({ species: 1, scale: [0.08, 0.085, 0.09] as Swimmer['scale'], y: 1.34 - i * 0.13, rx: 0.95 - i * 0.15, cz: 0.12 - i * 0.12, rz: 0.15, speed: 0.4 + i * 0.07, phase: 1.7 + i * 2.1 })),
  ...[0, 1].map((i) => ({ species: 2, scale: [0.11, 0.21, 0.1] as Swimmer['scale'], y: 1.08 + i * 0.16, rx: 0.75, cz: i ? 0.15 : -0.15, rz: 0.08, speed: 0.22 + i * 0.05, phase: 0.8 + i * 2.6 })),
  ...[0, 1].map((i) => ({ species: 3, scale: [0.09, 0.09, 0.1] as Swimmer['scale'], y: 0.84, rx: 0.95, cz: i ? 0.2 : -0.2, rz: 0.06, speed: 0.15 + i * 0.04, phase: 3.1 * i })),
];
const BUBBLES = 6;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

/** Fish swimming around, and bubbles rising from a stone in the corner. */
function Fish() {
  const opacity = useContext(OpacityContext);
  const fish = useRef<THREE.InstancedMesh>(null);
  const bubbles = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = fish.current;
    if (!mesh) return;
    SWIMMERS.forEach((s, i) => mesh.setColorAt(i, color.set(FISH[s.species].color)));
    // Guppies come in a few colours.
    mesh.setColorAt(SWIMMERS.findIndex((s) => s.species === 1) + 1, color.set('#ffd166'));
    mesh.setColorAt(SWIMMERS.findIndex((s) => s.species === 1) + 2, color.set('#ef476f'));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, []);
  useFrame(({ clock }) => {
    const t = reducedMotion.matches ? 0 : clock.elapsedTime;
    const mesh = fish.current;
    if (mesh) {
      SWIMMERS.forEach((s, i) => {
        const a = t * s.speed + s.phase;
        dummy.position.set(s.rx * Math.sin(a), s.y + 0.03 * Math.sin(t * 1.3 + s.phase * 5), s.cz + s.rz * Math.sin(2 * a));
        // Heading where it's going, with a little wag.
        const dx = s.rx * Math.cos(a);
        const dz = 2 * s.rz * Math.cos(2 * a);
        dummy.rotation.set(0, Math.atan2(-dz, dx) + 0.12 * Math.sin(t * 9 + i), 0);
        dummy.scale.set(...s.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    const b = bubbles.current;
    if (b) {
      b.visible = !reducedMotion.matches;
      for (let i = 0; i < BUBBLES; i++) {
        const k = (t * 0.45 + i / BUBBLES) % 1;
        dummy.position.set(1.22 + 0.02 * Math.sin(t * 5 + i), 0.82 + k * 0.66, -0.28 + 0.015 * Math.cos(t * 4 + i));
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(0.012 + k * 0.01);
        dummy.updateMatrix();
        b.setMatrixAt(i, dummy.matrix);
      }
      b.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <>
      <instancedMesh
        ref={fish}
        args={[fishGeo, undefined, SWIMMERS.length]}
        material={mat('#ffffff', { opacity, roughness: 0.4 })}
        frustumCulled={false}
        raycast={noRaycast}
      />
      <instancedMesh
        ref={bubbles}
        args={[bubbleGeo, undefined, BUBBLES]}
        material={mat('#e8f7ff', { opacity: 0.7 * opacity, roughness: 0.1 })}
        frustumCulled={false}
        raycast={noRaycast}
      />
    </>
  );
}

// Clumps of long leaves: where each clump grows and how tall it is.
const CLUMPS: [x: number, z: number, h: number][] = [
  [-1.2, -0.25, 0.42],
  [-0.35, 0.25, 0.3],
  [0.95, 0.2, 0.38],
  [1.25, -0.2, 0.26],
];
const LEAVES = CLUMPS.length * 3;

/** Water plants, drawn together (a tank has a dozen leaves). */
function WaterPlants() {
  const opacity = useContext(OpacityContext);
  const leaves = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = leaves.current;
    if (!mesh) return;
    CLUMPS.forEach(([x, z, h], i) =>
      [-0.5, 0, 0.5].forEach((lean, j) => {
        dummy.position.set(x + lean * h * 0.4, 0.78 + h / 2, z);
        dummy.rotation.set(0, j * 0.9, -lean);
        dummy.scale.set(0.03, h / 2, 0.05);
        dummy.updateMatrix();
        mesh.setMatrixAt(i * 3 + j, dummy.matrix);
        mesh.setColorAt(i * 3 + j, color.set((i + j) % 2 ? '#3a9d5d' : '#5cbf6e'));
      }),
    );
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, []);
  return <instancedMesh ref={leaves} args={[bubbleGeo, undefined, LEAVES]} material={mat('#ffffff', { opacity, roughness: 0.6 })} raycast={noRaycast} />;
}

/** A long fish tank on a cabinet, glass all round, so it can stand in the middle of a room. */
export function Aquarium() {
  return (
    <group>
      <Box p={[0, 0.35, 0]} s={[3, 0.7, 1]} c="#2f3238" />
      {[-0.75, 0.75].map((x) => (
        <Box key={x} p={[x, 0.36, 0.501]} s={[1.42, 0.58, 0.004]} c="#3a3e46" shadow={false} />
      ))}
      {/* Frame: bottom, corners and the rim round the top, with a light across it. */}
      <Box p={[0, 0.72, 0]} s={[3, 0.04, 1]} c="#16181d" />
      {[-1.48, 1.48].flatMap((x) => [-0.48, 0.48].map((z) => <Box key={`${x}${z}`} p={[x, 1.12, z]} s={[0.04, 0.8, 0.04]} c="#16181d" />))}
      {[-0.48, 0.48].map((z) => (
        <Box key={z} p={[0, 1.53, z]} s={[3, 0.04, 0.04]} c="#16181d" />
      ))}
      {[-1.48, 1.48].map((x) => (
        <Box key={x} p={[x, 1.53, 0]} s={[0.04, 0.04, 1]} c="#16181d" />
      ))}
      <Box p={[0, 1.56, 0]} s={[2.9, 0.03, 0.14]} c="#2d2f36" />
      <Box p={[0, 1.54, 0]} s={[2.8, 0.006, 0.1]} c="#e0f4ff" emissive="#e0f4ff" emissiveIntensity={1.4} shadow={false} />
      {/* Gravel, stones, driftwood, water plants and fish (left out of the hover outline). */}
      <group userData={{ noOutline: true }}>
        <Box p={[0, 0.76, 0]} s={[2.92, 0.05, 0.92]} c="#c9b18a" shadow={false} />
        <Ball p={[-0.9, 0.82, 0.15]} s={[0.16, 0.09, 0.12]} c="#8d939c" />
        <Ball p={[0.55, 0.8, -0.2]} s={[0.12, 0.07, 0.1]} c="#a3a9b2" />
        <Cyl p={[0.1, 0.84, -0.1]} r={[0, 0.5, 1.25]} rad={0.035} h={0.8} c="#6b4f3f" top={0.6} seg={6} />
        <WaterPlants />
        <Fish />
        {/* The water, drawn last over the fish. */}
        <Box p={[0, 1.11, 0]} s={[2.92, 0.74, 0.92]} c="#2a8fc4" o={0.5} emissive="#0b4f70" emissiveIntensity={0.4} roughness={0.05} shadow={false} />
      </group>
    </group>
  );
}

// ---------- Info board ----------

const FACE_W = 600;
const FACE_H = 400;
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const faceGeo = new THREE.PlaneGeometry(1.8, 1.2);

/** Breaks text into lines that fit `width` (paragraphs on their own lines; '' marks a gap). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  text.split(/\n+/).forEach((paragraph, i) => {
    if (i) lines.push('');
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  });
  return lines;
}

/** Shortens `text` with an ellipsis until it fits `width`. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function drawBoard(ctx: CanvasRenderingContext2D, c: string, title: string, text: string): void {
  ctx.fillStyle = '#fbfaf6';
  ctx.fillRect(0, 0, FACE_W, FACE_H);
  ctx.fillStyle = c;
  ctx.fillRect(0, 0, FACE_W, 92);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  let size = 44;
  ctx.font = `700 ${size}px ${FONT}`;
  while (size > 28 && ctx.measureText(title).width > FACE_W - 56) {
    size -= 2;
    ctx.font = `700 ${size}px ${FONT}`;
  }
  ctx.fillText(fit(ctx, title || 'Info', FACE_W - 56), 28, 48);
  ctx.fillStyle = '#2b2d36';
  ctx.font = `500 23px ${FONT}`;
  const lines = wrap(ctx, text, FACE_W - 56);
  const max = 9;
  lines.slice(0, max).forEach((line, i) => {
    const last = i === max - 1 && lines.length > max;
    ctx.fillText(last ? fit(ctx, `${line}…`, FACE_W - 56) : line, 28, 126 + i * 30);
  });
}

/** The picture on a board's face. */
function useFaceTexture(c: string, title: string, text: string): THREE.CanvasTexture {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = FACE_W;
    canvas.height = FACE_H;
    drawBoard(canvas.getContext('2d')!, c, title, text);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [c, title, text]);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/** A sign on two posts: a coloured header with its title, and its text below. */
export function InfoBoard({ item, c }: ItemModelProps) {
  const data = sanitizeBoardData(item.data);
  const opacity = useContext(OpacityContext);
  const map = useFaceTexture(c, data?.title ?? '', data?.text ?? '');
  const material = useMemo(() => new THREE.MeshStandardMaterial({ map, roughness: 0.7 }), [map]);
  useEffect(() => () => material.dispose(), [material]);
  const opaque = opacity >= 0.99;
  if (material.opacity !== opacity || material.transparent === opaque) {
    material.opacity = opacity;
    material.transparent = !opaque;
    material.depthWrite = opaque;
    material.needsUpdate = true;
  }
  return (
    <group>
      {[-0.93, 0.93].map((x) => (
        <group key={x}>
          <Box p={[x, 0.02, 0]} s={[0.12, 0.04, 0.42]} c={DARK} />
          <Box p={[x, 0.98, -0.03]} s={[0.05, 1.94, 0.05]} c={METAL} />
        </group>
      ))}
      <Box p={[0, 1.33, -0.03]} s={[1.92, 1.32, 0.05]} c={shade(c, -0.2)} rounded />
      <mesh geometry={faceGeo} material={material} position={[0, 1.33, -0.002]} receiveShadow />
    </group>
  );
}
