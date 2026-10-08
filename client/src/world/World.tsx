import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useRef, type ComponentRef } from 'react';
import * as THREE from 'three';
import { local } from '../lib/positions';
import { useStore } from '../state/store';
import { BuildGrid, Floor, Lights, PerimeterWalls, useSceneColors, Zones } from './Environment';
import { useWorldLayers } from './extensions';
import { Ground } from './Ground';
import { Items } from './Items';
import { LocalPlayer, RemotePlayers } from './Players';
import { Projector } from './Projector';

const target = new THREE.Vector3();
const delta = new THREE.Vector3();

/** Orbit camera that follows your character around. */
function CameraRig() {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const prev = useRef<THREE.Vector3 | null>(null);
  const building = useStore((s) => s.mode === 'build');
  const camera = useThree((s) => s.camera);

  useFrame(() => {
    const c = controls.current;
    if (!c) return;
    target.set(local.x, 0.9, local.z);
    if (!prev.current) {
      c.target.copy(target);
      camera.position.set(target.x, target.y + 8.5, target.z + 9);
      prev.current = target.clone();
      c.update();
      return;
    }
    delta.copy(target).sub(prev.current);
    if (delta.lengthSq() > 0) {
      camera.position.add(delta);
      c.target.add(delta);
      prev.current.copy(target);
    }
  });

  // Rotate with the left button while playing; in build mode the left button builds and the right one rotates.
  const buttons = building
    ? { LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
    : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      enablePan={false}
      minDistance={3.5}
      maxDistance={building ? 70 : 30}
      minPolarAngle={0.2}
      maxPolarAngle={1.32}
      mouseButtons={buttons}
      touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE }}
    />
  );
}

function Scene() {
  const settings = useStore((s) => s.office?.settings);
  const building = useStore((s) => s.mode === 'build');
  const { sky } = useSceneColors();
  if (!settings) return null;
  return (
    <>
      <color attach="background" args={[sky]} />
      <fog attach="fog" args={[sky, 45, 110]} />
      <Lights settings={settings} />
      <Floor settings={settings} />
      {building && <BuildGrid settings={settings} />}
      <PerimeterWalls settings={settings} />
      <Zones />
      <Items />
      <Ground />
      <LocalPlayer />
      <RemotePlayers />
      <CameraRig />
      <Projector />
      <WorldLayers />
    </>
  );
}

/** Scene content added by features (world/extensions.ts). */
function WorldLayers() {
  const layers = useWorldLayers();
  return (
    <>
      {layers.map((l) => (
        <l.Component key={l.id} />
      ))}
    </>
  );
}

export default function World() {
  useEffect(() => () => void (document.body.style.cursor = ''), []);
  return (
    <Canvas
      className="world-canvas"
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ fov: 45, near: 0.1, far: 300, position: [0, 10, 10] }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Suspense fallback={null}>
        <Scene />
      </Suspense>
    </Canvas>
  );
}
