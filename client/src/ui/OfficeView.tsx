import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { reactionForKey } from '../../../shared/avatar';
import { toggleFocus } from '../lib/focus';
import { media } from '../lib/media';
import { getSession } from '../lib/session';
import { setPanel, setState, useStore } from '../state/store';
import { isTyping } from '../world/input';
import { toggleSit } from '../world/movement';
import { Dock, copyInvite } from './Dock';
import { FocusIndicator } from './Focus';
import { CloseIcon, HelpIcon, LinkIcon } from './icons';
import { Modals } from './Modals';
import { NowPlayingPill } from './MusicPanel';
import { usePanels } from './panels';
import { SelfView, Spotlight, VideoStrip } from './VideoStrip';
import { WorldLabels, ZoneIndicator } from './WorldLabels';

const World = lazy(() => import('../world/World'));

function TopBar() {
  const name = useStore((s) => s.office?.settings.name ?? '');
  const count = useStore((s) => Object.keys(s.players).length + 1);
  const isOwner = useStore((s) => s.isOwner);
  const ref = useRef<HTMLDivElement>(null);
  // Toasts sit under the top bar, however tall it gets (private area, headphones, music…).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty('--topbar-bottom', `${Math.round(el.getBoundingClientRect().bottom)}px`);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => {
      observer.disconnect();
      root.style.removeProperty('--topbar-bottom');
    };
  }, []);
  return (
    <div className="topbar" ref={ref}>
      <div className="office-chip">
        <span className="brand-mark">◆</span>
        <strong>{name}</strong>
        {isOwner && <span className="badge">owner</span>}
        <span className="online-dot" />
        <span className="muted">{count} online</span>
        <button className="icon-btn" onClick={copyInvite} title="Copy invite link">
          <LinkIcon size={16} />
        </button>
      </div>
      <ZoneIndicator />
      <FocusIndicator />
      <NowPlayingPill />
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
  if (connection === 'online') return null;
  return <div className="connection-banner">Connection lost — reconnecting…</div>;
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
      const { modal, mode } = useStore.getState();
      if (modal !== 'none') return;
      if (e.code === 'KeyE') toggleSit();
      else if (e.code === 'KeyM') void media.setMic(!media.micOn);
      else if (e.code === 'KeyV') void media.setCam(!media.camOn);
      else if (e.code === 'KeyB') setPanel('build');
      else if (e.code === 'KeyH') toggleFocus();
      else if (e.code === 'Enter') {
        const target = e.target as Element;
        if (target.matches?.('button, a') && (target === keyFocused || target.closest('[role="menu"]'))) return;
        e.preventDefault();
        setState({ panel: 'chat', unread: 0, mode: 'play' });
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
      <Suspense fallback={<div className="loading">Loading the office…</div>}>
        <World />
      </Suspense>
      <WorldLabels />
      <TopBar />
      <VideoStrip />
      <SelfView />
      <SidePanel />
      <Hint />
      <Help />
      <Dock />
      <Spotlight />
      <Modals />
      <ConnectionBanner />
    </div>
  );
}
