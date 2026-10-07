import { useEffect, useRef, useState } from 'react';
import { EMOTES } from '../../../shared/avatar';
import { colorFor, initials } from '../lib/color';
import { media } from '../lib/media';
import { officeUrl } from '../lib/router';
import { getSession, leaveOffice } from '../lib/session';
import { canBuild, setPanel, setState, toast, useStore } from '../state/store';
import {
  CamIcon,
  CamOffIcon,
  ChatIcon,
  HammerIcon,
  LeaveIcon,
  LinkIcon,
  MicIcon,
  MicOffIcon,
  MusicIcon,
  PeopleIcon,
  ScreenIcon,
  SettingsIcon,
  SmileIcon,
} from './icons';
import { useMediaState } from './media';

export async function copyInvite(): Promise<void> {
  const id = useStore.getState().officeId;
  if (!id) return;
  try {
    await navigator.clipboard.writeText(officeUrl(id));
    toast('Invite link copied');
  } catch {
    prompt('Copy this invite link:', officeUrl(id));
  }
}

export function toggleScreen(): void {
  if (media.screenOn) media.stopScreen();
  else void media.startScreen();
}

function EmoteMenu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [onClose]);
  return (
    <div className="emote-menu" ref={ref}>
      {EMOTES.map((e, i) => (
        <button
          key={e}
          title={`Press ${i + 1}`}
          onClick={() => {
            getSession()?.emote(e);
            onClose();
          }}
        >
          {e}
          <kbd>{i + 1}</kbd>
        </button>
      ))}
    </div>
  );
}

export function Dock() {
  const m = useMediaState();
  const me = useStore((s) => s.me);
  const panel = useStore((s) => s.panel);
  const unread = useStore((s) => s.unread);
  const count = useStore((s) => Object.keys(s.players).length + 1);
  const [emotes, setEmotes] = useState(false);
  useStore((s) => s.office?.settings.buildPolicy);
  const buildAllowed = canBuild();

  return (
    <nav className="dock" aria-label="Controls">
      <div className="dock-group">
        <button className="me-btn" onClick={() => setState({ modal: 'avatar' })} title="Edit your character">
          <span className="person-avatar small" style={{ background: colorFor(me.name) }}>
            {initials(me.name)}
            <i className={`status-dot ${me.status}`} />
          </span>
          <span className="me-name">{me.name}</span>
        </button>
      </div>
      <div className="dock-group center">
        <button className={`dock-btn${m.mic ? '' : ' off'}`} onClick={() => media.setMic(!m.mic)} title={m.mic ? 'Mute (M)' : 'Unmute (M)'}>
          {m.mic ? <MicIcon /> : <MicOffIcon />}
        </button>
        <button className={`dock-btn${m.cam ? '' : ' off'}`} onClick={() => media.setCam(!m.cam)} title={m.cam ? 'Stop camera (V)' : 'Start camera (V)'}>
          {m.cam ? <CamIcon /> : <CamOffIcon />}
        </button>
        <button className={`dock-btn${m.screen ? ' on' : ''}`} onClick={toggleScreen} title={m.screen ? 'Stop sharing' : 'Share your screen'}>
          <ScreenIcon />
        </button>
        <div className="emote-wrap">
          <button className={`dock-btn${emotes ? ' on' : ''}`} onClick={() => setEmotes((v) => !v)} title="Reactions (1–6)">
            <SmileIcon />
          </button>
          {emotes && <EmoteMenu onClose={() => setEmotes(false)} />}
        </div>
        <button
          className={`dock-btn${panel === 'build' ? ' on' : ''}`}
          onClick={() => setPanel('build')}
          title={buildAllowed ? 'Build mode (B)' : 'Only the owner can edit this office'}
        >
          <HammerIcon />
        </button>
      </div>
      <div className="dock-group">
        <button className={`dock-btn${panel === 'chat' ? ' on' : ''}`} onClick={() => setPanel('chat')} title="Chat (Enter)">
          <ChatIcon />
          {unread > 0 && <span className="badge-count">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <button className={`dock-btn hide-mobile${panel === 'music' ? ' on' : ''}`} onClick={() => setPanel('music')} title="Music">
          <MusicIcon />
        </button>
        <button className={`dock-btn${panel === 'people' ? ' on' : ''}`} onClick={() => setPanel('people')} title="People">
          <PeopleIcon />
          <span className="badge-count neutral">{count}</span>
        </button>
        <button className="dock-btn hide-mobile" onClick={copyInvite} title="Copy invite link">
          <LinkIcon />
        </button>
        <button className="dock-btn" onClick={() => setState({ modal: 'settings' })} title="Settings">
          <SettingsIcon />
        </button>
        <button className="dock-btn danger" onClick={() => leaveOffice()} title="Leave office">
          <LeaveIcon />
        </button>
      </div>
    </nav>
  );
}
