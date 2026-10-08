// Headphones (focus mode): people wearing them can be tapped on the shoulder. Focus itself is
// PlayerState.focus, set with a 'profile' message.

export type TapResult = { ok: true } | { ok: false; error: string };

/** How often one person may tap the same person on the shoulder. */
export const TAP_INTERVAL_MS = 30_000;

declare module './types' {
  interface ClientToServerEvents {
    /** Tap someone who is wearing headphones on the shoulder (a gentle knock). */
    'focus:tap': (to: string, ack: (res: TapResult) => void) => void;
  }
  interface ServerToClientEvents {
    /** Someone tapped you on the shoulder. */
    'focus:tapped': (from: string, name: string) => void;
  }
}
