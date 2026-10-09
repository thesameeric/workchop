import { FocusBadge } from '../features/audio/Headphones';
import { AppChip } from '../features/presence/AppChip';
import { LockIcon, WaitIcon } from '../ui/icons';
import type { Actor } from './cast';
import { bubbleShift, spread, type LabelGroup, type Move } from './layout';
import { ROOM } from './office';

// What the labels over the office look like: the office's own name tags, speech bubbles, emotes and
// the meeting room's sign. The poster and the live scene draw the same ones.

export function NameTag({ actor, speaking, inLine }: { actor: Actor; speaking: boolean; inLine: boolean }) {
  return (
    <>
      <div className={`nametag${speaking ? ' speaking' : ''}`}>
        <span className="status-dot available" />
        <span className="nametag-name">{actor.name}</span>
        {actor.focus && <FocusBadge />}
        {actor.app && <AppChip app={actor.app} variant="tag" />}
      </div>
      {inLine && (
        <span className="hero-stage-chip">
          <WaitIcon size={12} /> 1st in line
        </span>
      )}
    </>
  );
}

/** A label on screen: those with the same `group` move together (a name tag, its bubble and its emote). */
export interface Placed {
  group: string;
  kind: 'tag' | 'bubble' | 'emote' | 'sign';
  /** Its point, in pixels. */
  x: number;
  y: number;
  el: HTMLElement;
}

/** How far above its point an emote floats (`.hero-stage .emote-bubble` in hero3d.css). */
const EMOTE_RISE = 34;
/** How far above its point a bubble's tail ends (its 22px margin less the 8px tail). */
const TAIL_TIP = 14;

/**
 * Where each label goes so none covers another (spread, in layout.ts): how far it moves, and how far a
 * bubble slides to stay in the frame. Labels that aren't shown (display: none) are left where they are.
 */
export function arrange(labels: Placed[], width: number, height: number): (Move & { shift: number })[] {
  const groups = new Map<string, LabelGroup>();
  for (const l of labels) {
    const [w, h] = [l.el.offsetWidth, l.el.offsetHeight];
    if (!w) continue;
    // The room's sign makes way more readily than someone's name tag.
    const g = groups.get(l.group) ?? { x: l.x, y: l.y, parts: [], give: l.kind === 'sign' ? 3 : 1 };
    groups.set(l.group, g);
    if (l.kind === 'bubble') {
      // Pinned by its bottom (with room for the tail) above the name tag.
      g.parts.push({ left: -w / 2, top: -h, right: w / 2, bottom: -TAIL_TIP, slides: true });
    } else if (l.kind === 'emote') {
      // A little bigger: it pops in at 1.25 times its size.
      const [rx, ry] = [w / 2 + 4, h / 2 + 4];
      g.parts.push({ left: -rx, top: -EMOTE_RISE - ry, right: rx, bottom: -EMOTE_RISE + ry });
    } else {
      g.parts.push({ left: -w / 2, top: -h / 2, right: w / 2, bottom: h / 2 });
      const chip = l.el.querySelector<HTMLElement>('.hero-stage-chip');
      if (chip) g.parts.push({ left: -chip.offsetWidth / 2, top: h / 2 + 4, right: chip.offsetWidth / 2, bottom: h / 2 + 4 + chip.offsetHeight });
    }
  }
  const keys = [...groups.keys()];
  const moves = new Map(spread([...groups.values()], width, height).map((m, i) => [keys[i], m]));
  return labels.map((l) => {
    const m = moves.get(l.group) ?? { dx: 0, dy: 0 };
    return { ...m, shift: l.kind === 'bubble' ? bubbleShift(l.x + m.dx, l.el.offsetWidth, width) : 0 };
  });
}

export function Bubble({ text }: { text: string }) {
  return <div className="hero-stage-bubble">{text}</div>;
}

export function RoomSign({ active }: { active: boolean }) {
  return (
    <div className={`zone-label${active ? ' active' : ''}`} style={{ ['--zone' as string]: ROOM.color }}>
      <LockIcon size={12} /> {ROOM.name}
    </div>
  );
}
