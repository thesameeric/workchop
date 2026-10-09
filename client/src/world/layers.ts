import type { ComponentType } from 'react';
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
