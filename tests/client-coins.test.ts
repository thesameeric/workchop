import { afterEach, describe, expect, it, vi } from 'vitest';

// Coins are off unless the server runs with COINS=on: the client shows them (the wallet, "Send coins",
// celebrations) and loads your wallet only once the server says it has them, on joining an office.

const fake = vi.hoisted(() => ({
  /** The coins module's office-session hook. */
  hooks: [] as ((session: unknown) => () => void)[],
  app: { account: { id: 'u1' } as { id: string } | null, panel: 'none', selfId: 'me' },
  /** What's registered now, by kind: panels, People panel buttons, overlays. */
  shown: new Map<string, Set<string>>(),
  toast: vi.fn(),
}));

function registry(kind: string) {
  return (entry: { id: string }) => {
    const ids = fake.shown.get(kind) ?? new Set<string>();
    fake.shown.set(kind, ids);
    ids.add(entry.id);
    return () => void ids.delete(entry.id);
  };
}

vi.mock('../client/src/lib/session', () => ({
  getSession: () => null,
  onSession: (_id: string, hook: (session: unknown) => () => void) => void fake.hooks.push(hook),
}));
vi.mock('../client/src/state/store', () => ({
  getState: () => fake.app,
  setPanel: () => {},
  toast: fake.toast,
  useStore: () => null,
}));
vi.mock('../client/src/ui/panels', () => ({ registerPanel: registry('panel') }));
vi.mock('../client/src/ui/personActions', () => ({ registerPersonAction: registry('person action') }));
vi.mock('../client/src/ui/overlays', () => ({ registerOverlay: registry('overlay') }));
vi.mock('../client/src/features/coins/WalletPanel', () => ({ WalletPanel: () => null }));
vi.mock('../client/src/features/coins/Celebrations', () => ({ Celebrations: () => null }));

await import('../client/src/features/coins/index');

const shown = () => Object.fromEntries([...fake.shown].map(([kind, ids]) => [kind, [...ids]]).filter(([, ids]) => ids.length));

/** In an office: a stand-in for its connection. */
function office() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const joined = new Set<(rejoin: boolean) => void>();
  const session = {
    socket: {
      on: (event: string, fn: (...args: unknown[]) => void) => void handlers.set(event, fn),
      off: (event: string) => void handlers.delete(event),
    },
    onJoined: (fn: (rejoin: boolean) => void) => {
      joined.add(fn);
      return () => void joined.delete(fn);
    },
  };
  const leave = fake.hooks[0](session);
  return {
    join: (rejoin = false) => joined.forEach((fn) => fn(rejoin)),
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
    leave,
  };
}

describe('coins (client)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('show nothing and ask for nothing on a server without coins', async () => {
    const fetches = vi.spyOn(globalThis, 'fetch');
    expect(shown()).toEqual({});
    const o = office();
    o.join();
    await new Promise((r) => setTimeout(r, 450));
    expect(shown()).toEqual({});
    expect(fetches).not.toHaveBeenCalled();
    o.leave();
  });

  it('appear when the server says it has them, load your wallet, and go when you leave', async () => {
    const fetches = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ balance: 120, recent: [] }));
    const o = office();
    o.join();
    o.emit('coins:office', { enabled: true });
    expect(shown()).toEqual({ panel: ['wallet'], 'person action': ['coins'], overlay: ['coins'] });
    expect(fetches.mock.calls.map(([url]) => url)).toEqual(['/api/me/wallet']);
    // The owner switching them off for the office keeps the wallet (and the switch) there.
    o.emit('coins:office', { enabled: false });
    expect(shown()).toEqual({ panel: ['wallet'], 'person action': ['coins'], overlay: ['coins'] });
    expect(fetches).toHaveBeenCalledTimes(1);
    // A rejoin loads it again.
    o.join(true);
    o.emit('coins:office', { enabled: true });
    expect(fetches).toHaveBeenCalledTimes(2);
    o.leave();
    expect(shown()).toEqual({});
  });

  it("don't load a guest's wallet", async () => {
    const fetches = vi.spyOn(globalThis, 'fetch');
    fake.app.account = null;
    const o = office();
    o.join();
    o.emit('coins:office', { enabled: true });
    expect(shown()).toEqual({ panel: ['wallet'], 'person action': ['coins'], overlay: ['coins'] });
    expect(fetches).not.toHaveBeenCalled();
    o.leave();
    fake.app.account = { id: 'u1' };
  });
});
