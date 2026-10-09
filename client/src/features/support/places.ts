import { inFrontOf } from '../../../../shared/geometry';
import { deskLabels } from '../../../../shared/support';
import type { Office, OfficeItem } from '../../../../shared/types';
import { BOARD_TYPE } from '../../../../shared/world';
import { BookIcon, CoffeeIcon, FishIcon, GamesIcon, MusicIcon, type IconComponent } from '../../ui/icons';
import { walkTo } from '../../world/movement';

// Where things are in a support workspace: its desks, and the sights to walk to while you wait.

export const BOARD_SCREEN_TYPE = 'queue-board';

/** The support desks in order, with their labels ("Desk 2"). */
export function supportDesks(office: Office): { item: OfficeItem; label: string }[] {
  const items = new Map(office.items.map((i) => [i.id, i]));
  return [...deskLabels(office.items)].map(([id, label]) => ({ item: items.get(id)!, label }));
}

export interface Sight {
  id: string;
  label: string;
  icon: IconComponent;
  item: OfficeItem;
}

const SIGHTS: { id: string; label: string; icon: IconComponent; types: string[] }[] = [
  { id: 'aquarium', label: 'Aquarium', icon: FishIcon, types: ['aquarium'] },
  { id: 'faq', label: 'FAQ', icon: BookIcon, types: [BOARD_TYPE] },
  { id: 'music', label: 'Music corner', icon: MusicIcon, types: ['jukebox'] },
  { id: 'coffee', label: 'Coffee bar', icon: CoffeeIcon, types: ['coffee-machine'] },
  { id: 'games', label: 'Games', icon: GamesIcon, types: ['arcade', 'ping-pong'] },
];

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** The sights this office has, each the nearest of its kind to `from`. */
export function sightsIn(office: Office, from: { x: number; z: number }): Sight[] {
  const out: Sight[] = [];
  for (const s of SIGHTS) {
    let items = office.items.filter((i) => s.types.includes(i.type));
    // With several boards, the one by the entrance is the welcome; the others are the FAQ.
    if (s.id === 'faq' && items.length > 1) {
      const welcome = items.reduce((a, b) => (dist(a, office.settings.spawn) <= dist(b, office.settings.spawn) ? a : b));
      items = items.filter((i) => i !== welcome);
    }
    const item = items.reduce<OfficeItem | null>((best, i) => (!best || dist(i, from) < dist(best, from) ? i : best), null);
    if (item) out.push({ id: s.id, label: s.label, icon: s.icon, item });
  }
  return out;
}

/** Walks you to just in front of an item (or the nearest free spot, if a bench is in the way). */
export function walkUpTo(item: OfficeItem): void {
  const spot = inFrontOf(item, 1);
  walkTo(spot.x, spot.z);
}
