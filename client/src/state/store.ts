import { create } from 'zustand';
import type { AccountUser, SignInProviders } from '../../../shared/account';
import type { SpotifySession } from '../../../shared/music';
import type { AvatarConfig, Office, PlayerState, Status } from '../../../shared/types';
import { loadProfile } from '../lib/storage';
import type { IconComponent } from '../ui/icons';

export type Phase = 'landing' | 'lobby' | 'office' | 'auth' | 'profile' | 'welcome';
/** The page shown in the 'auth' phase (its path: /signin, /signup…). */
export type AuthPage = 'signin' | 'signup' | 'forgot' | 'reset' | 'confirm-email';
/** The open side panel: 'none', or the id of a panel in ui/panels.tsx ('chat', 'people', 'build', 'music'…). */
export type Panel = string;
export type BuildTool = 'select' | 'place' | 'zone';
export type Modal = 'none' | 'avatar' | 'settings' | 'profile';

export type RemotePlayer = Omit<PlayerState, 'x' | 'z' | 'ry' | 'anim'>;

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  icon?: IconComponent;
  action?: ToastAction;
}

/** What the jukebox you can hear is playing. */
export interface NowPlaying {
  itemId: string;
  title: string;
  kind: 'generated' | 'stream' | 'tracks' | 'off';
  /** 0..1: how close you are (full volume inside its area). */
  near: number;
}

export type SpotifyStatus = 'disabled' | 'disconnected' | 'connecting' | 'ready' | 'error';

interface State {
  phase: Phase;
  officeId: string | null;
  authPage: AuthPage;
  /** The token from an emailed link (`/reset#t=…`), taken out of the address. */
  linkToken: string | null;
  connection: 'online' | 'reconnecting';

  /** Who is signed in (null for guests). */
  account: AccountUser | null;
  /** Whether we know yet (GET /api/me answered or failed), so the lobby doesn't show a guest first. */
  accountReady: boolean;
  /** Sign-in methods the server offers. */
  providers: SignInProviders;

  selfId: string | null;
  isOwner: boolean;
  office: Office | null;
  players: Record<string, RemotePlayer>;

  me: { name: string; avatar: AvatarConfig; status: Status };
  /** Headphones on: you hear nobody and no music (until you take them off or leave the office). */
  focus: boolean;
  media: { mic: boolean; cam: boolean; screen: boolean; version: number; error: string | null };

  /** People we currently have a call link with. */
  linked: Record<string, true>;
  streams: Record<string, MediaStream>;
  speaking: Record<string, boolean>;

  /** Asks the chat to open a conversation with this player (see messagePlayer); the chat clears it. */
  chatWith: string | null;

  emotes: Record<string, { emoji: string; at: number }>;

  panel: Panel;
  modal: Modal;
  mode: 'play' | 'build';
  build: {
    tool: BuildTool;
    placeType: string | null;
    rot: number;
    selectedId: string | null;
    selectedZoneId: string | null;
  };
  spotlight: string | null;
  toasts: Toast[];
  /** Hint shown near the bottom of the screen (e.g. "Press E to sit"). */
  hint: string | null;
  /** Private area you're currently standing in. */
  activeZoneId: string | null;

  music: {
    /** Your own music volume (0..1) and mute; saved in this browser. */
    volume: number;
    muted: boolean;
    nowPlaying: NowPlaying | null;
    /** Spotify is playing for you, so the lounge radio steps aside. */
    spotifyPlaying: boolean;
    /** The browser refused to start audio until the next click. */
    blocked: boolean;
  };
  /** Jukebox shown in the music panel. */
  musicItemId: string | null;
  /** Spotify listen-along sessions by jukebox id. */
  spotifySessions: Record<string, SpotifySession>;
  spotify: { status: SpotifyStatus; error: string | null };
}

const profile = loadProfile();

function loadMusicPrefs(): { volume: number; muted: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem('workchop:music') ?? '{}') as { volume?: unknown; muted?: unknown };
    const volume = typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : 0.6;
    return { volume, muted: raw.muted === true };
  } catch {
    return { volume: 0.6, muted: false };
  }
}

export function setMusicPrefs(prefs: { volume?: number; muted?: boolean }): void {
  setState((s) => ({ music: { ...s.music, ...prefs } }));
  const { volume, muted } = getState().music;
  try {
    localStorage.setItem('workchop:music', JSON.stringify({ volume, muted }));
  } catch {
    // Not saved; fine.
  }
}

/** How loud music plays for you (0..1): your own volume, or silence when muted or wearing headphones. */
export function personalMusicVolume(st: Pick<State, 'music' | 'focus'> = getState()): number {
  return st.music.muted || st.focus ? 0 : st.music.volume;
}

export const initialBuild: State['build'] = { tool: 'select', placeType: null, rot: 0, selectedId: null, selectedZoneId: null };

export const useStore = create<State>()(() => ({
  phase: 'landing',
  officeId: null,
  authPage: 'signin',
  linkToken: null,
  connection: 'online',
  account: null,
  accountReady: false,
  providers: { google: false, apple: false, github: false, dev: false, password: false, emailLinks: false },
  selfId: null,
  isOwner: false,
  office: null,
  players: {},
  me: { name: profile.name, avatar: profile.avatar, status: 'available' },
  focus: false,
  media: { mic: false, cam: false, screen: false, version: 0, error: null },
  linked: {},
  streams: {},
  speaking: {},
  chatWith: null,
  emotes: {},
  panel: 'none',
  modal: 'none',
  mode: 'play',
  build: initialBuild,
  spotlight: null,
  toasts: [],
  hint: null,
  activeZoneId: null,
  music: { ...loadMusicPrefs(), nowPlaying: null, spotifyPlaying: false, blocked: false },
  musicItemId: null,
  spotifySessions: {},
  spotify: { status: 'disabled', error: null },
}));

export const getState = useStore.getState;
export const setState = useStore.setState;

export interface ToastOptions {
  kind?: Toast['kind'];
  /** An icon from ui/icons.tsx, shown before the text. */
  icon?: IconComponent;
  /** A button, like "Open" or "View"; clicking it also closes the toast. */
  action?: ToastAction;
  /** How long it stays, in ms (default 3 s, errors 5 s, with an action 6 s). */
  duration?: number;
}

let toastId = 0;
/** A short message in the corner: `toast('Saved')`, `toast('Failed', 'error')`, `toast('New file', { icon, action })`. */
export function toast(text: string, options: Toast['kind'] | ToastOptions = {}): number {
  const { kind = 'info', icon, action, duration } = typeof options === 'string' ? { kind: options } : options;
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind, icon, action }] }));
  setTimeout(() => dismissToast(id), duration ?? (action ? 6000 : kind === 'error' ? 5000 : 3000));
  return id;
}

export function dismissToast(id: number): void {
  setState((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : {}));
}

export function canBuild(): boolean {
  const { office, isOwner } = getState();
  return !!office && (office.settings.buildPolicy === 'everyone' || isOwner);
}

/** Whether this server offers any way to sign in. */
export function canSignIn(s: Pick<State, 'providers'> = getState()): boolean {
  return Object.values(s.providers).some(Boolean);
}

export function setPanel(panel: Panel): void {
  setState((s) => {
    const next = s.panel === panel ? 'none' : panel;
    const building = next === 'build' && canBuild();
    return {
      panel: next,
      mode: building ? 'build' : 'play',
      build: building ? s.build : initialBuild,
    };
  });
}

/** Opens the chat with a direct message to someone in the office (a player id). */
export function messagePlayer(playerId: string): void {
  setState({ panel: 'chat', mode: 'play', chatWith: playerId });
}
