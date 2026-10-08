import { describe, expect, it } from 'vitest';
import { getEntry } from '../shared/catalog';
import { buildColliders, isBlocked, itemFootprint } from '../shared/geometry';
import { applyOp, OpError, sanitizeItem, sanitizeOffice } from '../shared/office';
import { createFromTemplate } from '../shared/templates';

describe('items', () => {
  const bounds = { width: 20, depth: 16 };

  it('snaps items to the half-tile grid and clamps them inside the floor', () => {
    expect(sanitizeItem({ id: 'a', type: 'desk', x: 3.13, z: 2.3, rot: 0 }, bounds)).toMatchObject({ x: 3, z: 2.5 });
    expect(sanitizeItem({ id: 'a', type: 'desk', x: -5, z: 99, rot: 0 }, bounds)).toMatchObject({ x: 1, z: 15.5 });
    expect(sanitizeItem({ id: 'a', type: 'wall', x: 4.2, z: 2.9, rot: 0 }, bounds)).toMatchObject({ x: 4, z: 3 });
  });

  it('rejects unknown types, bad ids and non-numbers', () => {
    expect(sanitizeItem({ id: 'a', type: 'rocket', x: 1, z: 1, rot: 0 }, bounds)).toBeNull();
    expect(sanitizeItem({ id: '../../etc', type: 'desk', x: 1, z: 1, rot: 0 }, bounds)).toBeNull();
    expect(sanitizeItem({ id: 'a', type: 'desk', x: 'x', z: 1, rot: 0 }, bounds)).toBeNull();
  });

  it('keeps colours only on colourable items', () => {
    expect(sanitizeItem({ id: 'a', type: 'desk', x: 5, z: 5, rot: 0, color: '#ABCDEF' }, bounds)?.color).toBe('#abcdef');
    expect(sanitizeItem({ id: 'a', type: 'tv', x: 5, z: 5, rot: 0, color: '#abcdef' }, bounds)?.color).toBeUndefined();
    expect(sanitizeItem({ id: 'a', type: 'desk', x: 5, z: 5, rot: 0, color: 'red; drop' }, bounds)?.color).toBeUndefined();
  });

  it("checks item data with the item type's sanitizeData, and drops it for types without one", () => {
    const jukebox = { id: 'j', type: 'jukebox', x: 5, z: 5, rot: 0 };
    expect(sanitizeItem({ ...jukebox, data: { station: 'lofi', links: 'x', extra: 1 } }, bounds)?.data).toEqual({ station: 'lofi', links: [] });
    expect(sanitizeItem(jukebox, bounds)?.data).toEqual({ station: null, links: [] });
    expect(sanitizeItem({ id: 'd', type: 'desk', x: 5, z: 5, rot: 0, data: { note: 'hi' } }, bounds)).not.toHaveProperty('data');

    // A feature gives its item type a sanitizer; undefined means "no data".
    const sofa = getEntry('sofa')!;
    sofa.sanitizeData = (raw) => (raw && typeof (raw as { note?: unknown }).note === 'string' ? { note: (raw as { note: string }).note.slice(0, 5) } : undefined);
    try {
      expect(sanitizeItem({ id: 'd', type: 'sofa', x: 5, z: 5, rot: 0, data: { note: 'hello world', x: 1 } }, bounds)?.data).toEqual({ note: 'hello' });
      expect(sanitizeItem({ id: 'd', type: 'sofa', x: 5, z: 5, rot: 0, data: 42 }, bounds)).not.toHaveProperty('data');
    } finally {
      delete sofa.sanitizeData;
    }
  });
});

describe('applyOp', () => {
  const base = createFromTemplate('blank', 'test', 'Test');

  it('adds, updates and removes items without touching the others', () => {
    let o = applyOp(base, { t: 'add', item: { id: 'n1', type: 'sofa', x: 5, z: 5, rot: 0 } });
    expect(o.items).toHaveLength(base.items.length + 1);
    expect(o.items[0]).toBe(base.items[0]);
    o = applyOp(o, { t: 'update', item: { id: 'n1', type: 'sofa', x: 6, z: 5, rot: 1 } });
    expect(o.items.find((i) => i.id === 'n1')).toMatchObject({ x: 6, rot: 1 });
    o = applyOp(o, { t: 'remove', id: 'n1' });
    expect(o.items.find((i) => i.id === 'n1')).toBeUndefined();
  });

  it('rejects duplicates and unknown ids', () => {
    expect(() => applyOp(base, { t: 'add', item: { ...base.items[0] } })).toThrow(OpError);
    expect(() => applyOp(base, { t: 'remove', id: 'nope' })).toThrow(OpError);
    expect(() => applyOp(base, { t: 'bogus' } as never)).toThrow(OpError);
  });

  it('manages zones', () => {
    let o = applyOp(base, { t: 'zone:add', zone: { id: 'z9', name: 'Booth', x: 1.4, z: 2, w: 3.6, d: 3, color: '#ff00ff' } });
    expect(o.zones.at(-1)).toMatchObject({ x: 1, w: 4, name: 'Booth' });
    o = applyOp(o, { t: 'zone:update', zone: { ...o.zones.at(-1)!, name: 'Phone booth' } });
    expect(o.zones.at(-1)?.name).toBe('Phone booth');
    o = applyOp(o, { t: 'zone:remove', id: 'z9' });
    expect(o.zones).toHaveLength(0);
  });

  it('shrinking the office drops items that no longer fit', () => {
    let o = applyOp(base, { t: 'add', item: { id: 'far', type: 'plant', x: 18.5, z: 2.5, rot: 0 } });
    o = applyOp(o, { t: 'settings', settings: { width: 12 } });
    expect(o.settings.width).toBe(12);
    expect(o.items.find((i) => i.id === 'far')).toBeUndefined();
    for (const item of o.items) expect(itemFootprint(item)!.maxX).toBeLessThanOrEqual(12);
  });

  it('clamps settings', () => {
    const o = applyOp(base, { t: 'settings', settings: { width: 1000, depth: 1, floorColor: 'nope', floor: 'lava' as never } });
    expect(o.settings.width).toBe(80);
    expect(o.settings.depth).toBe(8);
    expect(o.settings.floorColor).toBe(base.settings.floorColor);
    expect(o.settings.floor).toBe(base.settings.floor);
  });
});

describe('templates', () => {
  for (const template of ['startup', 'blank'] as const) {
    it(`${template} is valid and survives a save/load round trip`, () => {
      const office = createFromTemplate(template, 'abc', 'Name');
      expect(new Set(office.items.map((i) => i.id)).size).toBe(office.items.length);
      for (const item of office.items) {
        expect(getEntry(item.type)).toBeDefined();
        const fp = itemFootprint(item)!;
        expect(fp.minX).toBeGreaterThanOrEqual(0);
        expect(fp.minZ).toBeGreaterThanOrEqual(0);
        expect(fp.maxX).toBeLessThanOrEqual(office.settings.width);
        expect(fp.maxZ).toBeLessThanOrEqual(office.settings.depth);
      }
      const { spawn } = office.settings;
      expect(isBlocked(spawn.x, spawn.z, buildColliders(office), office.settings)).toBe(false);
      expect(sanitizeOffice(JSON.parse(JSON.stringify(office)))).toEqual(office);
    });
  }

  it('startup template has seats that are reachable', () => {
    const office = createFromTemplate('startup', 'abc', 'Name');
    expect(office.items.filter((i) => i.type === 'chair').length).toBeGreaterThan(20);
    expect(office.zones.map((z) => z.name)).toEqual(['Meeting Room', 'Lounge']);
  });
});
