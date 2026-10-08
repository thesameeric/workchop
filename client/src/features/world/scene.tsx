import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useShallow } from 'zustand/react/shallow';
import { getEntry, rotateLocal, seatsOf } from '../../../../shared/catalog';
import { PLANTS } from '../../../../shared/plants';
import type { Office, OfficeItem } from '../../../../shared/types';
import {
  areaAt,
  areaCells,
  darkAreas,
  deskOf,
  deskOwner,
  isLamp,
  isLightOn,
  LAMP_TYPES,
  pairChairsWithDesks,
  surfaceHeight,
  SWITCH_TYPE,
} from '../../../../shared/world';
import { local, remoteTargets } from '../../lib/positions';
import { getState, useStore } from '../../state/store';
import { registerItemDecor, registerItemModel } from '../../world/extensions';
import { registerSceneLayer } from '../../world/layers';
import { ItemModel } from '../../world/models';
import { walkTo } from '../../world/movement';
import { officeData } from '../../world/officeCache';
import { boxGeo, mat } from '../../world/prims';
import { DESK_LAMP_BULB, DeskLamp, LightSwitch, PLANT_MODELS, useBulb } from './models';
import { hasNewFailure, useGithub } from '../github/state';
import { useShownApp } from '../presence/state';
import { appInfo, clockTime, drawBoot, drawScreen, type ScreenContent } from './screen';
import { cardAnchor, openCard, sceneActions, useWorld } from './state';

// The 3D side of the world feature, loaded with the scene: models, lit monitors, name plates and
// sticky notes on desks, lamp glow, darkened areas, and the card that follows a clicked item.

for (const [type, Model] of Object.entries(PLANT_MODELS)) registerItemModel(type, Model);
registerItemModel('desk-lamp', DeskLamp);
registerItemModel(SWITCH_TYPE, LightSwitch);

// ---------- Desk monitors ----------

let pairsFor: OfficeItem[] | null = null;
let pairs = new Map<string, string>();

/** Which desk each chair works at, recomputed when the furniture changes. */
function chairDesks(office: Office): Map<string, string> {
  if (office.items !== pairsFor) {
    pairsFor = office.items;
    pairs = pairChairsWithDesks(office.items);
  }
  return pairs;
}

/** Walk to your desk's chair and sit down (or just to the desk, if it has none). */
sceneActions.sitAtDesk = (deskId) => {
  const office = getState().office;
  const desk = office?.items.find((i) => i.id === deskId);
  if (!office || !desk) return;
  const chairId = [...chairDesks(office)].find(([, d]) => d === deskId)?.[0];
  const seat = chairId ? seatsOf(office.items.find((i) => i.id === chairId)!)[0] : undefined;
  if (seat && chairId) {
    walkTo(seat.x, seat.z, { ...seat, itemId: chairId });
  } else {
    const front = rotateLocal(0, 1, desk.rot);
    walkTo(desk.x + front.x, desk.z + front.z);
  }
};

const sameRecord = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/** Notices who sits at which desk (you, or others sitting on its chair) and turns monitors on and off. */
function SitterTracker() {
  const seen = useRef(new Map<string, { who: string; at: number }>());
  const timer = useRef(0);
  useFrame((_, dt) => {
    timer.current += dt;
    if (timer.current < 0.2) return;
    timer.current = 0;
    const office = getState().office;
    if (!office) return;
    const desks = chairDesks(office);
    const { seats } = officeData(office);
    const now = performance.now();
    const sitting = new Map<string, string>();
    const deskAt = local.seat && desks.get(local.seat.itemId);
    if (deskAt) sitting.set(deskAt, 'self');
    for (const [id, t] of remoteTargets) {
      if (t.anim !== 'sit') continue;
      let chair: string | null = null;
      let best = 0.35;
      for (const s of seats) {
        const d = Math.hypot(s.x - t.x, s.z - t.z);
        if (d < best) {
          best = d;
          chair = s.itemId;
        }
      }
      const desk = chair && desks.get(chair);
      if (desk && !sitting.has(desk)) sitting.set(desk, id);
    }
    for (const [desk, who] of sitting) seen.current.set(desk, { who, at: now });
    // Monitors stay on for a second after their person stands up.
    const screens: Record<string, string> = {};
    for (const [desk, s] of seen.current) {
      if (now - s.at < 1000) screens[desk] = s.who;
      else seen.current.delete(desk);
    }
    if (!sameRecord(screens, useWorld.getState().screens)) useWorld.setState({ screens });
  });
  return null;
}

