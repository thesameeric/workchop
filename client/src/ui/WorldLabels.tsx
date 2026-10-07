import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Status, Zone } from '../../../shared/types';
import { useAnchor } from '../lib/anchors';
import { local, rendered } from '../lib/positions';
import { useStore } from '../state/store';
import { LockIcon, MicOffIcon } from './icons';

const TAG_Y = 2.12;
const SIT_DROP = 0.22;

function playerPoint(id: string, self: boolean, offset: number) {
  if (self) return { x: local.x, y: TAG_Y + offset - (local.anim === 'sit' ? SIT_DROP : 0), z: local.z };
  const r = rendered.get(id);
  return r ? { x: r.x, y: TAG_Y + offset - (r.sit ? SIT_DROP : 0), z: r.z } : null;
}

const PlayerLabel = memo(function PlayerLabel({
  id,
  self,
  name,
  status,
  mic,
}: {
  id: string;
  self: boolean;
  name: string;
  status: Status;
  mic: boolean;
}) {
  const speaking = useStore((s) => !!s.speaking[self ? 'self' : id]);
  const emote = useStore((s) => s.emotes[id]);
  const tagRef = useAnchor(`tag:${id}`, () => playerPoint(id, self, 0));
  const emoteRef = useAnchor(`emote:${id}`, () => playerPoint(id, self, 0.5));
  return (
    <>
      <div ref={tagRef} className="world-label">
        <div className={`nametag${speaking ? ' speaking' : ''}${self ? ' self' : ''}`}>
          <span className={`status-dot ${status}`} />
          <span className="nametag-name">{name}</span>
          {!mic && (
            <span className="nametag-muted">
              <MicOffIcon size={12} />
            </span>
          )}
        </div>
      </div>
      {emote && (
        <div ref={emoteRef} className="world-label top">
          <div className="emote-bubble" key={emote.at}>
            {emote.emoji}
          </div>
        </div>
      )}
    </>
  );
});

function RemoteLabel({ id }: { id: string }) {
  const p = useStore((s) => s.players[id]);
  if (!p) return null;
  return <PlayerLabel id={id} self={false} name={p.name} status={p.status} mic={p.mic} />;
}

function ZoneLabel({ zone, active }: { zone: Zone; active: boolean }) {
  const ref = useAnchor(`zone:${zone.id}`, () => ({ x: zone.x + zone.w / 2, y: 0.05, z: zone.z + 0.35 }));
  return (
    <div ref={ref} className="world-label under">
      <div className={`zone-label${active ? ' active' : ''}`} style={{ ['--zone' as string]: zone.color }}>
        <LockIcon size={12} /> {zone.name}
      </div>
    </div>
  );
}

/** Name tags, reactions and area names, pinned to the 3D world by the canvas projector. */
export function WorldLabels() {
  const ids = useStore(useShallow((s) => Object.keys(s.players)));
  const selfId = useStore((s) => s.selfId) ?? 'self';
  const me = useStore((s) => s.me);
  const mic = useStore((s) => s.media.mic);
  const zones = useStore((s) => s.office?.zones ?? []);
  const activeZoneId = useStore((s) => s.activeZoneId);
  return (
    <div className="world-labels" aria-hidden="true">
      {zones.map((z) => (
        <ZoneLabel key={z.id} zone={z} active={z.id === activeZoneId} />
      ))}
      {ids.map((id) => (
        <RemoteLabel key={id} id={id} />
      ))}
      <PlayerLabel id={selfId} self name={me.name} status={me.status} mic={mic} />
    </div>
  );
}

/** Shows which private area you're in, if any. */
export function ZoneIndicator() {
  const zone = useStore((s) => s.office?.zones.find((z) => z.id === s.activeZoneId));
  if (!zone) return null;
  return (
    <div className="zone-indicator" style={{ ['--zone' as string]: zone.color }}>
      <LockIcon size={15} />
      <strong>{zone.name}</strong>
      <span>Only people in this area can hear you</span>
    </div>
  );
}
