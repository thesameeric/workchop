import { useSyncExternalStore } from 'react';

/**
 * A list that features add entries to (panels, settings sections…), kept sorted by `order`.
 * Registering an id again replaces that entry.
 */
export function createRegistry<T extends { id: string; order: number }>() {
  const entries = new Map<string, T>();
  const listeners = new Set<() => void>();
  let sorted: T[] = [];
  /** Each registration's number, for keyOf. */
  const serials = new WeakMap<T, number>();
  let serial = 0;

  const changed = () => {
    sorted = [...entries.values()].sort((a, b) => a.order - b.order);
    listeners.forEach((l) => l());
  };
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  };

  return {
    /** Adds (or replaces) an entry; returns a function that removes it again. */
    register(entry: T): () => void {
      serials.set(entry, ++serial);
      entries.set(entry.id, entry);
      changed();
      return () => {
        if (entries.get(entry.id) !== entry) return;
        entries.delete(entry.id);
        changed();
      };
    },
    get: (id: string): T | undefined => entries.get(id),
    list: (): T[] => sorted,
    /** The entries, sorted; re-renders when one is added or removed. */
    useList: (): T[] => useSyncExternalStore(subscribe, () => sorted),
    /**
     * A React key for an entry that changes when its id is registered again, so a component calling
     * the entry's hooks (e.g. a panel's useBadge) starts afresh instead of running different hooks.
     */
    keyOf: (entry: T): string => `${entry.id}:${serials.get(entry)}`,
  };
}
