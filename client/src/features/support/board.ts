import type { SupportBoard } from '../../../../shared/support';

// The picture on a queue screen ("Now serving"): who's at which desk, and how many are waiting.
// Drawn on a canvas that the 3D screen shows (scene.tsx), in the same colours in both themes.

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const ACCENT = '#8fa0ff';
const FRESH = '#3ddc84';

export interface BoardView {
  board: SupportBoard;
  time: string;
  /** Your own ticket's number, picked out when it's served. */
  mine: number | null;
  /** Numbers called a moment ago, picked out for a while. */
  fresh: Set<number>;
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function drawBoard(ctx: CanvasRenderingContext2D, w: number, h: number, { board, time, mine, fresh }: BoardView): void {
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#0d1124');
  bg.addColorStop(1, '#1a2146');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const pad = w * 0.035;
  const side = w * 0.27;
  ctx.textBaseline = 'middle';

  // Title and time.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(h * 0.085)}px ${FONT}`;
  ctx.fillText('Now serving', pad, h * 0.11);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `500 ${Math.round(h * 0.06)}px ${FONT}`;
  ctx.fillText(time, w - pad, h * 0.11);

  // Who's at which desk: up to six tiles, three to a row.
  const area = { x: pad, y: h * 0.22, w: w - side - pad * 2.5, h: h * 0.72 };
  const shown = board.serving.slice(0, 6);
  if (!shown.length) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `500 ${Math.round(h * 0.065)}px ${FONT}`;
    ctx.fillText(board.waiting ? 'We’ll call the next number soon' : 'Ready when you are', area.x + area.w / 2, area.y + area.h / 2);
  }
  const cols = 3;
  const gap = w * 0.018;
  const tw = (area.w - gap * (cols - 1)) / cols;
  const th = (area.h - gap) / 2;
  shown.forEach((s, i) => {
    const x = area.x + (i % cols) * (tw + gap);
    const y = area.y + Math.floor(i / cols) * (th + gap);
    const you = s.number === mine;
    const isNew = fresh.has(s.number);
    rounded(ctx, x, y, tw, th, h * 0.035);
    ctx.fillStyle = you ? ACCENT : isNew ? 'rgba(61, 220, 132, 0.2)' : 'rgba(255,255,255,0.07)';
    ctx.fill();
    if (isNew && !you) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = FRESH;
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = you ? '#0d1124' : '#ffffff';
    ctx.font = `800 ${Math.round(th * 0.42)}px ${FONT}`;
    ctx.fillText(`#${s.number}`, x + tw / 2, y + th * 0.42);
    ctx.fillStyle = you ? '#0d1124' : isNew ? FRESH : ACCENT;
    ctx.font = `600 ${Math.round(th * 0.17)}px ${FONT}`;
    ctx.fillText(you ? `You · ${s.desk}` : s.desk, x + tw / 2, y + th * 0.78);
  });

  // How many are waiting.
  const sx = w - side - pad;
  rounded(ctx, sx, area.y, side, area.h, h * 0.035);
  ctx.fillStyle = 'rgba(143, 160, 255, 0.12)';
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `600 ${Math.round(h * 0.055)}px ${FONT}`;
  ctx.fillText('Waiting', sx + side / 2, area.y + area.h * 0.2);
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${Math.round(h * 0.24)}px ${FONT}`;
  ctx.fillText(String(board.waiting), sx + side / 2, area.y + area.h * 0.52);
  ctx.fillStyle = ACCENT;
  ctx.font = `500 ${Math.round(h * 0.045)}px ${FONT}`;
  ctx.fillText(board.waiting === 1 ? 'person' : 'people', sx + side / 2, area.y + area.h * 0.8);
}
