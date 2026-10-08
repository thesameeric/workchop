import { defaultSettings, sanitizeItem, sanitizeZone } from './office';
import type { Office, OfficeItem, OfficeSettings, Zone } from './types';

export type TemplateId = 'startup' | 'blank';

export const TEMPLATES: { id: TemplateId; label: string; description: string }[] = [
  { id: 'startup', label: 'Startup office', description: 'Desk pods, a glass meeting room, lounge, kitchen and a ping pong table.' },
  { id: 'blank', label: 'Blank floor', description: 'An empty room to build from scratch.' },
];

type Spec = [type: string, x: number, z: number, rot?: number, color?: string];

function build(id: string, settings: OfficeSettings, specs: Spec[], zones: Omit<Zone, 'id'>[]): Office {
  const items: OfficeItem[] = [];
  specs.forEach(([type, x, z, rot = 0, color], i) => {
    const item = sanitizeItem({ id: `i${i + 1}`, type, x, z, rot, color }, settings);
    if (item) items.push(item);
  });
  const now = Date.now();
  return {
    id,
    settings,
    items,
    zones: zones.map((z, i) => sanitizeZone({ ...z, id: `z${i + 1}` }, settings)!).filter(Boolean),
    createdAt: now,
    updatedAt: now,
  };
}

function startup(id: string, name: string): Office {
  const settings: OfficeSettings = {
    ...defaultSettings(name),
    width: 32,
    depth: 24,
    spawn: { x: 16, z: 21 },
  };
  const specs: Spec[] = [];

  // Glass meeting room in the back-left corner.
  for (const z of [1, 3, 5, 7]) specs.push(['glass-wall', 10, z, 1]);
  for (const x of [1, 3, 5, 9]) specs.push(['glass-wall', x, 8, 0]);
  specs.push(['meeting-table', 5, 4]);
  for (const x of [3.5, 4.5, 5.5, 6.5]) {
    specs.push(['chair', x, 2.5, 0]);
    specs.push(['chair', x, 5.5, 2]);
  }
  specs.push(['chair', 2.5, 4, 1], ['chair', 7.5, 4, 3]);
  specs.push(['tv', 5, 0.25, 0], ['whiteboard', 0.25, 4, 1]);
  specs.push(['plant', 9.5, 0.5], ['plant', 0.5, 7.5], ['bonsai', 5.25, 4.25], ['light-switch', 9.75, 7.25, 3]);

  // Open plan desk pods.
  const pod = (x: number, z: number, chairColor?: string) => {
    for (const dx of [0, 2]) {
      specs.push(['desk', x + dx, z, 2], ['chair', x + dx, z - 1, 0, chairColor]);
      specs.push(['desk', x + dx, z + 1, 0], ['chair', x + dx, z + 2, 2, chairColor]);
    }
  };
  pod(15, 4);
  pod(22, 4, '#4361ee');
  pod(28, 4);
  pod(15, 9, '#2a9d8f');
  pod(22, 9);
  // A few things on the desks.
  specs.push(['desk-lamp', 15.75, 4.25, 2], ['cactus', 24.75, 4.75], ['desk-lamp', 22.75, 9.75, 0, '#4cc9f0'], ['lavender', 28.75, 4.25]);

  // Back wall decor.
  specs.push(
    ['bookshelf', 13, 0.25], ['bookshelf', 15, 0.25], ['monstera', 17, 0.5], ['art', 19, 0.05, 0, '#ff924c'],
    ['whiteboard', 22, 0.25], ['art', 25, 0.05, 0, '#4cc9f0'], ['fiddle-leaf', 27, 0.5], ['bookshelf', 29, 0.25, 0, '#6d4c41'],
    ['snake-plant', 31, 0.5], ['pothos', 13.75, 0.25],
  );
  specs.push(['printer', 31.4, 9, 3], ['water-cooler', 31.25, 11.25], ['rubber-plant', 28.5, 9.5]);

  // Lounge.
  specs.push(
    ['rug', 5.5, 16, 0, '#e76f51'], ['coffee-table', 5.5, 16], ['sofa', 5.5, 14, 0], ['sofa', 5.5, 18, 2, '#264653'],
    ['armchair', 3, 16, 1, '#e9c46a'], ['armchair', 8, 16, 3, '#e9c46a'], ['floor-lamp', 2.25, 13.25], ['bird-of-paradise', 9, 13],
    ['zz-plant', 1.5, 12.5], ['peace-lily', 6.25, 16.25], ['light-switch', 0.25, 18.75, 1], ['floor-lamp', 9.25, 17.75],
    ['bookshelf', 0.25, 16, 1], ['beanbag', 2, 21.5, 1, '#9b5de5'], ['beanbag', 3.5, 22, 0, '#ef476f'],
    ['arcade', 7, 23.5, 2], ['arcade', 8, 23.5, 2, '#4cc9f0'],
    ['jukebox', 9, 19, 3],
  );

  // Games and entrance.
  specs.push(['ping-pong', 17.5, 16], ['rug-round', 16, 21, 0, '#4361ee'], ['tall-plant', 13.5, 23.5], ['tall-plant', 18.5, 23.5]);

  // Kitchen.
  specs.push(
    ['fridge', 31.5, 15.5, 3], ['counter', 31.5, 17, 3], ['counter', 31.5, 19, 3], ['coffee-machine', 31.5, 20.5, 3],
    ['vending', 29.5, 23.5, 2], ['water-cooler', 28.25, 23.75],
  );
  for (const z of [17.5, 20.5]) {
    specs.push(['round-table', 26.5, z]);
    specs.push(['stool', 25.5, z, 1], ['stool', 27.5, z, 3], ['stool', 26.5, z - 1, 0], ['stool', 26.5, z + 1, 2]);
  }

  const office = build(id, settings, specs, [
    { name: 'Meeting Room', x: 0, z: 0, w: 10, d: 8, color: '#6c8cff' },
    { name: 'Lounge', x: 1, z: 12, w: 9, d: 8, color: '#ff9f6c' },
  ]);
  // The lounge jukebox starts on the built-in lo-fi station (heard only inside the Lounge).
  for (const item of office.items) if (item.type === 'jukebox') item.data = { station: 'lofi', links: [], startedAt: office.createdAt };
  return office;
}

function blank(id: string, name: string): Office {
  const settings = defaultSettings(name);
  return build(
    id,
    settings,
    [
      ['plant', 0.5, 0.5], ['plant', 19.5, 0.5], ['tall-plant', 0.5, 15.5], ['tall-plant', 19.5, 15.5],
      ['rug-round', 10, 8, 0, '#4361ee'],
    ],
    [],
  );
}

export function createFromTemplate(template: TemplateId, id: string, name: string): Office {
  return template === 'blank' ? blank(id, name) : startup(id, name);
}
