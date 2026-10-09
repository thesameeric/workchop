import { buildColliders, findPath, isBlocked, zoneAt } from '../../../shared/geometry';
import type { Gesture } from '../world/Avatar';
import type { ActorId } from './cast';
import { OFFICE, ROOM, SPOTS, type Spot, type SpotId } from './office';

// The landing page's office as a 40-second loop: who walks where, sits, talks and waves, and where
// the ping pong ball is. Everything is a pure function of the time in the loop, so the poster, the
// tests and the live scene agree.

export const LOOP = 40;
/** The moment the poster shows; the live scene starts here. */
export const T_POSTER = 20.6;
/** How long an emote floats (the .emote-bubble animation). */
const EMOTE_SECONDS = 3.2;
/** How long turning to face a new way takes. */
const TURN = 0.15;
/** How long Sanni (Visitor 14) takes to appear and to vanish. */
const POP = 0.35;

export interface Point {
  x: number;
  z: number;
}

type Anim = 'idle' | 'walk' | 'sit';

interface Move {
  from: number;
  until: number;
  to: SpotId;
  via?: [number, number][];
  /** Sits down at the end (else stands there). */
  sit?: boolean;
}

interface Script {
  start: SpotId;
  sitting: boolean;
  moves?: Move[];
  /** Gets up from the seat without going anywhere yet. */
  stands?: number[];
  says?: [from: number, until: number, text: string][];
  emotes?: [at: number, emoji: string][];
  gestures?: [from: number, until: number, gesture: Gesture][];
}

const SCRIPTS: Record<ActorId, Script> = {
  ama: {
    start: 'D_AMA',
    sitting: true,
    moves: [
      { from: 13.5, until: 17.7, to: 'R2', via: [[8.6, 1.2], [8.5, 2.5], [6.6, 3.9]], sit: true },
      { from: 30.4, until: 34.6, to: 'D_AMA', via: [[6.6, 3.9], [8.5, 2.5], [8.6, 1.2]], sit: true },
    ],
    says: [
      [11.3, 13.3, 'Sure. Meeting room?'],
      [28.0, 29.8, 'Love it.'],
    ],
    emotes: [[24.6, '👍']],
  },
  promise: {
    start: 'L1',
    sitting: true,
    moves: [
      { from: 1.0, until: 8.6, to: 'BY_AMA', via: [[13.5, 5]] },
      { from: 14.1, until: 18.1, to: 'R1', via: [[8.6, 1.2], [8.5, 2.5], [6.6, 1.1]], sit: true },
      { from: 31.6, until: 38.4, to: 'L1', via: [[6.6, 1.1], [8.5, 2.5], [8.6, 5.4]], sit: true },
    ],
    says: [
      [8.9, 11.1, 'Got a minute?'],
      [19.4, 24.2, 'So, about the launch…'],
    ],
  },
  utibe: { start: 'D_UTIBE', sitting: true },
  kayode: { start: 'D_KAYODE', sitting: true },
  samuel: {
    start: 'STAFF',
    sitting: true,
    says: [
      [16.3, 18.5, 'Hi! How can I help?'],
      [22.0, 24.4, 'Done. You’re all set.'],
    ],
    emotes: [[28.1, '👋']],
    gestures: [[28.0, 29.2, 'wave']],
  },
  sanni: {
    start: 'MAT',
    sitting: false,
    moves: [
      { from: 0.8, until: 4.6, to: 'W1', via: [[18.3, 7.75], [16.5, 7.75]], sit: true },
      { from: 11.5, until: 15.9, to: 'CUST', via: [[16.5, 7.6], [15.1, 7.2], [15.1, 5.5]], sit: true },
      { from: 29.2, until: 34.6, to: 'MAT', via: [[18.8, 5.5], [18.8, 10.6]] },
    ],
    stands: [28.0],
    says: [[18.9, 21.5, 'Can I move my delivery to Friday?']],
    emotes: [
      [0.3, '👋'],
      [24.8, '👍'],
    ],
    gestures: [[28.0, 29.2, 'wave']],
  },
  deji: {
    start: 'P1',
    sitting: false,
    emotes: [
      [8.8, '😂'],
      [26.8, '🙌'],
    ],
    gestures: [[26.8, 28.4, 'cheer']],
  },
  damo: {
    start: 'P2',
    sitting: false,
    emotes: [
      [8.8, '🎉'],
      [26.8, '😂'],
    ],
    gestures: [[8.8, 10.4, 'cheer']],
  },
};

/** When Sanni is in the office: appears at the start, vanishes at the door. */
const SANNI_SHOWN: [from: number, until: number] = [0, 35.15];
/** "1st in line" under Sanni's name tag while he waits. */
const IN_LINE: [from: number, until: number] = [4.6, 11.5];
/** The jukebox floats a note now and then. */
const NOTES = [5, 15, 25, 35];

