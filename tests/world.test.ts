import { describe, expect, it, vi } from 'vitest';
import { appInfo, drawScreen } from '../client/src/features/world/screen';
import { HUGEICONS } from '../client/src/ui/hugeicons';
import { appInfo as appDef, HEADS_DOWN, OTHER_APP } from '../shared/apps';
import { CATALOG_LIST, getEntry } from '../shared/catalog';
import { applyOp, sanitizeItem, sanitizeOffice } from '../shared/office';
import { PLANTS, plantSpecies } from '../shared/plants';
import { createFromTemplate } from '../shared/templates';
import type { Office, OfficeItem } from '../shared/types';
import {
  areaCells,
  claimDesk,
  darkAreas,
  deskOf,
  deskOwner,
  isLightOn,
  mayDeleteNote,
  NOTE_COLORS,
  OPEN_AREA,
  pairChairsWithDesks,
  releaseDesk,
  renameDeskOwner,
  sanitizeDeskData,
  sanitizeLightData,
  sanitizeNoteColor,
  sanitizeNoteText,
  setLight,
  surfaceHeight,
  wallMountZ,
  whyNoNote,
  type WorldChange,
} from '../shared/world';

const bounds = { width: 20, depth: 16 };

function office(items: Partial<OfficeItem>[], zones: Office['zones'] = []): Office {
  const base = createFromTemplate('blank', 'w', 'World');
  return {
    ...base,
    zones,
    items: items.map((i, n) => sanitizeItem({ id: `i${n}`, rot: 0, ...i }, bounds)!).filter(Boolean),
  };
}

function ok(change: WorldChange): { office: Office; items: OfficeItem[] } {
  if ('error' in change) throw new Error(change.error);
  return change;
}

describe('desk monitors', () => {
  it('pair a chair with the desk it faces', () => {
    // A desk pod like the startup template's: desks back to back, chairs facing them.
    const items = office([
      { id: 'd1', type: 'desk', x: 5, z: 5, rot: 2 },
      { id: 'c1', type: 'chair', x: 5, z: 4, rot: 0 },
      { id: 'd2', type: 'desk', x: 5, z: 6, rot: 0 },
      { id: 'c2', type: 'chair', x: 5, z: 7, rot: 2 },
    ]).items;
    expect(Object.fromEntries(pairChairsWithDesks(items))).toEqual({ c1: 'd1', c2: 'd2' });
  });

  it('ignore chairs facing away, too far, off to the side, or behind the monitor', () => {
    const items = office([
      { id: 'd', type: 'desk', x: 10, z: 5, rot: 0 }, // front faces +z
      { id: 'away', type: 'chair', x: 10, z: 6, rot: 0 }, // in front, but facing away
      { id: 'far', type: 'chair', x: 10.5, z: 7.5, rot: 2 },
      { id: 'side', type: 'chair', x: 12, z: 6, rot: 2 },
      { id: 'behind', type: 'chair', x: 10, z: 4, rot: 0 },
      { id: 'ok', type: 'chair', x: 9.5, z: 6, rot: 2 },
    ]).items;
    expect(Object.fromEntries(pairChairsWithDesks(items))).toEqual({ ok: 'd' });
  });

  it('work for turned desks and pick the nearest desk', () => {
    const items = office([
      { id: 'd', type: 'desk', x: 3, z: 8, rot: 1 }, // front faces +x
      { id: 'c', type: 'chair', x: 4, z: 8.5, rot: 3 },
      { id: 'd2', type: 'desk', x: 5.5, z: 8, rot: 3 }, // faces -x, also near the chair but its back is to it
    ]).items;
    expect(pairChairsWithDesks(items).get('c')).toBe('d');
  });

  it('pair every chair of the startup template with a desk', () => {
    const o = createFromTemplate('startup', 's', 'S');
    const pairs = pairChairsWithDesks(o.items);
    const deskChairs = o.items.filter((i) => i.type === 'chair' && i.z > 2 && i.x > 12);
    expect(deskChairs.length).toBe(20);
    for (const c of deskChairs) expect(pairs.has(c.id)).toBe(true);
    // Meeting room chairs face a table, not a desk.
    expect(o.items.filter((i) => i.type === 'chair' && i.x < 10).some((c) => pairs.has(c.id))).toBe(false);
  });

  it("show someone's app the way the presence feature names it", () => {
    const figma = appInfo('figma')!;
    expect(figma).toMatchObject({ label: 'Figma', color: appDef('figma').color });
    expect(figma.glyph).toBe(String.fromCodePoint(HUGEICONS.figma));
    expect(figma.doing('Ana')).toBe('Ana is in Figma');
    expect(appInfo(HEADS_DOWN)!.doing('Ana')).toBe('Ana is heads-down');
    expect(appInfo(OTHER_APP)!.doing('Ana')).toBe('Ana is working');
    // Unknown apps show as "Working"; no app (or not an id) is the wallpaper.
    expect(appInfo('made-up')!.label).toBe('Working');
    for (const none of [null, undefined, '', 42, { id: 'figma' }]) expect(appInfo(none)).toBeNull();
  });

  it('show the app only when it is shared, else just the name and the time', () => {
    vi.stubGlobal('document', { fonts: { check: () => true } });
    /** The words a screen shows. */
    const words = (app: unknown) => {
      const texts: string[] = [];
      const paint = { addColorStop: () => {} };
      const ctx = new Proxy({} as Record<string | symbol, unknown>, {
        get: (target, key) => (key === 'fillText' ? (text: string) => texts.push(text) : key in target ? target[key] : typeof key === 'string' && key.startsWith('create') ? () => paint : () => {}),
        set: (target, key, value) => ((target[key] = value), true),
      });
      drawScreen(ctx as unknown as CanvasRenderingContext2D, 384, 202, { name: 'Ana', app: appInfo(app), time: '09:41' });
      return texts;
    };
    // No app (or one they don't share, which never reaches the office): the wallpaper.
    expect(words(null)).toEqual(['09:41', 'Ana']);
    expect(words('figma')).toEqual(['Figma — Ana', '09:41', String.fromCodePoint(HUGEICONS.figma), 'Figma', 'Ana is in Figma']);
    vi.unstubAllGlobals();
  });
});

