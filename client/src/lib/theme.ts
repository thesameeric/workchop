import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';

// index.html applies the saved theme before the page renders; keep the two in step.
const KEY = 'workchop:theme';
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function saved(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

let theme = saved();
let dark = false;

function apply(): void {
  dark = theme === 'dark' || (theme === 'system' && prefersDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  listeners.forEach((l) => l());
}

apply();
prefersDark.addEventListener('change', () => theme === 'system' && apply());

export function setTheme(next: Theme): void {
  theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Not saved; it still applies until the page is reloaded.
  }
  apply();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** The chosen theme ('system' follows the device setting). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => theme);
}

/** Whether the page is dark right now, e.g. to tint the 3D scene to match. */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(subscribe, () => dark);
}
