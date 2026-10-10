import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountUser } from '../shared/account';
import type { HelpingEnded, MyTicket, OfferEnded, SupportQueue, Ticket, TicketOffer } from '../shared/support';

// A support workspace on the client, for handing a visitor over and inviting a colleague: what the
// customer is told as they're moved to another desk and colleagues come and go, whom each side hears
// at full volume, and the staff's toasts when an offer or a helper's part ends.

type Listener = (...args: unknown[]) => void;

const fake = vi.hoisted(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) }));
  vi.stubGlobal('document', { visibilityState: 'visible' });
  const handlers = new Map<string, Listener[]>();
  const session = {
    officeId: 'o1',
    socket: {
      connected: true,
      on(event: string, fn: Listener) {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      },
      off(event: string, fn: Listener) {
        handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn));
      },
    },
    onJoined: () => () => {},
    setFullVolume: vi.fn(),
  };
  return {
    session,
    /** The server sends an event. */
    fire(event: string, ...args: unknown[]) {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
  };
});
vi.mock('../client/src/lib/session', () => ({ getSession: () => fake.session, backToLobby: () => {} }));
vi.mock('../client/src/world/movement', () => ({ sitOn: () => {}, standUp: () => {}, walkTo: () => {} }));
vi.mock('../client/src/world/officeCache', () => ({ officeData: () => ({ colliders: [], seats: [] }) }));
vi.mock('../client/src/features/chat/state', () => ({ loadConv: async () => {} }));

const { attach, checkArrived, useSupport } = await import('../client/src/features/support/state');
const { getState, setState } = await import('../client/src/state/store');
const { local } = await import('../client/src/lib/positions');

const mia = { id: 'mia', name: 'Mia', email: 'mia@example.com', profile: {} } as unknown as AccountUser;

const myTicket = (agent: { name: string; desk: string; deskItemId: string; playerId: string | null }, helpers: { name: string; playerId: string | null }[] = []): MyTicket => ({
  id: 't1',
  number: 7,
  status: 'active',
  ahead: null,
  agent,
  rating: null,
  helpers,
});

const ticket = (helpers: Ticket['helpers'] = []): Ticket => ({
  id: 't1',
  number: 7,
  status: 'active',
  customerName: 'Vic',
  customerEmail: null,
  firstMessage: 'Help',
  playerId: 'p-vic',
  present: true,
  assignee: { userId: 'tunde', name: 'Tunde' },
  deskItemId: 'd1',
  rating: null,
  createdAt: 0,
  assignedAt: 0,
  closedAt: null,
  helpers,
});

const queue = (patch: Partial<SupportQueue>): SupportQueue => ({
  waiting: [],
  desks: [],
  mine: null,
  helping: null,
  colleagues: [],
  offers: { outgoing: null, incoming: null },
  ...patch,
});

const offer = (kind: TicketOffer['kind']): TicketOffer => ({
  id: 'o1',
  kind,
  ticketId: 't1',
  number: 7,
  customerName: 'Vic',
  firstMessage: 'Help',
  from: { userId: 'mia', name: 'Mia', desk: 'Desk 1' },
  to: { userId: 'tunde', name: 'Tunde' },
  expiresAt: 0,
});

const toasts = () => getState().toasts.map((t) => t.text);
const loud = () => fake.session.setFullVolume.mock.calls.at(-1)?.[0];

let detach: () => void = () => {};

beforeEach(() => {
  detach();
  fake.session.setFullVolume.mockClear();
  setState({ toasts: [], account: null, office: null, me: { name: 'Visitor', avatar: {} as never, status: 'available' } });
  detach = attach(fake.session as never);
});

describe('a customer', () => {
  beforeEach(() => {
    useSupport.setState({ as: 'customer' });
    fake.fire('support:ticket', myTicket({ name: 'Mia', desk: 'Desk 1', deskItemId: 'd1', playerId: 'p-mia' }));
    setState({ toasts: [] });
  });

  it('is told when they’re handed to another agent, and walks over', () => {
    fake.fire('support:ticket', myTicket({ name: 'Tunde', desk: 'Desk 3', deskItemId: 'd3', playerId: 'p-tunde' }));
    expect(toasts()).toEqual(['Tunde at Desk 3 will help you now']);
    expect(useSupport.getState().moved).toBe(true);
    // Still at the first desk.
    local.seat = { x: 0, z: 0, ry: 0, itemId: 'd1' };
    checkArrived();
    expect(useSupport.getState().moved).toBe(true);
    local.seat = { x: 0, z: 0, ry: 0, itemId: 'd3' };
    checkArrived();
    expect(useSupport.getState().moved).toBe(false);
    local.seat = null;
  });

  it('is told who joins and leaves, and hears them all at full volume', () => {
    const agent = { name: 'Mia', desk: 'Desk 1', deskItemId: 'd1', playerId: 'p-mia' };
    expect(loud()).toEqual(['p-mia']);
    fake.fire('support:ticket', myTicket(agent, [{ name: 'Olive', playerId: 'p-olive' }]));
    expect(loud()).toEqual(['p-mia', 'p-olive']);
    fake.fire('support:ticket', myTicket(agent, [{ name: 'Olive', playerId: 'p-olive' }, { name: 'Ben', playerId: null }]));
    fake.fire('support:ticket', myTicket(agent, [{ name: 'Ben', playerId: null }]));
    expect(toasts()).toEqual(['Olive joined', 'Ben joined', 'Olive left']);
    expect(useSupport.getState().moved).toBe(false);
    // A colleague who takes over didn't leave.
    fake.fire('support:ticket', myTicket({ name: 'Ben', desk: 'Desk 2', deskItemId: 'd2', playerId: 'p-ben' }));
    expect(toasts()).toEqual(['Olive joined', 'Ben joined', 'Olive left', 'Ben at Desk 2 will help you now']);
    expect(loud()).toEqual(['p-ben']);
  });
});

