import { describe, expect, it } from 'vitest';
import { getEntry, seatsOf } from '../shared/catalog';
import { buildColliders, findPath, inFrontOf, isBlocked, itemBox, itemFootprint, moveWithCollision, standUpSpot, zoneAt, type AABB } from '../shared/geometry';
import { sanitizeOffice } from '../shared/office';
import { CUSTOMER_SEAT, STAFF_SEAT } from '../shared/support';
import { createFromTemplate, TEMPLATES } from '../shared/templates';
import type { Office, OfficeItem } from '../shared/types';
import { BOARD_TYPE, MAX_BOARD_TEXT, MAX_BOARD_TITLE, sanitizeBoardData } from '../shared/world';

type Point = { x: number; z: number };

/**
 * Finds the way from `start` to `goal` and walks it like the client does (small steps that slide
 * along whatever they touch), ending close enough to `goal` (`near`: a seat is sat on from nearby).
 */
function expectRoute(office: Office, colliders: AABB[], start: Point, goal: Point, what: string, near = 0.05) {
  const path = findPath(start, goal, colliders, office.settings);
  expect(path, what).not.toBeNull();
  let at = start;
  for (const p of path!) {
    for (let i = 0; i < 2000; i++) {
      const d = Math.hypot(p.x - at.x, p.z - at.z);
      if (d < 1e-3) break;
      const step = Math.min(d, 0.07);
      at = moveWithCollision(at.x, at.z, ((p.x - at.x) / d) * step, ((p.z - at.z) / d) * step, colliders, office.settings);
    }
  }
  expect(Math.hypot(at.x - goal.x, at.z - goal.z), what).toBeLessThan(near);
}

describe('templates', () => {
  it('has one for each kind of workspace, with unique ids', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(TEMPLATES.filter((t) => t.kind === 'support').map((t) => t.id)).toEqual(['support']);
  });

  for (const { id } of TEMPLATES) {
    it(`${id}: every item is placed as written, inside the floor, and survives a save and load`, () => {
      const office = createFromTemplate(id, 'abc', 'Name');
      // Items are numbered in the order they're written: a gap would be one that was dropped.
      expect(office.items.map((i) => i.id)).toEqual(office.items.map((_, n) => `i${n + 1}`));
      for (const item of office.items) {
        const fp = itemFootprint(item)!;
        expect(fp.minX, item.id).toBeGreaterThanOrEqual(0);
        expect(fp.minZ, item.id).toBeGreaterThanOrEqual(0);
        expect(fp.maxX, item.id).toBeLessThanOrEqual(office.settings.width);
        expect(fp.maxZ, item.id).toBeLessThanOrEqual(office.settings.depth);
      }
      expect(sanitizeOffice(JSON.parse(JSON.stringify(office)))).toEqual(office);
    });
  }
});

