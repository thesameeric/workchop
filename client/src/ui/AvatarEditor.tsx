import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import {
  CLOTHING_COLORS,
  FACIAL_HAIR,
  GLASSES_STYLES,
  HAIR_COLORS,
  HAIR_STYLES,
  HAT_STYLES,
  randomAvatar,
  SKIN_TONES,
  TOP_STYLES,
} from '../../../shared/avatar';
import type { AvatarConfig } from '../../../shared/types';
import { Avatar, BlobShadow, useMotion } from '../world/Avatar';
import { ShuffleIcon } from './icons';

function Spinner({ avatar }: { avatar: AvatarConfig }) {
  const group = useRef<THREE.Group>(null);
  const motion = useMotion();
  const waved = useRef(false);
  useFrame((state) => {
    if (!waved.current && state.clock.elapsedTime > 0.6) {
      waved.current = true;
      Object.assign(motion.current, { gesture: 'wave', gestureUntil: performance.now() + 1800 });
    }
  });
  return (
    <group ref={group}>
      <BlobShadow />
      <Avatar config={avatar} motion={motion} />
    </group>
  );
}

export function AvatarPreview({ avatar, height = 280 }: { avatar: AvatarConfig; height?: number }) {
  return (
    <div className="avatar-preview" style={{ height }}>
      <Canvas shadows="percentage" dpr={[1, 2]} camera={{ position: [0, 1.3, 3.2], fov: 35 }}>
        <hemisphereLight args={['#ffffff', '#b9a99a', 1.3]} />
        <directionalLight position={[2, 4, 3]} intensity={1.6} castShadow />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <circleGeometry args={[1.1, 40]} />
          <meshStandardMaterial color="#e7e9f5" />
        </mesh>
        <Spinner avatar={avatar} />
        <OrbitControls target={[0, 0.95, 0]} enablePan={false} enableZoom={false} autoRotate autoRotateSpeed={1.6} minPolarAngle={1} maxPolarAngle={1.6} />
      </Canvas>
    </div>
  );
}

const LABELS: Record<string, string> = {
  none: 'None',
  short: 'Short',
  long: 'Long',
  bun: 'Bun',
  ponytail: 'Ponytail',
  mohawk: 'Mohawk',
  curly: 'Curly',
  spiky: 'Spiky',
  tshirt: 'T-shirt',
  hoodie: 'Hoodie',
  suit: 'Suit',
  dress: 'Dress',
  cap: 'Cap',
  beanie: 'Beanie',
  tophat: 'Top hat',
  crown: 'Crown',
  headphones: 'Headphones',
  round: 'Round',
  shades: 'Shades',
  beard: 'Beard',
  mustache: 'Mustache',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="editor-row">
      <div className="editor-label">{label}</div>
      <div className="editor-controls">{children}</div>
    </div>
  );
}

function Chips<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button key={o} type="button" className={`chip${o === value ? ' active' : ''}`} onClick={() => onChange(o)}>
          {LABELS[o] ?? o}
        </button>
      ))}
    </div>
  );
}

export function Swatches({ value, colors, onChange, custom = true }: { value: string; colors: readonly string[]; onChange: (v: string) => void; custom?: boolean }) {
  return (
    <div className="swatches">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch${c.toLowerCase() === value.toLowerCase() ? ' active' : ''}`}
          style={{ background: c }}
          aria-label={c}
          onClick={() => onChange(c)}
        />
      ))}
      {custom && (
        <label className="swatch custom" title="Custom colour">
          <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        </label>
      )}
    </div>
  );
}

/** Controls for customising a character. Pure/controlled: the parent owns the state. */
export function AvatarEditor({
  name,
  avatar,
  onName,
  onAvatar,
}: {
  name: string;
  avatar: AvatarConfig;
  onName: (name: string) => void;
  onAvatar: (avatar: AvatarConfig) => void;
}) {
  const set = <K extends keyof AvatarConfig>(key: K, value: AvatarConfig[K]) => onAvatar({ ...avatar, [key]: value });
  return (
    <div className="avatar-editor">
      <div className="editor-name">
        <label htmlFor="display-name">Display name</label>
        <div className="name-row">
          <input id="display-name" value={name} maxLength={32} placeholder="Your name" autoComplete="nickname" onChange={(e) => onName(e.target.value)} />
          <button type="button" className="btn ghost" onClick={() => onAvatar(randomAvatar())} title="Randomise look">
            <ShuffleIcon size={16} /> Shuffle
          </button>
        </div>
      </div>
      <Row label="Skin">
        <Swatches value={avatar.skin} colors={SKIN_TONES} onChange={(v) => set('skin', v)} />
      </Row>
      <Row label="Hair">
        <Chips value={avatar.hair} options={HAIR_STYLES} onChange={(v) => set('hair', v)} />
        <Swatches value={avatar.hairColor} colors={HAIR_COLORS} onChange={(v) => set('hairColor', v)} />
      </Row>
      <Row label="Top">
        <Chips value={avatar.top} options={TOP_STYLES} onChange={(v) => set('top', v)} />
        <Swatches value={avatar.topColor} colors={CLOTHING_COLORS} onChange={(v) => set('topColor', v)} />
      </Row>
      <Row label="Bottoms">
        <Swatches value={avatar.bottomColor} colors={CLOTHING_COLORS} onChange={(v) => set('bottomColor', v)} />
      </Row>
      <Row label="Shoes">
        <Swatches value={avatar.shoeColor} colors={CLOTHING_COLORS} onChange={(v) => set('shoeColor', v)} />
      </Row>
      <Row label="Headwear">
        <Chips value={avatar.hat} options={HAT_STYLES} onChange={(v) => set('hat', v)} />
        {avatar.hat !== 'none' && avatar.hat !== 'crown' && (
          <Swatches value={avatar.hatColor} colors={CLOTHING_COLORS} onChange={(v) => set('hatColor', v)} />
        )}
      </Row>
      <Row label="Glasses">
        <Chips value={avatar.glasses} options={GLASSES_STYLES} onChange={(v) => set('glasses', v)} />
      </Row>
      <Row label="Facial hair">
        <Chips value={avatar.facialHair} options={FACIAL_HAIR} onChange={(v) => set('facialHair', v)} />
      </Row>
    </div>
  );
}
