/** Local, bounded timing breadcrumbs. Never stores SDP, addresses, credentials or media. */
export type AudioStage = 'config_requested' | 'config_ready' | 'session_joined' | 'microphone' | 'camera' | 'playback_prepared' | 'transport_prepared' | 'conversation_enabled' |
  'conversation_paused' | 'transport_closed' | 'remote_track' | 'playback_started' | 'playback_blocked' | 'playback_retry' | 'session_disconnected';

type Detail = string | number | boolean;
export class AudioDiagnostics {
  private readonly started = performance.now();
  private readonly events: { atMs: number; stage: AudioStage; peer?: string; detail?: Detail }[] = [];
  private readonly aliases = new Map<string, string>();
  private nextPeer = 1;

  record(stage: AudioStage, id?: string, detail?: Detail): void {
    let peer: string | undefined;
    if (id) {
      peer = this.aliases.get(id);
      if (!peer) {
        // Bound identifiers as well as events during long visits with many people coming and going.
        if (this.aliases.size >= 128) this.aliases.delete(this.aliases.keys().next().value!);
        this.aliases.set(id, peer = `peer-${this.nextPeer++}`);
      }
    }
    this.events.push({ atMs: Math.round(performance.now() - this.started), stage, ...(peer ? { peer } : {}), ...(detail !== undefined ? { detail } : {}) });
    if (this.events.length > 200) this.events.shift();
  }

  snapshot() {
    return this.events.map((event) => ({ ...event }));
  }
}