describe('support lobby', () => {
  const office = createFromTemplate('support', 'lobby', 'Acme Help');
  const colliders = buildColliders(office);
  const { spawn } = office.settings;
  const ofType = (type: string) => office.items.filter((i) => i.type === type);

  it('is a big floor that only the owner and admins rearrange', () => {
    expect(office.settings).toMatchObject({ width: 56, depth: 40, buildPolicy: 'owner' });
    expect(isBlocked(spawn.x, spawn.z, colliders, office.settings)).toBe(false);
  });

  it('has six support desks in a row along the north wall, and the queue screen', () => {
    const desks = ofType('support-desk');
    expect(desks).toHaveLength(6);
    expect(new Set(desks.map((d) => `${d.z}|${d.rot}`))).toEqual(new Set(['3|0']));
    // Listed west to east (the order they're numbered in).
    expect(desks.map((d) => d.x)).toEqual([...desks.map((d) => d.x)].sort((a, b) => a - b));
    for (const desk of desks) {
      const seats = seatsOf(desk);
      // Staff with their backs to the north wall, customers on the lobby side.
      expect(seats[STAFF_SEAT].z).toBeLessThan(seats[CUSTOMER_SEAT].z);
    }
    const [screen] = ofType('queue-board');
    expect(screen.z).toBeLessThan(1);
  });

  it('has no solid things on top of each other', () => {
    // Small things standing on tables and shelves are meant to.
    const solids = office.items.filter((i) => getEntry(i.type)!.solid && !getEntry(i.type)!.onSurfaces);
    for (let a = 0; a < solids.length; a++) {
      for (let b = a + 1; b < solids.length; b++) {
        const A = itemBox(solids[a])!;
        const B = itemBox(solids[b])!;
        const overlap = A.minX < B.maxX - 1e-6 && B.minX < A.maxX - 1e-6 && A.minZ < B.maxZ - 1e-6 && B.minZ < A.maxZ - 1e-6;
        expect(overlap, `${solids[a].type} ${solids[a].id} and ${solids[b].type} ${solids[b].id}`).toBe(false);
      }
    }
  });

  it('gets you from the entrance to every desk seat, and back after standing up', () => {
    for (const desk of ofType('support-desk')) {
      for (const seat of seatsOf(desk)) {
        // Close enough to sit down on arrival (SIT_RANGE in client/src/world/movement.ts).
        expectRoute(office, colliders, spawn, seat, `to a seat of ${desk.id}`, 1.3);
        const up = standUpSpot(seat, true, colliders, office.settings);
        expect(Math.hypot(up.x - seat.x, up.z - seat.z)).toBeCloseTo(0.8);
        expectRoute(office, colliders, up, spawn, `back from ${desk.id}`);
      }
    }
  });

  it('gets you from the entrance to every other seat and back', () => {
    for (const item of office.items) {
      if (item.type === 'support-desk') continue;
      for (const seat of seatsOf(item)) {
        expectRoute(office, colliders, spawn, seat, `to ${item.type} ${item.id}`, 1.3);
        expectRoute(office, colliders, standUpSpot(seat, !!getEntry(item.type)?.solid, colliders, office.settings), spawn, `back from ${item.type} ${item.id}`);
      }
    }
  });

  it('gets you to the front of every sight: fish tanks, info boards, the jukebox and the queue screen', () => {
    const sights = office.items.filter((i) => ['aquarium', BOARD_TYPE, 'jukebox', 'queue-board'].includes(i.type));
    expect(sights.length).toBeGreaterThanOrEqual(5 + 5 + 1 + 1);
    // To the spot a step in front of it, or next to it when a bench stands there.
    for (const item of sights) expectRoute(office, colliders, spawn, inFrontOf(item, 1), `to the front of ${item.type} ${item.id}`, 0.8);
  });

  it('finds its way across the floor quickly', () => {
    const goals = office.items.flatMap((item) => seatsOf(item));
    const started = performance.now();
    for (const goal of goals) findPath(spawn, goal, colliders, office.settings);
    const each = (performance.now() - started) / goals.length;
    // About 2 ms on a laptop; findPath builds its grid each time, which is fine at this size.
    expect(each).toBeLessThan(25);
  });

  it('has a welcome board and FAQ boards with their text in full', () => {
    const boards = ofType(BOARD_TYPE).map((b) => sanitizeBoardData(b.data)!);
    expect(boards.map((b) => b.title)).toEqual(['Welcome to Acme Help', 'How the queue works', 'Talking with us', 'Your privacy', 'Getting around']);
    for (const board of boards) {
      expect(board.title.length).toBeLessThan(MAX_BOARD_TITLE);
      expect(board.text.length).toBeGreaterThan(100);
      expect(board.text.length).toBeLessThan(MAX_BOARD_TEXT);
    }
    expect(boards[1].text).toContain('10 minutes');
    // Customers are walked to the desk, as the lobby tells them.
    expect(boards[0].text).toContain('walk you to a desk');
  });

  it('has the welcome board nearest the entrance, and only FAQ boards besides', () => {
    // The support client tells them apart this way (the board nearest the spawn is the welcome).
    const near = (i: OfficeItem) => Math.hypot(i.x - spawn.x, i.z - spawn.z);
    const [welcome, ...faq] = ofType(BOARD_TYPE).sort((a, b) => near(a) - near(b));
    expect(sanitizeBoardData(welcome.data)!.title).toBe('Welcome to Acme Help');
    expect(faq).toHaveLength(4);
    // All in the FAQ gallery in the west.
    for (const board of faq) expect(board.x).toBeLessThan(12);
  });

  it('plays lo-fi in the music corner, heard only in there', () => {
    const [jukebox] = ofType('jukebox');
    expect(jukebox.data).toMatchObject({ station: 'lofi' });
    expect(zoneAt(office.zones, jukebox.x, jukebox.z)?.name).toBe('Music corner');
    expect(office.zones).toHaveLength(1);
  });

  it('fits a long workspace name on the welcome board', () => {
    const long = createFromTemplate('support', 'lobby', 'N'.repeat(48));
    const welcome = sanitizeBoardData(long.items.find((i) => i.type === BOARD_TYPE)!.data)!;
    expect(welcome.title).toBe(`Welcome to ${'N'.repeat(48)}`);
  });
});
