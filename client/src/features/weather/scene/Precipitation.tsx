import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { local } from '../../../lib/positions';
import type { Fx } from './sky';

// Rain streaks and snowflakes: one instanced quad each, moved entirely on the GPU (only a few uniforms
// change per frame). They fall over a square that follows you; inside the building they stop at the
// roof (the top of the walls), so nothing falls at head height indoors.

/** The square the drops fall over, in metres, and the walls' height and thickness (world/Environment.tsx). */
const AREA = 40;
const ROOF = 2.6;
const WALL = 0.3;
/** The share of drops that still fall over the building, so the office stays easy to see. */
const OVER_BUILDING = 0.45;
/** uTime wraps around after this many seconds; every fall takes a whole fraction of it, so none jumps then. */
const PERIOD = 3600;

export type PrecipitationKind = 'drizzle' | 'rain' | 'snow';

const TAU = 2 * Math.PI;

const KINDS = {
  drizzle: { fall: 5, top: 12, drift: 0.6, maxDrift: 6, width: 0.022, length: 0.4, opacity: 0.4, color: '#f2f6ff', max: [1500, 600] },
  rain: { fall: 9, top: 12, drift: 0.6, maxDrift: 6, width: 0.03, length: 0.8, opacity: 0.55, color: '#f2f6ff', max: [1500, 600] },
  // For snow, width is the flake's radius.
  snow: { fall: 1.1, top: 10, drift: 0.35, maxDrift: 2.2, width: 0.085, length: 0, opacity: 0.95, color: '#ffffff', max: [1000, 400] },
} satisfies Record<PrecipitationKind, unknown>;

const COMMON = /* glsl */ `
uniform float uTime;
uniform vec2 uSway;
uniform vec2 uCenter;
uniform float uTop;
uniform float uFall;
uniform vec2 uWind;
uniform vec4 uRoof;
attribute vec4 aDrop;
attribute float aRnd;
varying float vAlpha;
#include <fog_pars_vertex>

const float AREA = ${AREA.toFixed(1)};
const float ROOF = ${ROOF.toFixed(1)};
const float PERIOD = ${PERIOD.toFixed(1)};

// aDrop: where in the square (x, z), when in its fall (0-1), and how fast. Drops drift with the wind as
// they fall, so the square starts up-wind; it wraps around you, so drops stay put as you walk.
// \`landing\` is where this fall ends, and \`edge\` fades the drop out near the square's edge, where it wraps.
vec3 dropAt(float sway, out vec2 landing, out float edge) {
  float life = PERIOD / max(1.0, floor(PERIOD * uFall * aDrop.w / uTop + 0.5));
  float fall = uTop / life;
  float age = fract(aDrop.z + uTime / life) * life;
  vec2 origin = uCenter - uWind * life * 0.5;
  vec2 offset = (fract(aDrop.xy - origin / AREA + 0.5) - 0.5) * AREA;
  edge = 1.0 - smoothstep(AREA * 0.4, AREA * 0.5, max(abs(offset.x), abs(offset.y)));
  vec2 start = origin + offset;
  landing = start + uWind * life;
  vec2 p = start + uWind * age + sway * vec2(sin(uSway.x + aDrop.w * 40.0), cos(uSway.y + aDrop.w * 57.0));
  return vec3(p.x, uTop - fall * age, p.y);
}

bool overBuilding(vec2 xz) {
  return xz.x > uRoof.x && xz.x < uRoof.z && xz.y > uRoof.y && xz.y < uRoof.w;
}

// Thinned out over the building, faint right in front of the camera and far from you.
float dropAlpha(vec3 p, vec2 landing, float edge, float depth) {
  float thin = overBuilding(landing) && aRnd > ${OVER_BUILDING.toFixed(2)} ? 0.0 : 1.0;
  return thin * edge * smoothstep(1.5, 6.0, depth) * (1.0 - smoothstep(AREA * 0.3, AREA * 0.5, distance(p.xz, uCenter)));
}
`;

const RAIN_VERTEX = /* glsl */ `
${COMMON}
uniform vec2 uShape;
varying float vTail;
varying float vY;
varying float vFloor;

void main() {
  vec2 landing;
  float edge;
  vec3 head = dropAt(0.0, landing, edge);
  vec3 tail = head - normalize(vec3(uWind.x, -uFall * aDrop.w, uWind.y)) * uShape.y;
  vec4 a = viewMatrix * vec4(head, 1.0);
  vec4 b = viewMatrix * vec4(tail, 1.0);
  // A thin quad from head to tail, facing the camera.
  vec2 d = b.xy - a.xy;
  float len = length(d);
  vec2 side = len > 1e-4 ? vec2(-d.y, d.x) / len : vec2(1.0, 0.0);
  vec4 mvPosition = mix(a, b, position.y);
  mvPosition.xy += side * position.x * uShape.x * 0.5;
  gl_Position = projectionMatrix * mvPosition;
  vTail = position.y;
  vY = mix(head.y, tail.y, position.y);
  vFloor = overBuilding(head.xz) ? ROOF : 0.0;
  vAlpha = dropAlpha(head, landing, edge, -a.z);
  #include <fog_vertex>
}
`;

