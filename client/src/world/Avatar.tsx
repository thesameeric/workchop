import { useFrame } from '@react-three/fiber';
import { memo, useMemo, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import type { AnimState, AvatarConfig } from '../../../shared/types';
import { shade } from '../lib/color';
import { Ball, Box, Cyl, mat } from './prims';

export interface AvatarMotion {
  anim: AnimState;
  /** Horizontal speed in units per second. */
  speed: number;
  /** Gesture currently playing (reactions), until `gestureUntil` (ms timestamp). */
  gesture: Gesture | null;
  gestureUntil: number;
}

export type Gesture = 'wave' | 'raise' | 'dance' | 'clap' | 'cheer';

export function useMotion(): MutableRefObject<AvatarMotion> {
  return useRef<AvatarMotion>({ anim: 'idle', speed: 0, gesture: null, gestureUntil: 0 });
}

const HEAD_Y = 1.42;
const HEAD_R = 0.27;
const HIP_Y = 0.62;
const SIT_HIP_Y = 0.42;

// Partial spheres shared by all avatars.
const capGeo = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.52);
const beardGeo = new THREE.SphereGeometry(1, 24, 12, Math.PI / 2 - 1.15, 2.3, Math.PI * 0.52, Math.PI * 0.36);
const smileGeo = new THREE.TorusGeometry(0.045, 0.011, 6, 14, Math.PI);
const ringGeo = new THREE.TorusGeometry(0.05, 0.011, 8, 20);
const bandGeo = new THREE.TorusGeometry(0.3, 0.025, 8, 24, Math.PI);
const hoodGeo = new THREE.TorusGeometry(0.17, 0.065, 8, 18);
const coneGeo = new THREE.ConeGeometry(1, 1, 10);
const beanieRimGeo = new THREE.TorusGeometry(0.29, 0.045, 8, 28);
// Focus-mode headphones: a band high enough to clear hats and tall hair, and a soft halo.
const focusBandGeo = new THREE.TorusGeometry(1, 0.08, 8, 32, Math.PI);
const focusGlowGeo = new THREE.TorusGeometry(0.075, 0.014, 8, 24);
const haloGeo = new THREE.TorusGeometry(0.47, 0.012, 6, 56);
const focusGlowMat = new THREE.MeshBasicMaterial({ color: '#c4b5fd' });
const haloMat = new THREE.MeshBasicMaterial({ color: '#a78bfa', transparent: true, opacity: 0.55, depthWrite: false });
const FOCUS_CUP = '#8b5cf6';
const capsules = new Map<string, THREE.CapsuleGeometry>();
function capsuleGeo(rad: number, len: number): THREE.CapsuleGeometry {
  const key = `${rad}:${len}`;
  let g = capsules.get(key);
  if (!g) {
    g = new THREE.CapsuleGeometry(rad, len, 4, 10);
    capsules.set(key, g);
  }
  return g;
}

function Mesh({ geo, c, p, r, s, o }: { geo: THREE.BufferGeometry; c: string; p?: [number, number, number]; r?: [number, number, number]; s?: [number, number, number]; o?: number }) {
  return <mesh geometry={geo} material={mat(c, { opacity: o, side: THREE.DoubleSide })} position={p} rotation={r} scale={s} castShadow />;
}

function Capsule({ c, p, rad, len, r }: { c: string; p: [number, number, number]; rad: number; len: number; r?: [number, number, number] }) {
  return <mesh geometry={capsuleGeo(rad, len)} material={mat(c)} position={p} rotation={r} castShadow />;
}

