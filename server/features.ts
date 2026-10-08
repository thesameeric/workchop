import type express from 'express';
import type { AccountUser } from '../shared/account';
import type { Db } from './db';
import type { Migration } from './db/migrations';
import type { OfficeStore } from './officeStore';
import type { IO, RealtimeApi } from './realtime';
import type { Uploads } from './uploads';

export type { Migration } from './db/migrations';
export type { RealtimeApi, SocketContext, SocketUser } from './realtime';

/** What a feature gets to hook into. */
export interface ServerContext {
  /** Routes under /api (express.json already applied), checked before the API's 404. */
  app: express.Router;
  io: IO;
  db: Db;
  store: OfficeStore;
  auth: {
    /** The signed-in user making the request, or null for guests. */
    userFromRequest(req: express.Request): Promise<AccountUser | null>;
    /** Middleware: 401 for guests; otherwise the user is in `res.locals.user`. */
    requireUser: express.RequestHandler;
  };
  realtime: RealtimeApi;
  uploads: Uploads;
  /** The address people open Workchop at (PUBLIC_URL's origin), when known. */
  publicOrigin: string | null;
}

/**
 * A server feature (one module in server/features/). Its socket events are declared in
 * shared/<feature>.ts by augmenting the event maps:
 *
 *   declare module './types' {
 *     interface ClientToServerEvents { 'thing:do': (id: string) => void }
 *     interface ServerToClientEvents { 'thing:done': (id: string) => void }
 *   }
 */
export interface Feature {
  name: string;
  /** Its tables; ids are global, so take the next free one from 100 up. */
  migrations?: Migration[];
  register(ctx: ServerContext): void | Promise<void>;
}

export async function registerFeatures(features: Feature[], ctx: ServerContext): Promise<void> {
  for (const feature of features) {
    try {
      await feature.register(ctx);
    } catch (err) {
      throw new Error(`Feature "${feature.name}" failed to start: ${(err as Error).message}`, { cause: err });
    }
  }
}
