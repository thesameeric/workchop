import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { useShallow } from 'zustand/react/shallow';
import { tapShoulder } from '../features/audio/focus';
import { GESTURES, ReactionEffects } from '../features/audio/Reactions';
import { local, remoteTargets, rendered } from '../lib/positions';
import { getState, useStore } from '../state/store';
import { Avatar, BlobShadow, useMotion, type AvatarMotion } from './Avatar';
import { stepLocal } from './movement';
import { stepRemote, type Drawn } from './remoteMotion';

const ringMaterial = new THREE.MeshBasicMaterial({ color: '#3ddc84', transparent: true, opacity: 0.9, depthWrite: false });
const selfRingMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false });
const ringGeo = new THREE.RingGeometry(0.36, 0.44, 40);

/** Speaking ring at a character's feet, and the animations and particles of reactions. */
const Overlay = memo(function Overlay({
  id,
  speakId,
  isSelf,
  motion,
}: {
  id: string;
  speakId: string;
  isSelf: boolean;
  motion: MutableRefObject<AvatarMotion>;
}) {
  const speaking = useStore((s) => !!s.speaking[speakId]);
  const emote = useStore((s) => s.emotes[id]);

  useEffect(() => {
    const g = emote && GESTURES[emote.emoji];
    if (g) Object.assign(motion.current, { gesture: g.gesture, gestureUntil: performance.now() + g.ms });
  }, [emote, motion]);

  return (
    <>
      {speaking && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} geometry={ringGeo} material={ringMaterial} />}
      {isSelf && !speaking && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]} geometry={ringGeo} material={selfRingMaterial} />}
      <ReactionEffects emote={emote} />
    </>
  );
});

export function LocalPlayer() {
  const me = useStore((s) => s.me);
  const focus = useStore((s) => s.focus);
  const selfId = useStore((s) => s.selfId) ?? 'self';
  const group = useRef<THREE.Group>(null);
  const motion = useMotion();
  const camera = useThree((s) => s.camera);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const speed = stepLocal(dt, camera);
    motion.current.anim = local.anim;
    motion.current.speed = speed;
    if (group.current) {
      group.current.position.set(local.x, 0, local.z);
      group.current.rotation.y = local.ry;
    }
  });

  return (
    <group ref={group}>
      <BlobShadow />
      <Avatar config={me.avatar} motion={motion} focus={focus} />
      <Overlay id={selfId} speakId="self" isSelf motion={motion} />
    </group>
  );
}

const RemotePlayer = memo(function RemotePlayer({ id }: { id: string }) {
  const info = useStore((s) => s.players[id]);
  const group = useRef<THREE.Group>(null);
  const motion = useMotion();
  const pos = useRef<Drawn | null>(null);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const t = remoteTargets.get(id);
    if (!t || !group.current) return;
    const step = stepRemote(pos.current, t, dt, performance.now());
    const p = (pos.current = step.drawn);
    motion.current.anim = step.anim;
    motion.current.speed = step.speed;
    group.current.position.set(p.x, 0, p.z);
    group.current.rotation.y = p.ry;
    const r = rendered.get(id);
    if (r) {
      r.x = p.x;
      r.z = p.z;
      r.sit = motion.current.anim === 'sit';
    } else {
      rendered.set(id, { x: p.x, z: p.z, sit: motion.current.anim === 'sit' });
    }
  });

  useEffect(() => () => void rendered.delete(id), [id]);

  const avatar = useMemo(() => info?.avatar, [info?.avatar]);
  const focus = !!info?.focus;
  // The hand pointer we showed over them; put back when they take the headphones off or leave.
  const hovered = useRef(false);
  useEffect(() => {
    if (!focus) return;
    return () => {
      if (hovered.current) document.body.style.cursor = '';
      hovered.current = false;
    };
  }, [focus]);
  if (!info || !avatar) return null;
  // Someone wearing headphones can be tapped on the shoulder by clicking them.
  const tap = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 5 || getState().mode !== 'play') return;
    e.stopPropagation();
    void tapShoulder(id);
  };
  const hover = (on: boolean) => () => {
    if (on ? getState().mode !== 'play' : !hovered.current) return;
    hovered.current = on;
    document.body.style.cursor = on ? 'pointer' : '';
  };
  return (
    <group
      ref={group}
      onClick={focus ? tap : undefined}
      onPointerOver={focus ? hover(true) : undefined}
      onPointerOut={focus ? hover(false) : undefined}
    >
      <BlobShadow />
      <Avatar config={avatar} motion={motion} focus={focus} />
      <Overlay id={id} speakId={id} isSelf={false} motion={motion} />
    </group>
  );
});

export function RemotePlayers() {
  const ids = useStore(useShallow((s) => Object.keys(s.players)));
  return (
    <group>
      {ids.map((id) => (
        <RemotePlayer key={id} id={id} />
      ))}
    </group>
  );
}
