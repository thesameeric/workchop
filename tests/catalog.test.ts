import { describe, expect, it } from 'vitest';
import { CATALOG_LIST, getEntry, seatsOf } from '../shared/catalog';
import { buildColliders, inFrontOf, isBlocked, standUpSpot } from '../shared/geometry';
import { sanitizeItem } from '../shared/office';
import { CUSTOMER_SEAT, STAFF_SEAT } from '../shared/support';
import type { OfficeItem } from '../shared/types';
import { MAX_BOARD_TEXT, MAX_BOARD_TITLE } from '../shared/world';

const bounds = { width: 20, depth: 20 };
const supportDesk = (rot: number): OfficeItem => ({ id: 'sd', type: 'support-desk', x: 10, z: 10, rot });

describe('seats', () => {
  it('turns a seat by its quarter turns: the customer faces the staff across a support desk', () => {
    const [staff, customer] = seatsOf(supportDesk(0));
    expect(staff).toEqual({ x: 10, z: 9, ry: 0 });
    expect(customer.x).toBe(10);
    expect(customer.z).toBe(11);
    expect(customer.ry).toBeCloseTo(Math.PI);
  });

  it('keeps the staff and customer seats facing each other however the desk is turned', () => {
    for (const rot of [0, 1, 2, 3]) {
      const desk = supportDesk(rot);
      const seats = seatsOf(desk);
      expect(seats).toHaveLength(2);
      for (const seat of seats) {
        // Facing the desk's middle.
        const facing = { x: Math.sin(seat.ry), z: Math.cos(seat.ry) };
        const toDesk = { x: desk.x - seat.x, z: desk.z - seat.z };
        expect(facing.x * toDesk.x + facing.z * toDesk.z, `rot ${rot}`).toBeCloseTo(1);
      }
      expect(Math.hypot(seats[STAFF_SEAT].x - seats[CUSTOMER_SEAT].x, seats[STAFF_SEAT].z - seats[CUSTOMER_SEAT].z)).toBeCloseTo(2);
      // The staff seat is on the desk's back side.
      const back = { x: -Math.sin((rot * Math.PI) / 2), z: -Math.cos((rot * Math.PI) / 2) };
      expect((seats[STAFF_SEAT].x - desk.x) * back.x + (seats[STAFF_SEAT].z - desk.z) * back.z).toBeCloseTo(1);
    }
  });

  it('leaves seats without a turn facing the item’s front', () => {
    for (const rot of [0, 1, 2, 3]) {
      for (const seat of seatsOf({ id: 's', type: 'sofa', x: 5, z: 5, rot })) expect(seat.ry).toBeCloseTo((rot * Math.PI) / 2);
    }
  });

  it('puts both support desk seats clear of the desk, with the desk solid between them', () => {
    const desk = supportDesk(1);
    const colliders = buildColliders({ items: [desk] });
    for (const seat of seatsOf(desk)) expect(isBlocked(seat.x, seat.z, colliders, bounds)).toBe(false);
    expect(isBlocked(desk.x, desk.z, colliders, bounds)).toBe(true);
  });
});

describe('workspace types', () => {
  it('offers the support desk and the queue screen only in support workspaces', () => {
    const only = CATALOG_LIST.filter((e) => e.kinds).map((e) => [e.type, e.kinds]);
    expect(only).toEqual([
      ['support-desk', ['support']],
      ['queue-board', ['support']],
    ]);
    const team = CATALOG_LIST.filter((e) => !e.kinds || e.kinds.includes('team')).map((e) => e.type);
    expect(team).toContain('aquarium');
    expect(team).toContain('info-board');
    expect(team).not.toContain('support-desk');
  });
});

