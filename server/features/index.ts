import type { Feature } from '../features';
import { feature as github } from './github';

/**
 * The server's features, registered in this order after the core routes and socket handlers.
 * Each module exports `const feature: Feature = { name, migrations?, register(ctx) }`; add it here:
 *
 *   import { feature as chat } from './chat';
 *   export const features: Feature[] = [chat];
 */
export const features: Feature[] = [github];
