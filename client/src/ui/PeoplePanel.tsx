import { useEffect, useState } from 'react';
import { STATUSES } from '../../../shared/avatar';
import type { Status } from '../../../shared/types';
import { setFocus, tapShoulder } from '../features/audio/focus';
import { FocusBadge } from '../features/audio/Headphones';
import { colorFor, initials } from '../lib/color';
import { local, remoteTargets } from '../lib/positions';
import { getSession } from '../lib/session';
import { messagePlayer, useStore } from '../state/store';
import { PlayerApp } from '../features/presence/AppChip';
import { CamIcon, ChatIcon, MicOffIcon, PinIcon, ScreenIcon, TapIcon } from './icons';

const STATUS_LABEL: Record<Status, string> = { available: 'Available', busy: 'Do not disturb', away: 'Away' };

/** Distances change constantly; refresh them a couple of times per second. */
function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function PeoplePanel() {
  const players = useStore((s) => s.players);
  const linked = useStore((s) => s.linked);
  const me = useStore((s) => s.me);
  const mic = useStore((s) => s.media.mic);
  const focus = useStore((s) => s.focus);
  useTick(500);

  const others = Object.values(players)
    .map((p) => {
      const t = remoteTargets.get(p.id);
      return { ...p, dist: t ? Math.hypot(t.x - local.x, t.z - local.z) : Infinity };
    })
    .sort((a, b) => a.dist - b.dist);

  return (
    <div className="panel-body people">
      <div className="person self">
        <span className="person-avatar" style={{ background: colorFor(me.name) }}>
          {initials(me.name)}
          <i className={`status-dot ${me.status}`} />
        </span>
        <div className="person-info">
          <strong>{me.name} (you)</strong>
          <PlayerApp self />
          <select value={me.status} onChange={(e) => getSession()?.updateProfile({ status: e.target.value as Status })} aria-label="Status">
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        {focus && <FocusBadge size={16} />}
        {!mic && <MicOffIcon size={16} className="muted" />}
      </div>
      {me.status === 'busy' && <p className="muted small pad">Do not disturb: you won’t connect with anyone outside private areas.</p>}
      {focus && (
        <p className="muted small pad">
          Headphones on: you can’t hear anyone, but they can still hear you.{' '}
          <button className="link-btn" onClick={() => setFocus(false)}>
            Take them off
          </button>
        </p>
      )}
      {others.length === 0 && <p className="muted center pad">You’re the only one here. Share the invite link!</p>}
      {others.map((p) => (
        <div key={p.id} className="person">
          <span className="person-avatar" style={{ background: colorFor(p.name) }}>
            {initials(p.name)}
            <i className={`status-dot ${p.status}`} />
          </span>
          <div className="person-info">
            <strong>{p.name}</strong>
            <PlayerApp id={p.id} />
            <span className="muted small">
              {p.focus ? 'Wearing headphones' : linked[p.id] ? <span className="badge">In conversation</span> : STATUS_LABEL[p.status]}
              {Number.isFinite(p.dist) && ` · ${p.dist.toFixed(0)} m`}
            </span>
          </div>
          <div className="person-icons">
            {p.focus && <FocusBadge size={14} />}
            {!p.mic && <MicOffIcon size={14} />}
            {p.cam && !p.screen && <CamIcon size={14} />}
            {p.screen && <ScreenIcon size={14} />}
          </div>
          <div className="person-actions">
            {p.focus && (
              <button className="icon-btn" title={`Tap ${p.name} on the shoulder`} onClick={() => void tapShoulder(p.id)}>
                <TapIcon size={16} />
              </button>
            )}
            <button className="icon-btn" title={`Go to ${p.name}`} onClick={() => getSession()?.goTo(p.id)}>
              <PinIcon size={16} />
            </button>
            <button
              className="icon-btn"
              title={`Message ${p.name}`}
              onClick={() => messagePlayer(p.id)}
            >
              <ChatIcon size={16} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
