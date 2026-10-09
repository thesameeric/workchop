import { advance, Canvas, useFrame, useThree, type RootState } from '@react-three/fiber';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import * as THREE from 'three';
import { getEntry } from '../../../shared/catalog';
import type { OfficeItem } from '../../../shared/types';
import { Aquarium, InfoBoard, SupportDesk } from '../features/world/lobby';
import { PLANT_MODELS } from '../features/world/models';
import { appInfo, drawScreen } from '../features/world/screen';
import { shade } from '../lib/color';
import { Avatar, BlobShadow, useMotion } from '../world/Avatar';
import type { ItemModelProps } from '../world/extensions';
import { defaultSceneLighting } from '../world/lighting';
import { ItemModel } from '../world/models';
import { Box } from '../world/prims';
import { floorTexture } from '../world/textures';
import { CAST, type Actor, type ActorId } from './cast';
import { ballAt, emotePoint, emotesAt, gestureAt, inLineAt, poseAt, roomBusyAt, sayingAt, SIGN_POINT, T_POSTER, tagPoint, type Emote, type Point3 } from './director';
import { arrange, Bubble, NameTag, RoomSign, type Placed } from './labels';
import { bubbleShift, type Move } from './layout';
import { LIT_DESKS, OFFICE, ROOM } from './office';
import { FOV, planShot, SHOTS, type ShotName } from './shots';

// The live 3D office on the landing page: its own small office and cast, played from the script in
// director.ts. Nothing here touches the app's store, session or the office's shared state: it only
// reuses the office's models. Loaded on its own (HeroStage imports it once the hero may move).

const { width: W, depth: D, wallColor, floor, floorColor } = OFFICE.settings;

// ---------- The building ----------

const WALL_H = 2.6;
const WALL_T = 0.3;
const CUT_H = 0.35;
/** Where the south wall is open (the entrance). */
const DOOR = [16, 18];
/** Windows along the north wall (their middles), clear of the art and the shelves. */
const WINDOWS = [6, 13, 17];

/** The floor on its slab, full-height walls at the back (north, west) and cut-away ones in front. */
function Shell() {
  const map = useMemo(() => {
    const t = floorTexture(floor, floorColor).clone();
    t.repeat.set(W / 2, D / 2);
    t.needsUpdate = true;
    return t;
  }, []);
  useEffect(() => () => map.dispose(), [map]);
  const side = shade(wallColor, -0.35);
  const trim = shade(wallColor, -0.25);
  const cutTop = shade(wallColor, -0.3);
  const cut = (x0: number, x1: number, z0: number, z1: number) => (
    <group key={`${x0}:${z0}`}>
      <Box p={[(x0 + x1) / 2, CUT_H / 2, (z0 + z1) / 2]} s={[x1 - x0, CUT_H, z1 - z0]} c={wallColor} />
      <Box p={[(x0 + x1) / 2, CUT_H + 0.01, (z0 + z1) / 2]} s={[x1 - x0, 0.02, z1 - z0]} c={cutTop} shadow={false} />
    </group>
  );
  return (
    <group>
      <Box p={[W / 2, -0.151, D / 2]} s={[W + WALL_T * 2, 0.3, D + WALL_T * 2]} c={side} shadow={false} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0, D / 2]} receiveShadow>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial map={map} roughness={0.85} />
      </mesh>
      <Box p={[W / 2, WALL_H / 2, -WALL_T / 2]} s={[W + WALL_T * 2, WALL_H, WALL_T]} c={wallColor} />
      <Box p={[W / 2, 0.07, -WALL_T / 2]} s={[W + WALL_T * 2, 0.14, WALL_T + 0.02]} c={trim} />
      <Box p={[-WALL_T / 2, WALL_H / 2, D / 2]} s={[WALL_T, WALL_H, D]} c={wallColor} />
      <Box p={[-WALL_T / 2, 0.07, D / 2]} s={[WALL_T + 0.02, 0.14, D]} c={trim} />
      {cut(-WALL_T, DOOR[0], D, D + WALL_T)}
      {cut(DOOR[1], W + WALL_T, D, D + WALL_T)}
      {cut(W, W + WALL_T, 0, D)}
      {WINDOWS.map((x) => (
        <group key={x} position={[x, 1.6, 0.005]}>
          <Box p={[0, 0, 0]} s={[2.2, 1.1, 0.02]} c="#2d2f36" shadow={false} />
          <Box p={[0, 0, 0.012]} s={[2.05, 0.95, 0.01]} c="#a8d8ff" emissive="#a8d8ff" emissiveIntensity={0.45} shadow={false} />
          <Box p={[0, 0, 0.02]} s={[0.04, 0.95, 0.01]} c="#2d2f36" shadow={false} />
        </group>
      ))}
    </group>
  );
}

