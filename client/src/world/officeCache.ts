import { getEntry, seatsOf, type Seat } from '../../../shared/catalog';
import { buildColliders, type AABB } from '../../../shared/geometry';
import type { Office } from '../../../shared/types';

export interface OfficeData {
  colliders: AABB[];
  seats: (Seat & { itemId: string; type: string; solid: boolean })[];
}

let cachedFor: Office | null = null;
let cached: OfficeData = { colliders: [], seats: [] };

/** Collision boxes and seats for the current office, recomputed only when the office changes. */
export function officeData(office: Office): OfficeData {
  if (office !== cachedFor) {
    cachedFor = office;
    cached = {
      colliders: buildColliders(office),
      seats: office.items.flatMap((item) =>
        seatsOf(item).map((s) => ({ ...s, itemId: item.id, type: item.type, solid: !!getEntry(item.type)?.solid })),
      ),
    };
  }
  return cached;
}

export function nearestSeat(office: Office, x: number, z: number, maxDist: number, accept: (seat: OfficeData['seats'][number]) => boolean = () => true) {
  let best: OfficeData['seats'][number] | null = null;
  let bestD = maxDist;
  for (const s of officeData(office).seats) {
    if (!accept(s)) continue;
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
