import { Edges } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { memo, useRef, useState } from 'react';
import * as THREE from 'three';
import { create } from 'zustand';
import { getEntry, seatsOf } from '../../../shared/catalog';
import { itemFootprint } from '../../../shared/geometry';
import type { OfficeItem } from '../../../shared/types';
import { local } from '../lib/positions';
import { canBuild, getState, setState, useStore } from '../state/store';
import { offeredInteraction, useItemDecor } from './extensions';
import { ItemModel } from './models';
import { walkTo } from './movement';
import { OpacityContext } from './prims';

/**
 * Item grabbed in build mode. Once it has actually moved (`moved`), it's hidden from the
 * normal item list and drawn at the pointer instead.
 */
export const useDrag = create<{ item: OfficeItem | null; offsetX: number; offsetZ: number; moved: boolean }>(() => ({
  item: null,
  offsetX: 0,
  offsetZ: 0,
  moved: false,
}));

function onItemPointerDown(e: ThreeEvent<PointerEvent>, item: OfficeItem) {
  const { mode, build } = getState();
  if (mode !== 'build' || e.button !== 0 || build.tool === 'zone') return;
  e.stopPropagation();
  if (build.tool === 'place') return; // Placing on top of other items is handled by the ground.
  if (!canBuild()) return;
  setState({ build: { ...build, selectedId: item.id, selectedZoneId: null } });
  useDrag.setState({ item, offsetX: item.x - e.point.x, offsetZ: item.z - e.point.z, moved: false });
}

function onItemClick(e: ThreeEvent<MouseEvent>, item: OfficeItem) {
  if (getState().mode !== 'play' || e.delta > 5) return;
  const interaction = offeredInteraction(item.type, getState());
  if (interaction) {
    e.stopPropagation();
    interaction.onClick(item);
    return;
  }
  if (getEntry(item.type)?.music) {
    e.stopPropagation();
    setState({ panel: 'music', musicItemId: item.id, mode: 'play' });
    return;
  }
  const seats = seatsOf(item);
  if (!seats.length) return;
  e.stopPropagation();
  // Walk to the closest free seat of this item and sit down.
  const seat = seats.sort((a, b) => Math.hypot(a.x - local.x, a.z - local.z) - Math.hypot(b.x - local.x, b.z - local.z))[0];
  walkTo(seat.x, seat.z, { ...seat, itemId: item.id });
}

function setCursor(cursor: string) {
  document.body.style.cursor = cursor;
}

const hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });

/** Invisible box over the item's whole footprint so it's easy to grab in build mode. */
function HitBox({ type }: { type: string }) {
  const entry = getEntry(type);
  if (!entry) return null;
  const h = Math.max(entry.h, 0.15);
  return (
    <mesh position={[0, h / 2, 0]} scale={[entry.w, h, Math.max(entry.d, 0.3)]} material={hitMaterial}>
      <boxGeometry />
    </mesh>
  );
}

function SelectionBox({ item }: { item: OfficeItem }) {
  const entry = getEntry(item.type);
  if (!entry) return null;
  const h = Math.max(entry.h, 0.1);
  return (
    <mesh position={[0, h / 2, 0]} scale={[entry.w + 0.08, h + 0.04, entry.d + 0.08]} raycast={() => null}>
      <boxGeometry />
      <meshBasicMaterial color="#5b6cff" transparent opacity={0.12} depthWrite={false} />
      <Edges color="#5b6cff" />
    </mesh>
  );
}

export const ItemView = memo(function ItemView({
  item,
  faded = false,
  selected = false,
  interactive = true,
  opacity = 1,
}: {
  item: OfficeItem;
  faded?: boolean;
  selected?: boolean;
  interactive?: boolean;
  opacity?: number;
}) {
  const building = useStore((s) => s.mode === 'build');
  const entry = getEntry(item.type);
  const interaction = useStore((s) => offeredInteraction(item.type, s));
  const decor = useItemDecor().filter((d) => d.types.includes(item.type));
  const sittable = !!entry?.seats || !!entry?.music || !!interaction;
  const hoverable = interactive && (building || sittable);
  const hover = (e: ThreeEvent<PointerEvent>, on: boolean) => {
    setCursor(on ? (building ? 'grab' : 'pointer') : '');
    if (building || !interaction?.onHover) return;
    // Only the nearest item under the pointer counts as hovered (e.g. a plant on a desk).
    e.stopPropagation();
    interaction.onHover(item, on);
  };
  return (
    <group
      position={[item.x, 0, item.z]}
      rotation={[0, (item.rot * Math.PI) / 2, 0]}
      onPointerDown={interactive && building ? (e) => onItemPointerDown(e, item) : undefined}
      onClick={interactive && !building && sittable ? (e) => onItemClick(e, item) : undefined}
      onPointerOver={hoverable ? (e) => hover(e, true) : undefined}
      onPointerOut={hoverable ? (e) => hover(e, false) : undefined}
    >
      <OpacityContext.Provider value={(faded ? 0.18 : 1) * opacity}>
        <ItemModel type={item.type} color={item.color} itemId={item.id} data={item.data} item={item} />
        {interactive && decor.map((d) => <d.Component key={d.id} item={item} />)}
      </OpacityContext.Provider>
      {interactive && building && <HitBox type={item.type} />}
      {selected && <SelectionBox item={item} />}
    </group>
  );
});

const ray = new THREE.Ray();
const box = new THREE.Box3();
const hit = new THREE.Vector3();
const head = new THREE.Vector3();

function sameSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** All furniture. Tall items between the camera and your character fade out. */
export function Items() {
  const items = useStore((s) => s.office?.items ?? []);
  const selectedId = useStore((s) => (s.mode === 'build' ? s.build.selectedId : null));
  const dragId = useDrag((s) => (s.moved ? s.item?.id ?? null : null));
  const camera = useThree((s) => s.camera);
  const [faded, setFaded] = useState<Set<string>>(() => new Set());
  const elapsed = useRef(0);

  useFrame((_, dt) => {
    elapsed.current += dt;
    if (elapsed.current < 0.1) return;
    elapsed.current = 0;
    head.set(local.x, 0.9, local.z);
    const dist = camera.position.distanceTo(head);
    ray.origin.copy(camera.position);
    ray.direction.copy(head).sub(camera.position).normalize();
    const next = new Set<string>();
    for (const item of items) {
      const entry = getEntry(item.type);
      if (!entry?.tall) continue;
      const fp = itemFootprint(item)!;
      box.min.set(fp.minX - 0.25, 0, fp.minZ - 0.25);
      box.max.set(fp.maxX + 0.25, entry.h, fp.maxZ + 0.25);
      if (ray.intersectBox(box, hit) && camera.position.distanceTo(hit) < dist - 0.4) next.add(item.id);
    }
    if (!sameSet(next, faded)) setFaded(next);
  });

  return (
    <group>
      {items.map((item) =>
        item.id === dragId ? null : <ItemView key={item.id} item={item} faded={faded.has(item.id)} selected={item.id === selectedId} />,
      )}
    </group>
  );
}