const SCREEN_W = 384;
const SCREEN_H = 202;
const screenGeo = new THREE.PlaneGeometry(0.8, 0.42);
const glowGeo = new THREE.PlaneGeometry(1, 1);

/** A soft radial spot, for glows and pools of light. */
const spotTexture = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

/** The monitor of a desk someone sits at: it wakes up (glow, logo), then shows their app or wallpaper. */
function DeskScreen({ item }: { item: OfficeItem }) {
  const who = useWorld((s) => s.screens[item.id] ?? null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (who) setShown(true);
  }, [who]);
  if (!who && !shown) return null;
  return <Screen who={who} onOff={() => setShown(false)} />;
}

function Screen({ who, onOff }: { who: string | null; onOff: () => void }) {
  const parts = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true });
    material.color.setScalar(0);
    const glow = new THREE.MeshBasicMaterial({ map: spotTexture, color: '#7f9cff', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    return { ctx: canvas.getContext('2d')!, texture, material, glow };
  }, []);
  useEffect(
    () => () => {
      parts.texture.dispose();
      parts.material.dispose();
      parts.glow.dispose();
    },
    [parts],
  );

  const name = useStore((s) => (who === 'self' ? s.me.name : who ? s.players[who]?.name : '')) ?? '';
  // Only what their name tag shows (nothing when they don't share it): then it's the wallpaper.
  const app = appInfo(useShownApp(who, who === 'self'));
  const [time, setTime] = useState(clockTime);
  useEffect(() => {
    const t = setInterval(() => setTime(clockTime()), 15_000);
    return () => clearInterval(t);
  }, []);

  const content = useRef<ScreenContent>({ name, app, time });
  content.current = { name, app, time };
  const power = useRef({ level: 0, bootAt: -1, booted: false });
  const key = `${name}|${app?.label}|${app?.color}|${time}`;
  useEffect(() => {
    if (!power.current.booted) return;
    drawScreen(parts.ctx, SCREEN_W, SCREEN_H, content.current);
    parts.texture.needsUpdate = true;
  }, [key, parts]);

  useFrame(({ clock }, dt) => {
    const p = power.current;
    const t = clock.elapsedTime;
    if (who) {
      if (p.bootAt < 0) {
        p.bootAt = t;
        p.booted = false;
        drawBoot(parts.ctx, SCREEN_W, SCREEN_H);
        parts.texture.needsUpdate = true;
      }
      const since = t - p.bootAt;
      if (!p.booted && since > 0.8) {
        p.booted = true;
        drawScreen(parts.ctx, SCREEN_W, SCREEN_H, content.current);
        parts.texture.needsUpdate = true;
      }
      // Glow ramps up over a quarter second, with a brief flicker as the logo appears.
      p.level = since < 0.25 ? since / 0.25 : since < 0.35 ? 0.75 : 1;
    } else {
      p.bootAt = -1;
      p.level = Math.max(0, p.level - dt / 0.3);
      if (p.level === 0) {
        onOff();
        return;
      }
    }
    parts.material.color.setScalar(p.level);
    parts.glow.opacity = p.level * 0.22;
  });

  return (
    <>
      <mesh geometry={screenGeo} material={parts.material} position={[0, 0.98, -0.2742]} renderOrder={3} />
      <mesh geometry={glowGeo} material={parts.glow} position={[0, 0.632, -0.05]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.2, 0.7, 1]} renderOrder={2} raycast={() => null} />
    </>
  );
}

// ---------- Your monitor's GitHub badge ----------

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const noRaycast = () => null;

// Sprites the same size on screen at any zoom (about 15px), so the badge is seen from across the office.
const badgeMaterial = new THREE.SpriteMaterial({
  map: (() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e5484d';
    ctx.beginPath();
    ctx.arc(32, 32, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 42px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 32, 35);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })(),
  sizeAttenuation: false,
  depthWrite: false,
  toneMapped: false,
});
const badgeGlow = new THREE.SpriteMaterial({ map: spotTexture, color: '#ff4d4f', opacity: 0.45, sizeAttenuation: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });

