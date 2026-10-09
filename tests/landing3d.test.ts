import { describe, expect, it } from 'vitest';
import { seatsOf } from '../shared/catalog';
import { zoneAt } from '../shared/geometry';
import { CAST } from '../client/src/landing3d/cast';
import { ballAt, emotesAt, LOOP, poseAt, sayingAt, T_POSTER, WALKS } from '../client/src/landing3d/director';
import { spread, type LabelGroup, type Part } from '../client/src/landing3d/layout';
import { LIT_DESKS, OFFICE, ROOM, SPOTS } from '../client/src/landing3d/office';
import { planShot, SHOTS } from '../client/src/landing3d/shots';

// The landing page's 3D office: its script must loop, keep people apart and on real seats, and show
// what the poster shows.

const grid = (step = 0.1) => Array.from({ length: Math.round(LOOP / step) }, (_, i) => i * step);
const sameAngle = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-6;
const seats = OFFICE.items.flatMap(seatsOf);

describe('the landing office script', () => {
  it('walks round the furniture at a walking pace', () => {
    expect(WALKS).toHaveLength(8);
    for (const w of WALKS) {
      expect(w.points.length, `${w.actor} at ${w.from}s`).toBeGreaterThan(1);
      expect(w.speed, `${w.actor} at ${w.from}s`).toBeGreaterThanOrEqual(1.2);
      expect(w.speed, `${w.actor} at ${w.from}s`).toBeLessThanOrEqual(2.4);
    }
  });

  it('loops: the end is the start', () => {
    for (const a of CAST) {
      const start = poseAt(a.id, 0);
      const end = poseAt(a.id, LOOP - 1e-6);
      expect(Math.hypot(start.x - end.x, start.z - end.z), a.id).toBeLessThan(0.01);
      expect(end.anim, a.id).toBe(start.anim);
    }
    const start = ballAt(0);
    const end = ballAt(LOOP - 1e-6);
    expect(Math.hypot(start.x - end.x, start.y - end.y, start.z - end.z)).toBeLessThan(0.01);
    expect(end.opacity).toBe(start.opacity);
  });

  it('sits people on real seats, facing the way the seat does', () => {
    for (const t of grid()) {
      for (const a of CAST) {
        const p = poseAt(a.id, t);
        if (p.anim !== 'sit') continue;
        const seat = seats.find((s) => Math.hypot(s.x - p.x, s.z - p.z) < 0.01);
        expect(seat, `${a.id} at ${t.toFixed(1)}s`).toBeDefined();
        // Turning round to sit takes a moment.
        const before = poseAt(a.id, t - 0.2);
        if (before.anim === 'sit' && before.x === p.x && before.z === p.z) expect(sameAngle(seat!.ry, p.ry), `${a.id} at ${t.toFixed(1)}s`).toBe(true);
      }
    }
    for (const id of ['D_AMA', 'D_UTIBE', 'D_KAYODE', 'R1', 'R2', 'L1', 'W1', 'STAFF', 'CUST'] as const) {
      const spot = SPOTS[id];
      expect(
        seats.some((s) => Math.hypot(s.x - spot.x, s.z - spot.z) < 0.01 && sameAngle(s.ry, spot.ry)),
        id,
      ).toBe(true);
    }
  });

  it('names the lit desks after people in the cast, sitting at them', () => {
    for (const d of LIT_DESKS) {
      const actor = CAST.find((a) => a.name === d.name);
      expect(actor, d.name).toBeDefined();
      const p = poseAt(actor!.id, T_POSTER);
      expect(p.anim, d.name).toBe('sit');
      expect(Math.hypot(p.x - d.x, p.z - d.z), d.name).toBeLessThan(1.1);
    }
  });

  it('keeps people half a metre apart unless both are sitting', () => {
    for (const t of grid()) {
      const poses = CAST.map((a) => ({ id: a.id, ...poseAt(a.id, t) })).filter((p) => p.scale > 0);
      for (let i = 0; i < poses.length; i++) {
        for (let j = i + 1; j < poses.length; j++) {
          const [a, b] = [poses[i], poses[j]];
          if (a.anim === 'sit' && b.anim === 'sit') continue;
          expect(Math.hypot(a.x - b.x, a.z - b.z), `${a.id} and ${b.id} at ${t.toFixed(1)}s`).toBeGreaterThanOrEqual(0.5);
        }
      }
    }
  });

  it('shows the poster’s moment at T_POSTER', () => {
    const talking = CAST.filter((a) => sayingAt(a.id, T_POSTER)).map((a) => a.id);
    expect(talking.sort()).toEqual(['promise', 'sanni']);
    for (const id of ['ama', 'promise'] as const) {
      const p = poseAt(id, T_POSTER);
      expect(zoneAt([ROOM], p.x, p.z)?.id, id).toBe(ROOM.id);
      expect(p.anim, id).toBe('sit');
    }
    const sanni = poseAt('sanni', T_POSTER);
    expect(sanni.anim).toBe('sit');
    expect(Math.hypot(sanni.x - SPOTS.CUST.x, sanni.z - SPOTS.CUST.z)).toBeLessThan(0.01);
    const ball = ballAt(T_POSTER);
    expect(ball.opacity).toBe(1);
    expect(ball.y).toBeGreaterThan(0.75);
  });
});