// ---------- Walks ----------

const colliders = buildColliders(OFFICE);
const bounds = OFFICE.settings;

/** Where to stand to get on or off a seat inside furniture (a sofa): a step clear of its front. */
function stepOff(spot: Spot): Point {
  if (!isBlocked(spot.x, spot.z, colliders, bounds)) return spot;
  const at = (d: number) => ({ x: spot.x + Math.sin(spot.ry) * d, z: spot.z + Math.cos(spot.ry) * d });
  const free = (p: Point) => !isBlocked(p.x, p.z, colliders, bounds);
  for (let d = 0.3; d <= 1.5; d += 0.05) {
    if (!free(at(d))) continue;
    // A little further when there's room, so the way on doesn't scrape the corner.
    return free(at(d + 0.3)) ? at(d + 0.3) : at(d);
  }
  throw new Error(`Nowhere to step off ${spot.x}, ${spot.z}`);
}

export interface Walk {
  actor: ActorId;
  from: number;
  until: number;
  points: Point[];
  /** Distance along `points` at each point. */
  at: number[];
  length: number;
  /** Metres per second. */
  speed: number;
  /** Ends in a seat inside furniture: the last step turns round into it, facing this way. */
  backsInto: number | null;
}

/** The way from one spot to another through `via`, walking round the furniture; null if there's none. */
function route(from: Spot, to: Spot, via: Point[] = []): Point[] | null {
  const points: Point[] = [{ x: from.x, z: from.z }];
  let cur = stepOff(from);
  if (cur !== from) points.push(cur);
  const end = stepOff(to);
  for (const target of [...via, end]) {
    const leg = findPath(cur, target, colliders, bounds);
    if (!leg) return null;
    points.push(...leg);
    cur = target;
  }
  if (end !== to) points.push({ x: to.x, z: to.z });
  return points;
}

