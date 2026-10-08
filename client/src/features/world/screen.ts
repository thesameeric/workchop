import { appInfo as appDef, HEADS_DOWN, OTHER_APP } from '../../../../shared/apps';
import { HUGEICONS, type HugeiconName } from '../../ui/hugeicons';

// What a desk monitor shows while someone sits at it: the app they're in (PlayerState.app, set by
// the presence feature; shared/apps.ts says how each one looks), or a calm wallpaper with their name
// and the time.

export interface AppInfo {
  label: string;
  color: string;
  /** Its Hugeicons glyph. */
  glyph: string;
  /** "Ana is in Figma", "Ana is working"… */
  doing: (name: string) => string;
}

/** How to show someone's app (an id from shared/apps.ts), or null for none. */
export function appInfo(app: unknown): AppInfo | null {
  if (typeof app !== 'string' || !app) return null;
  const def = appDef(app);
  const code = HUGEICONS[def.icon as HugeiconName] ?? HUGEICONS.work;
  const doing = (name: string) =>
    def.id === HEADS_DOWN ? `${name} is heads-down` : def.id === OTHER_APP ? `${name} is working` : `${name} is in ${def.label}`;
  return { label: def.label, color: def.color, glyph: String.fromCodePoint(code), doing };
}

function hue(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** The few frames a monitor shows while it wakes up. */
export function drawBoot(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, h * 0.6);
  glow.addColorStop(0, 'rgba(91, 108, 255, 0.55)');
  glow.addColorStop(1, 'rgba(91, 108, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(h * 0.3)}px ${FONT}`;
  ctx.fillText('◆', w / 2, h * 0.44);
  ctx.font = `600 ${Math.round(h * 0.09)}px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillText('Workchop', w / 2, h * 0.72);
}

export interface ScreenContent {
  name: string;
  app: AppInfo | null;
  time: string;
}

export function drawScreen(ctx: CanvasRenderingContext2D, w: number, h: number, { name, app, time }: ScreenContent): void {
  ctx.textBaseline = 'middle';
  if (app) {
    // A window of the app: its colour, icon and name, with some made-up content.
    ctx.fillStyle = '#14161d';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = app.color;
    ctx.fillRect(0, 0, w, h * 0.12);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `600 ${Math.round(h * 0.065)}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(`${app.label} — ${name}`, w * 0.03, h * 0.06);
    ctx.textAlign = 'right';
    ctx.fillText(time, w * 0.97, h * 0.06);
    // Sidebar and content lines.
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, h * 0.12, w * 0.22, h * 0.88);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i === 1 ? app.color : 'rgba(255,255,255,0.14)';
      roundRect(ctx, w * 0.03, h * (0.2 + i * 0.11), w * 0.15, h * 0.05, 4);
      ctx.fill();
    }
    const size = h * 0.3;
    const x = w * 0.3;
    const y = h * 0.24;
    ctx.fillStyle = app.color;
    roundRect(ctx, x, y, size, size, size * 0.22);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    // The app's icon from the icon font (the dock has loaded it by now), else its initial.
    if (document.fonts.check(`${Math.round(size * 0.6)}px hugeicons`)) {
      ctx.font = `${Math.round(size * 0.6)}px hugeicons`;
      ctx.fillText(app.glyph, x + size / 2, y + size / 2);
    } else {
      ctx.font = `800 ${Math.round(size * 0.55)}px ${FONT}`;
      ctx.fillText(app.label.charAt(0).toUpperCase(), x + size / 2, y + size / 2 + size * 0.03);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(h * 0.11)}px ${FONT}`;
    ctx.fillText(app.label, x + size + w * 0.04, y + size * 0.36);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `500 ${Math.round(h * 0.065)}px ${FONT}`;
    ctx.fillText(app.doing(name), x + size + w * 0.04, y + size * 0.78);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      roundRect(ctx, x, h * (0.68 + i * 0.075), w * (0.62 - (i % 3) * 0.12), h * 0.035, 3);
      ctx.fill();
    }
    return;
  }
  // Wallpaper: soft colours picked from the name, the time, and whose desk it is.
  const base = hue(name);
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, `hsl(${base} 45% 22%)`);
  bg.addColorStop(1, `hsl(${(base + 50) % 360} 55% 42%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  for (const [cx, cy, r, a] of [
    [0.8, 0.25, 0.45, 0.16],
    [0.15, 0.85, 0.5, 0.12],
    [0.55, 0.95, 0.3, 0.1],
  ]) {
    const g = ctx.createRadialGradient(w * cx, h * cy, 0, w * cx, h * cy, h * r * 1.6);
    g.addColorStop(0, `hsla(${(base + 90) % 360}, 80%, 75%, ${a})`);
    g.addColorStop(1, 'hsla(0, 0%, 100%, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = `200 ${Math.round(h * 0.34)}px ${FONT}`;
  ctx.fillText(time, w / 2, h * 0.44);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = `600 ${Math.round(h * 0.085)}px ${FONT}`;
  ctx.fillText(name, w / 2, h * 0.74);
}

export function clockTime(date = new Date()): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
