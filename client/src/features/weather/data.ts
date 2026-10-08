import type { AccountUser } from '../../../../shared/account';
import type { SharedWeather, WeatherPlace } from '../../../../shared/weather';
import { saveAccountSettings } from '../../lib/account';
import { onSession, type OfficeSession } from '../../lib/session';
import { getState as getAppState, useStore } from '../../state/store';
import { fetchHere, fetchReport, REFRESH_MS, WeatherError } from './api';
import { locateDevice } from './location';
import { resolvePlace, sameCell } from './places';
import { decodeSynced, encodeSynced, loadPrefs, loadUnsynced, PREFS_KEY, savePrefs, saveUnsynced, SETTING } from './prefs';
import { useWeather, type WeatherPrefs } from './state';

// Your weather: the preferences (this browser, and the account when signed in), the place they
// point to, and its weather, fetched from the server while you're in an office (and shared with
// the office when you allow it).

const { getState: get, setState: set } = useWeather;

/** Puts preferences and your connection's place in effect. A different weather cell drops the old report. */
function apply(prefs: WeatherPrefs, here = get().here): void {
  const next = resolvePlace(prefs, here);
  const moved = !sameCell(get().place, next.place);
  set({ prefs, here, ...next, ...(moved ? { report: null, error: null } : {}) });
}

/** The account's weather setting as last taken in or sent, so our own saves aren't taken in again. */
let synced: string | null = null;
let saving = 0;

function syncToAccount(prefs: WeatherPrefs): void {
  const account = getAppState().account;
  if (!account) return;
  const value = encodeSynced(prefs);
  if (value === synced) return;
  synced = value;
  saving++;
  saveAccountSettings({ [SETTING]: value })
    .then(
      () => saveUnsynced(null),
      () => {
        // Not saved: the account still has its old value, and this browser the change, to save later.
        const kept = getAppState().account?.profile.settings?.[SETTING];
        const base = typeof kept === 'string' ? kept : null;
        if (synced === value) synced = base;
        saveUnsynced({ user: account.id, base });
      },
    )
    .finally(() => saving--);
}

/**
 * Signed in, the preferences saved with your account win (they may have changed on another device),
 * except a change this browser couldn't save while the account still has what it had then.
 */
function adopt(account: AccountUser | null): void {
  if (!account || saving) return;
  const raw = account.profile.settings?.[SETTING];
  const value = typeof raw === 'string' ? raw : null;
  const unsynced = loadUnsynced();
  if (unsynced?.user === account.id && unsynced.base === value) {
    // Not changed elsewhere since: try saving this browser's change again.
    syncToAccount(get().prefs);
    return;
  }
  if (value === null || value === synced) return;
  synced = value;
  if (unsynced) saveUnsynced(null);
  // Already in effect here (this browser may know more about the city than the account's short copy).
  if (encodeSynced(get().prefs) === value) return;
  const fromAccount = decodeSynced(value);
  if (!fromAccount) return;
  const prefs = { ...get().prefs, ...fromAccount };
  savePrefs(prefs);
  apply(prefs);
}

/** Changes your weather preferences: here, in this browser and, signed in, with your account. */
export function setPrefs(patch: Partial<WeatherPrefs>): void {
  const prefs = { ...get().prefs, ...patch };
  savePrefs(prefs);
  apply(prefs);
  syncToAccount(prefs);
}

/** Counts the places chosen, so a late answer to "Use my location" can't undo a newer choice. */
let choices = 0;

/** A place you chose: it replaces a "Use my location" still waiting, and the last one's error. */
function choose(patch: Pick<WeatherPrefs, 'city' | 'device'>): void {
  choices++;
  set({ locating: false, locateError: null });
  setPrefs(patch);
}

export function chooseCity(city: WeatherPlace): void {
  choose({ city, device: null });
}

/** Back to your connection's place (when the server knows it). */
export function chooseAutomatic(): void {
  choose({ city: null, device: null });
}

/**
 * Uses your device's location: the browser asks first, so call it from a click. Resolves whether it
 * was used (not when it failed, or you chose another place meanwhile).
 */
export async function locateMe(): Promise<boolean> {
  const choice = ++choices;
  set({ locating: true, locateError: null });
  try {
    const device = await locateDevice();
    if (choice !== choices) return false;
    choose({ device, city: null });
    return true;
  } catch (err) {
    if (choice === choices) set({ locating: false, locateError: (err as Error).message });
    return false;
  }
}

/** Forgets why "Use my location" last failed (once the picker that showed it closes). */
export function clearLocateError(): void {
  set({ locateError: null });
}

