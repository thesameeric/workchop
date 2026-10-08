import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskNote } from '../shared/world';

// The toasts for new desk notes: they say when a guest (anyone with the link, under any name) wrote
// one, and notes arriving close together share one toast instead of piling up.

const fake = vi.hoisted(() => {
  let id = 0;
  return {
    hooks: [] as ((session: unknown) => () => void)[],
    toasts: new Map<number, string>(),
    toast: (text: string) => {
      fake.toasts.set(++id, text);
      return id;
    },
    dismissToast: (toastId: number) => void fake.toasts.delete(toastId),
  };
});

vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
vi.mock('../client/src/lib/session', () => ({
  getSession: () => null,
  onSession: (_id: string, hook: (session: unknown) => () => void) => void fake.hooks.push(hook),
}));
vi.mock('../client/src/state/store', () => ({
  getState: () => ({ account: { id: 'ana' }, panel: 'none' }),
  setPanel: () => {},
  toast: fake.toast,
  dismissToast: fake.dismissToast,
  useStore: Object.assign(() => null, { subscribe: () => () => {} }),
}));
vi.mock('../client/src/ui/icons', () => ({ StickyNoteIcon: () => null }));
vi.mock('../client/src/ui/overlays', () => ({ registerOverlay: () => () => {} }));
vi.mock('../client/src/ui/panels', () => ({ registerPanel: () => () => {} }));
vi.mock('../client/src/world/extensions', () => ({
  registerWorldModule: () => {},
  registerItemInteraction: () => {},
  registerNearbyAction: () => {},
}));
vi.mock('../client/src/features/world/actions', () => ({ areaLit: () => true, toggleLight: () => {} }));
vi.mock('../client/src/features/world/cards', () => ({ WorldCard: () => null }));
vi.mock('../client/src/features/world/DeskPanel', () => ({ DeskPanel: () => null }));

await import('../client/src/features/world/index');

const handlers = new Map<string, (...args: unknown[]) => void>();
fake.hooks[0]({
  officeId: 'o1',
  socket: {
    on: (event: string, fn: (...args: unknown[]) => void) => void handlers.set(event, fn),
    off: (event: string) => void handlers.delete(event),
  },
  onJoined: () => () => {},
});

const note = (authorName: string, byGuest: boolean): DeskNote => ({
  id: `n${authorName}`,
  ownerUserId: 'ana',
  authorName,
  byGuest,
  text: 'hi',
  color: '#ffe066',
  createdAt: Date.now(),
  readAt: null,
});
const arrive = (n: DeskNote, officeId = 'o1') => handlers.get('desk:note:new')!(n, officeId, 'Other office');

describe('new desk note toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fake.toasts.clear();
  });

  it('say who wrote it, and when it was a guest', () => {
    arrive(note('Ben', false));
    expect([...fake.toasts.values()]).toEqual(['Ben left a note on your desk']);
    vi.advanceTimersByTime(7000);
    arrive(note('Ana', true));
    expect([...fake.toasts.values()].at(-1)).toBe('Ana (guest) left a note on your desk');
  });

  it('share one toast when they arrive close together', () => {
    vi.advanceTimersByTime(7000);
    for (const name of ['Gus', 'Hal', 'Ida']) arrive(note(name, true));
    expect([...fake.toasts.values()]).toEqual(['3 new notes on your desk']);
    arrive(note('Jo', true), 'o2');
    expect([...fake.toasts.values()]).toEqual(['3 new notes on your desk', 'Jo (guest) left a note on your desk in Other office']);
  });
});
