import type { TapResult } from '../../../../shared/audio';
import { media } from '../../lib/media';
import { local, remoteTargets } from '../../lib/positions';
import { getSession } from '../../lib/session';
import { getState, setState, toast } from '../../state/store';
import { TapIcon } from '../../ui/icons';

// Noise-cancelling headphones (focus mode): you stop hearing people and music, and everyone sees
// you're focusing. Your mic stays as it is. They come off when you leave the office.

export function setFocus(on: boolean): void {
  if (getState().focus === on || !getSession()) return;
  setState({ focus: on });
  getSession()?.updateProfile({ focus: on });
}

export function toggleFocus(): void {
  setFocus(!getState().focus);
}

/** Gently knock on the shoulder of someone wearing headphones (they get a toast and a soft sound). */
export async function tapShoulder(id: string): Promise<void> {
  const session = getSession();
  const name = getState().players[id]?.name ?? 'them';
  if (!session) return;
  try {
    const res: TapResult = await session.socket.timeout(5000).emitWithAck('focus:tap', id);
    if (res.ok) toast(`You tapped ${name} on the shoulder`, { icon: TapIcon });
    else toast(res.error, 'error');
  } catch {
    toast('Couldn’t reach the server. Please try again.', 'error');
  }
}

const HINT_RANGE = 3;

/** "Sam is wearing headphones…", when you walk up to someone wearing them. */
export function focusHint(): string | null {
  let nearest: { name: string; d: number } | null = null;
  for (const p of Object.values(getState().players)) {
    const t = p.focus ? remoteTargets.get(p.id) : undefined;
    if (!t) continue;
    const d = Math.hypot(t.x - local.x, t.z - local.z);
    if (d < HINT_RANGE && (!nearest || d < nearest.d)) nearest = { name: p.name, d };
  }
  const touch = window.matchMedia?.('(pointer: coarse)').matches;
  return nearest && `${nearest.name} is wearing headphones · ${touch ? 'touch' : 'click'} them to tap their shoulder`;
}

/** Two soft knocks, made with Web Audio (no file to load). They get through headphones: that's the point. */
export function playKnock(): void {
  try {
    const ctx = new AudioContext();
    const withSink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (media.audioOutputId && withSink.setSinkId) void withSink.setSinkId(media.audioOutputId).catch(() => {});
    const start = ctx.currentTime + 0.03;
    for (const at of [start, start + 0.17]) {
      const osc = new OscillatorNode(ctx, { type: 'triangle', frequency: 260 });
      const gain = new GainNode(ctx, { gain: 0.0001 });
      osc.frequency.setValueAtTime(260, at);
      osc.frequency.exponentialRampToValueAtTime(120, at + 0.12);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.3, at + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.2);
    }
    setTimeout(() => void ctx.close().catch(() => {}), 1000);
  } catch {
    // No sound; the toast is enough.
  }
}

/** Taken off when you leave (headphones are remembered only while you're in the office). */
export function resetFocus(): void {
  if (getState().focus) setState({ focus: false });
}
