import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { getEntry } from '../../../shared/catalog';
import { sanitizeItem, ZONE_COLORS } from '../../../shared/office';
import type { OfficeItem } from '../../../shared/types';
import { getSession } from '../lib/session';
import { canBuild, getState, setState, toast, useStore } from '../state/store';
import { isTyping } from './input';
import { ItemView, useDrag } from './Items';
import { walkTo } from './movement';

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const invisible = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
const footprintMat = new THREE.MeshBasicMaterial({ color: '#5b6cff', transparent: true, opacity: 0.25, depthWrite: false });

function placementFor(type: string, rot: number, x: number, z: number): OfficeItem | null {
  const office = getState().office;
  if (!office) return null;
  return sanitizeItem({ id: 'ghost', type, x, z, rot }, office.settings);
}

interface ZoneDraft {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

function zoneRect(d: ZoneDraft, width: number, depth: number) {
  const x = Math.max(0, Math.floor(Math.min(d.x0, d.x1)));
  const z = Math.max(0, Math.floor(Math.min(d.z0, d.z1)));
  const x2 = Math.min(width, Math.max(x + 1, Math.ceil(Math.max(d.x0, d.x1))));
  const z2 = Math.min(depth, Math.max(z + 1, Math.ceil(Math.max(d.z0, d.z1))));
  return { x, z, w: x2 - x, d: z2 - z };
}

function rotateSelected(): void {
  const { office, build } = getState();
  if (build.tool === 'place') {
    setState({ build: { ...build, rot: (build.rot + 1) % 4 } });
    return;
  }
  const item = office?.items.find((i) => i.id === build.selectedId);
  if (item) getSession()?.edit({ t: 'update', item: { ...item, rot: (item.rot + 1) % 4 } });
}

function deleteSelected(): void {
  const { build } = getState();
  if (build.selectedId) getSession()?.edit({ t: 'remove', id: build.selectedId });
  else if (build.selectedZoneId) getSession()?.edit({ t: 'zone:remove', id: build.selectedZoneId });
}

function duplicateSelected(): void {
  const { office, build } = getState();
  const item = office?.items.find((i) => i.id === build.selectedId);
  if (!item || !office) return;
  const entry = getEntry(item.type)!;
  const copy = { ...item, id: newId('i'), x: item.x + (item.rot % 2 ? entry.d : entry.w) };
  if (getSession()?.edit({ t: 'add', item: copy })) setState({ build: { ...build, selectedId: copy.id } });
}

export const buildActions = { rotateSelected, deleteSelected, duplicateSelected };

/**
 * Invisible plane under everything that turns pointer input into actions:
 * click-to-walk while playing; placing, dragging and zone drawing while building.
 */
export function Ground() {
  const settings = useStore((s) => s.office!.settings);
  const mode = useStore((s) => s.mode);
  const build = useStore((s) => s.build);
  const [ghost, setGhost] = useState<OfficeItem | null>(null);
  const [dragItem, setDragItem] = useState<OfficeItem | null>(null);
  const [zoneDraft, setZoneDraft] = useState<ZoneDraft | null>(null);
  const zoneRef = useRef<ZoneDraft | null>(null);
  const dragRef = useRef<OfficeItem | null>(null);
  zoneRef.current = zoneDraft;
  dragRef.current = dragItem;

  const building = mode === 'build';
  const placing = building && build.tool === 'place' && !!build.placeType;

  useEffect(() => {
    if (!placing) setGhost(null);
  }, [placing]);

  const commitDrag = () => {
    const original = useDrag.getState().item;
    const moved = dragRef.current;
    dragRef.current = null;
    useDrag.setState({ item: null, moved: false });
    setDragItem(null);
    document.body.style.cursor = '';
    if (original && moved && (moved.x !== original.x || moved.z !== original.z)) {
      getSession()?.edit({ t: 'update', item: { ...original, x: moved.x, z: moved.z } });
    }
  };

  const commitZone = () => {
    const draft = zoneRef.current;
    zoneRef.current = null;
    setZoneDraft(null);
    const office = getState().office;
    if (!draft || !office) return;
    const rect = zoneRect(draft, office.settings.width, office.settings.depth);
    if (rect.w * rect.d < 2) {
      toast('Drag across the floor to draw a private area.');
      return;
    }
    const zone = {
      id: newId('z'),
      name: `Private area ${office.zones.length + 1}`,
      color: ZONE_COLORS[office.zones.length % ZONE_COLORS.length],
      ...rect,
    };
    if (getSession()?.edit({ t: 'zone:add', zone })) {
      setState((s) => ({ build: { ...s.build, tool: 'select', selectedZoneId: zone.id, selectedId: null } }));
    }
  };

  // Finish drags even if the pointer is released outside the canvas.
  useEffect(() => {
    const up = () => {
      if (useDrag.getState().item) commitDrag();
      if (zoneRef.current) commitZone();
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  });

  // Build-mode keyboard shortcuts.
  useEffect(() => {
    if (!building) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping()) return;
      if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey) rotateSelected();
      else if (e.code === 'Delete' || e.code === 'Backspace') deleteSelected();
      else if (e.code === 'KeyD' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        duplicateSelected();
      } else if (e.code === 'Escape') {
        setState((s) => ({ build: { ...s.build, tool: 'select', placeType: null, selectedId: null, selectedZoneId: null } }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [building]);

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (!building) return;
    const p = e.point;
    const d = useDrag.getState();
    if (d.item) {
      const next = placementFor(d.item.type, d.item.rot, p.x + d.offsetX, p.z + d.offsetZ);
      const current = dragRef.current ?? d.item;
      if (next && (next.x !== current.x || next.z !== current.z)) {
        const moved = { ...d.item, x: next.x, z: next.z };
        dragRef.current = moved;
        setDragItem(moved);
        if (!d.moved) useDrag.setState({ moved: true });
        document.body.style.cursor = 'grabbing';
      }
    } else if (placing) {
      const next = placementFor(build.placeType!, build.rot, p.x, p.z);
      if (next && (next.x !== ghost?.x || next.z !== ghost?.z || next.rot !== ghost?.rot || next.type !== ghost?.type)) setGhost(next);
    } else if (zoneRef.current) {
      setZoneDraft({ ...zoneRef.current, x1: p.x, z1: p.z });
    }
  };

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (!building || e.button !== 0) return;
    if (build.tool === 'zone') {
      if (!canBuild()) return;
      setZoneDraft({ x0: e.point.x, z0: e.point.z, x1: e.point.x, z1: e.point.z });
    } else if (build.tool === 'select') {
      setState((s) => ({ build: { ...s.build, selectedId: null, selectedZoneId: null } }));
    }
  };

  const onUp = () => {
    if (useDrag.getState().item) commitDrag();
    else if (zoneRef.current) commitZone();
  };

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 5) return;
    if (!building) {
      walkTo(e.point.x, e.point.z);
      return;
    }
    if (placing) {
      const item = placementFor(build.placeType!, build.rot, e.point.x, e.point.z);
      if (item) getSession()?.edit({ t: 'add', item: { ...item, id: newId('i') } });
    }
  };

  const draft = zoneDraft ? zoneRect(zoneDraft, settings.width, settings.depth) : null;
  const ghostEntry = ghost ? getEntry(ghost.type) : null;
  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[settings.width / 2, 0, settings.depth / 2]}
        material={invisible}
        onPointerMove={onMove}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onClick={onClick}
      >
        <planeGeometry args={[settings.width + 40, settings.depth + 40]} />
      </mesh>
      {ghost && ghostEntry && (
        <group>
          <ItemView item={ghost} interactive={false} opacity={0.55} />
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[ghost.x, 0.02, ghost.z]}
            material={footprintMat}
            scale={ghost.rot % 2 ? [ghostEntry.d, ghostEntry.w, 1] : [ghostEntry.w, ghostEntry.d, 1]}
            raycast={() => null}
          >
            <planeGeometry />
          </mesh>
        </group>
      )}
      {dragItem && <ItemView item={dragItem} interactive={false} opacity={0.75} selected />}
      {draft && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[draft.x + draft.w / 2, 0.025, draft.z + draft.d / 2]} material={footprintMat} raycast={() => null}>
          <planeGeometry args={[draft.w, draft.d]} />
        </mesh>
      )}
    </group>
  );
}