/**
 * A GitHub Actions run of yours failed: a small red badge pulses on your own desk's monitor (the one
 * you claimed, or else the one you sit at) until you open the GitHub panel or mark the run read or
 * done. Drawn only in your browser.
 */
function CiBadge({ item }: { item: OfficeItem }) {
  const failed = useGithub(hasNewFailure);
  return failed ? <CiBadgeIfMine item={item} /> : null;
}

function CiBadgeIfMine({ item }: { item: OfficeItem }) {
  // The desk you claimed here; null for none (undefined outside an office or signed out).
  const myDesk = useStore((s) => (s.account && s.office ? (deskOf(s.office, s.account.id)?.id ?? null) : undefined));
  const sitting = useWorld((s) => s.screens[item.id] === 'self');
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!group.current) return;
    const beat = reducedMotion.matches ? 0.4 : (Math.sin(clock.elapsedTime * Math.PI * 1.4) + 1) / 2;
    group.current.scale.setScalar(1 + beat * 0.25);
    badgeGlow.opacity = 0.25 + beat * 0.5;
  });
  if (myDesk !== item.id && !(myDesk === null && sitting)) return null;
  return (
    <group ref={group} position={[0.34, 1.13, -0.268]}>
      <sprite material={badgeGlow} scale={0.045} renderOrder={4} raycast={noRaycast} />
      <sprite material={badgeMaterial} scale={0.016} renderOrder={5} raycast={noRaycast} />
    </group>
  );
}

// ---------- Desk name plates and sticky notes ----------

const textures = new Map<string, THREE.CanvasTexture>();

/** A cached canvas texture, drawn once per key. */
function canvasTexture(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  let t = textures.get(key);
  if (!t) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    draw(canvas.getContext('2d')!);
    t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    textures.set(key, t);
  }
  return t;
}

const plateMaterials = new Map<string, THREE.Material[]>();
const plateKey = (name: string, mine: boolean) => `${mine}|${name}`;

/** Frees the plates no desk shows any more (people rename themselves, and each name gets its own). */
function dropUnusedPlates(): void {
  const { office, account } = getState();
  const used = new Set<string>();
  for (const item of office?.items ?? []) {
    const owner = deskOwner(item);
    if (owner) used.add(plateKey(owner.ownerName, account?.id === owner.ownerUserId));
  }
  for (const [key, [, , , , face]] of plateMaterials) {
    if (used.has(key)) continue;
    (face as THREE.MeshStandardMaterial).map?.dispose();
    face.dispose();
    textures.delete(`plate|${key}`);
    plateMaterials.delete(key);
  }
}

function plateMaterial(name: string, mine: boolean): THREE.Material[] {
  const key = plateKey(name, mine);
  let m = plateMaterials.get(key);
  if (!m) {
    dropUnusedPlates();
    const map = canvasTexture(`plate|${key}`, 320, 80, (ctx) => {
      ctx.fillStyle = mine ? '#dfe4ff' : '#f7f3ea';
      ctx.fillRect(0, 0, 320, 80);
      ctx.fillStyle = mine ? '#5b6cff' : '#c8a27a';
      ctx.fillRect(0, 70, 320, 10);
      ctx.fillStyle = '#23262f';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let size = 44;
      ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
      while (size > 22 && ctx.measureText(name).width > 296) {
        size -= 2;
        ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
      }
      let text = name;
      while (text.length > 1 && ctx.measureText(text).width > 296) text = text.slice(0, -1);
      ctx.fillText(text === name ? name : `${text.slice(0, -1)}…`, 160, 37);
    });
    const face = new THREE.MeshStandardMaterial({ map, roughness: 0.55 });
    const edge = mat('#3a3d46');
    m = [edge, edge, edge, edge, face, face];
    plateMaterials.set(key, m);
  }
  return m;
}

/** A name plate on a claimed desk, readable from both sides. */
function Nameplate({ item }: { item: OfficeItem }) {
  const owner = deskOwner(item);
  const mine = useStore((s) => !!owner && s.account?.id === owner.ownerUserId);
  if (!owner) return null;
  return (
    <mesh
      geometry={boxGeo}
      material={plateMaterial(owner.ownerName, mine)}
      position={[0.6, 0.685, 0.33]}
      scale={[0.46, 0.12, 0.03]}
      castShadow
    />
  );
}

