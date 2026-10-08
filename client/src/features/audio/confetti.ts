const COLORS = ['#ff5d8f', '#ffd166', '#06d6a0', '#4cc9f0', '#8b5cf6', '#ff924c'];
const DURATION = 1800;

/** A light shower of confetti over the whole screen, for the person who popped it. */
export function screenConfetti(): void {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.className = 'screen-confetti';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);

  const pieces = Array.from({ length: Math.round(Math.min(70, w / 14)) }, (_, i) => ({
    x: Math.random() * w,
    y: -20 - Math.random() * h * 0.3,
    vx: (Math.random() - 0.5) * 60,
    vy: 120 + Math.random() * 140,
    rot: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 10,
    size: 5 + Math.random() * 5,
    color: COLORS[i % COLORS.length],
  }));
  const start = performance.now();
  let last = start;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now - start;
    ctx.clearRect(0, 0, w, h);
    // Fades out over the last third.
    ctx.globalAlpha = Math.min(1, (DURATION - t) / (DURATION / 3)) * 0.85;
    for (const p of pieces) {
      p.x += (p.vx + Math.sin(t / 180 + p.rot) * 30) * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (t < DURATION) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
