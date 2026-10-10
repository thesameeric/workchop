import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Space } from '../../../shared/account';
import { reactionForKey } from '../../../shared/avatar';
import { isCustomer } from '../../../shared/workspace';
import { toggleFocus } from '../features/audio/focus';
import { FocusIndicator } from '../features/audio/Headphones';
import { fetchSpaces } from '../lib/api';
import { colorFor, initials } from '../lib/color';
import { media } from '../lib/media';
import { goHome, navigate } from '../lib/router';
import { closeOffice, getSession, leaveOffice } from '../lib/session';
import { setPanel, setState, useStore } from '../state/store';
import { isTyping } from '../world/input';
import { loadWorldModules } from '../world/extensions';
import { interact } from '../world/movement';
import { menuKeys, usePopover } from './Account';
import { LogoMark } from './Brand';
import { Dock, inviteAction } from './Dock';
import { LoadBoundary } from './LoadBoundary';
import { AddIcon, CheckIcon, ChevronDownIcon, CloseIcon, HelpIcon, HomeIcon, VolumeOffIcon } from './icons';
import { Modals } from './Modals';
import { NowPlayingPill } from './MusicPanel';
import { Overlays } from './overlays';
import { usePanels } from './panels';
import { topBarItemKey, useTopBarItems } from './topbar';
import { SelfView, Spotlight, VideoStrip } from './VideoStrip';
import { WorldLabels, ZoneIndicator } from './WorldLabels';

// Features' 3D modules load with the scene, so it appears complete.
const World = lazy(() => Promise.all([import('../world/World'), loadWorldModules()]).then(([world]) => world));

/** The workspace switcher: your other workspaces, all of them (home), and making a new one. */
function WorkspaceMenu({ onClose }: { onClose: (refocus?: boolean) => void }) {
  const officeId = useStore((s) => s.officeId);
  const invite = inviteAction(useStore((s) => s.role));
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    fetchSpaces().then(
      (list) => alive && setSpaces(list),
      () => alive && setSpaces([]),
    );
    return () => {
      alive = false;
    };
  }, []);
  // The first workspace takes the focus once they're here, for the keyboard.
  useEffect(() => {
    if (spaces) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [spaces]);
  const pick = (run: () => void) => () => {
    onClose();
    run();
  };
  return (
    <div className="account-menu workspace-menu" role="menu" aria-label="Workspaces" ref={ref} onKeyDown={(e) => menuKeys(e, onClose)}>
      <p className="menu-label">Your workspaces</p>
      {spaces === null && <p className="menu-label muted">Loading…</p>}
      {spaces?.map((s) => {
        const name = s.name || 'Untitled office';
        return (
          <button key={s.id} role="menuitem" aria-current={s.id === officeId} onClick={pick(() => s.id !== officeId && navigate(`/o/${s.id}`))}>
            <span className="menu-space-icon" style={{ background: colorFor(name) }} aria-hidden="true">
              {initials(name)}
            </span>
            <span className="menu-text">{name}</span>
            {s.id === officeId && <CheckIcon size={16} />}
          </button>
        );
      })}
      <hr />
      {invite && (
        <button role="menuitem" onClick={pick(invite.run)}>
          <invite.icon size={18} />
          {invite.label}
        </button>
      )}
      <button role="menuitem" onClick={pick(leaveOffice)}>
        <HomeIcon size={18} />
        All workspaces
      </button>
      <button
        role="menuitem"
        onClick={pick(() => {
          closeOffice();
          goHome('/#create');
        })}
      >
        <AddIcon size={18} />
        Create workspace
      </button>
    </div>
  );
}

/** The office's name, your role and who's here; for signed-in people it opens the workspace switcher. */
function OfficeChip() {
  const name = useStore((s) => s.office?.settings.name ?? '');
  const count = useStore((s) => Object.keys(s.players).length + 1);
  // Support customers are all guests: nothing to tell them apart by.
  const badge = useStore((s) => (s.isOwner ? 'owner' : s.role === 'admin' || (s.role === 'guest' && s.kind !== 'support') ? s.role : null));
  const signedIn = useStore((s) => !!s.account);
  const { open, setOpen, close, ref, menuRef, buttonRef } = usePopover();
  const [at, setAt] = useState({ left: 0, top: 0 });
  const toggle = () => {
    // Over the video tiles too: the menu goes in a portal, under the chip.
    const r = ref.current!.getBoundingClientRect();
    setAt({ left: r.left, top: r.bottom + 8 });
    setOpen((v) => !v);
  };
  const title = (
    <>
      <span className="brand-mark">
        <LogoMark size={16} />
      </span>
      <strong>{name}</strong>
    </>
  );
  return (
    <div className="office-chip" ref={ref}>
      {signedIn ? (
        <button className="office-switch" ref={buttonRef} onClick={toggle} aria-haspopup="menu" aria-expanded={open} title="Switch workspace">
          {title}
          <ChevronDownIcon size={14} />
        </button>
      ) : (
        title
      )}
      {badge && <span className="badge">{badge}</span>}
      <span className="online-dot" />
      <span className="muted">{count} online</span>
      {open &&
        createPortal(
          <div className="dock-menu" ref={menuRef} style={at}>
            <WorkspaceMenu onClose={close} />
          </div>,
          document.body,
        )}
    </div>
  );
}