function stickyTop(label: string | null): THREE.CanvasTexture {
  return canvasTexture(`sticky|${label}`, 64, 64, (ctx) => {
    ctx.clearRect(0, 0, 64, 64);
    if (label) {
      ctx.fillStyle = '#2b2d36';
      ctx.font = '800 30px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 32, 34);
      return;
    }
    // Scribbles.
    ctx.strokeStyle = 'rgba(40, 42, 54, 0.55)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const [y, w] of [[18, 40], [30, 46], [42, 30]]) {
      ctx.beginPath();
      ctx.moveTo(10, y);
      ctx.bezierCurveTo(10 + w / 3, y - 3, 10 + (2 * w) / 3, y + 3, 10 + w, y);
      ctx.stroke();
    }
  });
}

const stickyTopMaterials = new Map<string, THREE.MeshBasicMaterial>();

function stickyTopMaterial(label: string | null): THREE.MeshBasicMaterial {
  const key = String(label);
  let m = stickyTopMaterials.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ map: stickyTop(label), transparent: true, depthWrite: false });
    stickyTopMaterials.set(key, m);
  }
  return m;
}

/** The notes on a claimed desk: a little stack (the top 5), the top one saying how many more there are. */
function Stickies({ item }: { item: OfficeItem }) {
  const owner = deskOwner(item);
  const summary = useWorld((s) => (owner ? s.stickies[owner.ownerUserId] : undefined));
  if (!owner || !summary?.count) return null;
  const more = summary.count - summary.colors.length;
  const turn = (i: number) => ((i * 37) % 23) / 60 - 0.18;
  const top = summary.colors.length - 1;
  return (
    <group position={[-0.47, 0.627, 0.3]}>
      {summary.colors.map((c, i) => (
        <mesh key={i} geometry={boxGeo} material={mat(c, { roughness: 0.9 })} position={[((i * 13) % 5) * 0.006 - 0.012, 0.003 + i * 0.0045, ((i * 7) % 5) * 0.006 - 0.012]} rotation={[0, turn(i), 0]} scale={[0.16, 0.004, 0.16]} receiveShadow />
      ))}
      <mesh
        geometry={glowGeo}
        material={stickyTopMaterial(more > 0 ? `+${more}` : null)}
        position={[((top * 13) % 5) * 0.006 - 0.012, 0.0055 + top * 0.0045, ((top * 7) % 5) * 0.006 - 0.012]}
        rotation={[-Math.PI / 2, 0, turn(top)]}
        scale={[0.15, 0.15, 1]}
      />
    </group>
  );
}

// ---------- Lamps ----------