const RAIN_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying float vTail;
varying float vY;
varying float vFloor;
#include <fog_pars_fragment>

void main() {
  if (vY < vFloor) discard;
  float alpha = uOpacity * vAlpha * (1.0 - 0.75 * vTail);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uColor, alpha);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const SNOW_VERTEX = /* glsl */ `
${COMMON}
uniform vec2 uShape;
varying vec2 vCorner;

void main() {
  vec2 landing;
  float edge;
  vec3 flake = dropAt(0.35, landing, edge);
  vec4 mvPosition = viewMatrix * vec4(flake, 1.0);
  mvPosition.xy += position.xy * uShape.x;
  gl_Position = projectionMatrix * mvPosition;
  vCorner = position.xy;
  vAlpha = flake.y < (overBuilding(flake.xz) ? ROOF : 0.0) ? 0.0 : dropAlpha(flake, landing, edge, -mvPosition.z);
  #include <fog_vertex>
}
`;

const SNOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying vec2 vCorner;
#include <fog_pars_fragment>

void main() {
  float alpha = uOpacity * vAlpha * (1.0 - smoothstep(0.35, 1.0, length(vCorner)));
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uColor, alpha);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function makeGeometry(kind: PrecipitationKind, count: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  // Rain: x across the streak, y from head (0) to tail (1). Snow: a square around the flake.
  const corners = kind === 'snow' ? [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0] : [-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0];
  g.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  const drops = new Float32Array(count * 4);
  const rnd = new Float32Array(count);
  const spread = kind === 'snow' ? 0.6 : 0.3;
  for (let i = 0; i < count; i++) {
    drops[i * 4] = Math.random();
    drops[i * 4 + 1] = Math.random();
    drops[i * 4 + 2] = Math.random();
    drops[i * 4 + 3] = 1 - spread / 2 + Math.random() * spread;
    rnd[i] = Math.random();
  }
  g.setAttribute('aDrop', new THREE.InstancedBufferAttribute(drops, 4));
  g.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 1));
  g.instanceCount = 0;
  return g;
}

/** Falling rain or snow; how much and which way the wind blows come from `fx`, eased by the weather scene. */
export function Precipitation({ kind, fx, width, depth, small }: { kind: PrecipitationKind; fx: Fx; width: number; depth: number; small: boolean }) {
  const k = KINDS[kind];
  const max = k.max[small ? 1 : 0];
  const mesh = useRef<THREE.Mesh>(null);
  const time = useRef(0);
  const geometry = useMemo(() => makeGeometry(kind, max), [kind, max]);
  const { material, uniforms } = useMemo(() => {
    const uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 },
      uSway: { value: new THREE.Vector2() },
      uCenter: { value: new THREE.Vector2() },
      uTop: { value: k.top },
      uFall: { value: k.fall },
      uWind: { value: new THREE.Vector2() },
      uRoof: { value: new THREE.Vector4() },
      uShape: { value: new THREE.Vector2(k.width, k.length) },
      uColor: { value: new THREE.Color() },
      uOpacity: { value: k.opacity },
    };
    const snow = kind === 'snow';
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: snow ? SNOW_VERTEX : RAIN_VERTEX,
      fragmentShader: snow ? SNOW_FRAGMENT : RAIN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      // Not tone mapped, so they stay light against the floor.
      toneMapped: false,
    });
    return { material, uniforms };
  }, [kind, k]);
  const base = useMemo(() => new THREE.Color(k.color), [k]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  // The building, walls included.
  useEffect(() => void uniforms.uRoof.value.set(-WALL, -WALL, width + WALL, depth + WALL), [uniforms, width, depth]);

  useFrame((_, dt) => {
    const look = fx.current;
    time.current += Math.min(dt, 0.1);
    uniforms.uTime.value = time.current % PERIOD;
    uniforms.uSway.value.set((time.current * 0.9) % TAU, (time.current * 0.7) % TAU);
    uniforms.uCenter.value.set(local.x, local.z);
    // Drops drift slower than the wind, and only so far.
    const wind = Math.hypot(look.windX, look.windZ);
    const drift = wind > 0 ? Math.min(wind * k.drift, k.maxDrift) / wind : 0;
    uniforms.uWind.value.set(look.windX * drift, look.windZ * drift);
    uniforms.uColor.value.copy(base).multiplyScalar(fx.level);
    geometry.instanceCount = Math.round(max * look.precip);
    if (mesh.current) mesh.current.visible = geometry.instanceCount > 0;
  });

  return <mesh ref={mesh} geometry={geometry} material={material} frustumCulled={false} renderOrder={1} />;
}