// ---------- Furniture ----------

/** Models the office's features add (resolved here, so they don't depend on those modules having loaded). */
const FEATURE_MODELS: Record<string, (props: ItemModelProps) => ReactNode> = {
  ...PLANT_MODELS,
  aquarium: Aquarium,
  'info-board': InfoBoard,
  'support-desk': SupportDesk,
};

function Furniture() {
  return (
    <group>
      {OFFICE.items.map((item) => {
        const Model = FEATURE_MODELS[item.type];
        const c = item.color ?? getEntry(item.type)?.defaultColor ?? '#cccccc';
        return (
          <group key={item.id} position={[item.x, 0, item.z]} rotation-y={(item.rot * Math.PI) / 2}>
            {Model ? <Model item={item} c={c} /> : <ItemModel type={item.type} color={item.color} itemId={item.id} data={item.data} item={item} />}
          </group>
        );
      })}
    </group>
  );
}

const SCREEN_W = 512;
const SCREEN_H = 272;
const screenGeo = new THREE.PlaneGeometry(0.8, 0.42);

/** A desk's monitor showing the app its person is in (at a fixed time, so the poster stays the same). */
function Screen({ desk, name, app }: { desk: OfficeItem; name: string; app: string }) {
  const parts = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    const ctx = canvas.getContext('2d')!;
    const draw = () => drawScreen(ctx, SCREEN_W, SCREEN_H, { name, app: appInfo(app), time: '10:42' });
    draw();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return { draw, texture, material: new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }) };
  }, [name, app]);
  useEffect(() => {
    let mounted = true;
    // The app's icon comes from the icon font: draw again once it's in.
    void document.fonts.load('20px hugeicons').then(() => {
      if (!mounted) return;
      parts.draw();
      parts.texture.needsUpdate = true;
    });
    return () => {
      mounted = false;
      parts.texture.dispose();
      parts.material.dispose();
    };
  }, [parts]);
  return (
    <group position={[desk.x, 0, desk.z]} rotation-y={(desk.rot * Math.PI) / 2}>
      <mesh geometry={screenGeo} material={parts.material} position={[0, 0.98, -0.274]} />
    </group>
  );
}

function Screens() {
  return (
    <>
      {LIT_DESKS.map((d) => {
        const desk = OFFICE.items.find((i) => i.type === 'desk' && i.x === d.x && i.z === d.z)!;
        return <Screen key={desk.id} desk={desk} name={d.name} app={d.app} />;
      })}
    </>
  );
}

/** The meeting room's floor, brighter while someone's inside (as in the office). */
function Room() {
  const fill = useMemo(() => new THREE.MeshBasicMaterial({ color: ROOM.color, transparent: true, opacity: 0.1, depthWrite: false }), []);
  const edge = useMemo(() => new THREE.MeshBasicMaterial({ color: ROOM.color, transparent: true, opacity: 0.5, depthWrite: false }), []);
  useEffect(
    () => () => {
      fill.dispose();
      edge.dispose();
    },
    [fill, edge],
  );
  const checked = useRef(-1);
  useFrame(({ clock }) => {
    // Ten times a second is plenty.
    const tenth = Math.floor(clock.elapsedTime * 10);
    if (tenth === checked.current) return;
    checked.current = tenth;
    const busy = roomBusyAt(clock.elapsedTime);
    fill.opacity = busy ? 0.2 : 0.1;
    edge.opacity = busy ? 0.85 : 0.5;
  });
  const { x, z, w, d } = ROOM;
  const e = 0.06;
  return (
    <group position={[x, 0.016, z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[w / 2, 0, d / 2]} material={fill}>
        <planeGeometry args={[w, d]} />
      </mesh>
      {[
        [w / 2, e / 2, w, e],
        [w / 2, d - e / 2, w, e],
        [e / 2, d / 2, e, d],
        [w - e / 2, d / 2, e, d],
      ].map(([cx, cz, sw, sd], i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.002, cz]} material={edge}>
          <planeGeometry args={[sw, sd]} />
        </mesh>
      ))}
    </group>
  );
}

// ---------- People and the ball ----------

