import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioDiagnostics } from '../client/src/lib/audioDiagnostics';

afterEach(() => vi.useRealTimers());

describe('local audio timing breadcrumbs', () => {
  it('keeps a bounded history with elapsed timings and anonymous peer labels', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const log = new AudioDiagnostics();
    log.record('transport_prepared', 'socket-secret');
    vi.advanceTimersByTime(150);
    log.record('conversation_enabled', 'socket-secret');
    expect(log.snapshot()).toEqual([
      { atMs: 0, stage: 'transport_prepared', peer: 'peer-1' },
      { atMs: 150, stage: 'conversation_enabled', peer: 'peer-1' },
    ]);
    for (let i = 0; i < 250; i++) log.record('transport_closed', `s${i}`);
    expect(log.snapshot()).toHaveLength(200);
    expect(JSON.stringify(log.snapshot())).not.toContain('socket-secret');
    const copy = log.snapshot();
    copy[0].atMs = -1;
    expect(log.snapshot()[0].atMs).toBeGreaterThanOrEqual(0);
  });
});