describe('lights', () => {
  it('keep only an on/off flag, on by default', () => {
    expect(sanitizeLightData(undefined)).toEqual({ on: true });
    expect(sanitizeLightData({ on: false, color: 'red' })).toEqual({ on: false });
    expect(sanitizeLightData({ on: 'false' })).toEqual({ on: true });
    expect(sanitizeLightData(null)).toEqual({ on: true });
    expect(sanitizeItem({ id: 'l', type: 'floor-lamp', x: 2, z: 2, rot: 0, data: { on: false, extra: 1 } }, bounds)?.data).toEqual({ on: false });
    expect(sanitizeItem({ id: 'l', type: 'desk-lamp', x: 2, z: 2, rot: 0 }, bounds)?.data).toEqual({ on: true });
    expect(sanitizeItem({ id: 's', type: 'light-switch', x: 2, z: 2, rot: 0, data: 'off' }, bounds)?.data).toEqual({ on: true });
  });

  it('give lamps in saved offices (from before lamps could switch) their data', () => {
    const o = sanitizeOffice({ id: 'x', settings: {}, items: [{ id: 'l', type: 'floor-lamp', x: 2, z: 2, rot: 0 }], zones: [] })!;
    expect(o.items[0].data).toEqual({ on: true });
  });

  it('switch a lamp', () => {
    const o = office([{ id: 'l', type: 'floor-lamp', x: 2, z: 2 }, { id: 'p', type: 'plant', x: 5, z: 5 }]);
    const off = ok(setLight(o, 'l', false));
    expect(off.items.map((i) => [i.id, i.data])).toEqual([['l', { on: false }]]);
    expect(isLightOn(off.office.items[0])).toBe(false);
    expect(ok(setLight(off.office, 'l', false)).items).toEqual([]);
    expect(setLight(o, 'p', false)).toEqual({ error: 'That light is gone.' });
    expect(setLight(o, 'nope', false)).toEqual({ error: 'That light is gone.' });
  });

  it('switch every switch in the area together, and darken only that area', () => {
    const zone = { id: 'lounge', name: 'Lounge', x: 0, z: 0, w: 6, d: 6, color: '#ff9f6c' };
    const o = office(
      [
        { id: 's1', type: 'light-switch', x: 1, z: 1 },
        { id: 's2', type: 'light-switch', x: 4, z: 4 },
        { id: 's3', type: 'light-switch', x: 10, z: 10 },
        { id: 'lamp', type: 'floor-lamp', x: 2, z: 3 },
      ],
      [zone],
    );
    expect(darkAreas(o)).toEqual(new Set());
    const off = ok(setLight(o, 's1', false));
    expect(off.items.map((i) => i.id).sort()).toEqual(['s1', 's2']);
    expect(darkAreas(off.office)).toEqual(new Set(['lounge']));
    // Lamps keep shining, the open office keeps its lights.
    expect(isLightOn(off.office.items.find((i) => i.id === 'lamp')!)).toBe(true);
    const both = ok(setLight(off.office, 's3', false));
    expect(darkAreas(both.office)).toEqual(new Set(['lounge', OPEN_AREA]));
    expect(darkAreas(ok(setLight(both.office, 's2', true)).office)).toEqual(new Set([OPEN_AREA]));
  });

  it('work the lights of the area in front of them', () => {
    // On the outer wall, a step outside the lounge's area: still the lounge's switch.
    const lounge = { id: 'lounge', name: 'Lounge', x: 1, z: 2, w: 6, d: 6, color: '#ff9f6c' };
    const o = office([{ id: 's', type: 'light-switch', x: 0.25, z: 4, rot: 1 }], [lounge]);
    expect(darkAreas(ok(setLight(o, 's', false)).office)).toEqual(new Set(['lounge']));
    // The same switch turned the other way (facing out of the lounge, towards the outer wall's side) isn't.
    const out = office([{ id: 's', type: 'light-switch', x: 7.25, z: 4, rot: 1 }], [lounge]);
    expect(darkAreas(ok(setLight(out, 's', false)).office)).toEqual(new Set([OPEN_AREA]));
  });

  it('count an area lit while any of its switches is on (e.g. after a switch moved in)', () => {
    const o = office([
      { id: 's1', type: 'light-switch', x: 1, z: 1, data: { on: false } },
      { id: 's2', type: 'light-switch', x: 4, z: 4, data: { on: true } },
    ]);
    expect(darkAreas(o)).toEqual(new Set());
    expect(darkAreas(applyOp(o, { t: 'remove', id: 's2' }))).toEqual(new Set([OPEN_AREA]));
  });

  it('split the floor into areas cell by cell, overlapping zones going to the later one', () => {
    const o = office([], [
      { id: 'a', name: 'A', x: 0, z: 0, w: 4, d: 4, color: '#fff' },
      { id: 'b', name: 'B', x: 2, z: 2, w: 4, d: 4, color: '#fff' },
    ]);
    const cells = areaCells(o.zones, o.settings.width, o.settings.depth);
    expect(cells.get('a')!.length).toBe(16 - 4);
    expect(cells.get('b')!.length).toBe(16);
    expect(cells.get(OPEN_AREA)!.length).toBe(20 * 16 - 28);
  });

  it('mount a light switch on the wall behind it, or on the outer wall', () => {
    const o = office([
      { id: 'w', type: 'wall', x: 6, z: 6, rot: 0 }, // along x, from z 5.9 to 6.1
      { id: 'front', type: 'light-switch', x: 6, z: 6.25, rot: 0 }, // faces +z, wall behind
      { id: 'back', type: 'light-switch', x: 6, z: 5.75, rot: 2 }, // faces -z, wall behind
      { id: 'edge', type: 'light-switch', x: 3, z: 0.25, rot: 0 }, // against the office's outer wall
      { id: 'glass', type: 'glass-wall', x: 12, z: 4, rot: 1 }, // along z, from x 11.925 to 12.075
      { id: 'side', type: 'light-switch', x: 11.75, z: 4, rot: 3 }, // faces -x
    ]);
    const byId = (id: string) => o.items.find((i) => i.id === id)!;
    expect(wallMountZ(o.items, byId('front'))).toBeCloseTo(-0.15);
    expect(wallMountZ(o.items, byId('back'))).toBeCloseTo(-0.15);
    expect(wallMountZ(o.items, byId('edge'))).toBeCloseTo(-0.25);
    expect(wallMountZ(o.items, byId('side'))).toBeCloseTo(-0.175);
  });
});