const ringMaterial = new THREE.MeshBasicMaterial({ color: '#3ddc84', transparent: true, opacity: 0.9, depthWrite: false });
const ringGeo = new THREE.RingGeometry(0.36, 0.44, 40);

function ActorView({ actor }: { actor: Actor }) {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const motion = useMotion();
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const p = poseAt(actor.id, t);
    const g = group.current;
    if (!g) return;
    g.position.set(p.x, 0, p.z);
    g.rotation.y = p.ry;
    g.scale.setScalar(Math.max(p.scale, 0.001));
    g.visible = p.scale > 0;
    const m = motion.current;
    m.anim = p.anim;
    m.speed = p.speed;
    const gesture = gestureAt(actor.id, t);
    if (gesture) Object.assign(m, { gesture: gesture.gesture, gestureUntil: performance.now() + gesture.left * 1000 });
    else m.gestureUntil = 0;
    if (ring.current) ring.current.visible = !!sayingAt(actor.id, t);
  });
  return (
    <group ref={group}>
      <BlobShadow />
      <Avatar config={actor.avatar} motion={motion} focus={actor.focus} />
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} geometry={ringGeo} material={ringMaterial} visible={false} />
    </group>
  );
}

function PingPongBall() {
  const ref = useRef<THREE.Mesh>(null);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4, transparent: true }), []);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(({ clock }) => {
    const b = ballAt(clock.elapsedTime);
    const m = ref.current;
    if (!m) return;
    m.position.set(b.x, b.y, b.z);
    m.visible = b.opacity > 0;
    material.opacity = b.opacity;
  });
  return (
    <mesh ref={ref} material={material} scale={0.03}>
      <sphereGeometry args={[1, 12, 8]} />
    </mesh>
  );
}

// ---------- Light and camera ----------

const lighting = defaultSceneLighting();
const MIDDLE = new THREE.Vector3(W / 2, 0, D / 2);

/** The office's daytime light. Its shadows are drawn once (see bake), so only the furniture casts them. */
function Lights() {
  const gl = useThree((s) => s.gl);
  const target = useMemo(() => {
    const o = new THREE.Object3D();
    o.position.copy(MIDDLE);
    return o;
  }, []);
  useLayoutEffect(() => {
    gl.shadowMap.autoUpdate = false;
  }, [gl]);
  const sun = MIDDLE.clone().addScaledVector(lighting.sunDir, 30);
  return (
    <>
      <hemisphereLight args={[lighting.hemiSky, lighting.hemiGround, lighting.hemiIntensity]} />
      <ambientLight intensity={lighting.ambientIntensity} />
      <primitive object={target} />
      <directionalLight
        position={sun}
        target={target}
        color={lighting.sunColor}
        intensity={lighting.sunIntensity}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
        shadow-camera-near={10}
        shadow-camera-far={50}
      />
    </>
  );
}

interface Nudge {
  theta: number;
  phi: number;
}

/** Points the camera for the shot: drifting slowly with `drift`, and turned a little towards the pointer. */
function CameraRig({ shot, drift, pointer }: { shot: ShotName; drift: boolean; pointer?: RefObject<Nudge> }) {
  const eased = useRef<Nudge>({ theta: 0, phi: 0 });
  useFrame(({ camera, size, clock }, dt) => {
    const n = eased.current;
    const goal = pointer?.current;
    if (goal) {
      const k = 1 - Math.exp(-3 * Math.max(0, dt));
      n.theta += (goal.theta - n.theta) * k;
      n.phi += (goal.phi - n.phi) * k;
    }
    const plan = planShot(SHOTS[shot], size.width / size.height, drift ? clock.elapsedTime : undefined, n);
    camera.position.set(...plan.position);
    camera.lookAt(...plan.target);
    camera.updateMatrixWorld();
  });
  return null;
}

// ---------- Labels ----------

interface Anchor {
  el: HTMLElement;
  point: (t: number) => Point3 | null;
  kind: Placed['kind'];
  /** Labels in the same group move together: someone's name tag, bubble and emote. */
  group: string;
  last: string;
}

type Anchors = Map<string, Anchor>;

const projected = new THREE.Vector3();

/** Where a group of labels is drawn (`at`) on its way to where it should be (`goal`). */
interface Glide {
  at: Move;
  goal: Move;
}

