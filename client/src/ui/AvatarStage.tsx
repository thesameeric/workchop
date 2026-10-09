import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { AvatarConfig } from '../../../shared/types';
import { Avatar, BlobShadow, useMotion } from '../world/Avatar';

// The 3D part of AvatarPreview, loaded on its own so three.js stays out of the pages that show it.

function Spinner({ avatar }: { avatar: AvatarConfig }) {
  const motion = useMotion();
  const waved = useRef(false);
  useFrame((state) => {
    if (!waved.current && state.clock.elapsedTime > 0.6) {
      waved.current = true;
      Object.assign(motion.current, { gesture: 'wave', gestureUntil: performance.now() + 1800 });
    }
  });
  return (
    <group>
      <BlobShadow />
      <Avatar config={avatar} motion={motion} />
    </group>
  );
}

/** A character turning slowly on a little round floor. */
export default function AvatarStage({ avatar, dark }: { avatar: AvatarConfig; dark: boolean }) {
  return (
    <Canvas shadows="percentage" dpr={[1, 2]} camera={{ position: [0, 1.3, 3.2], fov: 35 }}>
      <hemisphereLight args={['#ffffff', '#b9a99a', 1.3]} />
      <directionalLight position={[2, 4, 3]} intensity={1.6} castShadow />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[1.1, 40]} />
        <meshStandardMaterial color={dark ? '#4a5068' : '#e7e9f5'} />
      </mesh>
      <Spinner avatar={avatar} />
      <OrbitControls target={[0, 0.95, 0]} enablePan={false} enableZoom={false} autoRotate autoRotateSpeed={1.6} minPolarAngle={1} maxPolarAngle={1.6} />
    </Canvas>
  );
}
