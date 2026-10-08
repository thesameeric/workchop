import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Gesture } from '../../world/Avatar';

/** Reactions that animate the character, and for how long (ms). */
export const GESTURES: Record<string, { gesture: Gesture; ms: number }> = {
  '👋': { gesture: 'wave', ms: 2400 },
  '✋': { gesture: 'raise', ms: 3000 },
  '💃': { gesture: 'dance', ms: 6000 },
  '👏': { gesture: 'clap', ms: 2200 },
  '🙌': { gesture: 'cheer', ms: 2600 },
};

type EffectKind = 'confetti' | 'hearts' | 'flames';

/** Reactions with particles around the character. */
const EFFECTS: Record<string, EffectKind> = { '🎉': 'confetti', '❤️': 'hearts', '🔥': 'flames' };

const CONFETTI_COLORS = ['#ff5d8f', '#ffd166', '#06d6a0', '#4cc9f0', '#8b5cf6', '#ff924c', '#ef476f', '#ffffff'];
const HEART_COLORS = ['#ff4d6d', '#ff758f', '#e5383b', '#ff8fa3'];

function heartGeometry(): THREE.ShapeGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, -0.5);
  s.bezierCurveTo(-0.15, -0.32, -0.6, -0.1, -0.5, 0.25);
  s.bezierCurveTo(-0.42, 0.55, -0.08, 0.58, 0, 0.3);
  s.bezierCurveTo(0.08, 0.58, 0.42, 0.55, 0.5, 0.25);
  s.bezierCurveTo(0.6, -0.1, 0.15, -0.32, 0, -0.5);
  return new THREE.ShapeGeometry(s, 10);
}

function flameGeometry(): THREE.ShapeGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0.6);
  s.quadraticCurveTo(0.42, 0.05, 0.28, -0.22);
  s.quadraticCurveTo(0, -0.58, -0.28, -0.22);
  s.quadraticCurveTo(-0.42, 0.05, 0, 0.6);
  return new THREE.ShapeGeometry(s, 8);
}

const geometries = {
  confetti: new THREE.PlaneGeometry(0.13, 0.075),
  hearts: heartGeometry(),
  flames: flameGeometry(),
};

// One material per kind, shared by every burst and kept (disposing it would throw away the compiled
// shader, so each burst would compile it again). Particles fade out by shrinking.
const material = (opacity: number) => new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
const materials = { confetti: material(1), hearts: material(1), flames: material(0.9) };

interface Spec {
  count: number;
  /** Seconds until the effect is gone. */
  life: number;
  /** Turned to face the camera (hearts, flames), rather than tumbling (confetti). */
  billboard: boolean;
}

const SPECS: Record<EffectKind, Spec> = {
  confetti: { count: 120, life: 2.8, billboard: false },
  hearts: { count: 10, life: 2.6, billboard: true },
  flames: { count: 64, life: 2.2, billboard: true },
};