/** Moves each label to the screen position of its point, clear of the others; labels outside the frame are hidden. */
function Projector({ anchors }: { anchors: Anchors }) {
  const eased = useRef(new Map<string, Glide>());
  const frameWidth = useRef(0);
  useFrame(({ camera, size, clock }, dt) => {
    const shown: (Placed & { anchor: Anchor })[] = [];
    for (const a of anchors.values()) {
      const p = a.point(clock.elapsedTime);
      if (p) projected.set(p.x, p.y, p.z).project(camera);
      if (!p || projected.z <= -1 || projected.z >= 1 || Math.abs(projected.x) > 1.2 || Math.abs(projected.y) > 1.2) {
        if (a.last !== 'hidden') {
          a.last = 'hidden';
          a.el.style.visibility = 'hidden';
        }
        continue;
      }
      const x = (projected.x * 0.5 + 0.5) * size.width;
      const y = (-projected.y * 0.5 + 0.5) * size.height;
      shown.push({ anchor: a, group: a.group, kind: a.kind, el: a.el, x, y });
    }
    const goals = arrange(shown, size.width, size.height);
    // Labels follow small, steady changes exactly (people walking past each other) and glide over
    // jumps (a bubble pushing a tag aside), except on the first frame, after a resize and when paused.
    const snap = dt <= 0 || dt > 0.25 || size.width !== frameWidth.current;
    const k = 1 - Math.exp(-18 * dt);
    frameWidth.current = size.width;
    const next = new Map<string, Glide>();
    shown.forEach((l, i) => {
      let m = next.get(l.group)?.at;
      if (!m) {
        const goal = goals[i];
        const was = eased.current.get(l.group);
        if (snap || !was) {
          m = { dx: goal.dx, dy: goal.dy };
        } else {
          const steady = Math.abs(goal.dx - was.goal.dx) < 4 && Math.abs(goal.dy - was.goal.dy) < 4;
          const from = steady ? { dx: was.at.dx + goal.dx - was.goal.dx, dy: was.at.dy + goal.dy - was.goal.dy } : was.at;
          m = { dx: from.dx + (goal.dx - from.dx) * k, dy: from.dy + (goal.dy - from.dy) * k };
        }
        next.set(l.group, { at: m, goal: { dx: goal.dx, dy: goal.dy } });
      }
      const x = Math.round(l.x + m.dx);
      const y = Math.round(l.y + m.dy);
      let value = `translate3d(${x}px, ${y}px, 0) translate(-50%, ${l.kind === 'bubble' ? '-100%' : '-50%'})`;
      if (l.kind === 'bubble') value += `|${bubbleShift(x, l.el.offsetWidth, size.width)}`;
      const a = l.anchor;
      if (value === a.last) return;
      a.last = value;
      const [transform, shift] = value.split('|');
      a.el.style.transform = transform;
      if (shift) a.el.style.setProperty('--shift', `${shift}px`);
      a.el.style.visibility = 'visible';
    });
    eased.current = next;
  });
  return null;
}

/** Which labels are up: speech bubbles, emotes, the queue chip and the meeting room's sign. */
interface Cues {
  says: Partial<Record<ActorId, string>>;
  emotes: Emote[];
  inLine: boolean;
  roomBusy: boolean;
}

function cuesAt(t: number): Cues {
  const says: Cues['says'] = {};
  for (const a of CAST) {
    const text = sayingAt(a.id, t);
    if (text) says[a.id] = text;
  }
  return { says, emotes: emotesAt(t), inLine: inLineAt(t), roomBusy: roomBusyAt(t) };
}

/** Tells `onCues` when the labels that are up change (looking ten times a second). */
function CueWatch({ onCues }: { onCues: (cues: Cues) => void }) {
  const last = useRef('');
  const checked = useRef(-1);
  useFrame(({ clock }) => {
    const tenth = Math.floor(clock.elapsedTime * 10);
    if (tenth === checked.current) return;
    checked.current = tenth;
    const cues = cuesAt(clock.elapsedTime);
    const key = JSON.stringify(cues);
    if (key === last.current) return;
    last.current = key;
    onCues(cues);
  });
  return null;
}

function Pinned({
  anchors,
  id,
  point,
  kind = 'tag',
  group = id,
  quiet = false,
  children,
}: {
  anchors: Anchors;
  id: string;
  point: Anchor['point'];
  kind?: Anchor['kind'];
  group?: string;
  /** A name tag that small stages leave out (hero3d.css): nobody's talking to or about them. */
  quiet?: boolean;
  children: ReactNode;
}) {
  const pointRef = useRef(point);
  pointRef.current = point;
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        el.style.visibility = 'hidden';
        anchors.set(id, { el, point: (t) => pointRef.current(t), kind, group, last: '' });
      } else {
        anchors.delete(id);
      }
    },
    [anchors, id, kind, group],
  );
  return (
    <div ref={ref} className={`world-label${quiet ? ' quiet' : ''}`}>
      {children}
    </div>
  );
}

