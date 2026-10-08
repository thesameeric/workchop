import type { Feature } from '../features';
import { feature as audio } from './audio';
import { feature as chat } from './chat';
import { feature as coins } from './coins';
import { feature as github } from './github';
import { feature as presence } from './presence';
import { feature as weather } from './weather';

/**
 * The server's features, registered in this order after the core routes and socket handlers.
 * Each module exports `const feature: Feature = { name, migrations?, register(ctx) }`; import it
 * and add it to the list.
 */
export const features: Feature[] = [chat, audio, presence, coins, weather, github];