function Hair({ a, hatOn }: { a: AvatarConfig; hatOn: boolean }) {
  const c = a.hairColor;
  const H: [number, number, number] = [0, HEAD_Y, 0];
  const cap = <Mesh geo={capGeo} c={c} p={[0, HEAD_Y + 0.01, -0.01]} r={[-0.38, 0, 0]} s={[0.29, 0.29, 0.29]} />;
  // Tall styles get squashed under a hat.
  const style = hatOn && ['mohawk', 'spiky', 'curly', 'bun'].includes(a.hair) ? 'short' : a.hair;
  switch (style) {
    case 'none':
      return null;
    case 'short':
      return cap;
    case 'long':
      return (
        <group>
          {cap}
          <Box p={[0, HEAD_Y - 0.12, -0.15]} s={[0.52, 0.5, 0.2]} c={c} rounded />
          {[-1, 1].map((sx) => (
            <Box key={sx} p={[sx * 0.24, HEAD_Y - 0.08, -0.02]} s={[0.08, 0.42, 0.26]} c={c} rounded />
          ))}
        </group>
      );
    case 'bun':
      return (
        <group>
          {cap}
          <Ball p={[0, HEAD_Y + 0.27, -0.13]} rad={0.12} c={c} />
        </group>
      );
    case 'ponytail':
      return (
        <group>
          {cap}
          <Ball p={[0, HEAD_Y + 0.12, -0.27]} rad={0.08} c={c} />
          <Capsule c={c} p={[0, HEAD_Y - 0.08, -0.33]} rad={0.07} len={0.2} r={[0.35, 0, 0]} />
        </group>
      );
    case 'mohawk':
      return (
        <group>
          {[-0.18, -0.06, 0.06, 0.18].map((z, i) => (
            <Mesh key={z} geo={coneGeo} c={c} p={[0, HEAD_Y + 0.27 - Math.abs(z) * 0.35, z]} r={[z * 1.6, 0, 0]} s={[0.07, 0.2 - (i % 3) * 0.02, 0.07]} />
          ))}
        </group>
      );
    case 'curly': {
      const balls: [number, number, number][] = [];
      for (let ring = 0; ring < 3; ring++) {
        const theta = 0.15 + ring * 0.42;
        const n = ring === 0 ? 3 : ring === 1 ? 8 : 11;
        for (let i = 0; i < n; i++) {
          const phi = (i / n) * Math.PI * 2 + ring;
          const x = Math.sin(theta) * Math.cos(phi);
          const z = Math.sin(theta) * Math.sin(phi);
          if (z > 0.55 && ring === 2) continue; // keep the face clear
          balls.push([x * 0.27, HEAD_Y + Math.cos(theta) * 0.27, z * 0.27 - 0.02]);
        }
      }
      return (
        <group>
          {balls.map((p, i) => (
            <Ball key={i} p={p} rad={0.1} c={i % 2 ? c : shade(c, 0.08)} />
          ))}
        </group>
      );
    }
    case 'spiky':
      return (
        <group>
          {cap}
          {[[0, 0.3, 0, 0, 0], [0.13, 0.26, 0.05, -0.5, -0.4], [-0.13, 0.26, 0.05, -0.5, 0.4], [0.12, 0.24, -0.12, 0.4, -0.5], [-0.12, 0.24, -0.12, 0.4, 0.5], [0, 0.26, 0.14, -0.6, 0]].map(
            ([x, y, z, rx, rz], i) => (
              <Mesh key={i} geo={coneGeo} c={c} p={[x, H[1] + y, z]} r={[-rx, 0, rz]} s={[0.07, 0.18, 0.07]} />
            ),
          )}
        </group>
      );
    default:
      return cap;
  }
}

