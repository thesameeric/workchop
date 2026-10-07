import { createContext, useContext } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

// Geometries and materials are shared and cached: an office can contain thousands of meshes.

export const boxGeo = new THREE.BoxGeometry(1, 1, 1);
export const roundedBoxGeo = new RoundedBoxGeometry(1, 1, 1, 3, 0.12);
export const sphereGeo = new THREE.SphereGeometry(1, 24, 16);

const cylinders = new Map<string, THREE.CylinderGeometry>();
/** Unit-height cylinder; scale x/z for the radius and y for the height. */
export function cylGeo(topRatio = 1, segments = 24): THREE.CylinderGeometry {
  const key = `${topRatio}:${segments}`;
  let g = cylinders.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(topRatio, 1, 1, segments);
    cylinders.set(key, g);
  }
  return g;
}

export interface MatOpts {
  opacity?: number;
  emissive?: string;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  side?: THREE.Side;
}

const materials = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: string, o: MatOpts = {}): THREE.MeshStandardMaterial {
  const opacity = o.opacity ?? 1;
  const key = `${color}|${opacity.toFixed(2)}|${o.emissive ?? ''}|${o.emissiveIntensity ?? ''}|${o.roughness ?? ''}|${o.metalness ?? ''}|${o.side ?? ''}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: o.roughness ?? 0.75,
      metalness: o.metalness ?? 0,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 0.99,
      side: o.side ?? THREE.FrontSide,
    });
    if (o.emissive) {
      m.emissive = new THREE.Color(o.emissive);
      m.emissiveIntensity = o.emissiveIntensity ?? 1;
    }
    materials.set(key, m);
  }
  return m;
}

/** Multiplies the opacity of everything rendered below it (ghost previews, cut-away walls). */
export const OpacityContext = createContext(1);

type V3 = [number, number, number];

interface PrimProps extends Omit<MatOpts, 'opacity'> {
  p?: V3;
  r?: V3;
  c: string;
  /** Material opacity before the context multiplier. */
  o?: number;
  shadow?: boolean;
}

function useMaterial(props: PrimProps): { material: THREE.MeshStandardMaterial; opaque: boolean } {
  const ctx = useContext(OpacityContext);
  const opacity = (props.o ?? 1) * ctx;
  const material = mat(props.c, {
    opacity,
    emissive: props.emissive,
    emissiveIntensity: props.emissiveIntensity,
    roughness: props.roughness,
    metalness: props.metalness,
    side: props.side,
  });
  return { material, opaque: opacity >= 0.99 };
}

/** Box with size `s`. */
export function Box({ s, rounded, ...props }: PrimProps & { s: V3; rounded?: boolean }) {
  const { material, opaque } = useMaterial(props);
  const shadow = props.shadow !== false && opaque;
  return (
    <mesh
      geometry={rounded ? roundedBoxGeo : boxGeo}
      material={material}
      position={props.p}
      rotation={props.r}
      scale={s}
      castShadow={shadow}
      receiveShadow={opaque}
    />
  );
}

/** Cylinder with bottom radius `rad`, height `h` and optional top/bottom ratio. */
export function Cyl({ rad, h, top = 1, seg = 24, ...props }: PrimProps & { rad: number; h: number; top?: number; seg?: number }) {
  const { material, opaque } = useMaterial(props);
  const shadow = props.shadow !== false && opaque;
  return (
    <mesh
      geometry={cylGeo(top, seg)}
      material={material}
      position={props.p}
      rotation={props.r}
      scale={[rad, h, rad]}
      castShadow={shadow}
      receiveShadow={opaque}
    />
  );
}

/** Sphere (or ellipsoid with `s`). */
export function Ball({ rad = 1, s, ...props }: PrimProps & { rad?: number; s?: V3 }) {
  const { material, opaque } = useMaterial(props);
  const shadow = props.shadow !== false && opaque;
  return (
    <mesh
      geometry={sphereGeo}
      material={material}
      position={props.p}
      rotation={props.r}
      scale={s ?? [rad, rad, rad]}
      castShadow={shadow}
      receiveShadow={opaque}
    />
  );
}