describe('small things on surfaces', () => {
  it('stand on the desk, table or shelf under them', () => {
    const o = office([
      { id: 'desk', type: 'desk', x: 5, z: 5 },
      { id: 'shelf', type: 'bookshelf', x: 10, z: 0.25 },
      { id: 'lamp', type: 'desk-lamp', x: 5.75, z: 5.25 },
      { id: 'cactus', type: 'cactus', x: 10.25, z: 0.25 },
      { id: 'floor', type: 'lavender', x: 15.25, z: 8.25 },
    ]);
    const at = (id: string) => surfaceHeight(o.items, o.items.find((i) => i.id === id)!);
    expect(at('lamp')).toBeCloseTo(0.625);
    expect(at('cactus')).toBeCloseTo(1.995);
    expect(at('floor')).toBe(0);
    expect(getEntry('desk-lamp')?.onSurfaces && getEntry('cactus')?.onSurfaces).toBe(true);
  });
});

describe('plants', () => {
  it('have a full, distinct species card for every plant in the catalog', () => {
    const plants = CATALOG_LIST.filter((e) => e.category === 'Plants');
    expect(plants.length).toBeGreaterThanOrEqual(13);
    expect(plants.map((e) => e.type).sort()).toEqual(PLANTS.map((p) => p.type).sort());
    for (const p of PLANTS) {
      for (const key of ['name', 'scientific', 'origin', 'light', 'water', 'humidity', 'pets', 'air', 'fact'] as const) {
        expect(p[key].trim().length, `${p.type}.${key}`).toBeGreaterThan(3);
      }
      expect(['low', 'medium', 'bright', 'sun']).toContain(p.lightLevel);
      expect(['easy', 'moderate', 'fussy']).toContain(p.difficulty);
      expect(typeof p.petSafe).toBe('boolean');
      expect(p.fact.length).toBeLessThan(200);
      expect(plantSpecies(p.type)).toBe(p);
    }
    expect(new Set(PLANTS.map((p) => p.scientific)).size).toBe(PLANTS.length);
    expect(plantSpecies('desk')).toBeUndefined();
  });

  it('agree with the ASPCA on the well-known ones', () => {
    expect(plantSpecies('plant')?.petSafe).toBe(true); // Boston fern
    for (const toxic of ['monstera', 'snake-plant', 'pothos', 'peace-lily', 'lavender', 'tall-plant']) {
      expect(plantSpecies(toxic)?.petSafe, toxic).toBe(false);
    }
  });
});