function Hat({ a }: { a: AvatarConfig }) {
  const c = a.hatColor;
  switch (a.hat) {
    case 'cap':
      return (
        <group>
          <Mesh geo={capGeo} c={c} p={[0, HEAD_Y + 0.03, 0]} s={[0.3, 0.3, 0.3]} />
          <Cyl p={[0, HEAD_Y + 0.08, 0.2]} rad={0.2} h={0.02} c={shade(c, -0.15)} />
          <Ball p={[0, HEAD_Y + 0.33, 0]} rad={0.025} c={shade(c, -0.15)} />
        </group>
      );
    case 'beanie':
      return (
        <group>
          <Mesh geo={capGeo} c={c} p={[0, HEAD_Y + 0.04, 0]} s={[0.305, 0.33, 0.305]} />
          <Mesh geo={beanieRimGeo} c={shade(c, -0.12)} p={[0, HEAD_Y + 0.06, 0]} r={[Math.PI / 2, 0, 0]} />
          <Ball p={[0, HEAD_Y + 0.38, 0]} rad={0.065} c="#f2f2f2" />
        </group>
      );
    case 'tophat':
      return (
        <group>
          <Cyl p={[0, HEAD_Y + 0.22, 0]} rad={0.34} h={0.025} c={c} />
          <Cyl p={[0, HEAD_Y + 0.4, 0]} rad={0.2} h={0.36} c={c} />
          <Cyl p={[0, HEAD_Y + 0.27, 0]} rad={0.205} h={0.06} c="#1b1b1b" />
        </group>
      );
    case 'crown':
      return (
        <group>
          <Cyl p={[0, HEAD_Y + 0.28, 0]} rad={0.2} top={1.05} h={0.1} c="#ffd166" metalness={0.7} roughness={0.25} />
          {[0, 1, 2, 3, 4].map((i) => {
            const ang = (i / 5) * Math.PI * 2;
            return (
              <Mesh key={i} geo={coneGeo} c="#ffd166" p={[Math.sin(ang) * 0.19, HEAD_Y + 0.38, Math.cos(ang) * 0.19]} s={[0.045, 0.12, 0.045]} />
            );
          })}
          <Ball p={[0, HEAD_Y + 0.28, 0.205]} rad={0.03} c="#e63946" />
        </group>
      );
    case 'headphones':
      return (
        <group>
          <Mesh geo={bandGeo} c={shade(c, -0.3)} p={[0, HEAD_Y + 0.02, 0]} />
          {[-1, 1].map((sx) => (
            <Cyl key={sx} p={[sx * 0.29, HEAD_Y, 0]} r={[0, 0, Math.PI / 2]} rad={0.09} h={0.08} c={c} />
          ))}
        </group>
      );
    default:
      return null;
  }
}

/** Big over-ear headphones in the focus colour, worn on top of any hat or hair, with a slowly breathing halo. */
function FocusHeadphones() {
  const halo = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const s = 1 + Math.sin(clock.elapsedTime * 2.2) * 0.07;
    halo.current?.scale.set(s, s, s);
  });
  return (
    <group>
      <Mesh geo={focusBandGeo} c="#2a2d3e" p={[0, HEAD_Y, 0]} s={[0.335, 0.41, 0.36]} />
      {[-1, 1].map((sx) => (
        <group key={sx}>
          <Cyl p={[sx * 0.33, HEAD_Y, 0]} r={[0, 0, Math.PI / 2]} rad={0.12} h={0.09} c={FOCUS_CUP} roughness={0.4} />
          <Cyl p={[sx * 0.282, HEAD_Y, 0]} r={[0, 0, Math.PI / 2]} rad={0.105} h={0.03} c="#1d1f2b" />
          <mesh geometry={focusGlowGeo} material={focusGlowMat} position={[sx * 0.377, HEAD_Y, 0]} rotation={[0, Math.PI / 2, 0]} />
        </group>
      ))}
      <mesh ref={halo} geometry={haloGeo} material={haloMat} position={[0, HEAD_Y + 0.02, 0]} rotation={[Math.PI / 2, 0, 0]} />
    </group>
  );
}

