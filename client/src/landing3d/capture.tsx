import { advance, Canvas, useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import { appInfo } from '../features/world/screen';
import { LOGO_PATH } from '../ui/Brand';
import { CAST, type ActorId } from './cast';
import { roomBusyAt, sayingAt, SIGN_POINT, T_POSTER, tagPoint, type Point3 } from './director';
import { bake, Scene } from './Diorama';
import type { PosterLabel } from './poster';
import { FOV, planShot, SHOTS, type ShotName } from './shots';

// DEV only (HeroStage loads it for /?capture=<receiver>): draws the landing page's stills from the
// real scene, sends them to `node scripts/capture-landing.mjs` (the receiver, which saves them into
// client/public/landing/), and prints the poster's label positions for poster.ts.

interface Still {
  file: string;
  shot: ShotName;
  t: number;
  width: number;
  height: number;
  /** Print where the labels go, for this poster in poster.ts. */
  poster?: 'wide' | 'narrow';
}

const STILLS: Still[] = [
  { file: 'hero-wide.webp', shot: 'heroWide', t: T_POSTER, width: 1360, height: 1020, poster: 'wide' },
  { file: 'hero-narrow.webp', shot: 'heroNarrow', t: T_POSTER, width: 720, height: 600, poster: 'narrow' },
  { file: 'shot-lounge.webp', shot: 'lounge', t: 0.5, width: 1200, height: 900 },
  { file: 'shot-support.webp', shot: 'support', t: 20, width: 1200, height: 900 },
];
const OG_SHOT = { shot: 'og' as const, t: T_POSTER, width: 680, height: 630 };
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Draws the scene at the still's time after the shadows and a few frames, then hands over the canvas. */
function Shoot({ t, onDone }: { t: number; onDone: (canvas: HTMLCanvasElement) => void }) {
  const get = useThree((s) => s.get);
  useEffect(() => {
    bake(get(), t);
    let frames = 0;
    let raf = 0;
    const step = () => {
      advance(t, true, get());
      if (++frames < 3) raf = requestAnimationFrame(step);
      else onDone(get().gl.domElement);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [get, t, onDone]);
  return null;
}

/** Renders one still, 1:1 pixels; resolves with a copy of the picture. */
function shoot(root: Root, still: Omit<Still, 'file'>): Promise<HTMLCanvasElement> {
  return new Promise((resolve) => {
    const done = (canvas: HTMLCanvasElement) => {
      const copy = document.createElement('canvas');
      copy.width = still.width;
      copy.height = still.height;
      copy.getContext('2d')!.drawImage(canvas, 0, 0);
      resolve(copy);
    };
    root.render(
      <Canvas
        key={`${still.shot}:${still.width}`}
        frameloop="never"
        dpr={1}
        shadows="percentage"
        gl={{ alpha: true, antialias: true, preserveDrawingBuffer: true }}
        camera={{ fov: FOV, near: 1, far: 150 }}
        style={{ width: still.width, height: still.height }}
      >
        <Scene shot={still.shot} drift={false} />
        <Shoot t={still.t} onDone={done} />
      </Canvas>,
    );
  });
}

/** Where a point lands in a still, in % of its width and height. */
function projector(shot: ShotName, width: number, height: number): (p: Point3) => { x: number; y: number } | null {
  const plan = planShot(SHOTS[shot], width / height);
  const camera = new THREE.PerspectiveCamera(plan.fov, width / height, 1, 150);
  camera.position.set(...plan.position);
  camera.lookAt(...plan.target);
  camera.updateMatrixWorld();
  const v = new THREE.Vector3();
  const round = (n: number) => Math.round(n * 100) / 100;
  return (p) => {
    v.set(p.x, p.y, p.z).project(camera);
    if (Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) return null;
    return { x: round((v.x * 0.5 + 0.5) * 100), y: round((-v.y * 0.5 + 0.5) * 100) };
  };
}

/** The labels the live scene shows at the still's moment. */
function posterLabels(still: Still): PosterLabel[] {
  const at = projector(still.shot, still.width, still.height);
  const t = still.t;
  const out: PosterLabel[] = [];
  const sign = at(SIGN_POINT);
  if (sign) out.push({ kind: 'sign', active: roomBusyAt(t), ...sign });
  for (const a of CAST) {
    const p = tagPoint(a.id, t);
    const q = p && at(p);
    if (q) out.push({ kind: 'tag', who: a.id, speaking: !!sayingAt(a.id, t), ...q });
  }
  for (const a of CAST) {
    const text = sayingAt(a.id, t);
    const p = tagPoint(a.id, t);
    const q = text && p && at(p);
    if (text && q) out.push({ kind: 'bubble', who: a.id, text, ...q });
  }
  return out;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`No ${type} from the canvas`))), type, quality));
}

async function send(receiver: string, file: string, blob: Blob): Promise<void> {
  const res = await fetch(`${receiver.replace(/\/$/, '')}/save/${file}`, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } });
  if (!res.ok) throw new Error(`The receiver didn't take ${file} (${res.status})`);
  console.info(`[capture] ${file}: ${Math.round(blob.size / 1024)} KB`);
}