function makeWalk(actor: ActorId, from: Spot, move: Move): Walk {
  const points = route(from, SPOTS[move.to], (move.via ?? []).map(([x, z]) => ({ x, z })));
  if (!points) throw new Error(`No way for ${actor} at ${move.from}s`);
  const at = [0];
  for (let i = 1; i < points.length; i++) at.push(at[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  const length = at[at.length - 1];
  const to = SPOTS[move.to];
  const backsInto = isBlocked(to.x, to.z, colliders, bounds) ? to.ry : null;
  return { actor, from: move.from, until: move.until, points, at, length, speed: length / (move.until - move.from), backsInto };
}

// ---------- Timelines ----------

type Segment =
  | { kind: 'stay'; from: number; until: number; spot: Spot; anim: 'idle' | 'sit'; arrivingRy: number | null }
  | { kind: 'walk'; from: number; until: number; walk: Walk; leavingRy: number };

function timeline(actor: ActorId, s: Script): Segment[] {
  const events = [...(s.moves ?? []).map((m) => ({ t: m.from, move: m })), ...(s.stands ?? []).map((t) => ({ t, move: null }))].sort((a, b) => a.t - b.t);
  const out: Segment[] = [];
  let spot: Spot = SPOTS[s.start];
  let anim: 'idle' | 'sit' = s.sitting ? 'sit' : 'idle';
  let since = 0;
  let arrivingRy: number | null = null;
  for (const { t, move } of events) {
    out.push({ kind: 'stay', from: since, until: t, spot, anim, arrivingRy });
    if (!move) {
      anim = 'idle';
      since = t;
      arrivingRy = null;
      continue;
    }
    const walk = makeWalk(actor, spot, move);
    out.push({ kind: 'walk', from: move.from, until: move.until, walk, leavingRy: spot.ry });
    const [a, b] = walk.points.slice(-2);
    arrivingRy = walk.backsInto ?? Math.atan2(b.x - a.x, b.z - a.z);
    spot = SPOTS[move.to];
    anim = move.sit ? 'sit' : 'idle';
    since = move.until;
  }
  out.push({ kind: 'stay', from: since, until: LOOP, spot, anim, arrivingRy });
  return out;
}

const TIMELINES = Object.fromEntries(Object.entries(SCRIPTS).map(([id, s]) => [id, timeline(id as ActorId, s)])) as Record<ActorId, Segment[]>;

/** Every walk in the loop (for the tests). */
export const WALKS: Walk[] = Object.values(TIMELINES).flatMap((segments) => segments.flatMap((s) => (s.kind === 'walk' ? [s.walk] : [])));

// ---------- Poses ----------

export interface Pose {
  x: number;
  z: number;
  ry: number;
  anim: Anim;
  /** Walking speed, m/s. */
  speed: number;
  /** 0 hidden, 1 there (Sanni pops in and out). */
  scale: number;
}

/** The time within the loop. */
function loopTime(t: number): number {
  return ((t % LOOP) + LOOP) % LOOP;
}

function turnTowards(a: number, b: number, k: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * k;
}

const smooth = (k: number) => k * k * (3 - 2 * k);
const easeTurn = (since: number) => smooth(Math.min(1, Math.max(0, since / TURN)));

function walkPose(seg: Extract<Segment, { kind: 'walk' }>, t: number): Pose {
  const { walk } = seg;
  const d = Math.min(walk.length, ((t - seg.from) / (seg.until - seg.from)) * walk.length);
  let i = 1;
  while (i < walk.points.length - 1 && walk.at[i] < d) i++;
  const a = walk.points[i - 1];
  const b = walk.points[i];
  const span = walk.at[i] - walk.at[i - 1] || 1;
  const k = (d - walk.at[i - 1]) / span;
  let before = seg.leavingRy;
  if (i > 1) {
    const p = walk.points[i - 2];
    before = Math.atan2(a.x - p.x, a.z - p.z);
  }
  const last = i === walk.points.length - 1;
  // Turning at a corner (or setting off) takes a moment; into a sofa you turn round on the last step.
  const ry =
    last && walk.backsInto !== null
      ? turnTowards(before, walk.backsInto, smooth(k))
      : turnTowards(before, Math.atan2(b.x - a.x, b.z - a.z), easeTurn((d - walk.at[i - 1]) / walk.speed));
  return {
    x: a.x + (b.x - a.x) * k,
    z: a.z + (b.z - a.z) * k,
    ry,
    anim: 'walk',
    speed: walk.speed,
    scale: 1,
  };
}

/** Where someone is and what they're doing at time `t` (seconds; any value, it loops). */
export function poseAt(actor: ActorId, t: number): Pose {
  const lt = loopTime(t);
  const segments = TIMELINES[actor];
  const seg = segments.find((s) => lt < s.until) ?? segments[segments.length - 1];
  const pose: Pose =
    seg.kind === 'walk'
      ? walkPose(seg, lt)
      : {
          x: seg.spot.x,
          z: seg.spot.z,
          ry: seg.arrivingRy === null ? seg.spot.ry : turnTowards(seg.arrivingRy, seg.spot.ry, easeTurn(lt - seg.from)),
          anim: seg.anim,
          speed: 0,
          scale: 1,
        };
  if (actor === 'sanni') {
    const [shown, gone] = SANNI_SHOWN;
    pose.scale = lt >= gone ? 0 : smooth(Math.min(1, (lt - shown) / POP, (gone - lt) / POP));
  }
  return pose;
}

/** What someone is saying (a speech bubble), if anything. */
export function sayingAt(actor: ActorId, t: number): string | null {
  const lt = loopTime(t);
  return SCRIPTS[actor].says?.find(([from, until]) => lt >= from && lt < until)?.[2] ?? null;
}

/** The gesture someone is making, and how many seconds of it are left. */
export function gestureAt(actor: ActorId, t: number): { gesture: Gesture; left: number } | null {
  const lt = loopTime(t);
  const g = SCRIPTS[actor].gestures?.find(([from, until]) => lt >= from && lt < until);
  return g ? { gesture: g[2], left: g[1] - lt } : null;
}

export interface Emote {
  /** Who floats it ('jukebox' for the music notes). */
  who: ActorId | 'jukebox';
  emoji: string;
  /** When it started (loop time); with `who`, a key that changes for every new emote. */
  at: number;
}

/** The emotes floating at time `t`. */
export function emotesAt(t: number): Emote[] {
  const lt = loopTime(t);
  const out: Emote[] = [];
  const add = (who: Emote['who'], at: number, emoji: string) => {
    if (lt >= at && lt < at + EMOTE_SECONDS) out.push({ who, emoji, at });
  };
  for (const [id, s] of Object.entries(SCRIPTS)) for (const [at, emoji] of s.emotes ?? []) add(id as ActorId, at, emoji);
  for (const at of NOTES) add('jukebox', at, '🎵');
  return out;
}

/** Whether Sanni's name tag shows "1st in line". */
export function inLineAt(t: number): boolean {
  const lt = loopTime(t);
  return lt >= IN_LINE[0] && lt < IN_LINE[1];
}

/** Whether anyone is in the meeting room. */
export function roomBusyAt(t: number): boolean {
  return (Object.keys(SCRIPTS) as ActorId[]).some((id) => {
    const p = poseAt(id, t);
    return p.scale > 0 && !!zoneAt([ROOM], p.x, p.z);
  });
}

// ---------- Ping pong ----------

/** The two ends of the table where the ball is hit (Deji's west, Damo's east). */
const HIT_X = { deji: 8.35, damo: 11.65 } as const;
const TABLE_Z = 9;
const PADDLE_Y = 0.95;
/** The ball's middle as it bounces on the table top. */
const BOUNCE_Y = 0.735;
const FLOOR_Y = 0.03;
const BOUNCE_AT = 0.7;
const DROP = 0.8;

interface Rally {
  from: number;
  server: 'deji' | 'damo';
  /** Times the ball crosses the table (one second each). */
  crossings: number;
  /** The last one goes wide and the point is over; else play goes on into the next rally. */
  missed: boolean;
}

// Deji serves at 0; Damo wins the point at 8.8, serves at 10 and loses it at 26.8; Deji serves at
// 28 and his return at 40 is the serve at 0.
const RALLIES: Rally[] = [
  { from: 0, server: 'deji', crossings: 8, missed: true },
  { from: 10, server: 'damo', crossings: 16, missed: true },
  { from: 28, server: 'deji', crossings: 12, missed: false },
];

/** Across the table, where a hit at time `t` sends the ball (it loops with the script). */
const hitZ = (t: number) => TABLE_Z + 0.3 * Math.sin((2 * Math.PI * 7 * t) / LOOP) * Math.cos((2 * Math.PI * 3 * t) / LOOP);

export interface Ball {
  x: number;
  y: number;
  z: number;
  /** 0 hidden, 1 in play; fades out after a point. */
  opacity: number;
}

/** Where the ping pong ball is. */
export function ballAt(t: number): Ball {
  const lt = loopTime(t);
  for (const r of RALLIES) {
    const end = r.from + r.crossings;
    if (lt < r.from || lt >= end + (r.missed ? DROP : 0)) continue;
    const i = Math.min(r.crossings - 1, Math.floor(lt - r.from));
    const forward = (r.server === 'deji') === (i % 2 === 0);
    const x0 = forward ? HIT_X.deji : HIT_X.damo;
    const x1 = forward ? HIT_X.damo : HIT_X.deji;
    const wide = r.missed && i === r.crossings - 1;
    const z0 = hitZ(r.from + i);
    const z1 = wide ? TABLE_Z + 0.95 : hitZ(r.from + i + 1);
    if (lt >= end) {
      // Past the player, off the end of the table, down to the floor, and gone.
      const s = lt - end;
      const dir = Math.sign(x1 - x0);
      return {
        x: x1 + dir * 1.6 * s,
        y: Math.max(FLOOR_Y, PADDLE_Y + 0.6 * s - 4.9 * s * s),
        z: z1 + 0.4 * s,
        opacity: s < 0.5 ? 1 : Math.max(0, 1 - (s - 0.5) / 0.3),
      };
    }
    const u = lt - r.from - i;
    let y: number;
    if (u < BOUNCE_AT) {
      const v = u / BOUNCE_AT;
      y = PADDLE_Y + (BOUNCE_Y - PADDLE_Y) * v + 0.31 * Math.sin(Math.PI * v);
    } else {
      const v = (u - BOUNCE_AT) / (1 - BOUNCE_AT);
      y = BOUNCE_Y + (PADDLE_Y - BOUNCE_Y) * v + 0.12 * Math.sin(Math.PI * v);
    }
    return { x: x0 + (x1 - x0) * u, y, z: z0 + (z1 - z0) * u, opacity: 1 };
  }
  // Between points: someone has it in hand.
  return { x: HIT_X.deji, y: PADDLE_Y, z: TABLE_Z, opacity: 0 };
}

// ---------- Where the labels go ----------

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Name tags float this high over someone standing (as in the office), lower when they sit. */
const TAG_Y = 2.12;
const SIT_DROP = 0.22;

/** Someone's name tag, above their head (their bubbles and emotes sit on it); null while they're not there. */
export function tagPoint(actor: ActorId, t: number): Point3 | null {
  const p = poseAt(actor, t);
  if (p.scale < 0.5) return null;
  return { x: p.x, y: TAG_Y - (p.anim === 'sit' ? SIT_DROP : 0), z: p.z };
}

const jukebox = OFFICE.items.find((i) => i.type === 'jukebox')!;
/** Where the jukebox's notes float. */
const NOTE_POINT: Point3 = { x: jukebox.x, y: 1.9, z: jukebox.z };
/** The meeting room's sign, on the floor along its glass front. */
export const SIGN_POINT: Point3 = { x: ROOM.x + ROOM.w / 2, y: 0.05, z: ROOM.z + ROOM.d };

/** Where an emote floats. */
export function emotePoint(e: Emote, t: number): Point3 | null {
  return e.who === 'jukebox' ? NOTE_POINT : tagPoint(e.who, t);
}