function Labels({ anchors, cues }: { anchors: Anchors; cues: Cues }) {
  return (
    <div className="hero-stage-labels" aria-hidden="true">
      <Pinned anchors={anchors} id="sign" kind="sign" point={() => SIGN_POINT}>
        <RoomSign active={cues.roomBusy} />
      </Pinned>
      {CAST.map((a) => {
        const inLine = a.id === 'sanni' && cues.inLine;
        return (
          <Pinned key={a.id} anchors={anchors} id={`tag:${a.id}`} group={a.id} quiet={!cues.says[a.id] && !inLine} point={(t) => tagPoint(a.id, t)}>
            <NameTag actor={a} speaking={!!cues.says[a.id]} inLine={inLine} />
          </Pinned>
        );
      })}
      {CAST.map((a) => {
        const text = cues.says[a.id];
        const id = `say:${a.id}:${text}`;
        return (
          text && (
            <Pinned key={id} anchors={anchors} id={id} kind="bubble" group={a.id} point={(t) => tagPoint(a.id, t)}>
              <Bubble text={text} />
            </Pinned>
          )
        );
      })}
      {cues.emotes.map((e) => {
        const id = `emote:${e.who}:${e.at}`;
        return (
          <Pinned key={id} anchors={anchors} id={id} kind="emote" group={e.who} point={(t) => emotePoint(e, t)}>
            <div className="emote-bubble">{e.emoji}</div>
          </Pinned>
        );
      })}
    </div>
  );
}

// ---------- The scene ----------

/** Everything in the Canvas. The live hero and the capture tool (capture.tsx) both draw this. */
export function Scene({
  shot,
  drift,
  pointer,
  anchors,
  onCues,
}: {
  shot: ShotName;
  drift: boolean;
  pointer?: RefObject<Nudge>;
  anchors?: Anchors;
  onCues?: (cues: Cues) => void;
}) {
  return (
    <>
      <Lights />
      <Shell />
      <Furniture />
      <Screens />
      <Room />
      <group name="actors">
        {CAST.map((a) => (
          <ActorView key={a.id} actor={a} />
        ))}
        <PingPongBall />
      </group>
      <CameraRig shot={shot} drift={drift} pointer={pointer} />
      {anchors && <Projector anchors={anchors} />}
      {onCues && <CueWatch onCues={onCues} />}
    </>
  );
}

/**
 * Draws the scene at time `t` with the shadows baked: one frame with the people hidden (only the
 * furniture casts shadows; people have soft blobs), then the real one. The first frame's long step
 * from 0 also settles everyone straight into their pose.
 */
export function bake(state: RootState, t: number): void {
  const actors = state.scene.getObjectByName('actors');
  if (actors) actors.visible = false;
  state.gl.shadowMap.needsUpdate = true;
  advance(t, true, state);
  if (actors) actors.visible = true;
  advance(t, true, state);
}

// ---------- Live ----------

/** Frames that take longer than this on average (under ~22 fps) give up on the live scene. */
const SLOW_MS = 45;