function Face({ a }: { a: AvatarConfig }) {
  const z = 0.245;
  return (
    <group>
      {[-1, 1].map((sx) => (
        <group key={sx}>
          <Ball p={[sx * 0.095, HEAD_Y + 0.03, z]} s={[0.034, 0.042, 0.03]} c="#1b1b1f" roughness={0.3} />
          <Ball p={[sx * 0.095 + 0.012, HEAD_Y + 0.045, z + 0.022]} rad={0.01} c="#ffffff" shadow={false} />
          <Ball p={[sx * 0.15, HEAD_Y - 0.04, z - 0.03]} s={[0.035, 0.022, 0.01]} c="#ff8fa3" o={0.55} shadow={false} />
          <Ball p={[sx * 0.265, HEAD_Y, 0]} s={[0.045, 0.06, 0.04]} c={a.skin} />
        </group>
      ))}
      <Mesh geo={smileGeo} c="#7a3b3b" p={[0, HEAD_Y - 0.065, z + 0.008]} r={[0, 0, Math.PI]} />
      {a.facialHair === 'beard' && <Mesh geo={beardGeo} c={a.hairColor} p={[0, HEAD_Y + 0.005, 0.005]} s={[0.285, 0.285, 0.285]} />}
      {a.facialHair === 'mustache' && (
        <group>
          {[-1, 1].map((sx) => (
            <Ball key={sx} p={[sx * 0.04, HEAD_Y - 0.03, z + 0.02]} s={[0.05, 0.018, 0.02]} r={[0, 0, sx * -0.25]} c={a.hairColor} />
          ))}
        </group>
      )}
      {a.glasses === 'round' && (
        <group>
          {[-1, 1].map((sx) => (
            <Mesh key={sx} geo={ringGeo} c="#2b2b2b" p={[sx * 0.095, HEAD_Y + 0.03, z + 0.03]} />
          ))}
          <Box p={[0, HEAD_Y + 0.04, z + 0.03]} s={[0.05, 0.012, 0.01]} c="#2b2b2b" />
        </group>
      )}
      {a.glasses === 'shades' && (
        <group>
          {[-1, 1].map((sx) => (
            <Box key={sx} p={[sx * 0.095, HEAD_Y + 0.03, z + 0.03]} s={[0.13, 0.075, 0.02]} c="#111114" roughness={0.15} metalness={0.4} rounded />
          ))}
          <Box p={[0, HEAD_Y + 0.045, z + 0.03]} s={[0.07, 0.015, 0.012]} c="#111114" />
        </group>
      )}
    </group>
  );
}

function Torso({ a }: { a: AvatarConfig }) {
  const c = a.topColor;
  return (
    <group>
      <Box p={[0, 0.87, 0]} s={[0.46, 0.52, 0.28]} c={c} rounded />
      <Cyl p={[0, 1.15, 0]} rad={0.075} h={0.1} c={a.skin} />
      {a.top === 'hoodie' && (
        <group>
          <Mesh geo={hoodGeo} c={shade(c, -0.08)} p={[0, 1.13, -0.07]} r={[Math.PI / 2 - 0.25, 0, 0]} s={[1.1, 1, 1]} />
          <Box p={[0, 0.74, 0.142]} s={[0.28, 0.12, 0.01]} c={shade(c, -0.12)} shadow={false} />
          {[-0.05, 0.05].map((x) => (
            <Box key={x} p={[x, 1.0, 0.145]} s={[0.015, 0.14, 0.01]} c="#f2f2f2" shadow={false} />
          ))}
        </group>
      )}
      {a.top === 'suit' && (
        <group>
          <Box p={[0, 0.98, 0.141]} s={[0.13, 0.28, 0.01]} c="#fafafa" shadow={false} />
          <Box p={[0, 0.95, 0.148]} s={[0.05, 0.24, 0.01]} c="#c0392b" shadow={false} />
          <Box p={[0, 0.72, 0.142]} s={[0.035, 0.035, 0.01]} c="#1b1b1b" shadow={false} />
        </group>
      )}
      {a.top === 'dress' && <Cyl p={[0, 0.5, 0]} rad={0.36} top={0.66} h={0.42} c={c} />}
      {a.top === 'tshirt' && <Box p={[0, 0.92, 0.142]} s={[0.16, 0.12, 0.01]} c={shade(c, 0.35)} shadow={false} />}
    </group>
  );
}

