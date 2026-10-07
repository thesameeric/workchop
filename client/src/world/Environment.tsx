import { Grid } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { memo, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { zoneAt } from '../../../shared/geometry';
import type { OfficeSettings, Zone } from '../../../shared/types';
import { shade } from '../lib/color';
import { local } from '../lib/positions';
import { useStore } from '../state/store';
import { OpacityContext, Box } from './prims';
import { floorTexture } from './textures';

export function Lights({ settings }: { settings: OfficeSettings }) {
  const { width, depth } = settings;
  const light = useRef<THREE.DirectionalLight>(null);
  const span = Math.max(width, depth);
  const target = useMemo(() => {
    const o = new THREE.Object3D();
    o.position.set(width / 2, 0, depth / 2);
    return o;
  }, [width, depth]);
  return (
    <>
      <hemisphereLight args={['#f4f1ff', '#8c7a6b', 1.25]} />
      <ambientLight intensity={0.35} />
      <primitive object={target} />
      <directionalLight
        ref={light}
        position={[width / 2 - span * 0.35, span * 0.9, depth / 2 + span * 0.45]}
        intensity={1.6}
        target={target}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-span * 0.8}
        shadow-camera-right={span * 0.8}
        shadow-camera-top={span * 0.8}
        shadow-camera-bottom={-span * 0.8}
        shadow-camera-near={1}
        shadow-camera-far={span * 3}
      />
    </>
  );
}

export const Floor = memo(function Floor({ settings }: { settings: OfficeSettings }) {
  const { width, depth, floor, floorColor } = settings;
  const map = useMemo(() => {
    const t = floorTexture(floor, floorColor);
    t.repeat.set(width / 2, depth / 2);
    t.needsUpdate = true;
    return t;
  }, [floor, floorColor, width, depth]);
  return (
    <group>
      {/* Ground around the building. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[width / 2, -0.02, depth / 2]} receiveShadow>
        <planeGeometry args={[width + 60, depth + 60]} />
        <meshStandardMaterial color="#b9c4d6" roughness={1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[width / 2, 0, depth / 2]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial map={map} roughness={floor === 'tile' ? 0.45 : 0.85} />
      </mesh>
    </group>
  );
});

export function BuildGrid({ settings }: { settings: OfficeSettings }) {
  const { width, depth } = settings;
  return (
    <Grid
      position={[width / 2, 0.012, depth / 2]}
      args={[width, depth]}
      cellSize={0.5}
      cellThickness={0.6}
      cellColor="#5b6475"
      sectionSize={1}
      sectionThickness={1.1}
      sectionColor="#5b6cff"
      fadeDistance={200}
      followCamera={false}
      infiniteGrid={false}
    />
  );
}

const WALL_H = 2.6;
const WALL_T = 0.3;

/** Outer walls. Any wall standing between the camera and the room fades out. */
export function PerimeterWalls({ settings }: { settings: OfficeSettings }) {
  const { width: w, depth: d, wallColor } = settings;
  const camera = useThree((s) => s.camera);
  const [hidden, setHidden] = useState({ n: false, s: true, w: false, e: false });
  useFrame(() => {
    const p = camera.position;
    const next = { n: p.z < 0, s: p.z > d, w: p.x < 0, e: p.x > w };
    if (next.n !== hidden.n || next.s !== hidden.s || next.w !== hidden.w || next.e !== hidden.e) setHidden(next);
  });
  const trim = shade(wallColor, -0.25);
  const wall = (key: keyof typeof hidden, pos: [number, number, number], size: [number, number, number]) => (
    <OpacityContext.Provider key={key} value={hidden[key] ? 0.12 : 1}>
      <Box p={pos} s={size} c={wallColor} />
      <Box p={[pos[0], 0.07, pos[2]]} s={[size[0] + 0.02, 0.14, size[2] + 0.02]} c={trim} />
    </OpacityContext.Provider>
  );
  return (
    <group>
      {wall('n', [w / 2, WALL_H / 2, -WALL_T / 2], [w + WALL_T * 2, WALL_H, WALL_T])}
      {wall('s', [w / 2, WALL_H / 2, d + WALL_T / 2], [w + WALL_T * 2, WALL_H, WALL_T])}
      {wall('w', [-WALL_T / 2, WALL_H / 2, d / 2], [WALL_T, WALL_H, d])}
      {wall('e', [w + WALL_T / 2, WALL_H / 2, d / 2], [WALL_T, WALL_H, d])}
      {/* A few windows on the back wall for some life. */}
      {Array.from({ length: Math.floor(w / 6) }, (_, i) => {
        const x = 3 + i * 6;
        return hidden.n ? null : (
          <group key={i} position={[x, 1.6, 0.005]}>
            <Box p={[0, 0, 0]} s={[2.2, 1.1, 0.02]} c="#2d2f36" shadow={false} />
            <Box p={[0, 0, 0.012]} s={[2.05, 0.95, 0.01]} c="#a8d8ff" emissive="#a8d8ff" emissiveIntensity={0.45} shadow={false} />
            <Box p={[0, 0, 0.02]} s={[0.04, 0.95, 0.01]} c="#2d2f36" shadow={false} />
          </group>
        );
      })}
    </group>
  );
}

const zoneFill = new Map<string, THREE.MeshBasicMaterial>();
function zoneMaterial(color: string, opacity: number) {
  const key = `${color}:${opacity}`;
  let m = zoneFill.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    zoneFill.set(key, m);
  }
  return m;
}

function ZoneArea({ zone, active, selected, building }: { zone: Zone; active: boolean; selected: boolean; building: boolean }) {
  const { x, z, w, d, color } = zone;
  const edge = 0.06;
  const edgeMat = zoneMaterial(color, selected ? 1 : active ? 0.85 : 0.5);
  const select = (e: { stopPropagation: () => void; delta: number }) => {
    if (!building || e.delta > 4) return;
    e.stopPropagation();
    useStore.setState((s) => ({ build: { ...s.build, tool: 'select', placeType: null, selectedId: null, selectedZoneId: zone.id } }));
  };
  return (
    <group position={[x, 0.016, z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[w / 2, 0, d / 2]} material={zoneMaterial(color, active ? 0.2 : selected ? 0.25 : 0.1)} onClick={building ? select : undefined}>
        <planeGeometry args={[w, d]} />
      </mesh>
      {[
        [w / 2, edge / 2, w, edge],
        [w / 2, d - edge / 2, w, edge],
        [edge / 2, d / 2, edge, d],
        [w - edge / 2, d / 2, edge, d],
      ].map(([cx, cz, sw, sd], i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.002, cz]} material={edgeMat}>
          <planeGeometry args={[sw, sd]} />
        </mesh>
      ))}
    </group>
  );
}

/** Private areas drawn on the floor; the one you're standing in is highlighted. */
export function Zones() {
  const zones = useStore((s) => s.office?.zones ?? []);
  const building = useStore((s) => s.mode === 'build');
  const selectedZoneId = useStore((s) => s.build.selectedZoneId);
  const activeId = useStore((s) => s.activeZoneId);
  useFrame(() => {
    const id = zoneAt(zones, local.x, local.z)?.id ?? null;
    if (id !== useStore.getState().activeZoneId) useStore.setState({ activeZoneId: id });
  });
  return (
    <group>
      {zones.map((zone) => (
        <ZoneArea key={zone.id} zone={zone} active={zone.id === activeId} selected={zone.id === selectedZoneId} building={building} />
      ))}
    </group>
  );
}
