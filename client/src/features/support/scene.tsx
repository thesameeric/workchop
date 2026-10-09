import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { registerItemModel, type ItemModelProps } from '../../world/extensions';
import { Box, OpacityContext } from '../../world/prims';
import { drawBoard } from './board';
import { BOARD_SCREEN_TYPE } from './places';
import { useSupport } from './state';

// The support feature's 3D parts, loaded with the scene: the queue screen showing Now serving.

const SCREEN_W = 1024;
const SCREEN_H = 416;
const screenGeo = new THREE.PlaneGeometry(2.76, 1.12);
/** How long a newly called number stands out. */
const FRESH_MS = 8000;

const clockTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** A big screen on the wall (its back against the back of the footprint) with the live queue on it. */
function QueueBoard(_: ItemModelProps) {
  const parts = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return { ctx: canvas.getContext('2d')!, texture, material: new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }) };
  }, []);
  useEffect(
    () => () => {
      parts.texture.dispose();
      parts.material.dispose();
    },
    [parts],
  );

  const board = useSupport((s) => s.board);
  const mine = useSupport((s) => (s.ticket?.status === 'active' ? s.ticket.number : null));
  const [time, setTime] = useState(clockTime);
  useEffect(() => {
    const t = setInterval(() => setTime(clockTime()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Numbers that weren't on the screen a moment ago stand out for a while (each on its own timer,
  // so another update meanwhile doesn't keep one lit).
  const seen = useRef<Set<number> | null>(null);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const [fresh, setFresh] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    const now = new Set(board.serving.map((s) => s.number));
    const added = seen.current ? [...now].filter((n) => !seen.current!.has(n)) : [];
    seen.current = now;
    if (!added.length) return;
    setFresh((f) => new Set([...f, ...added]));
    for (const n of added) {
      clearTimeout(timers.current.get(n));
      timers.current.set(
        n,
        setTimeout(() => {
          timers.current.delete(n);
          setFresh((f) => new Set([...f].filter((x) => x !== n)));
        }, FRESH_MS),
      );
    }
  }, [board]);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    drawBoard(parts.ctx, SCREEN_W, SCREEN_H, { board, time, mine, fresh });
    parts.texture.needsUpdate = true;
  }, [parts, board, time, mine, fresh]);

  // Fades with the rest of the item (when it's in the way of the camera, or a build preview).
  const opacity = useContext(OpacityContext);
  useEffect(() => {
    parts.material.opacity = opacity;
    parts.material.transparent = opacity < 0.99;
  }, [parts, opacity]);

  return (
    <group>
      <Box p={[0, 1.72, -0.24]} s={[1.2, 0.5, 0.02]} c="#5b5f66" />
      <Box p={[0, 1.72, -0.18]} s={[2.9, 1.26, 0.1]} c="#16181d" rounded />
      <mesh geometry={screenGeo} material={parts.material} position={[0, 1.72, -0.128]} />
      <Box p={[0, 1.04, -0.2]} s={[0.5, 0.05, 0.05]} c="#5b6cff" emissive="#5b6cff" emissiveIntensity={0.8} shadow={false} />
    </group>
  );
}

registerItemModel(BOARD_SCREEN_TYPE, QueueBoard);