/** A chibi-style character built from primitives; animated from `motion`. `focus` puts headphones on. */
export const Avatar = memo(function Avatar({ config, motion, focus = false }: { config: AvatarConfig; motion: MutableRefObject<AvatarMotion>; focus?: boolean }) {
  const a = config;
  const body = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const kneeL = useRef<THREE.Group>(null);
  const kneeR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const phase = useRef(Math.random() * 10);
  const fullSleeves = a.top === 'hoodie' || a.top === 'suit';

  useFrame((state, dt) => {
    const m = motion.current;
    const t = state.clock.elapsedTime;
    const k = 1 - Math.exp(-dt * 14);
    // Gestures follow their targets faster, so claps and dance moves keep their snap.
    const kg = 1 - Math.exp(-dt * 26);
    const lerp = (obj: THREE.Object3D | null, axis: 'x' | 'y' | 'z', target: number, speed = k) => {
      if (obj) obj.rotation[axis] += (target - obj.rotation[axis]) * speed;
    };
    let legSwing = 0;
    let armSwing = 0;
    let bob = 0;
    let hipY = HIP_Y;
    let thigh = 0;
    let knee = 0;
    let armRest = 0;
    let lean = 0;

    if (m.anim === 'walk') {
      phase.current += dt * Math.min(Math.max(m.speed, 1.5), 7) * 2.6;
      const s = Math.sin(phase.current);
      legSwing = s * 0.65;
      armSwing = s * 0.55;
      bob = Math.abs(Math.cos(phase.current)) * 0.04;
      knee = Math.max(0, -Math.cos(phase.current)) * 0.5;
      lean = 0.06;
    } else if (m.anim === 'sit') {
      hipY = SIT_HIP_Y;
      thigh = -Math.PI / 2 + 0.08;
      knee = Math.PI / 2 - 0.1;
      armRest = -0.55;
    } else {
      armSwing = Math.sin(t * 1.6) * 0.03;
    }

    // Walking off ends a dance.
    if (m.gesture === 'dance' && m.anim === 'walk') m.gestureUntil = 0;
    const g = m.gesture && performance.now() < m.gestureUntil ? m.gesture : null;
    const standing = m.anim !== 'sit';
    // Arms: x swings forward (negative) and back, z raises sideways (left arm positive, right negative).
    let armLx = armRest - armSwing;
    let armLz = 0;
    let armRx = armRest + armSwing;
    let armRz = 0;
    let hop = 0;
    let twist = 0;
    let sway = 0;
    let stepL = 0;
    let stepR = 0;
    let headTilt = m.anim === 'idle' ? Math.sin(t * 0.7) * 0.04 : 0;
    if (g === 'wave') {
      armRx = 0;
      armRz = -2.5 + Math.sin(t * 14) * 0.35;
    } else if (g === 'raise') {
      armRx = 0;
      armRz = -2.9;
    } else if (g === 'cheer') {
      armLx = armRx = 0;
      armLz = 2.7 + Math.sin(t * 11) * 0.18;
      armRz = -2.7 - Math.sin(t * 11 + 1.2) * 0.18;
      if (standing) hop = Math.abs(Math.sin(t * 7)) * 0.05;
    } else if (g === 'clap') {
      // Arms forward, hands meeting in front of the chest about three times a second.
      const together = (1 - Math.cos(t * 17)) / 2;
      armLx = armRx = -1.25;
      armLz = -(0.15 + together * 0.42);
      armRz = 0.15 + together * 0.42;
    } else if (g === 'dance') {
      const beat = t * 7.5;
      const up = (Math.sin(beat) + 1) / 2;
      armLx = armRx = -0.35;
      armLz = 0.5 + up * 1.9;
      armRz = -(0.5 + (1 - up) * 1.9);
      headTilt = Math.sin(beat) * 0.16;
      if (standing) {
        hop = Math.abs(Math.sin(beat)) * 0.06;
        sway = Math.sin(beat) * 0.12;
        twist = Math.sin(beat * 0.5) * 0.7;
        stepL = Math.max(0, Math.sin(beat)) * 0.45;
        stepR = Math.max(0, -Math.sin(beat)) * 0.45;
      }
    }

    if (body.current) {
      body.current.position.y += (hipY - HIP_Y + bob + hop - body.current.position.y) * (g ? kg : k);
      // Sitting keeps the torso in front of the seat's backrest (seats are placed so the back just touches it).
      body.current.position.z += (0 - body.current.position.z) * k;
      body.current.rotation.x += (lean - body.current.rotation.x) * k;
      body.current.rotation.y += (twist - body.current.rotation.y) * k;
      body.current.rotation.z += (sway - body.current.rotation.z) * kg;
    }
    lerp(legL.current, 'x', thigh + legSwing - stepL * 0.6);
    lerp(legR.current, 'x', thigh - legSwing - stepR * 0.6);
    lerp(kneeL.current, 'x', knee * (m.anim === 'walk' ? (legSwing < 0 ? 1 : 0.2) : 1) + stepL);
    lerp(kneeR.current, 'x', knee * (m.anim === 'walk' ? (legSwing > 0 ? 1 : 0.2) : 1) + stepR);
    lerp(armL.current, 'x', armLx, g ? kg : k);
    lerp(armL.current, 'z', armLz, g ? kg : k);
    lerp(armR.current, 'x', armRx, g ? kg : k);
    lerp(armR.current, 'z', armRz, g ? kg : k);
    if (head.current) {
      head.current.position.y = Math.sin(t * 2) * 0.008;
      head.current.rotation.z += (headTilt - head.current.rotation.z) * kg;
    }
  });

  const pants = a.top === 'dress' ? shade(a.bottomColor, 0) : a.bottomColor;
  const leg = (side: 1 | -1, ref: typeof legL, kneeRef: typeof kneeL) => (
    <group ref={ref} position={[side * 0.1, HIP_Y, 0]}>
      <Box p={[0, -0.15, 0]} s={[0.16, 0.32, 0.18]} c={pants} rounded />
      <group ref={kneeRef} position={[0, -0.3, 0]}>
        <Box p={[0, -0.13, 0]} s={[0.15, 0.26, 0.17]} c={pants} rounded />
        <Box p={[0, -0.28, 0.03]} s={[0.17, 0.08, 0.25]} c={a.shoeColor} rounded />
      </group>
    </group>
  );
  const arm = (side: 1 | -1, ref: typeof armL) => (
    <group ref={ref} position={[side * 0.29, 1.06, 0]}>
      {fullSleeves ? (
        <Capsule c={a.topColor} p={[side * 0.02, -0.2, 0]} rad={0.068} len={0.3} />
      ) : (
        <>
          <Capsule c={a.skin} p={[side * 0.02, -0.21, 0]} rad={0.058} len={0.3} />
          <Cyl p={[side * 0.015, -0.06, 0]} rad={0.08} h={0.14} c={a.topColor} />
        </>
      )}
      <Ball p={[side * 0.025, -0.43, 0]} rad={0.07} c={a.skin} />
    </group>
  );

  const hatOn = a.hat === 'cap' || a.hat === 'beanie' || a.hat === 'tophat';
  return (
    <group ref={body}>
      {leg(1, legL, kneeL)}
      {leg(-1, legR, kneeR)}
      <Box p={[0, HIP_Y, 0]} s={[0.42, 0.12, 0.25]} c={pants} rounded />
      <Torso a={a} />
      {arm(1, armL)}
      {arm(-1, armR)}
      <group ref={head}>
        <Ball p={[0, HEAD_Y, 0]} s={[HEAD_R, HEAD_R * 0.97, HEAD_R * 0.95]} c={a.skin} roughness={0.6} />
        <Face a={a} />
        <Hair a={a} hatOn={hatOn} />
        {!(focus && a.hat === 'headphones') && <Hat a={a} />}
        {focus && <FocusHeadphones />}
      </group>
    </group>
  );
});

/** Soft round shadow under a character, cheaper than relying on the shadow map alone. */
export function BlobShadow() {
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.22, depthWrite: false }),
    [],
  );
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} material={material}>
      <circleGeometry args={[0.32, 24]} />
    </mesh>
  );
}
