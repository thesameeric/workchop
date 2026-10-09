import type { Feature } from '../features';
import { feature as audio } from './audio';
import { feature as chat } from './chat';
import { feature as coins } from './coins';
import { feature as github } from './github';
import { feature as presence } from './presence';
import { feature as support } from './support';
import { feature as weather } from './weather';
import { feature as world } from './world';

/**
 * The server's features, registered in this order after the core routes and socket handlers.
 * Each module exports `const feature: Feature = { name, migrations?, register(ctx) }`; import it
 * and add it to the list.
 *
 * Coins are off until they're redesigned (see "Coins (off for now)" in the README): only COINS=on
 * adds them, for development. Off, they have no tables, routes, socket handlers or timers.
 */
export function serverFeatures(env: NodeJS.ProcessEnv = process.env): Feature[] {
  return [chat, world, audio, presence, support, ...(coinsOn(env) ? [coins] : []), weather, github];
}

/** The features left out by a setting (their tables stay in a database that had them on). */
export function dormantFeatures(env: NodeJS.ProcessEnv = process.env): Feature[] {
  return coinsOn(env) ? [] : [coins];
}

const coinsOn = (env: NodeJS.ProcessEnv) => env.COINS?.trim().toLowerCase() === 'on';