describe('a customer whose browser signs in in another tab', () => {
  it('stays the visitor people see (until they’re staff, or leave)', () => {
    useSupport.setState({ as: 'customer' });
    const visitor = getState().me;
    setState({ account: mia, me: { name: 'Mia', avatar: { hat: 'mia' } as never, status: 'available' } });
    expect(getState()).toMatchObject({ account: { id: 'mia' }, me: visitor });
    detach();
    detach = () => {};
    expect(getState().me).toMatchObject({ name: 'Mia' });
  });
});

describe('staff', () => {
  beforeEach(() => {
    setState({ account: mia });
    useSupport.setState({ as: 'staff' });
  });

  it('hear their customer and the colleagues helping; a helper hears the customer, the agent and the other helper', () => {
    fake.fire('support:queue', queue({ mine: ticket([{ userId: 'olive', name: 'Olive', playerId: 'p-olive' }]) }));
    expect(loud()).toEqual(['p-vic', 'p-olive']);
    fake.fire(
      'support:queue',
      queue({
        desks: [{ itemId: 'd1', label: 'Desk 1', userId: 'tunde', name: 'Tunde', playerId: 'p-tunde', ticketId: 't1' }],
        helping: ticket([
          { userId: 'mia', name: 'Mia', playerId: 'p-mia' },
          { userId: 'olive', name: 'Olive', playerId: 'p-olive' },
        ]),
      }),
    );
    expect(loud()).toEqual(['p-vic', 'p-olive', 'p-tunde']);
    fake.fire('support:queue', queue({}));
    expect(loud()).toEqual([]);
  });

  it('are told how their offers ended', () => {
    const ended = (o: TicketOffer, why: OfferEnded['why'], note?: string) => fake.fire('support:offer:ended', { offer: o, why, note });
    // Sent by Mia (at most four toasts show at once).
    ended(offer('transfer'), 'accepted');
    ended(offer('invite'), 'accepted');
    expect(toasts()).toEqual(['Visitor #7 is with Tunde now.', 'Tunde joined.']);
    setState({ toasts: [] });
    ended(offer('transfer'), 'declined');
    ended(offer('transfer'), 'expired');
    ended(offer('transfer'), 'gone', 'Tunde is serving someone.');
    ended(offer('invite'), 'gone');
    expect(toasts()).toEqual(['Tunde declined.', 'Tunde didn’t answer.', 'Tunde is serving someone.', 'That offer no longer works.']);
    // Got by Tunde.
    setState({ account: { ...mia, id: 'tunde' }, toasts: [] });
    ended(offer('transfer'), 'cancelled');
    ended(offer('transfer'), 'expired');
    ended(offer('invite'), 'gone');
    expect(toasts()).toEqual(['Mia took the offer back.', 'The offer from Mia ran out.', 'The offer from Mia no longer works.']);
  });

  it('are told when their part in a conversation ends', () => {
    const ended = (why: HelpingEnded['why']) => fake.fire('support:helping:ended', { ticketId: 't1', number: 7, why, agent: 'Tunde' });
    ended('removed');
    ended('resolved');
    ended('ended');
    expect(toasts()).toEqual(['Tunde ended your part in Visitor #7’s conversation.', 'Tunde resolved Visitor #7.', 'Visitor #7’s conversation ended.']);
  });

  it('close the colleague picker when the customer isn’t theirs any more', () => {
    fake.fire('support:queue', queue({ mine: ticket() }));
    useSupport.setState({ picker: 'transfer' });
    fake.fire('support:queue', queue({ mine: ticket([{ userId: 'olive', name: 'Olive', playerId: 'p-olive' }]) }));
    expect(useSupport.getState().picker).toBe('transfer');
    fake.fire('support:queue', queue({}));
    expect(useSupport.getState().picker).toBeNull();
  });
});
