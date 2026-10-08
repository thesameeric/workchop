import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { OfficeItem } from '../../../../shared/types';
import { useAnchor } from '../../lib/anchors';
import { local, remoteTargets, rendered } from '../../lib/positions';
import { useStore } from '../../state/store';
import { AppChip } from './AppChip';
import { usePresence } from './state';

/** Where a desk's monitor screen is (world/models.tsx draws it 0.3 m behind the desk's centre). */
function monitors(items: OfficeItem[] | undefined) {
  return (items ?? [])
    .filter((i) => i.type === 'desk')
    .map((i) => {
      const a = (i.rot * Math.PI) / 2;
      return { x: i.x - 0.3 * Math.sin(a), z: i.z - 0.3 * Math.cos(a) };
    });
}

type Monitor = ReturnType<typeof monitors>[number];

/** The monitor in front of someone sitting at x/z and facing ry, if any. */
function monitorAt(list: Monitor[], x: number, z: number, ry: number): Monitor | null {
  let best: Monitor | null = null;
  let bestD = 1.6;
  for (const m of list) {
    const d = Math.hypot(m.x - x, m.z - z);
    // Not the desk behind them (desks stand back to back).
    const ahead = (m.x - x) * Math.sin(ry) + (m.z - z) * Math.cos(ry) > 0;
    if (ahead && d < bestD) {
      best = m;
      bestD = d;
    }
  }
  return best;
}

function DeskLabel({ id, self, app, list }: { id: string; self: boolean; app: string; list: Monitor[] }) {
  const ref = useAnchor(`desk-app:${id}`, () => {
    let at: { x: number; z: number; ry: number } | null = null;
    if (self) at = local.anim === 'sit' ? local : null;
    else {
      const r = rendered.get(id);
      const t = remoteTargets.get(id);
      at = r?.sit && t ? { x: r.x, z: r.z, ry: t.ry } : null;
    }
    const m = at && monitorAt(list, at.x, at.z, at.ry);
    return m ? { x: m.x, y: 0.98, z: m.z } : null;
  });
  return (
    <div ref={ref} className="world-label">
      <AppChip app={app} variant="screen" />
    </div>
  );
}

/** The app on the monitor of the desk where someone with one is sitting. */
export function DeskAppLabels() {
  const others = useStore(useShallow((s) => Object.values(s.players).flatMap((p) => (p.app ? [`${p.id} ${p.app}`] : []))));
  const selfId = useStore((s) => s.selfId) ?? 'self';
  const mine = usePresence((s) => s.self?.app ?? null);
  const items = useStore((s) => s.office?.items);
  const list = useMemo(() => monitors(items), [items]);
  if (!list.length) return null;
  return (
    <>
      {others.map((entry) => {
        const [id, app] = entry.split(' ');
        return <DeskLabel key={id} id={id} self={false} app={app} list={list} />;
      })}
      {mine && <DeskLabel id={selfId} self app={mine} list={list} />}
    </>
  );
}
