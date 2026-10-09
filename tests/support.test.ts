import { describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR } from '../shared/avatar';
import { deskLabels, SUPPORT_DESK } from '../shared/support';
import type { PlayerState } from '../shared/types';
import { isCustomer } from '../shared/workspace';
import { supportLink, type SupportParty } from '../server/features/support/link';
import { byTurn, nextUp, positions, type InQueue } from '../server/features/support/queue';
import { Room, type LinkRule } from '../server/room';

const customer = (serving: string | null = null): SupportParty => ({ customer: true, serving });
const staff = (serving: string | null = null): SupportParty => ({ customer: false, serving });

describe('supportLink', () => {
  it('never links customers with each other', () => {
    expect(supportLink(customer(), customer())).toBe(false);
    expect(supportLink(customer('t1'), customer('t1'))).toBe(false);
  });

  it('links a customer with the agent serving them, and with nobody else', () => {
    expect(supportLink(customer('t1'), staff('t1'))).toBe(true);
    expect(supportLink(staff('t1'), customer('t1'))).toBe(true);
    expect(supportLink(customer('t1'), staff('t2'))).toBe(false);
    expect(supportLink(customer('t1'), staff())).toBe(false);
    // Waiting customers talk to nobody.
    expect(supportLink(customer(), staff())).toBe(false);
    expect(supportLink(staff(), customer())).toBe(false);
  });

  it('keeps an agent who is serving someone away from the other staff; otherwise the usual rules', () => {
    expect(supportLink(staff('t1'), staff())).toBe(false);
    expect(supportLink(staff(), staff('t2'))).toBe(false);
    expect(supportLink(staff('t1'), staff('t2'))).toBe(false);
    expect(supportLink(staff(), staff())).toBeNull();
  });
});

describe('the support queue', () => {
  const t = (id: string, number: number, createdAt: number, assignedAt: number | null = null): InQueue => ({ id, number, createdAt, assignedAt });

  it('puts tickets back from an agent first, then the oldest', () => {
    const waiting = [t('c', 3, 30), t('a', 1, 10), t('back', 2, 20, 40), t('d', 4, 30)];
    expect([...waiting].sort(byTurn).map((x) => x.id)).toEqual(['back', 'a', 'c', 'd']);
    expect(positions(waiting)).toEqual(new Map([['back', 0], ['a', 1], ['c', 2], ['d', 3]]));
    expect(positions([])).toEqual(new Map());
  });

  it('calls the first customer who is here; those away keep their place', () => {
    const waiting = [t('a', 1, 10), t('b', 2, 20), t('c', 3, 30)];
    expect(nextUp(waiting, new Set(['c', 'b']))?.id).toBe('b');
    expect(nextUp(waiting, new Set(['a', 'c']))?.id).toBe('a');
    expect(nextUp(waiting, new Set())).toBeUndefined();
    expect(positions(waiting).get('c')).toBe(2);
  });
});

describe('support desks and customers', () => {
  it('number desks west to east, then north to south', () => {
    const desk = (id: string, x: number, z: number) => ({ id, type: SUPPORT_DESK, x, z, rot: 0 });
    const labels = deskLabels([desk('far', 30, 3), desk('south', 5, 12), { id: 'sofa', type: 'sofa', x: 1, z: 1, rot: 0 }, desk('near', 10, 3)]);
    expect([...labels]).toEqual([
      ['near', 'Desk 1'],
      ['far', 'Desk 2'],
      ['south', 'Desk 3'],
    ]);
  });

  it('are the guests of support workspaces', () => {
    expect(isCustomer('guest', 'support')).toBe(true);
    expect(isCustomer('guest', 'team')).toBe(false);
    expect(isCustomer('member', 'support')).toBe(false);
    expect(isCustomer(null, 'support')).toBe(false);
  });
});

describe('link rules in a room', () => {
  const player = (id: string, x: number, z: number): PlayerState => ({
    id,
    name: id,
    avatar: DEFAULT_AVATAR,
    status: 'available',
    x,
    z,
    ry: 0,
    anim: 'idle',
    mic: false,
    cam: false,
    screen: false,
  });

  it('let false win, then true, then distance; each rule is set up once per check', () => {
    const verdicts = new Map<string, boolean | null>();
    let setUps = 0;
    const rule: LinkRule = (office) => {
      setUps++;
      return office === 'o1' ? (a, b) => verdicts.get([a.id, b.id].sort().join('')) ?? null : null;
    };
    const room = new Room('o1', [rule, () => null]);
    room.players.set('a', player('a', 1, 1));
    room.players.set('b', player('b', 1.5, 1));
    room.players.set('c', player('c', 30, 30));
    // Near each other: linked by distance; far apart: not.
    expect(room.recompute([]).added.map((l) => [l.a, l.b].sort().join(''))).toEqual(['ab']);
    expect(setUps).toBe(1);
    // Forced together, whatever the distance, and kept apart, however close.
    verdicts.set('ac', true);
    verdicts.set('ab', false);
    const changes = room.recompute([]);
    expect(changes.added.map((l) => [l.a, l.b].sort().join(''))).toEqual(['ac']);
    expect(changes.removed.map((l) => [l.a, l.b].sort().join(''))).toEqual(['ab']);
    // Only the given people's pairs are checked.
    verdicts.set('bc', true);
    expect(room.recompute([], ['a']).added).toEqual([]);
    expect(room.recompute([], ['b']).added.map((l) => [l.a, l.b].sort().join(''))).toEqual(['bc']);
    // Any rule saying false wins over one saying true; a rule that throws has no say.
    const quiet = console.error;
    console.error = () => {};
    const both = new Room('o2', [() => () => true, () => () => false, () => { throw new Error('broken'); }]);
    both.players.set('a', player('a', 1, 1));
    both.players.set('b', player('b', 1.2, 1));
    expect(both.recompute([]).added).toEqual([]);
    console.error = quiet;
  });
});
