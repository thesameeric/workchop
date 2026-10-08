import { clip } from './text';
import type { AvatarConfig, FacialHair, GlassesStyle, HairStyle, HatStyle, PlayerPatch, ProfilePatch, Status, TopStyle } from './types';

export const HAIR_STYLES: HairStyle[] = ['none', 'short', 'long', 'bun', 'ponytail', 'mohawk', 'curly', 'spiky'];
export const TOP_STYLES: TopStyle[] = ['tshirt', 'hoodie', 'suit', 'dress'];
export const HAT_STYLES: HatStyle[] = ['none', 'cap', 'beanie', 'tophat', 'crown', 'headphones'];
export const GLASSES_STYLES: GlassesStyle[] = ['none', 'round', 'shades'];
export const FACIAL_HAIR: FacialHair[] = ['none', 'beard', 'mustache'];
export const STATUSES: Status[] = ['available', 'busy', 'away'];

export const SKIN_TONES = ['#ffe0c7', '#f6c9a3', '#e8b48f', '#d19a6a', '#b07a4f', '#8d5a3b', '#6b4029', '#4a2c1d'];
export const HAIR_COLORS = ['#1c1410', '#3b2417', '#6b4423', '#a86b32', '#d9a55b', '#e8d18f', '#b9b9b9', '#c0392b', '#e86fae', '#5b6cff', '#2fbf8f'];
export const CLOTHING_COLORS = [
  '#f2f2f2', '#2b2d42', '#4361ee', '#4cc9f0', '#2a9d8f', '#8ac926', '#ffca3a', '#ff924c',
  '#ef476f', '#9b5de5', '#6d4c41', '#7f8c8d', '#111111', '#e9c46a',
];

export interface Reaction {
  emoji: string;
  name: string;
  /** The number key that sends it ('1'…'9', '0'). */
  key: string;
}

/** Reactions everyone sees above your head (some also animate your character). */
export const REACTIONS: readonly Reaction[] = [
  { emoji: '👋', name: 'Wave', key: '1' },
  { emoji: '❤️', name: 'Hearts', key: '2' },
  { emoji: '😂', name: 'Laugh', key: '3' },
  { emoji: '👍', name: 'Thumbs up', key: '4' },
  { emoji: '🎉', name: 'Confetti', key: '5' },
  { emoji: '✋', name: 'Raise hand', key: '6' },
  { emoji: '💃', name: 'Dance', key: '7' },
  { emoji: '👏', name: 'Clap', key: '8' },
  { emoji: '🔥', name: 'Fire', key: '9' },
  { emoji: '🙌', name: 'Hooray', key: '0' },
];

export const EMOTES: readonly string[] = REACTIONS.map((r) => r.emoji);

export function isEmote(v: unknown): v is string {
  return typeof v === 'string' && EMOTES.includes(v);
}

/** The reaction a number key sends (`key` is KeyboardEvent.key or .code, e.g. '7' or 'Digit7'). */
export function reactionForKey(key: string): Reaction | undefined {
  const digit = /^(?:Digit|Numpad)?([0-9])$/.exec(key)?.[1];
  return digit === undefined ? undefined : REACTIONS.find((r) => r.key === digit);
}

export const DEFAULT_AVATAR: AvatarConfig = {
  skin: SKIN_TONES[1],
  hair: 'short',
  hairColor: HAIR_COLORS[1],
  top: 'hoodie',
  topColor: '#4361ee',
  bottomColor: '#2b2d42',
  shoeColor: '#f2f2f2',
  hat: 'none',
  hatColor: '#ef476f',
  glasses: 'none',
  facialHair: 'none',
};

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

function pick<T>(list: readonly T[], rand: () => number): T {
  return list[Math.floor(rand() * list.length)];
}

export function randomAvatar(rand: () => number = Math.random): AvatarConfig {
  return {
    skin: pick(SKIN_TONES, rand),
    hair: pick(HAIR_STYLES, rand),
    hairColor: pick(HAIR_COLORS, rand),
    top: pick(TOP_STYLES, rand),
    topColor: pick(CLOTHING_COLORS, rand),
    bottomColor: pick(CLOTHING_COLORS, rand),
    shoeColor: pick(CLOTHING_COLORS, rand),
    hat: rand() < 0.6 ? 'none' : pick(HAT_STYLES, rand),
    hatColor: pick(CLOTHING_COLORS, rand),
    glasses: rand() < 0.6 ? 'none' : pick(GLASSES_STYLES, rand),
    facialHair: rand() < 0.7 ? 'none' : pick(FACIAL_HAIR, rand),
  };
}

function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

function color(v: unknown, fallback: string): string {
  return isHexColor(v) ? v.toLowerCase() : fallback;
}

/** Coerce untrusted input into a valid avatar, falling back to defaults field by field. */
export function sanitizeAvatar(raw: unknown): AvatarConfig {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_AVATAR;
  return {
    skin: color(a.skin, d.skin),
    hair: oneOf(a.hair, HAIR_STYLES, d.hair),
    hairColor: color(a.hairColor, d.hairColor),
    top: oneOf(a.top, TOP_STYLES, d.top),
    topColor: color(a.topColor, d.topColor),
    bottomColor: color(a.bottomColor, d.bottomColor),
    shoeColor: color(a.shoeColor, d.shoeColor),
    hat: oneOf(a.hat, HAT_STYLES, d.hat),
    hatColor: color(a.hatColor, d.hatColor),
    glasses: oneOf(a.glasses, GLASSES_STYLES, d.glasses),
    facialHair: oneOf(a.facialHair, FACIAL_HAIR, d.facialHair),
  };
}

export function sanitizeStatus(v: unknown): Status {
  return oneOf(v, STATUSES, 'available');
}

export function sanitizeName(v: unknown, max = 32): string {
  if (typeof v !== 'string') return '';
  // Strip control characters and collapse whitespace.
  return clip(v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim(), max);
}

/** The part of a 'profile' message a client may change, cleaned; `name` falls back to `currentName`. */
export function sanitizeProfile(raw: unknown, currentName: string): PlayerPatch {
  const patch = (raw && typeof raw === 'object' ? raw : {}) as Record<keyof ProfilePatch, unknown>;
  const clean: PlayerPatch = {};
  if ('name' in patch) clean.name = sanitizeName(patch.name) || currentName;
  if ('avatar' in patch) clean.avatar = sanitizeAvatar(patch.avatar);
  if ('status' in patch) clean.status = sanitizeStatus(patch.status);
  for (const key of ['mic', 'cam', 'screen', 'focus'] as const) if (key in patch) clean[key] = patch[key] === true;
  // Anything else (like `app`, which only the server sets) is ignored.
  return clean;
}