/** Runs the scene's clock: a frame per display frame (or every other one at 30 fps), never while paused. */
function Ticker({ paused, fps, onReady, onSlow }: { paused: boolean; fps: number; onReady: () => void; onSlow: () => void }) {
  const get = useThree((s) => s.get);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const time = useRef(T_POSTER);
  const [ready, setReady] = useState(false);
  const callbacks = useRef({ onReady, onSlow });
  callbacks.current = { onReady, onSlow };

  // Start on the poster's moment, so the swap doesn't show.
  useEffect(() => {
    bake(get(), time.current);
    const raf = requestAnimationFrame(() => {
      advance(time.current, true, get());
      setReady(true);
      callbacks.current.onReady();
    });
    return () => cancelAnimationFrame(raf);
  }, [get]);

  // A resized canvas is blank until it's drawn again, paused or not.
  useEffect(() => {
    if (ready) advance(time.current, true, get());
  }, [ready, width, height, get]);

  useEffect(() => {
    if (!ready || paused) return;
    let raf = 0;
    let last = performance.now();
    const interval = 1000 / fps;
    // Frame times, checked after a warm-up (the slow fallback).
    const checkFrom = last + 2000;
    let windowStart = 0;
    let windowFrames = 0;
    const stats = { since: last, frames: 0, ms: 0 };
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < interval - 3) return;
      // A long gap (a busy main thread, a throttled tab) doesn't make the scene jump, and isn't
      // counted against the device either.
      if (now - last > 250) windowStart = 0;
      time.current += Math.min((now - last) / 1000, 0.1);
      last = now;
      const state = get();
      const before = performance.now();
      advance(time.current, true, state);
      const spent = performance.now() - before;
      if (now >= checkFrom) {
        if (!windowStart) {
          windowStart = now;
          windowFrames = 0;
        } else {
          windowFrames++;
        }
        if (now - windowStart >= 3000) {
          if ((now - windowStart) / windowFrames > SLOW_MS) {
            cancelAnimationFrame(raf);
            callbacks.current.onSlow();
            return;
          }
          windowStart = now;
          windowFrames = 0;
        }
      }
      if (import.meta.env.DEV) {
        stats.frames++;
        stats.ms += spent;
        if (now - stats.since > 5000) {
          const { render, memory } = state.gl.info;
          const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
          console.debug(
            `[hero] ${(stats.ms / stats.frames).toFixed(2)} ms/frame, ${((stats.frames * 1000) / (now - stats.since)).toFixed(0)} fps, ` +
              `${render.calls} calls, ${render.triangles} triangles, ${memory.textures} textures, ${memory.geometries} geometries, ` +
              `dpr ${state.viewport.dpr}${heap ? `, heap ${(heap / 1048576).toFixed(0)} MB` : ''}`,
          );
          Object.assign(stats, { since: now, frames: 0, ms: 0 });
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, paused, fps, get]);

  return null;
}

function useMedia(query: string): boolean {
  const list = useMemo(() => window.matchMedia(query), [query]);
  return useSyncExternalStore(
    (onChange) => {
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => list.matches,
  );
}

/** Where the pointer is over `area`, as a small turn of the camera (fine pointers only). */
function usePointerNudge(area: RefObject<HTMLElement | null> | undefined, on: boolean): RefObject<Nudge> {
  const nudge = useRef<Nudge>({ theta: 0, phi: 0 });
  useEffect(() => {
    const el = area?.current;
    nudge.current = { theta: 0, phi: 0 };
    if (!el || !on || !window.matchMedia('(pointer: fine)').matches) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      const y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      nudge.current = { theta: x * 0.05, phi: y * 0.02 };
    };
    const leave = () => void (nudge.current = { theta: 0, phi: 0 });
    el.addEventListener('pointermove', move, { passive: true });
    el.addEventListener('pointerleave', leave, { passive: true });
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [area, on]);
  return nudge;
}

export interface DioramaProps {
  /** Stops the clock (paused, off screen or in a hidden tab); the last frame stays. */
  paused: boolean;
  /** 'low' draws fewer pixels and, like phones, 30 frames a second. */
  quality: 'high' | 'low';
  /** The first frame is drawn (the poster's moment): fade it in. */
  onReady: () => void;
  /** Frames are too slow for this device: go back to the poster. */
  onSlow: () => void;
  /** The pointer moving over it turns the camera a little. */
  pointerArea?: RefObject<HTMLElement | null>;
}

export default function Diorama({ paused, quality, onReady, onSlow, pointerArea }: DioramaProps) {
  const anchors = useMemo<Anchors>(() => new Map(), []);
  const [cues, setCues] = useState(() => cuesAt(T_POSTER));
  const narrow = useMedia('(max-width: 639px)');
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const coarse = useMedia('(pointer: coarse)');
  const pointer = usePointerNudge(pointerArea, !reduced);
  const dpr = Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.75 : 1.25);
  return (
    <div className="hero-stage-live">
      <Canvas
        frameloop="never"
        dpr={dpr}
        shadows="percentage"
        gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
        camera={{ fov: FOV, near: 1, far: 150 }}
        style={{ pointerEvents: 'none' }}
      >
        <Scene shot={narrow ? 'heroNarrow' : 'heroWide'} drift={!reduced} pointer={pointer} anchors={anchors} onCues={setCues} />
        <Ticker paused={paused} fps={quality === 'low' || coarse ? 30 : 60} onReady={onReady} onSlow={onSlow} />
      </Canvas>
      <Labels anchors={anchors} cues={cues} />
    </div>
  );
}
