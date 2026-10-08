import type { ComponentType } from 'react';
import * as THREE from 'three';
import { createRegistry } from '../lib/registry';

/** Something a feature adds to the 3D office (weather effects…), rendered inside the scene. */
export interface SceneLayer {
  id: string;
  /** Position among the layers. */
  order: number;
  /**
   * Rendered inside the Canvas, after the office. It may suspend (e.g. a lazy component): each layer has its
   * own Suspense, and its own error boundary, so one that fails renders nothing and the office carries on.
   */
  Component: ComponentType;
}

const layers = createRegistry<SceneLayer>();

/** Adds a scene layer (call it when your module loads); returns a function that removes it. */
export const registerSceneLayer = layers.register;
export const useSceneLayers = layers.useList;
/** The React key for a layer (it changes when the layer is registered again). */
export const sceneLayerKey = layers.keyOf;

// The fixed daytime sun: south-west, high up. Lights puts it this many office spans from the middle.
const SUN = new THREE.Vector3(-0.35, 0.9, 0.45);
export const SUN_DISTANCE = SUN.length();

/** The fixed daytime look. */
export function defaultSceneLighting() {
  return {
    /** Background and fog colour; null is the theme's sky (useSceneColors). */
    sky: null as THREE.Color | null,
    fogNear: 45,
    fogFar: 110,
    /** Unit vector from the middle of the office towards the sun (or moon). */
    sunDir: SUN.clone().normalize(),
    sunColor: new THREE.Color('#ffffff'),
    sunIntensity: 1.6,
    hemiSky: new THREE.Color('#f4f1ff'),
    hemiGround: new THREE.Color('#8c7a6b'),
    hemiIntensity: 1.25,
    ambientIntensity: 0.35,
    /** How lit the ground around the building looks (1: the theme's colour; less at night). */
    groundShade: 1,
    /** How wet the ground around the building looks, 0–1. */
    wetness: 0,
    /** The wind in m/s towards +x (east) and +z (south); plants sway with it. */
    windX: 0,
    windZ: 0,
  };
}

export type SceneLighting = ReturnType<typeof defaultSceneLighting>;

/**
 * The scene's light, air and wind. The office's own components read it every frame; a feature (weather)
 * may change it from useFrame (priority -1, before they read it) and calls resetSceneLighting when it stops,
 * e.g. on unmount. The defaults are the fixed daytime look, with no wind.
 */
export const sceneLighting: SceneLighting = defaultSceneLighting();

/** Back to the fixed daytime look. */
export function resetSceneLighting(): void {
  Object.assign(sceneLighting, defaultSceneLighting());
}