const haloMaterial = (opacity: number) =>
  new THREE.SpriteMaterial({ map: spotTexture, color: '#ffcf8a', transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const halo = { lit: haloMaterial(0.45), dark: haloMaterial(0.85) };
const poolMaterial = (opacity: number) =>
  new THREE.MeshBasicMaterial({ map: spotTexture, color: '#ffc46b', transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const pool = { lit: poolMaterial(0.22), dark: poolMaterial(0.5) };

/** Whether the ceiling lights are off where an item stands. */
function useInDark(item: OfficeItem): boolean {
  return useStore((s) => !!s.office && darkAreas(s.office).has(areaAt(s.office.zones, item.x, item.z)));
}

/** A lit lamp's glow, and the warm pool of light under it (they show through darkened areas). */
function LampGlow({ item }: { item: OfficeItem }) {
  const bulb = useBulb(item);
  const dark = useInDark(item);
  if (!isLightOn(item)) return null;
  const floor = item.type === 'floor-lamp';
  const k = dark ? 'dark' : 'lit';
  return (
    <>
      <sprite position={bulb} scale={floor ? [1.5, 1.5, 1] : [0.55, 0.55, 1]} material={halo[k]} renderOrder={2} raycast={noRaycast} />
      <mesh
        geometry={glowGeo}
        material={pool[k]}
        position={floor ? [0, 0.02, 0] : [bulb[0], bulb[1] - DESK_LAMP_BULB[1] + 0.004, bulb[2] + 0.06]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={floor ? [3.4, 3.4, 1] : [0.9, 0.9, 1]}
        renderOrder={2}
        raycast={noRaycast}
      />
    </>
  );
}

const MAX_LAMP_LIGHTS = 2;

/**
 * A couple of real lights, given to the lit lamps nearest to you: each one slows down every lit
 * pixel, even when it's dark, so an office without lamps has none. There are as many as lamps, on or
 * off, so switching a lamp doesn't rebuild every material.
 */
function LampLights() {
  const count = useStore((s) => Math.min(MAX_LAMP_LIGHTS, s.office?.items.filter(isLamp).length ?? 0));
  const lights = useRef<(THREE.PointLight | null)[]>([]);
  const timer = useRef(1);
  useFrame((_, dt) => {
    timer.current += dt;
    if (timer.current < 0.3) return;
    timer.current = 0;
    const office = getState().office;
    const lamps = (office?.items ?? [])
      .filter((i) => isLamp(i) && isLightOn(i))
      .map((i) => ({ i, d: Math.hypot(i.x - local.x, i.z - local.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_LAMP_LIGHTS);
    lights.current.forEach((light, n) => {
      if (!light) return;
      const lamp = lamps[n]?.i;
      if (!lamp || !office) {
        light.intensity = 0;
        return;
      }
      const desk = lamp.type === 'desk-lamp';
      const o = desk ? rotateLocal(DESK_LAMP_BULB[0], DESK_LAMP_BULB[2] + 0.05, lamp.rot) : { x: 0, z: 0 };
      light.position.set(lamp.x + o.x, desk ? surfaceHeight(office.items, lamp) + 0.25 : 1.45, lamp.z + o.z);
      light.intensity = desk ? 0.6 : 2.4;
      light.distance = desk ? 1.6 : 4.5;
    });
  });
  return (
    <>
      {Array.from({ length: count }, (_, n) => (
        <pointLight key={n} ref={(el) => void (lights.current[n] = el)} color="#ffc777" intensity={0} distance={4} decay={2} />
      ))}
    </>
  );
}

// ---------- Darkened areas ----------

const SHADE_H = 2.75;
/** The shade's floor, just under the ground (seen from inside, everything above it is shaded). */
const SHADE_FLOOR = -0.05;
const WALL_T = 0.3;

/** A closed box over an area's floor cells: its top and bottom, and sides only where the area ends. */
function shadeGeometry(cells: { x: number; z: number }[], width: number, depth: number): THREE.BufferGeometry {
  const inArea = new Set(cells.map((c) => `${c.x},${c.z}`));
  const pos: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], normal: [number, number, number]) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const flip = n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2] < 0;
    pos.push(...a, ...(flip ? c : b), ...(flip ? b : c), ...a, ...(flip ? d : c), ...(flip ? c : d));
  };
  for (const { x, z } of cells) {
    // Cells along the office's edge also cover its outer walls.
    const x0 = x === 0 ? -WALL_T : x;
    const x1 = x === width - 1 ? width + WALL_T : x + 1;
    const z0 = z === 0 ? -WALL_T : z;
    const z1 = z === depth - 1 ? depth + WALL_T : z + 1;
    const H = SHADE_H;
    const B = SHADE_FLOOR;
    quad([x0, H, z0], [x1, H, z0], [x1, H, z1], [x0, H, z1], [0, 1, 0]);
    quad([x0, B, z0], [x1, B, z0], [x1, B, z1], [x0, B, z1], [0, -1, 0]);
    if (!inArea.has(`${x - 1},${z}`)) quad([x0, B, z0], [x0, B, z1], [x0, H, z1], [x0, H, z0], [-1, 0, 0]);
    if (!inArea.has(`${x + 1},${z}`)) quad([x1, B, z0], [x1, B, z1], [x1, H, z1], [x1, H, z0], [1, 0, 0]);
    if (!inArea.has(`${x},${z - 1}`)) quad([x0, B, z0], [x1, B, z0], [x1, H, z0], [x0, H, z0], [0, 0, -1]);
    if (!inArea.has(`${x},${z + 1}`)) quad([x0, B, z1], [x1, B, z1], [x1, H, z1], [x0, H, z1], [0, 0, 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** Whether a point is inside an area's shade box (seen from above). */
function shadeContains(cells: { x: number; z: number }[], width: number, depth: number): (x: number, z: number) => boolean {
  const inArea = new Set(cells.map((c) => `${c.x},${c.z}`));
  return (x, z) => {
    if (x < -WALL_T || z < -WALL_T || x > width + WALL_T || z > depth + WALL_T) return false;
    const cx = Math.min(width - 1, Math.max(0, Math.floor(x)));
    const cz = Math.min(depth - 1, Math.max(0, Math.floor(z)));
    return inArea.has(`${cx},${cz}`);
  };
}

/**
 * Darkness over one area, fading in and out. From outside, the faces towards the camera shade
 * what's behind them. With the camera inside the box (zoomed in low), the faces behind everything
 * are drawn instead, only where something nearer is in the box: the depth test is turned around.
 */
function AreaShade({ geometry, contains, dark }: { geometry: THREE.BufferGeometry; contains: (x: number, z: number) => boolean; dark: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color: '#060a1a', transparent: true, opacity: 0, depthWrite: false }), []);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(({ camera }, dt) => {
    const target = dark ? 0.62 : 0;
    material.opacity += (target - material.opacity) * (1 - Math.exp(-dt * 3.5));
    if (Math.abs(target - material.opacity) < 0.002) material.opacity = target;
    const visible = material.opacity > 0.003;
    if (mesh.current) mesh.current.visible = visible;
    if (!visible) return;
    const inside = camera.position.y < SHADE_H && contains(camera.position.x, camera.position.z);
    if (inside !== (material.side === THREE.BackSide)) {
      material.side = inside ? THREE.BackSide : THREE.FrontSide;
      material.depthFunc = inside ? THREE.GreaterDepth : THREE.LessEqualDepth;
      material.needsUpdate = true;
    }
  });
  return <mesh ref={mesh} geometry={geometry} material={material} renderOrder={1} raycast={noRaycast} visible={false} />;
}

/** Areas whose lights are switched off are darkened (lamps and screens still glow through). */
function Darkness() {
  const zones = useStore((s) => s.office?.zones);
  const width = useStore((s) => s.office?.settings.width ?? 0);
  const depth = useStore((s) => s.office?.settings.depth ?? 0);
  const dark = useStore(useShallow((s) => (s.office ? [...darkAreas(s.office)].sort() : [])));
  const shades = useMemo(() => {
    if (!zones) return [];
    return [...areaCells(zones, width, depth)].map(([area, cells]) => ({
      area,
      geometry: shadeGeometry(cells, width, depth),
      contains: shadeContains(cells, width, depth),
    }));
  }, [zones, width, depth]);
  useEffect(() => () => shades.forEach((s) => s.geometry.dispose()), [shades]);
  return (
    <>
      {shades.map(({ area, geometry, contains }) => (
        <AreaShade key={area} geometry={geometry} contains={contains} dark={dark.includes(area)} />
      ))}
    </>
  );
}

// ---------- Hover outline ----------

const outlineMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.BackSide, toneMapped: false });
/** For merged leaves (see models.tsx): pushed out along the normals, the same width everywhere. */
const hullMaterial = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  vertexShader: `
    void main() {
      vec4 p = modelViewMatrix * vec4(position, 1.0);
      p.xyz += normalize(normalMatrix * normal) * 0.012;
      gl_Position = projectionMatrix * p;
    }`,
  fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
});

/** A white rim around the item under the pointer: its model again, a bit bigger, inside out. */
function HoverOutline({ item }: { item: OfficeItem }) {
  const hovered = useWorld((s) => s.hovered === item.id);
  const playing = useStore((s) => s.mode === 'play');
  if (!hovered || !playing) return null;
  return <Outline item={item} />;
}

function Outline({ item }: { item: OfficeItem }) {
  const group = useRef<THREE.Group>(null);
  const done = useRef(new WeakSet<THREE.Object3D>());
  useLayoutEffect(() => {
    group.current?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || done.current.has(mesh)) return;
      done.current.add(mesh);
      if (mesh.userData.hitArea) {
        mesh.visible = false;
        return;
      }
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.raycast = () => {};
      if (mesh.userData.hull) {
        mesh.material = hullMaterial;
        return;
      }
      mesh.material = outlineMaterial;
      mesh.scale.addScalar(0.03);
    });
  });
  return (
    <group ref={group}>
      <ItemModel type={item.type} color={item.color} itemId={item.id} data={item.data} item={item} />
    </group>
  );
}

