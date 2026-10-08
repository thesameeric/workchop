import type { CSSProperties } from 'react';
import { useAnchor } from '../../lib/anchors';
import { local, rendered } from '../../lib/positions';
import { getState } from '../../state/store';
import { CoinsIcon } from '../../ui/icons';
import { useCoins } from './state';

const HEAD_Y = 2.55;
const COLORS = ['#ffcc33', '#ff6b8b', '#5b6cff', '#3ddc84', '#ff9f6c', '#e66cff'];
/** The same scatter for every burst: [angle, distance, color, delay]. */
const PIECES = Array.from({ length: 18 }, (_, i) => [((i * 137.5) % 360) * (Math.PI / 180), 46 + ((i * 29) % 38), COLORS[i % COLORS.length], (i % 4) * 40] as const);

function point(playerId: string) {
  if (playerId === getState().selfId) return { x: local.x, y: HEAD_Y - (local.anim === 'sit' ? 0.22 : 0), z: local.z };
  const r = rendered.get(playerId);
  return r ? { x: r.x, y: HEAD_Y - (r.sit ? 0.22 : 0), z: r.z } : null;
}

function Burst({ id, playerId, amount, from, note }: { id: number; playerId: string; amount: number; from: string | null; note: string }) {
  const ref = useAnchor(`coins:${id}`, () => point(playerId));
  return (
    <div ref={ref} className="world-label">
      {/* Presence coins: a small float. Tips: confetti, for everyone to see. */}
      {from === null ? (
        <div className="coin-float">+{amount}</div>
      ) : (
        <div className="coin-burst">
          {PIECES.map(([angle, dist, color, delay], i) => (
            <i
              key={i}
              style={{ '--dx': `${Math.cos(angle) * dist}px`, '--dy': `${Math.sin(angle) * dist - 30}px`, background: color, animationDelay: `${delay}ms` } as CSSProperties}
            />
          ))}
          <div className={`coin-burst-label${note ? ' with-note' : ''}`}>
            <span className="coin-burst-head">
              <CoinsIcon size={16} />+{amount}
              <span>from {from}</span>
            </span>
            {note && <span className="coin-burst-note">{note}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Coin celebrations pinned over people in the 3D world (positioned by the canvas projector). */
export function Celebrations() {
  const bursts = useCoins((s) => s.bursts);
  return (
    <div className="world-labels coin-layer" aria-hidden="true">
      {bursts.map((b) => (
        <Burst key={b.id} {...b} />
      ))}
    </div>
  );
}
