import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { DISCONNECT_RADIUS, FULL_VOLUME_RADIUS, proximityVolume } from '../../../../shared/geometry';
import { initials } from '../../lib/color';
import { HUGEICONS } from '../hugeicons';
import { discColors } from './mocks';

// Two people on a floor, and how loud one hears the other: the office's own rule (shared/geometry.ts),
// with a slider for the distance (or drag Promise) and a switch for a meeting room.

const MIN = 0.75;
const MAX = 6;
const STEP = 0.25;
const LOCK = String.fromCodePoint(HUGEICONS['square-lock-02']);

/**
 * How loud Ama hears Promise, `d` metres apart, once they're talking: full up close, fading to silence
 * at DISCONNECT_RADIUS (they stay connected until then).
 */
function volumeAt(d: number, inRoom: boolean): number {
  return inRoom ? 0 : proximityVolume({ x: 0, z: 0 }, { x: d, z: 0 }, []);
}

function said(d: number, inRoom: boolean): string {
  if (inRoom) return 'Ama is in a meeting room, so she can’t hear Promise.';
  const v = volumeAt(d, false);
  if (v >= 1) return 'Ama hears Promise at full volume.';
  if (v <= 0) return 'Promise is too far away for Ama to hear.';
  return `Ama hears Promise at ${Math.round(v * 100)}%.`;
}

const metres = (d: number) => `${d} ${d === 1 ? 'metre' : 'metres'}`;

/** An arc of radius r around (x, y), facing left (towards Ama). */
function arc(x: number, y: number, r: number): string {
  const a = (35 * Math.PI) / 180;
  const dx = -r * Math.cos(a);
  const dy = r * Math.sin(a);
  return `M${x + dx} ${y - dy}A${r} ${r} 0 0 0 ${x + dx} ${y + dy}`;
}