// ---------- The card next to a clicked item ----------

const projected = new THREE.Vector3();
let view: { camera: THREE.Camera; width: number; height: number } | null = null;

// For automated tests and debugging: where a point of the world is on the screen, and what this
// feature knows.
Object.assign((window as unknown as { __workchop: object }).__workchop, {
  screenPoint(x: number, y: number, z: number) {
    if (!view) return null;
    const p = new THREE.Vector3(x, y, z).project(view.camera);
    return { x: (p.x * 0.5 + 0.5) * view.width, y: (-p.y * 0.5 + 0.5) * view.height };
  },
  world: () => {
    const { screens, stickies, unread, card } = useWorld.getState();
    const office = getState().office;
    return { screens, stickies, unread, card, items: office?.items ?? [], dark: office ? [...darkAreas(office)] : [], at: { x: local.x, z: local.z, seat: local.seat?.itemId ?? null } };
  },
});

/** Keeps the open card next to its item on screen, and closes it when you walk away. */
function CardProjector() {
  useFrame(({ camera, size }) => {
    view = { camera, width: size.width, height: size.height };
    const card = useWorld.getState().card;
    const el = cardAnchor.el;
    if (!card) return;
    const { office, mode } = getState();
    const item = office?.items.find((i) => i.id === card.itemId);
    if (!office || !item || mode !== 'play' || Math.hypot(item.x - local.x, item.z - local.z) > card.maxDistance) {
      openCard(null);
      return;
    }
    if (!el) return;
    // Phones show it as a sheet at the bottom instead.
    if (size.width <= 720) {
      if (el.style.transform) el.style.transform = '';
      return;
    }
    const entry = getEntry(item.type);
    const top = entry?.onSurfaces ? surfaceHeight(office.items, item) + 0.55 : Math.min(entry?.h ?? 1, 2.2) + 0.1;
    projected.set(item.x, top, item.z).project(camera);
    const sx = (projected.x * 0.5 + 0.5) * size.width;
    const sy = (-projected.y * 0.5 + 0.5) * size.height;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    // Above the item; beside it when there's no room under the top bar.
    let left = sx - w / 2;
    let y = sy - h - 16;
    if (y < 64) {
      left = sx + 48 + w < size.width - 12 ? sx + 48 : sx - 48 - w;
      y = sy - h / 3;
    }
    left = clamp(left, 12, size.width - w - 12);
    y = clamp(y, 64, size.height - h - 88);
    const next = `translate3d(${Math.round(left)}px, ${Math.round(y)}px, 0)`;
    if (el.style.transform !== next) el.style.transform = next;
    const visible = projected.z < 1 ? 'visible' : 'hidden';
    if (el.style.visibility !== visible) el.style.visibility = visible;
  });
  return null;
}

// ---------- Registration ----------

const PLANT_TYPES = PLANTS.map((p) => p.type);

registerItemDecor({ id: 'world-screen', order: 10, types: ['desk'], Component: DeskScreen });
registerItemDecor({ id: 'world-ci-badge', order: 15, types: ['desk'], Component: CiBadge });
registerItemDecor({ id: 'world-nameplate', order: 20, types: ['desk'], Component: Nameplate });
registerItemDecor({ id: 'world-stickies', order: 30, types: ['desk'], Component: Stickies });
registerItemDecor({ id: 'world-lamp-glow', order: 40, types: LAMP_TYPES, Component: LampGlow });
registerItemDecor({ id: 'world-outline', order: 50, types: ['desk', ...LAMP_TYPES, SWITCH_TYPE, ...PLANT_TYPES], Component: HoverOutline });

registerSceneLayer({ id: 'world-sitters', order: 20, Component: SitterTracker });
registerSceneLayer({ id: 'world-darkness', order: 30, Component: Darkness });
registerSceneLayer({ id: 'world-lamp-lights', order: 40, Component: LampLights });
registerSceneLayer({ id: 'world-card', order: 50, Component: CardProjector });
