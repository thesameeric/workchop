import type { Feature } from '../features';
import { feature as chat } from './chat';

/**
 * The server's features, registered in this order after the core routes and socket handlers.
 * Each module exports `const feature: Feature = { name, migrations?, register(ctx) }`; import it
 * and add it to the list.
 */
export const features: Feature[] = [chat];