describe('the landing camera', () => {
  it('frames every shot, and drifts back to the poster at T_POSTER', () => {
    for (const [name, shot] of Object.entries(SHOTS)) {
      for (const aspect of [6 / 5, 4 / 3]) {
        const plan = planShot(shot, aspect);
        expect([...plan.position, ...plan.target].every(Number.isFinite), name).toBe(true);
        const live = planShot(shot, aspect, T_POSTER);
        live.position.forEach((v, i) => expect(v).toBeCloseTo(plan.position[i], 9));
      }
    }
  });
});

describe('the landing labels', () => {
  const box = (w: number, h: number, dy = 0): Part => ({ left: -w / 2, top: dy - h / 2, right: w / 2, bottom: dy + h / 2 });
  /** Every part of every group where spread puts it. */
  const placed = (groups: LabelGroup[], width: number, height: number) => {
    const moves = spread(groups, width, height);
    return groups.map((g, i) => g.parts.map((p) => ({ l: g.x + moves[i].dx + p.left, r: g.x + moves[i].dx + p.right, t: g.y + moves[i].dy + p.top, b: g.y + moves[i].dy + p.bottom })));
  };
  const overlaps = (groups: ReturnType<typeof placed>) =>
    groups.flatMap((mine, i) =>
      groups.slice(i + 1).flatMap((theirs) => mine.flatMap((a) => theirs.filter((b) => Math.min(a.r, b.r) > Math.max(a.l, b.l) && Math.min(a.b, b.b) > Math.max(a.t, b.t)))),
    );

  it('clears a sign caught between a name tag and its emote', () => {
    const groups: LabelGroup[] = [
      { x: 139, y: 170, parts: [box(115, 22)], give: 3 },
      { x: 147, y: 197, parts: [box(54, 22), box(46, 38, -34)] },
    ];
    expect(overlaps(placed(groups, 527, 396))).toEqual([]);
  });

  it('moves the other label the whole way when the frame holds one back', () => {
    // The room's sign against the left edge, a name tag overlapping it.
    const groups: LabelGroup[] = [
      { x: 60, y: 131, parts: [box(112, 21)], give: 3 },
      { x: 123, y: 125, parts: [box(45, 19)] },
    ];
    const out = placed(groups, 343, 286);
    expect(overlaps(out)).toEqual([]);
    for (const g of out) for (const p of g) expect(p.l).toBeGreaterThanOrEqual(4);
  });

  it('keeps a speech bubble off the name tag behind its speaker', () => {
    const groups: LabelGroup[] = [
      { x: 210, y: 155, parts: [box(110, 22), { left: -35, top: -49, right: 35, bottom: -14, slides: true }] },
      { x: 225, y: 121, parts: [box(60, 22)] },
    ];
    expect(overlaps(placed(groups, 667, 501))).toEqual([]);
  });

  it('never floats an emote over someone who is talking (emotes sit where a bubble would)', () => {
    for (const t of grid()) for (const e of emotesAt(t)) if (e.who !== 'jukebox') expect(sayingAt(e.who, t), `${e.who} at ${t.toFixed(1)}s`).toBeNull();
  });
});