describe('desks', () => {
  const ana = { id: 'ana1', name: 'Ana' };
  const ben = { id: 'ben1', name: 'Ben' };
  const desks = () =>
    office([
      { id: 'd1', type: 'desk', x: 3, z: 3 },
      { id: 'd2', type: 'desk', x: 8, z: 3 },
      { id: 'c', type: 'chair', x: 3, z: 4, rot: 2 },
    ]);

  it('keep only a valid owner in their data', () => {
    expect(sanitizeDeskData({ ownerUserId: 'abc', ownerName: ' Ana ', extra: 1 })).toEqual({ ownerUserId: 'abc', ownerName: 'Ana' });
    expect(sanitizeDeskData({ ownerUserId: 'a b' })).toBeUndefined();
    expect(sanitizeDeskData({ ownerName: 'Ana' })).toBeUndefined();
    expect(sanitizeDeskData({ ownerUserId: 'abc' })).toEqual({ ownerUserId: 'abc', ownerName: 'Someone' });
    expect(sanitizeItem({ id: 'd', type: 'desk', x: 3, z: 3, rot: 0 }, bounds)).not.toHaveProperty('data');
  });

  it('can be claimed once per person per office: claiming another moves the claim', () => {
    let o = ok(claimDesk(desks(), 'd1', ana)).office;
    expect(deskOwner(o.items.find((i) => i.id === 'd1'))).toEqual({ ownerUserId: 'ana1', ownerName: 'Ana' });
    const moved = ok(claimDesk(o, 'd2', ana));
    expect(moved.items.map((i) => i.id).sort()).toEqual(['d1', 'd2']);
    o = moved.office;
    expect(deskOwner(o.items.find((i) => i.id === 'd1'))).toBeNull();
    expect(deskOf(o, 'ana1')?.id).toBe('d2');
    expect(ok(claimDesk(o, 'd2', ana)).items).toEqual([]);
  });

  it("can't be taken from someone else, or be anything but a desk", () => {
    const o = ok(claimDesk(desks(), 'd1', ana)).office;
    expect(claimDesk(o, 'd1', ben)).toEqual({ error: 'This is Ana’s desk.' });
    expect(claimDesk(o, 'c', ben)).toEqual({ error: 'That desk is gone.' });
    expect(claimDesk(o, 'nope', ben)).toEqual({ error: 'That desk is gone.' });
  });

  it('are freed by their owner or by someone who can edit the office', () => {
    const o = ok(claimDesk(desks(), 'd1', ana)).office;
    expect(releaseDesk(o, 'd1', { userId: 'ben1', mayEdit: false })).toEqual({
      error: 'Only its owner, or someone who can edit this office, can free a desk.',
    });
    expect(releaseDesk(o, 'd1', { userId: null, mayEdit: false })).toHaveProperty('error');
    expect(deskOwner(ok(releaseDesk(o, 'd1', { userId: 'ana1', mayEdit: false })).office.items[0])).toBeNull();
    expect(deskOwner(ok(releaseDesk(o, 'd1', { userId: null, mayEdit: true })).office.items[0])).toBeNull();
    expect(ok(releaseDesk(desks(), 'd2', { userId: 'ana1', mayEdit: false })).items).toEqual([]);
  });

  it('keep their name plate in step with the owner’s name', () => {
    const o = ok(claimDesk(desks(), 'd1', ana)).office;
    const renamed = ok(renameDeskOwner(o, { id: 'ana1', name: 'Ana B' }));
    expect(deskOwner(renamed.items[0])?.ownerName).toBe('Ana B');
    expect(ok(renameDeskOwner(renamed.office, { id: 'ana1', name: 'Ana B' })).items).toEqual([]);
    expect(ok(renameDeskOwner(o, ben)).items).toEqual([]);
  });

  it("can't be claimed or forged through build edits (data only changes through world ops)", () => {
    // Build edits (office:op) are pinned server-side; here: copying a claimed desk keeps no claim.
    const o = ok(claimDesk(desks(), 'd1', ana)).office;
    const claimed = o.items.find((i) => i.id === 'd1')!;
    const copy = sanitizeItem({ ...claimed, id: 'copy', data: undefined }, bounds)!;
    expect(copy).not.toHaveProperty('data');
  });
});