/** Asking the server for your connection's place: once per page load, until it answers. */
let hereAsked: Promise<boolean> | null = null;

/** Resolves whether the server answered. */
function askHere(): Promise<boolean> {
  hereAsked ??= fetchHere().then(
    (here) => {
      if (here === 'off') {
        set({ available: false });
      } else {
        set({ available: true });
        apply(get().prefs, here);
      }
      return true;
    },
    () => {
      // Offline or a hiccup: ask again next time.
      hereAsked = null;
      return false;
    },
  );
  return hereAsked;
}

/** When the current report is due to be fetched again (ms since 1970). */
let refreshAt = 0;

/** Fetches the weather while you're in the office, and shares it when you allow it. */
function weatherSession(session: OfficeSession): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ctrl: AbortController | undefined;
  let failures = 0;
  /** A refresh came due while the tab was hidden. */
  let due = false;
  /** What the server has of our weather (as JSON), so only changes are sent. */
  let shared = 'null';

  const later = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void update(), ms);
  };

  async function update(): Promise<void> {
    clearTimeout(timer);
    ctrl?.abort();
    const mine = (ctrl = new AbortController());
    const selfId = session.selfId();
    if (!selfId) return;
    // Also while the weather is off: Settings shows whether the server has it, and from where.
    const answered = await askHere();
    // Leaving the office, or a newer update (e.g. the place changed meanwhile), aborts this one.
    if (mine.signal.aborted) return;
    const { place, available, prefs } = get();
    if (!place || available === false) {
      set({ status: 'idle', error: null });
      // Without your connection's place yet, ask again in a minute.
      if (!answered) later(60_000);
      return;
    }
    // While the tab is hidden, a refresh waits until you're back (the first fetch doesn't), unless
    // others see your weather.
    if (document.hidden && get().report && !prefs.share) {
      due = true;
      return;
    }
    due = false;
    set({ status: 'loading' });
    try {
      const { report, refreshIn } = await fetchReport(place, selfId, mine.signal);
      failures = 0;
      refreshAt = Date.now() + refreshIn;
      set({ report, available: true, status: 'ready', error: null });
      later(refreshIn);
    } catch (err) {
      if (mine.signal.aborted) return;
      if (err instanceof WeatherError && err.status === 404) {
        set({ available: false, status: 'idle' });
        return;
      }
      // Keep the last report and try again later: sooner at first, and never before the server asks.
      failures++;
      set({ status: 'error', error: 'Couldn’t update the weather. Trying again soon.' });
      const retryAfter = err instanceof WeatherError && err.retryAfter ? err.retryAfter * 1000 : 0;
      later(Math.max(Math.min(REFRESH_MS, 30_000 * 2 ** (failures - 1)), retryAfter) * (1 + Math.random() * 0.2));
    }
  }

  const share = () => {
    if (!session.selfId()) return;
    const { prefs, report } = get();
    const weather: SharedWeather | null =
      prefs.share && report ? { code: report.code, isDay: report.isDay, tempC: report.tempC, utcOffset: report.utcOffset } : null;
    const json = JSON.stringify(weather);
    if (json === shared) return;
    shared = json;
    session.socket.emit('weather:share', weather);
  };

  const offJoined = session.onJoined(() => {
    // The server has a fresh player for us: nothing shared yet.
    shared = 'null';
    share();
    const wait = refreshAt - Date.now();
    if (!hereAsked || !get().report || wait <= 0) void update();
    else later(wait);
  });

  const onVisibility = () => {
    if (document.hidden) return;
    if (due || (failures === 0 && get().report && Date.now() >= refreshAt)) void update();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const unsubscribe = useWeather.subscribe((s, prev) => {
    if (s.prefs.enabled !== prev.prefs.enabled || !sameCell(s.place, prev.place)) {
      failures = 0;
      void update();
    } else if (due && s.prefs.share && !prev.prefs.share) {
      // Others see your weather now: a refresh waiting for the tab can't wait.
      void update();
    }
    if (s.report !== prev.report || s.prefs.share !== prev.prefs.share) share();
  });

  return () => {
    clearTimeout(timer);
    ctrl?.abort();
    offJoined();
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisibility);
    set((s) => (s.status === 'loading' ? { status: 'idle' } : {}));
  };
}

useStore.subscribe((s, prev) => {
  if (s.account !== prev.account) adopt(s.account);
});

/** Follows changes made in another tab, so this one doesn't save its older ones over them. */
function onStorage(e: StorageEvent): void {
  if (e.key === PREFS_KEY) apply(loadPrefs());
}
window.addEventListener('storage', onStorage);

onSession('weather', weatherSession);
