import { defaultSettings, sanitizeItem, sanitizeZone } from './office';
import { AWAY_GRACE_MS } from './support';
import type { Office, OfficeItem, OfficeSettings, Zone } from './types';
import type { BoardData } from './world';
import type { OfficeKind } from './workspace';

export type TemplateId = 'startup' | 'blank' | 'support';

/** The layouts a new workspace can start from, for each kind of workspace. */
export const TEMPLATES: { id: TemplateId; kind: OfficeKind; label: string; description: string }[] = [
  { id: 'startup', kind: 'team', label: 'Startup office', description: 'Desk pods, a glass meeting room, lounge, kitchen and a ping pong table.' },
  { id: 'blank', kind: 'team', label: 'Blank floor', description: 'An empty room to build from scratch.' },
  {
    id: 'support',
    kind: 'support',
    label: 'Support lobby',
    description: 'Six help desks and a queue screen, with a big lobby to wait in: lounges, FAQ boards, fish tanks, a music corner, games and a coffee bar.',
  },
];

type Spec = [type: string, x: number, z: number, rot?: number, color?: string, data?: unknown];

function build(id: string, settings: OfficeSettings, specs: Spec[], zones: Omit<Zone, 'id'>[]): Office {
  const items: OfficeItem[] = [];
  specs.forEach(([type, x, z, rot = 0, color, data], i) => {
    const item = sanitizeItem({ id: `i${i + 1}`, type, x, z, rot, color, data }, settings);
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

const board = (title: string, text: string): BoardData => ({ title, text });

/**
 * A customer support lobby. Help desks along the north wall (staff with their backs to the windows,
 * customers across from them) with the queue screen in the middle; the entrance in the south; and
 * plenty to look at while you wait: lounges and fish tanks in the middle, FAQ boards in the west,
 * a coffee bar, a plant garden, a music corner behind a wall of fish tanks, games and a reading nook.
 */
function support(id: string, name: string): Office {
  const settings: OfficeSettings = {
    ...defaultSettings(name),
    width: 56,
    depth: 40,
    floor: 'wood',
    floorColor: '#d2b48c',
    wallColor: '#f2efe9',
    spawn: { x: 28, z: 37 },
    buildPolicy: 'owner',
  };
  const specs: Spec[] = [];

  // Help desks, numbered west to east, with partitions between the customers' seats.
  for (const x of [17, 20, 23, 33, 36, 39]) specs.push(['support-desk', x, 3]);
  for (const x of [15.5, 18.5, 21.5, 24.5, 31.5, 34.5, 37.5, 40.5]) specs.push(['partition', x, 3.5, 1, '#aab4c3']);
  specs.push(['queue-board', 28, 0.25], ['tall-plant', 25.5, 0.5], ['tall-plant', 30.5, 0.5]);

  // Entrance: a mat, plants either side and the welcome board.
  specs.push(
    ['rug', 28, 38.5, 0, '#3d405b'], ['tall-plant', 25.5, 39.5], ['tall-plant', 30.5, 39.5], ['floor-lamp', 24.25, 39.75], ['floor-lamp', 31.75, 39.75],
    [
      'info-board', 28, 33.75, 0, '#5b6cff',
      board(
        `Welcome to ${name}`,
        'Thanks for stopping by. When it’s your turn, we’ll call you and walk you to a desk.\n\nUntil then, have a seat or look around: the fish, the plants, the FAQ boards and the music corner are all yours. The screen over the help desks shows who’s being served.',
      ),
    ],
  );

  // The lounge: seats around coffee tables, with a fish tank in the middle.
  const lounge = (x: number, z: number, rug: string, sofa: string, chair: string) => {
    specs.push(
      ['rug', x, z, 0, rug], ['coffee-table', x, z], ['sofa', x, z - 2, 0, sofa], ['sofa', x, z + 2, 2, sofa],
      ['armchair', x - 2.5, z, 1, chair], ['armchair', x + 2.5, z, 3, chair], ['floor-lamp', x - 2.75, z - 2.25], ['floor-lamp', x + 2.75, z + 2.25],
    );
  };
  lounge(20, 11, '#e76f51', '#2a9d8f', '#e9c46a');
  lounge(36, 11, '#4361ee', '#264653', '#f4a261');
  lounge(20, 24, '#9b5de5', '#3d405b', '#4cc9f0');
  lounge(36, 24, '#2a9d8f', '#e76f51', '#e9c46a');
  specs.push(['peace-lily', 20.25, 11.25], ['bonsai', 36.25, 11.25], ['lavender', 20.25, 24.25], ['cactus', 36.25, 24.25]);
  specs.push(
    ['aquarium', 28, 17], ['sofa', 28, 14.5, 0, '#3d405b'], ['sofa', 28, 19.5, 2, '#3d405b'], ['bird-of-paradise', 25.5, 17], ['monstera', 30.5, 17],
    ['fiddle-leaf', 17, 17.5], ['rubber-plant', 23, 17.5], ['tall-plant', 33, 17.5], ['snake-plant', 39, 17.5],
    ['rug-round', 28, 28, 0, '#f4a261'], ['beanbag', 27, 28, 1, '#ef476f'], ['beanbag', 29, 28, 3, '#4cc9f0'], ['zz-plant', 28, 29.5],
  );
  // More fish either side of the way in, with a bench in front of each tank.
  for (const [x, left, right] of [[20, 'monstera', 'rubber-plant'], [36, 'bird-of-paradise', 'fiddle-leaf']] as const) {
    specs.push(['aquarium', x, 30.5], ['sofa', x, 32.5, 2, '#264653'], [left, x - 2.5, 30.5], [right, x + 2.5, 30.5], ['floor-lamp', x - 2.25, 32.75], ['floor-lamp', x + 2.25, 32.75]);
  }

  // FAQ gallery: boards to read, with a bench in front of each.
  const faq: [x: number, z: number, color: string, data: BoardData][] = [
    [
      4, 13.75, '#4361ee',
      board(
        'How the queue works',
        `Everyone is helped in the order they arrived, and you’ll see your place in the queue while you wait. When it’s your turn, we’ll call you and walk you to a desk.\n\nIf you have to go, you keep your place for ${AWAY_GRACE_MS / 60_000} minutes. Changed your mind? You can leave the queue at any time.`,
      ),
    ],
    [
      9.5, 13.75, '#2a9d8f',
      board(
        'Talking with us',
        'At the desk you can talk, turn on your camera or type in the chat, whatever suits you. Only you and the person helping you hear each other: nobody else in the lobby can.\n\nPress M to mute or unmute your microphone, and V to turn your camera on or off.',
      ),
    ],
    [
      4, 21.75, '#9b5de5',
      board(
        'Your privacy',
        'Other visitors see you as a visitor number, never your name. The staff see the name and email you gave us, so they can help you and follow up.\n\nCalls aren’t recorded. What you write in the chat is kept with your question, so we can look back at it if you need us again.',
      ),
    ],
    [
      9.5, 21.75, '#e76f51',
      board(
        'Getting around',
        'Click the floor to walk somewhere, or use the arrow keys (WASD works too). Click a sofa or a chair to sit down.\n\nClick a plant or a fish tank to find out what’s in it, and drop by the music corner behind the fish tanks.',
      ),
    ],
  ];
  for (const [x, z, color, data] of faq) {
    specs.push(['info-board', x, z, 0, color, data], ['rug', x, z + 2.25, 0, color], ['sofa', x, z + 3.75, 2, '#264653']);
  }
  specs.push(
    ['art', 0.05, 15, 1, '#4cc9f0'], ['art', 0.05, 23, 1, '#ff924c'], ['art', 0.05, 27.5, 1, '#06d6a0'],
    ['tall-plant', 7, 13.5], ['monstera', 0.5, 11], ['pothos', 12.75, 13.75], ['peace-lily', 6.75, 21.75], ['snake-plant', 12.5, 21.5],
    ['floor-lamp', 0.75, 19.25], ['floor-lamp', 12.75, 27.25],
  );

  // Reading nook in the north-west corner.
  specs.push(
    ['bookshelf', 6, 0.25], ['bookshelf', 12, 0.25, 0, '#6d4c41'], ['bookshelf', 0.25, 4, 1], ['bookshelf', 0.25, 7, 1, '#6d4c41'],
    ['rug-round', 6, 5, 0, '#e9c46a'], ['round-table', 6, 5], ['armchair', 4.5, 5, 1, '#2a9d8f'], ['armchair', 7.5, 5, 3, '#2a9d8f'], ['armchair', 6, 6.5, 2, '#e76f51'],
    ['floor-lamp', 4.25, 3.25], ['floor-lamp', 7.75, 3.25], ['pothos', 12.25, 0.25], ['fiddle-leaf', 0.5, 0.5], ['zz-plant', 9, 0.5],
    ['beanbag', 10.5, 5.5, 3, '#9b5de5'], ['beanbag', 11.5, 7, 2, '#ffd166'], ['peace-lily', 6.25, 5.25],
  );

  // Games in the north-east corner.
  specs.push(
    ['ping-pong', 48.5, 5], ['arcade', 51.5, 0.5, 0, '#9b5de5'], ['arcade', 52.5, 0.5, 0, '#4cc9f0'], ['arcade', 53.5, 0.5, 0, '#ef476f'], ['arcade', 54.5, 0.5, 0, '#06d6a0'],
    ['whiteboard', 44, 0.25], ['stool', 46, 8, 0, '#ef476f'], ['stool', 51, 8, 0, '#4cc9f0'], ['vending', 55.5, 6.5, 3, '#4361ee'], ['tall-plant', 42.5, 8.5], ['plant', 55.5, 8.5],
  );

  // A wall of fish tanks, and the music corner behind it (its own area, glass walls north and south).
  for (const z of [12, 15, 22, 25]) specs.push(['aquarium', 44, z, 1]);
  for (const x of [45, 47, 49, 51, 53, 55]) specs.push(['glass-wall', x, 10, 0], ['glass-wall', x, 27, 0]);
  specs.push(['sofa', 41.5, 13.5, 1, '#264653'], ['sofa', 41.5, 23.5, 1, '#264653']);
  specs.push(
    ['jukebox', 55.5, 18.5, 3], ['rug-round', 52, 18.5, 0, '#9b5de5'], ['beanbag', 50.5, 17.5, 1, '#ef476f'], ['beanbag', 50.5, 19.5, 1, '#ffd166'],
    ['sofa', 50, 12, 0, '#3d405b'], ['armchair', 53, 12, 0, '#e76f51'], ['sofa', 50, 25, 2, '#3d405b'], ['armchair', 53, 25, 2, '#e76f51'],
    ['bookshelf', 55.75, 22, 3, '#3d405b'], ['monstera', 55.5, 14.5], ['tall-plant', 55.5, 25.5], ['floor-lamp', 46.25, 11.25], ['floor-lamp', 46.25, 25.75],
  );

  // Coffee bar in the south-west corner.
  specs.push(
    ['fridge', 1.5, 39.5, 2], ['counter', 3, 39.5, 2], ['counter', 5, 39.5, 2], ['coffee-machine', 6.5, 39.5, 2], ['coffee-machine', 7.5, 39.5, 2, '#3d405b'],
    ['counter', 9, 39.5, 2], ['vending', 10.5, 39.5, 2, '#06d6a0'], ['water-cooler', 11.75, 39.75], ['plant', 0.5, 30.5], ['tall-plant', 13.5, 39.5],
  );
  for (const x of [3.5, 7.5, 11.5]) {
    specs.push(['round-table', x, 34.5]);
    specs.push(['stool', x - 1, 34.5, 1], ['stool', x + 1, 34.5, 3], ['stool', x, 33.5, 0], ['stool', x, 35.5, 2]);
  }

  // A plant garden in the south-east corner, with benches.
  specs.push(
    ['bird-of-paradise', 55.5, 29.5], ['fiddle-leaf', 55.5, 31.5], ['monstera', 55.5, 33.5], ['rubber-plant', 55.5, 35.5], ['tall-plant', 55.5, 37.5], ['plant', 55.5, 39.5],
    ['snake-plant', 43.5, 39.5], ['zz-plant', 45.5, 39.5], ['plant', 47.5, 39.5], ['monstera', 53.5, 39.5],
    ['bookshelf', 50.5, 39.75, 2, '#a47148'], ['pothos', 50.25, 39.75], ['pothos', 51.25, 39.75],
    ['rug', 49, 33.5, 0, '#7c9a7e'], ['coffee-table', 47.5, 33.5, 1], ['coffee-table', 50.5, 33.5, 1],
    ['cactus', 47.25, 33.25], ['bonsai', 47.75, 33.75], ['lavender', 50.25, 33.25], ['peace-lily', 50.75, 33.75],
    ['sofa', 49, 30.5, 0, '#2a9d8f'], ['sofa', 49, 36.5, 2, '#2a9d8f'],
    ['monstera', 44.5, 29.5], ['armchair', 44.5, 31.5, 1, '#e9c46a'], ['floor-lamp', 44.25, 32.75],
  );

  const office = build(id, settings, specs, [{ name: 'Music corner', x: 45, z: 10, w: 11, d: 17, color: '#e66cff' }]);
  // The music corner's jukebox starts on the built-in lo-fi station (heard only in there).
  for (const item of office.items) if (item.type === 'jukebox') item.data = { station: 'lofi', links: [], startedAt: office.createdAt };
  return office;
}

export function createFromTemplate(template: TemplateId, id: string, name: string): Office {
  if (template === 'support') return support(id, name);
  return template === 'blank' ? blank(id, name) : startup(id, name);
}
