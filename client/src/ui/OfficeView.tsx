import { lazy, Suspense, useEffect, useState } from 'react';
import { EMOTES } from '../../../shared/avatar';
import { media } from '../lib/media';
import { getSession } from '../lib/session';
import { setPanel, setState, useStore } from '../state/store';
import { isTyping } from '../world/input';
import { toggleSit } from '../world/movement';
import { Dock, copyInvite } from './Dock';
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
  return (
    <div className="topbar">
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
        <kbd>E</kbd> sit/stand · <kbd>1</kbd>–<kbd>6</kbd> reactions · <kbd>M</kbd> mute · <kbd>V</kbd> camera
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
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const { modal, mode } = useStore.getState();
      if (modal !== 'none') return;
      if (e.code === 'KeyE') toggleSit();
      else if (e.code === 'KeyM') void media.setMic(!media.micOn);
      else if (e.code === 'KeyV') void media.setCam(!media.camOn);
      else if (e.code === 'KeyB') setPanel('build');
      else if (e.code === 'Enter') {
        e.preventDefault();
        setState({ panel: 'chat', unread: 0, mode: 'play' });
      } else if (e.code === 'Escape' && mode === 'play') {
        setState((s) => (s.spotlight ? { spotlight: null } : s.panel !== 'none' ? { panel: 'none' } : {}));
      } else if (/^Digit[1-6]$/.test(e.code)) {
        getSession()?.emote(EMOTES[Number(e.code.slice(5)) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