// ---------- The og image ----------

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rgb: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(rx / ry, 1);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
  g.addColorStop(0, `rgb(${rgb})`);
  g.addColorStop(0.6, `rgba(${rgb}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(-ry, -ry, ry * 2, ry * 2);
  ctx.restore();
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** A name tag like the office's, bigger, centred on (x, y); with an app chip for `app`. */
function nameTag(ctx: CanvasRenderingContext2D, x: number, y: number, name: string, app?: string) {
  const h = 32;
  ctx.font = `600 19px ${FONT}`;
  const nameW = ctx.measureText(name).width;
  const info = app ? appInfo(app) : null;
  ctx.font = `600 15px ${FONT}`;
  const chipW = info ? 30 + ctx.measureText(info.label).width : 0;
  const w = 12 + 12 + 8 + nameW + (info ? 8 + chipW : 0) + 14;
  const left = x - w / 2;
  const top = y - h / 2;
  pill(ctx, left, top, w, h, 'rgba(22, 24, 38, 0.8)');
  ctx.beginPath();
  ctx.arc(left + 18, y, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#3ddc84';
  ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 19px ${FONT}`;
  ctx.fillText(name, left + 32, y + 1);
  if (info) {
    const cx = left + 32 + nameW + 8;
    pill(ctx, cx, top + 5, chipW, h - 10, info.color);
    pill(ctx, cx, top + 5, chipW, h - 10, 'rgba(17, 19, 27, 0.38)');
    ctx.fillStyle = '#ffffff';
    ctx.font = '15px hugeicons';
    ctx.fillText(info.glyph, cx + 7, y + 1);
    ctx.font = `600 15px ${FONT}`;
    ctx.fillText(info.label, cx + 26, y + 1);
  }
}

/** A white speech bubble whose tail's tip is at (x, y). */
function bubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.font = `600 20px ${FONT}`;
  const w = ctx.measureText(text).width + 32;
  const h = 40;
  const tail = 11;
  const top = y - tail - h;
  ctx.save();
  ctx.shadowColor = 'rgba(20, 22, 40, 0.2)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 8;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, top, w, h, 16);
  ctx.moveTo(x - tail, top + h);
  ctx.lineTo(x, y);
  ctx.lineTo(x + tail, top + h);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#1d2030';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, top + h / 2 + 1);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  return [...lines, line];
}

/** 1200 × 630: the name and the headline on the left, the office on the right. */
function composeOg(shot: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f4f5fb';
  ctx.fillRect(0, 0, 1200, 630);
  // The landing page's light glow (--landing-glow).
  glow(ctx, 1020, -63, 960, 480, '223, 227, 255');
  glow(ctx, -120, 693, 640, 480, '255, 230, 217');
  const left = 520;
  ctx.drawImage(shot, left, 0);
  const at = projector(OG_SHOT.shot, OG_SHOT.width, OG_SHOT.height);
  const px = (who: ActorId) => {
    const p = tagPoint(who, OG_SHOT.t);
    const q = p && at(p);
    return q ? { x: left + (q.x / 100) * OG_SHOT.width, y: (q.y / 100) * OG_SHOT.height } : null;
  };
  const amaTag = px('ama');
  const utibeTag = px('utibe');
  const promiseTag = px('promise');
  if (amaTag) nameTag(ctx, amaTag.x, amaTag.y, 'Ama');
  if (utibeTag) nameTag(ctx, utibeTag.x, utibeTag.y, 'Utibe', 'figma');
  // Above where Promise's name tag would be.
  if (promiseTag) bubble(ctx, promiseTag.x, promiseTag.y - 22, 'So, about the launch…');

  ctx.save();
  ctx.translate(72, 120);
  ctx.scale(56 / 24, 56 / 24);
  ctx.fillStyle = '#5b6cff';
  ctx.fill(new Path2D(LOGO_PATH), 'evenodd');
  ctx.restore();
  ctx.fillStyle = '#1d2030';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `800 44px ${FONT}`;
  ctx.fillText('Homeoffice', 72 + 56 + 14, 120 + 29);
  ctx.font = `750 62px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  wrap(ctx, 'An office your team can walk into.', 470).forEach((line, i) => ctx.fillText(line, 72, 290 + i * 65));
  ctx.font = `600 26px ${FONT}`;
  ctx.fillStyle = '#444a63';
  ctx.fillText('homeoffice.town', 72, 540);
  return canvas;
}

let started = false;

/** Renders and sends every still and the og image, then prints poster.ts's labels. */
export async function capture(receiver: string): Promise<void> {
  if (started) return;
  started = true;
  await document.fonts.load('20px hugeicons');
  await document.fonts.ready;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none';
  document.body.append(host);
  const root = createRoot(host);
  try {
    const labels: Partial<Record<'wide' | 'narrow', PosterLabel[]>> = {};
    for (const still of STILLS) {
      const canvas = await shoot(root, still);
      await send(receiver, still.file, await toBlob(canvas, 'image/webp', 0.86));
      if (still.poster) labels[still.poster] = posterLabels(still);
    }
    const og = composeOg(await shoot(root, OG_SHOT));
    await send(receiver, 'og.jpg', await toBlob(og, 'image/jpeg', 0.88));
    const literal = (l: PosterLabel) => `{ ${Object.entries(l).map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : v}`).join(', ')} },`;
    const list = (name: 'wide' | 'narrow') => `  ${name}: [\n${(labels[name] ?? []).map((l) => `    ${literal(l)}`).join('\n')}\n  ],`;
    console.info(`[capture] Done. POSTER_LABELS for poster.ts:\n${list('wide')}\n${list('narrow')}`);
  } catch (err) {
    console.error('[capture] failed:', err);
  } finally {
    root.unmount();
    host.remove();
  }
}