describe('info boards', () => {
  it('keep a clean title and text', () => {
    const item = sanitizeItem(
      { id: 'b', type: 'info-board', x: 5, z: 5, data: { title: `  Opening\n hours ${'x'.repeat(80)}`, text: `Mon–Fri\r\n9–5${'y'.repeat(700)}`, extra: 1 } },
      bounds,
    )!;
    const data = item.data as { title: string; text: string };
    expect(Object.keys(data).sort()).toEqual(['text', 'title']);
    expect(data.title.startsWith('Opening hours x')).toBe(true);
    expect(data.title).toHaveLength(MAX_BOARD_TITLE);
    expect(data.text.startsWith('Mon–Fri\n9–5')).toBe(true);
    expect(data.text).toHaveLength(MAX_BOARD_TEXT);
  });

  it('start empty, and drop junk', () => {
    expect(sanitizeItem({ id: 'b', type: 'info-board', x: 5, z: 5 }, bounds)!.data).toBeUndefined();
    expect(sanitizeItem({ id: 'b', type: 'info-board', x: 5, z: 5, data: { title: 5, text: ['x'] } }, bounds)!.data).toBeUndefined();
    expect(sanitizeItem({ id: 'a', type: 'aquarium', x: 5, z: 5, data: { title: 'x' } }, bounds)!.data).toBeUndefined();
  });
});

describe('standing up', () => {
  it('steps back from a support desk, on both sides', () => {
    for (const rot of [0, 1, 2, 3]) {
      const desk = supportDesk(rot);
      const colliders = buildColliders({ items: [desk] });
      for (const seat of seatsOf(desk)) {
        const spot = standUpSpot(seat, true, colliders, bounds);
        expect(isBlocked(spot.x, spot.z, colliders, bounds)).toBe(false);
        // Away from the desk, not round it to the other side.
        expect(Math.hypot(spot.x - desk.x, spot.z - desk.z)).toBeCloseTo(1.8);
        expect(Math.hypot(spot.x - seat.x, spot.z - seat.z)).toBeCloseTo(0.8);
      }
    }
  });

  it('steps forward off a sofa, and somewhere free when both ways are blocked', () => {
    const sofa: OfficeItem = { id: 's', type: 'sofa', x: 10, z: 10, rot: 0 };
    const [seat] = seatsOf(sofa);
    const open = buildColliders({ items: [sofa] });
    const front = standUpSpot(seat, true, open, bounds);
    expect(isBlocked(front.x, front.z, open, bounds)).toBe(false);
    expect(front.z).toBeGreaterThan(10.5);
    expect(Math.hypot(front.x - seat.x, front.z - seat.z)).toBeLessThan(1.3);

    const boxedIn = buildColliders({
      items: [sofa, { id: 't', type: 'coffee-table', x: 10, z: 11, rot: 0 }, { id: 'w', type: 'wall', x: 10, z: 9.4, rot: 0 }],
    });
    const spot = standUpSpot(seat, true, boxedIn, bounds);
    expect(isBlocked(spot.x, spot.z, boxedIn, bounds)).toBe(false);
    expect(Math.hypot(spot.x - seat.x, spot.z - seat.z)).toBeLessThan(2);
  });

  it('leaves you where you sat on a chair', () => {
    const chair: OfficeItem = { id: 'c', type: 'chair', x: 4, z: 4, rot: 2 };
    const [seat] = seatsOf(chair);
    expect(standUpSpot(seat, false, buildColliders({ items: [chair] }), bounds)).toEqual({ x: 4, z: 4 });
  });
});

describe('in front of an item', () => {
  it('is past the front of its footprint, however it is turned', () => {
    const board: OfficeItem = { id: 'b', type: 'info-board', x: 10, z: 10, rot: 0 };
    expect(inFrontOf(board, 1)).toEqual({ x: 10, z: 10 + getEntry('info-board')!.d / 2 + 1 });
    const turned = inFrontOf({ ...board, rot: 1 }, 1);
    expect(turned.x).toBeCloseTo(11.25);
    expect(turned.z).toBeCloseTo(10);
  });
});