/** The browser blocked people's voices (you came straight in): a click lets them play. */
function AudioBlocked() {
  const blocked = useStore((s) => s.audioBlocked);
  if (!blocked) return null;
  return (
    <button className="audio-blocked" onClick={() => getSession()?.unblockAudio()}>
      <VolumeOffIcon size={16} />
      Audio blocked — click to hear people
    </button>
  );
}

function TopBar() {
  const items = useTopBarItems();
  return (
    <div className="topbar">
      <OfficeChip />
      <AudioBlocked />
      <ZoneIndicator />
      <NowPlayingPill />
      {items.map((item) => (
        <item.Component key={topBarItemKey(item)} />
      ))}
    </div>
  );
}

function SidePanel() {
  const id = useStore((s) => s.panel);
  // Re-render when panels are registered (a feature's may arrive after its id was set).
  const panel = usePanels().find((p) => p.id === id);
  if (!panel) return null;
  return (
    <aside className={`side-panel ${panel.id}`}>
      <div className="panel-head">
        <h2>{panel.title}</h2>
        <button className="icon-btn" onClick={() => setPanel(panel.id)} title="Close">
          <CloseIcon size={18} />
        </button>
      </div>
      <panel.Component />
    </aside>
  );
}

function Hint() {
  const hint = useStore((s) => s.hint);
  const building = useStore((s) => s.mode === 'build');
  if (!hint || building) return null;
  return <div className="hint">{hint}</div>;
}

function Help() {
  const customer = useStore((s) => isCustomer(s.role, s.kind));
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('workchop:help-dismissed') !== '1';
    } catch {
      return true;
    }
  });
  if (!open) {
    return (
      <button className="help-toggle" onClick={() => setOpen(true)} title="Controls">
        <HelpIcon size={18} />
      </button>
    );
  }
  return (
    <div className="help">
      <button
        className="icon-btn"
        onClick={() => {
          setOpen(false);
          try {
            localStorage.setItem('workchop:help-dismissed', '1');
          } catch {
            /* ignore */
          }
        }}
        title="Hide"
      >
        <CloseIcon size={14} />
      </button>
      <div>
        <kbd>W</kbd>
        <kbd>A</kbd>
        <kbd>S</kbd>
        <kbd>D</kbd> / arrows to move, <kbd>Shift</kbd> to run
      </div>
      <div>Click the floor to walk there, click a chair to sit</div>
      {/* Customers look around: lamps and desks aren't theirs to use. */}
      <div>{customer ? 'Click plants, fish tanks and boards to find out more' : 'Click plants, lamps and desks to use them'}</div>
      <div>
        <kbd>E</kbd> sit/stand · <kbd>1</kbd>–<kbd>9</kbd>, <kbd>0</kbd> reactions
      </div>
      <div>
        <kbd>M</kbd> mute · <kbd>V</kbd> camera · <kbd>H</kbd> headphones
      </div>
      <div>Drag to turn the camera, scroll to zoom</div>
      <div className="muted">Walk up to people to talk. Private areas keep conversations inside.</div>
    </div>
  );
}

function ConnectionBanner() {
  const connection = useStore((s) => s.connection);
  const note = useStore((s) => s.connectionNote);
  if (connection === 'online') return null;
  // Calls and everything else come back by themselves once it's back.
  return (
    <div className="connection-banner" role="status">
      {note ? `Reconnecting… ${note}` : 'Connection lost — reconnecting…'}
    </div>
  );
}

/** Global keyboard shortcuts while inside an office. */
function useShortcuts() {
  useEffect(() => {
    // Enter opens the chat, but presses a button reached with the keyboard or in a menu (a clicked
    // button keeps the focus too, and Enter still means chat there).
    let byKey = false;
    let keyFocused: EventTarget | null = null;
    const onPointer = () => (byKey = false);
    const onFocus = (e: FocusEvent) => (keyFocused = byKey ? e.target : null);
    const onKey = (e: KeyboardEvent) => {
      byKey = true;
      if (isTyping() || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const { modal, mode, role, kind } = useStore.getState();
      if (modal !== 'none') return;
      if (e.code === 'KeyE') interact();
      else if (e.code === 'KeyM') void media.setMic(!media.micOn);
      else if (e.code === 'KeyV') void media.setCam(!media.camOn);
      // Support customers don't build.
      else if (e.code === 'KeyB' && !isCustomer(role, kind)) setPanel('build');
      else if (e.code === 'KeyH') toggleFocus();
      else if (e.code === 'Enter') {
        const target = e.target as Element;
        if (target.matches?.('button, a') && (target === keyFocused || target.closest('[role="menu"]'))) return;
        e.preventDefault();
        setState({ panel: 'chat', mode: 'play' });
      } else if (e.code === 'Escape' && mode === 'play') {
        setState((s) => (s.spotlight ? { spotlight: null } : s.panel !== 'none' ? { panel: 'none' } : {}));
      } else {
        const reaction = reactionForKey(e.code);
        if (reaction) getSession()?.emote(reaction.emoji);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('focusin', onFocus);
    };
  }, []);
}

export function OfficeView() {
  useShortcuts();
  return (
    <div className="office">
      <LoadBoundary what="The office">
        <Suspense fallback={<div className="loading">Loading the office…</div>}>
          <World />
        </Suspense>
      </LoadBoundary>
      <WorldLabels />
      <Overlays />
      <TopBar />
      <VideoStrip />
      <SelfView />
      <SidePanel />
      <Hint />
      <FocusIndicator />
      <Help />
      <Dock />
      <Spotlight />
      <Modals />
      <ConnectionBanner />
    </div>
  );
}
