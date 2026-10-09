import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Component, Suspense, useEffect, useRef, type ComponentRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { getEntry } from '../../../shared/catalog';
import { local } from '../lib/positions';
import { getState, useStore } from '../state/store';
import { BuildGrid, Floor, Lights, PerimeterWalls, Sky, Zones } from './Environment';
import { Ground } from './Ground';
import { Items } from './Items';
import { sceneLayerKey, useSceneLayers } from './layers';
import { LocalPlayer, RemotePlayers } from './Players';
import { Projector } from './Projector';

const target = new THREE.Vector3();
const delta = new THREE.Vector3();
const offset = new THREE.Vector3();
const spherical = new THREE.Spherical();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Whether an item's seats face each other across it (a support desk). */
function facesAcross(itemId: string): boolean {
  const type = getState().office?.items.find((i) => i.id === itemId)?.type;
  return !!type && !!getEntry(type)?.seats?.some((s) => s.turn);
}

/** The shortest turn from angle `a` to angle `b`. */
function turn(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/**
 * Orbit camera that follows your character around. Sitting down across a desk from someone, it
 * swings round to look over your shoulder at them (until you move it yourself).
 */
function CameraRig() {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const prev = useRef<THREE.Vector3 | null>(null);
  const seatId = useRef<string | null>(null);
  const swing = useRef<{ theta: number; phi: number; radius: number } | null>(null);
  const building = useStore((s) => s.mode === 'build');
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const stop = () => void (swing.current = null);
    c.addEventListener('start', stop);
    return () => c.removeEventListener('start', stop);
  }, []);

  useFrame((_, dt) => {
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

    const seat = local.seat;
    if ((seat?.itemId ?? null) !== seatId.current) {
      seatId.current = seat?.itemId ?? null;
      swing.current = null;
      if (seat && facesAcross(seat.itemId)) {
        spherical.setFromVector3(offset.copy(camera.position).sub(c.target));
        // Behind you, a little above your head.
        swing.current = { theta: seat.ry + Math.PI, phi: 1.05, radius: Math.min(Math.max(spherical.radius, 3.5), 5) };
      }
    }
    const to = swing.current;
    if (!to) return;
    spherical.setFromVector3(offset.copy(camera.position).sub(c.target));
    const k = reducedMotion.matches ? 1 : 1 - Math.exp(-dt * 5);
    const dTheta = turn(spherical.theta, to.theta);
    spherical.theta += dTheta * k;
    spherical.phi += (to.phi - spherical.phi) * k;
    spherical.radius += (to.radius - spherical.radius) * k;
    camera.position.copy(c.target).add(offset.setFromSpherical(spherical));
    if (Math.abs(dTheta) < 0.005 && Math.abs(to.phi - spherical.phi) < 0.005 && Math.abs(to.radius - spherical.radius) < 0.01) swing.current = null;
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

/** A scene layer that fails (to load or to render) renders nothing, so the office carries on without it. */
class LayerBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`The ${this.props.id} scene layer failed and is turned off.`, error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Scene() {
  const settings = useStore((s) => s.office?.settings);
  const building = useStore((s) => s.mode === 'build');
  const layers = useSceneLayers();
  if (!settings) return null;
  return (
    <>
      <Sky />
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
      {/* What features add (weather…); one that is still loading or fails doesn't hold up the office. */}
      {layers.map((layer) => (
        <LayerBoundary key={sceneLayerKey(layer)} id={layer.id}>
          <Suspense fallback={null}>
            <layer.Component />
          </Suspense>
        </LayerBoundary>
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