export function ProximityDemo() {
  const [d, setD] = useState(3);
  const [inRoom, setInRoom] = useState(false);
  const [width, setWidth] = useState(640);
  const [output, setOutput] = useState(() => said(3, false));
  const wrap = useRef<HTMLDivElement>(null);

  // Drawn at the card's own size, so the people stay the same size on a phone.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Read out once the slider stops, not at every step.
  useEffect(() => {
    const t = setTimeout(() => setOutput(said(d, inRoom)), 300);
    return () => clearTimeout(t);
  }, [d, inRoom]);

  const volume = volumeAt(d, inRoom);
  const narrow = width < 480;
  const h = narrow ? 188 : 228;
  const r = narrow ? 20 : 24;
  const pad = narrow ? 14 : 24;
  // Metres to pixels, so 6 m fits with Ama's full-volume zone (or her room) on the left.
  const m = Math.min(64, (width - 2 * pad - 2 * r - 28) / MAX, (width - pad - r - 4) / (MAX + FULL_VOLUME_RADIUS));
  const amaX = Math.max((width - MAX * m) / 2, FULL_VOLUME_RADIUS * m + 4);
  const cy = Math.round(h * 0.46);
  const ground = h - 30;
  const room = Math.max(0.6 * m, r + 12);
  // Inside a room, Promise is drawn outside its glass.
  const promiseX = Math.max(amaX + d * m, inRoom ? amaX + room + r + 6 : 0);
  const earshot = amaX + DISCONNECT_RADIUS * m;
  // Its label beside the line, on two lines where one doesn't fit.
  const oneLine = width - earshot >= 104;

  const drag = (e: PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    if (e.type === 'pointerdown') svg.setPointerCapture(e.pointerId);
    else if (!svg.hasPointerCapture(e.pointerId)) return;
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * width;
    setD(Math.min(MAX, Math.max(MIN, Math.round((x - amaX) / m / STEP) * STEP)));
  };

  const amaDisc = discColors('Ama');
  const promiseDisc = discColors('Promise');
  return (
    <div className="lp-demo lp-card" data-reveal="">
      <div className="lp-demo-floor" ref={wrap}>
        <svg viewBox={`0 0 ${width} ${h}`} width="100%" height={h} aria-hidden="true" onPointerDown={drag} onPointerMove={drag}>
          {/* A metre scale along the floor, with 5 m marked as out of earshot. */}
          <line className="lp-demo-scale" x1={amaX} x2={amaX + MAX * m} y1={ground} y2={ground} />
          {Array.from({ length: MAX + 1 }, (_, k) => (
            <g key={k}>
              <line className="lp-demo-scale" x1={amaX + k * m} x2={amaX + k * m} y1={ground - 4} y2={ground + 4} />
              <text className="lp-demo-tick" x={amaX + k * m} y={ground + 20} textAnchor="middle">
                {k === MAX ? `${k} m` : k}
              </text>
            </g>
          ))}
          <line className="lp-demo-earshot" x1={earshot} x2={earshot} y1={14} y2={ground} />
          <text className="lp-demo-tick" x={earshot + 6} y={24}>
            {oneLine ? (
              'Out of earshot'
            ) : (
              <>
                <tspan x={earshot + 6}>Out of</tspan>
                <tspan x={earshot + 6} dy={15}>
                  earshot
                </tspan>
              </>
            )}
          </text>
          {!inRoom && <ellipse className="lp-demo-near" cx={amaX} cy={cy} rx={FULL_VOLUME_RADIUS * m} ry={Math.min(FULL_VOLUME_RADIUS * m * 0.5, h * 0.3)} />}
          {inRoom && (
            <g className="lp-demo-room">
              <rect x={amaX - room} y={cy - room} width={room * 2} height={room * 2 + 14} rx={14} />
              <text x={amaX} y={cy - room - 9} textAnchor="middle">
                <tspan className="lp-demo-lock">{LOCK}</tspan> Meeting room
              </text>
            </g>
          )}
          {[0, 1, 2].map((i) => (
            <path key={i} className="lp-demo-wave" d={arc(promiseX, cy, r + 9 + i * 9)} opacity={volume * (1 - i * 0.28)} />
          ))}
          <g>
            <circle cx={amaX} cy={cy} r={r} style={{ fill: amaDisc.background }} />
            <text className="lp-demo-initials" x={amaX} y={cy} fill={amaDisc.color} textAnchor="middle" dominantBaseline="central">
              {initials('Ama')}
            </text>
            <text className="lp-demo-name" x={amaX} y={cy + r + 16} textAnchor="middle">
              Ama
            </text>
          </g>
          <g className="lp-demo-promise">
            <circle cx={promiseX} cy={cy} r={r + 3} className="lp-demo-speaking" />
            <circle cx={promiseX} cy={cy} r={r} style={{ fill: promiseDisc.background }} />
            <text className="lp-demo-initials" x={promiseX} y={cy} fill={promiseDisc.color} textAnchor="middle" dominantBaseline="central">
              {initials('Promise')}
            </text>
            <text className="lp-demo-name" x={promiseX} y={cy + r + 16} textAnchor="middle">
              Promise
            </text>
          </g>
        </svg>
      </div>
      <div className="lp-demo-body">
        <div className="lp-demo-controls">
          <div className="lp-demo-range">
            <div className="lp-demo-range-head">
              <label htmlFor="lp-distance">Distance between Promise and Ama</label>
              <span aria-hidden="true">{d} m</span>
            </div>
            <input
              id="lp-distance"
              type="range"
              min={MIN}
              max={MAX}
              step={STEP}
              value={d}
              onChange={(e) => setD(Number(e.target.value))}
              aria-valuetext={metres(d)}
              style={{ ['--fill' as string]: `${((d - MIN) / (MAX - MIN)) * 100}%` }}
            />
          </div>
          <label className="lp-switch">
            <input type="checkbox" role="switch" checked={inRoom} onChange={(e) => setInRoom(e.target.checked)} />
            <span>Ama steps into a meeting room</span>
          </label>
        </div>
        <div className="lp-demo-meter">
          <div className="lp-meter-head" aria-hidden="true">
            <span>What Ama hears</span>
            <span>{Math.round(volume * 100)}%</span>
          </div>
          <div className="lp-meter" aria-hidden="true">
            <i style={{ width: `${volume * 100}%` }} />
          </div>
          <p className="lp-demo-output" aria-live="polite">
            {output}
          </p>
        </div>
        <p className="lp-demo-caption">Same rule as the office: full volume up close, quieter as you step away, and silent at about 5 metres.</p>
      </div>
    </div>
  );
}
