// Where the hero's labels go so none covers another: name tags, the speech bubbles and emotes over
// them, the meeting room's sign and the jukebox's notes. Pure, so the poster and the live scene agree
// (and it can be tested).

/** One box of a group, in pixels from the point the group is pinned to. */
export interface Part {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** A speech bubble: it slides sideways to stay in the frame (bubbleShift), so the frame's sides don't hold its group back. */
  slides?: boolean;
}

/** Labels that move together (a name tag with its bubble and emote), pinned at (x, y) in pixels. */
export interface LabelGroup {
  x: number;
  y: number;
  parts: Part[];
  /** How readily it makes way, against another group's 1 (the room's sign more than someone's name tag). */
  give?: number;
}

export interface Move {
  dx: number;
  dy: number;
}

/**
 * How far to slide a speech bubble sideways so it stays inside the frame (its tail stays put). `x` is
 * where its tail points, all in pixels.
 */
export function bubbleShift(x: number, width: number, frame: number): number {
  const half = width / 2;
  const pad = 6;
  let shift = 0;
  if (x + half > frame - pad) shift = frame - pad - (x + half);
  if (x - half + shift < pad) shift = pad - (x - half);
  // Not so far that the tail leaves the bubble's straight edge.
  const most = Math.max(0, half - 18);
  return Math.round(Math.max(-most, Math.min(most, shift)));
}

type Axis = 'x' | 'y';

interface Box {
  c: Record<Axis, number>;
  size: Record<Axis, number>;
}

/**
 * Moves groups that overlap apart and keeps them inside the frame (`width` × `height`); returns how
 * far each one moves. Of the four ways two groups can part, the shortest one that clears all their
 * parts wins, side by side preferred to stacked unless that's much further; where the frame's edge
 * holds one back, the other goes further, or they part another way. The same groups in the same
 * order always give the same moves.
 */
export function spread(groups: LabelGroup[], width: number, height: number, gap = 3): Move[] {
  const pad = 4;
  const at = groups.map((g) => ({ x: g.x, y: g.y }));
  const size = { x: width, y: height };

  /** The group's extent along an axis (a bubble's sides don't count: it slides). */
  const extent = (i: number, axis: Axis): [number, number] | null => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of groups[i].parts) {
      if (axis === 'x' && p.slides) continue;
      lo = Math.min(lo, axis === 'x' ? p.left : p.top);
      hi = Math.max(hi, axis === 'x' ? p.right : p.bottom);
    }
    return lo > hi ? null : [at[i][axis] + lo, at[i][axis] + hi];
  };
  const inside = (i: number) => {
    for (const axis of ['x', 'y'] as const) {
      const e = extent(i, axis);
      if (!e) continue;
      if (e[0] < pad || e[1] - e[0] > size[axis] - 2 * pad) at[i][axis] += pad - e[0];
      else if (e[1] > size[axis] - pad) at[i][axis] -= e[1] - (size[axis] - pad);
    }
  };
  /** How far group i can still go along `axis` (towards `s`, −1 or 1) before the frame stops it. */
  const room = (i: number, axis: Axis, s: number) => {
    const e = extent(i, axis);
    if (!e) return Infinity;
    return Math.max(0, s < 0 ? e[0] - pad : size[axis] - pad - e[1]);
  };
  const boxes = (i: number): Box[] =>
    groups[i].parts.map((p) => {
      const w = p.right - p.left;
      const cx = at[i].x + (p.left + p.right) / 2;
      return { c: { x: cx + (p.slides ? bubbleShift(cx, w, width) : 0), y: at[i].y + (p.top + p.bottom) / 2 }, size: { x: w, y: p.bottom - p.top } };
    });
  const near = (a: Box, b: Box, axis: Axis) => Math.abs(a.c[axis] - b.c[axis]) < (a.size[axis] + b.size[axis]) / 2 + gap;
  /** The least distance `mine` must move against `theirs` along `axis` (towards `s`) for none of their parts to overlap. */
  const clearance = (mine: Box[], theirs: Box[], axis: Axis, s: number) => {
    const other: Axis = axis === 'x' ? 'y' : 'x';
    const blocked: [number, number][] = [];
    for (const a of mine) {
      for (const b of theirs) {
        if (!near(a, b, other)) continue;
        const reach = (a.size[axis] + b.size[axis]) / 2 + gap;
        const off = s * (b.c[axis] - a.c[axis]);
        blocked.push([off - reach, off + reach]);
      }
    }
    let d = 0;
    for (let again = true; again; ) {
      again = false;
      for (const [lo, hi] of blocked) {
        if (lo < d && d < hi) {
          d = hi;
          again = true;
        }
      }
    }
    return d;
  };
  /** Moves i (towards `s`) and j apart by `d` along `axis`, as far as the frame lets them. */
  const part = (i: number, j: number, axis: Axis, s: number, d: number) => {
    const ri = room(i, axis, s);
    const rj = room(j, axis, -s);
    const gi = groups[i].give ?? 1;
    const mi = Math.min(ri, Math.max((d * gi) / (gi + (groups[j].give ?? 1)), d - rj));
    at[i][axis] += s * mi;
    at[j][axis] -= s * Math.min(rj, d - mi);
  };

  groups.forEach((_, i) => inside(i));
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const mine = boxes(i);
        const theirs = boxes(j);
        if (!mine.some((a) => theirs.some((b) => near(a, b, 'x') && near(a, b, 'y')))) continue;
        moved = true;
        const ways = (['x', 'y'] as const)
          .flatMap((axis) => [-1, 1].map((s) => ({ axis, s, d: clearance(mine, theirs, axis, s) })))
          .sort((a, b) => a.d * (a.axis === 'y' ? 2.5 : 1) - b.d * (b.axis === 'y' ? 2.5 : 1));
        const way = ways.find((w) => room(i, w.axis, w.s) + room(j, w.axis, -w.s) >= w.d) ?? ways[0];
        part(i, j, way.axis, way.s, way.d);
      }
    }
    if (!moved) break;
  }
  return at.map((p, i) => ({ dx: Math.round(p.x - groups[i].x), dy: Math.round(p.y - groups[i].y) }));
}