describe('desk notes', () => {
  it('clean up their text and colour', () => {
    expect(sanitizeNoteText('  hi\r\nthere\u0000\n\n\n\nbye  ')).toBe('hi\nthere\n\nbye');
    expect(sanitizeNoteText(42)).toBe('');
    expect(sanitizeNoteText('x'.repeat(600))).toHaveLength(500);
    expect(sanitizeNoteText(`${'x'.repeat(499)}😀`)).toHaveLength(499);
    expect(sanitizeNoteColor(NOTE_COLORS[2].toUpperCase())).toBe(NOTE_COLORS[2]);
    expect(sanitizeNoteColor('#000000')).toBe(NOTE_COLORS[0]);
    expect(NOTE_COLORS).toHaveLength(4);
  });

  it('go only on claimed desks, and not on your own', () => {
    const o = ok(claimDesk(office([{ id: 'd', type: 'desk', x: 3, z: 3 }, { id: 'free', type: 'desk', x: 8, z: 3 }]), 'd', { id: 'ana1', name: 'Ana' })).office;
    const d = o.items.find((i) => i.id === 'd');
    expect(whyNoNote(d, { userId: null })).toBeNull();
    expect(whyNoNote(d, { userId: 'ben1' })).toBeNull();
    expect(whyNoNote(d, { userId: 'ana1' })).toBe('That’s your own desk.');
    expect(whyNoNote(o.items.find((i) => i.id === 'free'), { userId: null })).toBe('Nobody has claimed this desk yet.');
    expect(whyNoNote(undefined, { userId: null })).toBe('That desk is gone.');
  });

  it('can be thrown away by the desk owner or their author only', () => {
    const byBen = { ownerUserId: 'ana1', authorUserId: 'ben1', authorKey: null };
    const byGuest = { ownerUserId: 'ana1', authorUserId: null, authorKey: 'hash1' };
    expect(mayDeleteNote(byBen, { userId: 'ana1', guestKeyHash: null })).toBe(true);
    expect(mayDeleteNote(byBen, { userId: 'ben1', guestKeyHash: null })).toBe(true);
    expect(mayDeleteNote(byBen, { userId: 'cat1', guestKeyHash: null })).toBe(false);
    expect(mayDeleteNote(byBen, { userId: null, guestKeyHash: 'hash1' })).toBe(false);
    expect(mayDeleteNote(byGuest, { userId: null, guestKeyHash: 'hash1' })).toBe(true);
    expect(mayDeleteNote(byGuest, { userId: null, guestKeyHash: 'hash2' })).toBe(false);
    expect(mayDeleteNote(byGuest, { userId: null, guestKeyHash: null })).toBe(false);
    expect(mayDeleteNote(byGuest, { userId: 'ana1', guestKeyHash: null })).toBe(true);
  });
});
