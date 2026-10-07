import { create } from 'zustand';
import type { SpotifySession } from '../../../shared/music';
import type { AvatarConfig, ChatMessage, ChatScope, Office, PlayerState, Status } from '../../../shared/types';
import { loadProfile } from '../lib/storage';

export type Phase = 'landing' | 'lobby' | 'office';
export type Panel = 'none' | 'chat' | 'people' | 'build' | 'music';
export type BuildTool = 'select' | 'place' | 'zone';
export type Modal = 'none' | 'avatar' | 'devices';

export type RemotePlayer = Omit<PlayerState, 'x' | 'z' | 'ry' | 'anim'>;

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
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

export interface ChatTarget {
  scope: ChatScope;
  to?: string;
}

interface State {
  phase: Phase;
  officeId: string | null;
  connection: 'online' | 'reconnecting';

  selfId: string | null;
  isOwner: boolean;
  office: Office | null;
  players: Record<string, RemotePlayer>;

  me: { name: string; avatar: AvatarConfig; status: Status };
  media: { mic: boolean; cam: boolean; screen: boolean; version: number; error: string | null };

  /** People we currently have a call link with. */
  linked: Record<string, true>;
  streams: Record<string, MediaStream>;
  speaking: Record<string, boolean>;

  chat: ChatMessage[];
  unread: number;
  chatTarget: ChatTarget;

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

export const initialBuild: State['build'] = { tool: 'select', placeType: null, rot: 0, selectedId: null, selectedZoneId: null };

export const useStore = create<State>()(() => ({
  phase: 'landing',
  officeId: null,
  connection: 'online',
  selfId: null,
  isOwner: false,
  office: null,
  players: {},
  me: { name: profile.name, avatar: profile.avatar, status: 'available' },
  media: { mic: false, cam: false, screen: false, version: 0, error: null },
  linked: {},
  streams: {},
  speaking: {},
  chat: [],
  unread: 0,
  chatTarget: { scope: 'all' },
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

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 5000 : 3000);
}

export function canBuild(): boolean {
  const { office, isOwner } = getState();
  return !!office && (office.settings.buildPolicy === 'everyone' || isOwner);
}

export function setPanel(panel: Panel): void {
  setState((s) => {
    const next = s.panel === panel ? 'none' : panel;
    const building = next === 'build' && canBuild();
    return {
      panel: next,
      unread: next === 'chat' ? 0 : s.unread,
      mode: building ? 'build' : 'play',
      build: building ? s.build : initialBuild,
    };
  });
}
