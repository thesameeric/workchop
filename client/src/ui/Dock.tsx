import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EMOTES } from '../../../shared/avatar';
import { colorFor, initials } from '../lib/color';
import { media } from '../lib/media';
import { officeUrl } from '../lib/router';
import { getSession, leaveOffice } from '../lib/session';
import { canBuild, setPanel, setState, toast, useStore } from '../state/store';
import { CamIcon, CamOffIcon, HammerIcon, LeaveIcon, LinkIcon, MicIcon, MicOffIcon, ScreenIcon, SettingsIcon, SmileIcon } from './icons';
import { AccountMenu, usePopover } from './Account';
import { useMediaState } from './media';
import { PresenceDockButton } from '../features/presence/DockButton';
import { panelKey, usePanels, type PanelDef } from './panels';

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

/** You: edits your character, or for signed-in people opens the account menu. */
function MeButton() {
  const me = useStore((s) => s.me);
  const account = useStore((s) => s.account);
  const { open, setOpen, close, ref, menuRef, buttonRef } = usePopover();
  const [at, setAt] = useState({ left: 0, bottom: 0 });
  const editCharacter = () => setState({ modal: 'avatar' });
  const toggle = () => {
    // The dock scrolls sideways on phones, which would clip a menu inside it: it goes in a portal.
    const r = ref.current!.getBoundingClientRect();
    setAt({ left: Math.max(8, r.left), bottom: window.innerHeight - r.top + 12 });
    setOpen((v) => !v);
  };
  return (
    <div ref={ref}>
      <button
        className="me-btn"
        ref={buttonRef}
        onClick={() => (account ? toggle() : editCharacter())}
        title={account ? 'Your account' : 'Edit your character'}
        aria-haspopup={account ? 'menu' : undefined}
        aria-expanded={account ? open : undefined}
      >
        <span className="person-avatar small" style={{ background: colorFor(me.name) }}>
          {initials(me.name)}
          <i className={`status-dot ${me.status}`} />
        </span>
        <span className="me-name">{me.name}</span>
      </button>
      {open &&
        account &&
        createPortal(
          <div className="dock-menu" ref={menuRef} style={at}>
            <AccountMenu user={account} onClose={close} onEditCharacter={editCharacter} />
          </div>,
          document.body,
        )}
    </div>
  );
}

function PanelButton({ panel, open }: { panel: PanelDef; open: boolean }) {
  const badge = panel.useBadge?.() ?? null;
  const { icon: Icon } = panel;
  return (
    <button
      className={`dock-btn${panel.hideOnMobile ? ' hide-mobile' : ''}${open ? ' on' : ''}`}
      onClick={() => setPanel(panel.id)}
      title={panel.shortcut ? `${panel.title} (${panel.shortcut})` : panel.title}
    >
      <Icon />
      {badge !== null && badge !== 0 && badge !== '' && <span className={`badge-count${panel.badgeTone === 'neutral' ? ' neutral' : ''}`}>{badge}</span>}
    </button>
  );
}

export function Dock() {
  const m = useMediaState();
  const panel = useStore((s) => s.panel);
  const panels = usePanels();
  const [emotes, setEmotes] = useState(false);
  useStore((s) => s.office?.settings.buildPolicy);
  const buildAllowed = canBuild();

  return (
    <nav className="dock" aria-label="Controls">
      <div className="dock-group">
        <MeButton />
        <PresenceDockButton />
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
        {panels
          .filter((p) => p.dock !== false)
          .map((p) => (
            <PanelButton key={panelKey(p)} panel={p} open={panel === p.id} />
          ))}
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