interface Particle {
  p: THREE.Vector3;
  v: THREE.Vector3;
  /** Spin axis and speed (confetti). */
  axis: THREE.Vector3;
  spin: number;
  angle: number;
  /** Seconds after the burst starts that this one appears, and how long it lasts. */
  delay: number;
  life: number;
  size: number;
  phase: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** 0 → 1 with a little overshoot. */
function easeOutBack(x: number): number {
  const c = 1.70158;
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
}

function makeParticles(kind: EffectKind): Particle[] {
  return Array.from({ length: SPECS[kind].count }, () => {
    const particle: Particle = {
      p: new THREE.Vector3(),
      v: new THREE.Vector3(),
      axis: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize(),
      spin: rand(4, 11),
      angle: rand(0, Math.PI * 2),
      delay: 0,
      life: SPECS[kind].life,
      size: 1,
      phase: rand(0, Math.PI * 2),
    };
    if (kind === 'confetti') {
      // A popper's burst from just above the head, falling back down and fluttering.
      particle.p.set(rand(-0.1, 0.1), 2.3, rand(-0.1, 0.1));
      const a = rand(0, Math.PI * 2);
      const out = rand(0.5, 2.2);
      particle.v.set(Math.cos(a) * out, rand(2.2, 4), Math.sin(a) * out);
      particle.delay = rand(0, 0.12);
      particle.size = rand(0.8, 1.3);
    } else if (kind === 'hearts') {
      particle.p.set(rand(-0.35, 0.35), rand(1.6, 2.0), rand(-0.25, 0.25));
      particle.v.set(0, rand(0.55, 0.95), 0);
      particle.delay = rand(0, 0.9);
      particle.life = rand(1.4, 1.7);
      particle.size = rand(0.17, 0.27);
    } else {
      // Little flames rising from a ring around the feet.
      const a = rand(0, Math.PI * 2);
      const r = rand(0.3, 0.55);
      particle.p.set(Math.cos(a) * r, rand(0.05, 0.3), Math.sin(a) * r);
      particle.v.set(0, rand(0.9, 1.5), 0);
      particle.delay = rand(0, 1.3);
      particle.life = rand(0.6, 0.85);
      particle.size = rand(0.26, 0.4);
    }
    return particle;
  });
}

const GRAVITY = 6.5;
const STEP = 1 / 60;
const FLAME_HOT = new THREE.Color('#ffd43b');
const FLAME_COOL = new THREE.Color('#f03e3e');
const matrix = new THREE.Matrix4();
const quat = new THREE.Quaternion();
const scale = new THREE.Vector3();
const pos = new THREE.Vector3();
const color = new THREE.Color();

/**
 * One burst of particles, from where the character is when it starts: it stays there in the world if
 * they walk or turn away. Calls `onDone` when it's over.
 */
const Burst = memo(function Burst({ kind, onDone }: { kind: EffectKind; onDone: () => void }) {
  const spec = SPECS[kind];
  const ref = useRef<THREE.InstancedMesh>(null);
  const particles = useMemo(() => makeParticles(kind), [kind]);
  const born = useRef<number | null>(null);
  const finished = useRef(false);
  /** Which way the character faced when it started. */
  const facing = useMemo(() => new THREE.Quaternion(), []);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    particles.forEach((_, i) => {
      if (kind === 'confetti') color.set(CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
      else if (kind === 'hearts') color.set(HEART_COLORS[i % HEART_COLORS.length]);
      else color.copy(FLAME_HOT);
      mesh.setColorAt(i, color);
      // Hidden until its turn.
      mesh.setMatrixAt(i, matrix.makeScale(0, 0, 0));
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
  }, [kind, particles]);

  useFrame(({ camera }, delta) => {
    const mesh = ref.current;
    if (!mesh || finished.current) return;
    // Lifetimes follow the clock, so a burst ends on time even when frames are slow or skipped.
    const wall = performance.now() / 1000;
    if (born.current === null) {
      born.current = wall;
      // Fix its place in the world: the character's later moves don't carry it along.
      mesh.getWorldQuaternion(facing);
      mesh.matrixWorldAutoUpdate = false;
    }
    const now = wall - born.current;
    if (now > spec.life) {
      finished.current = true;
      mesh.visible = false;
      onDone();
      return;
    }
    // Face the camera, undoing the character's turn.
    if (spec.billboard) quat.copy(facing).invert().multiply(camera.quaternion);
    // Confetti is simulated in small steps (gravity, drag, landing on the floor).
    const dt = Math.min(delta, 0.25);
    const steps = Math.ceil(dt / STEP);
    particles.forEach((pt, i) => {
      const t = now - pt.delay;
      if (t < 0 || t > pt.life) {
        mesh.setMatrixAt(i, matrix.makeScale(0, 0, 0));
        return;
      }
      let s = pt.size;
      if (kind === 'confetti') {
        for (let n = 0; n < steps && pt.p.y > 0.02; n++) {
          const h = dt / steps;
          pt.v.y = Math.max(pt.v.y - GRAVITY * h, -1.4);
          pt.v.x *= 1 - 1.2 * h;
          pt.v.z *= 1 - 1.2 * h;
          pt.p.addScaledVector(pt.v, h);
          pt.angle += pt.spin * h;
        }
        // Landed: lie on the floor.
        if (pt.p.y <= 0.02) pt.p.y = 0.02;
        pos.copy(pt.p);
        if (pt.p.y > 0.02) pos.x += Math.sin(t * 6 + pt.phase) * 0.05;
        s *= Math.min(1, (pt.life - t) / 0.5);
        quat.setFromAxisAngle(pt.axis, pt.angle);
      } else if (kind === 'hearts') {
        // Pops in, floats up swaying, fades out.
        pos.set(pt.p.x + Math.sin(t * 3 + pt.phase) * 0.12, pt.p.y + pt.v.y * t, pt.p.z);
        s *= easeOutBack(Math.min(1, t / 0.3)) * Math.min(1, (pt.life - t) / 0.4);
      } else {
        const k = t / pt.life;
        pos.set(pt.p.x * (1 - k * 0.3), pt.p.y + pt.v.y * t, pt.p.z * (1 - k * 0.3));
        s *= 1 - k * 0.85;
        mesh.setColorAt(i, color.copy(FLAME_HOT).lerp(FLAME_COOL, k));
      }
      matrix.compose(pos, quat, scale.setScalar(s));
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (kind === 'flames' && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[geometries[kind], materials[kind], spec.count]} frustumCulled={false} raycast={() => null} />;
});

/** Particles for the reactions that have them (🎉 confetti, ❤️ hearts, 🔥 flames), seen by everyone. */
export function ReactionEffects({ emote }: { emote: { emoji: string; at: number } | undefined }) {
  const [bursts, setBursts] = useState<{ id: number; kind: EffectKind }[]>([]);

  useEffect(() => {
    const kind = emote && EFFECTS[emote.emoji];
    if (!emote || !kind) return;
    // A few can overlap; the oldest goes first.
    setBursts((list) => [...list.slice(-2), { id: emote.at, kind }]);
  }, [emote]);

  return (
    <>
      {bursts.map((b) => (
        <Burst key={b.id} kind={b.kind} onDone={() => setBursts((list) => list.filter((x) => x.id !== b.id))} />
      ))}
    </>
  );
}
