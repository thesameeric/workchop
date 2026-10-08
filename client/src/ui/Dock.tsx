import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { appInfo } from '../../../shared/apps';
import { REACTIONS } from '../../../shared/avatar';
import { HeadphonesButton } from '../features/audio/Headphones';
import { toggleFocus } from '../features/audio/focus';
import { PresenceDockButton, PresenceIcon, PresenceMenu } from '../features/presence/DockButton';
import { usePresence } from '../features/presence/state';
import { colorFor, initials } from '../lib/color';
import { media } from '../lib/media';
import { officeUrl } from '../lib/router';
import { getSession, leaveOffice } from '../lib/session';
import { canBuild, setPanel, setState, toast, useStore } from '../state/store';
import {
  CamIcon,
  CamOffIcon,
  HammerIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  LeaveIcon,
  LinkIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  ScreenIcon,
  SettingsIcon,
  SmileIcon,
} from './icons';
import { AccountMenu, menuKeys, usePopover } from './Account';
import { useMediaState } from './media';
import { panelKey, usePanels, type PanelDef } from './panels';

const NARROW = '(max-width: 720px)';

function onNarrowChange(fn: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', fn);
  return () => query.removeEventListener('change', fn);
}

/** Phone-sized screens: the dock keeps the main buttons and puts the rest in its More menu. */
function useNarrow(): boolean {
  return useSyncExternalStore(onNarrowChange, () => window.matchMedia(NARROW).matches);
}

/** Most phone browsers can't share the screen. */
const canShareScreen = !!navigator.mediaDevices?.getDisplayMedia;

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

/** The reactions, above the dock (in a portal: the dock scrolls sideways on phones and would clip it). */
function EmoteMenu({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at] = useState(() => {
    const r = anchor.getBoundingClientRect();
    // Centred over the button, but kept on screen (the menu is about 250 px wide).
    const half = 130;
    return { left: Math.max(half, Math.min(window.innerWidth - half, r.left + r.width / 2)), bottom: window.innerHeight - r.top + 12 };
  });
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    // Escape closes only the menu (first, so it doesn't also close the side panel or spotlight).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
      anchor.focus();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey, true);
    ref.current?.querySelector('button')?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div className="emote-menu" ref={ref} role="menu" aria-label="Reactions" style={{ left: at.left, bottom: at.bottom }}>
      {REACTIONS.map((r) => (
        <button
          key={r.emoji}
          role="menuitem"
          title={`${r.name} (${r.key})`}
          aria-label={`${r.name} (${r.key})`}
          onClick={() => {
            getSession()?.emote(r.emoji);
            onClose();
          }}
        >
          {r.emoji}
          <kbd>{r.key}</kbd>
        </button>
      ))}
    </div>,
    document.body,
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

/** Something to look at (not a plain count like the people here). */
function isAlert(panel: PanelDef, badge: number | string | null): badge is number | string {
  return badge !== null && badge !== 0 && badge !== '' && panel.badgeTone !== 'neutral';
}

/** On narrow screens the dock scrolls sideways: a button that gets an alert out of sight scrolls into view. */
function useAlertInView(ref: RefObject<HTMLElement | null>, alert: boolean): void {
  useEffect(() => {
    const dock = ref.current?.closest<HTMLElement>('.dock');
    if (!alert || !ref.current || !dock) return;
    const button = ref.current.getBoundingClientRect();
    const visible = dock.getBoundingClientRect();
    // With room for the badge, which sticks out past the corner.
    const past = button.right + 8 - visible.right;
    const before = button.left - 8 - visible.left;
    if (past > 0) dock.scrollBy({ left: past, behavior: 'smooth' });
    else if (before < 0) dock.scrollBy({ left: before, behavior: 'smooth' });
  }, [ref, alert]);
}

function PanelButton({ panel, open }: { panel: PanelDef; open: boolean }) {
  const badge = panel.useBadge?.() ?? null;
  const shown = badge !== null && badge !== 0 && badge !== '';
  const ref = useRef<HTMLButtonElement>(null);
  useAlertInView(ref, isAlert(panel, badge));
  const { icon: Icon } = panel;
  return (
    <button
      ref={ref}
      className={`dock-btn${panel.hideOnMobile ? ' hide-mobile' : ''}${open ? ' on' : ''}`}
      onClick={() => setPanel(panel.id)}
      title={panel.shortcut ? `${panel.title} (${panel.shortcut})` : panel.title}
      // Otherwise screen readers would name it by its badge alone ("3").
      aria-label={shown ? `${panel.title}, ${badge}` : panel.title}
    >
      <Icon />
      {shown && <span className={`badge-count${panel.badgeTone === 'neutral' ? ' neutral' : ''}`}>{badge}</span>}
    </button>
  );
}

/** A panel in the More menu, with its badge (e.g. My desk's unread notes). */
function PanelItem({ panel, onPick }: { panel: PanelDef; onPick: () => void }) {
  const badge = panel.useBadge?.() ?? null;
  const { icon: Icon } = panel;
  return (
    <button
      role="menuitem"
      onClick={() => {
        onPick();
        setPanel(panel.id);
      }}
    >
      <Icon size={18} />
      {panel.title}
      {badge !== null && badge !== 0 && badge !== '' && <span className={`more-badge${isAlert(panel, badge) ? ' alert' : ''}`}>{badge}</span>}
    </button>
  );
}

/** Reports a panel's alert badge to the More button (hooks can't run in a loop over a changing list). */
function AlertProbe({ panel, report }: { panel: PanelDef; report: (title: string, badge: number | string | null) => void }) {
  const badge = panel.useBadge?.() ?? null;
  const alert = isAlert(panel, badge) ? badge : null;
  useEffect(() => {
    report(panel.title, alert);
    return () => report(panel.title, null);
  }, [panel.title, alert, report]);
  return null;
}

/** The More button's badge for the alerts of the panels in its menu: one as it is, several added up. */
function combineAlerts(badges: (number | string)[]): number | string | null {
  if (badges.length <= 1) return badges[0] ?? null;
  const counts = badges.map((b) => (typeof b === 'number' ? b : parseInt(b, 10)));
  if (counts.some(Number.isNaN)) return '!';
  const total = counts.reduce((a, b) => a + b, 0);
  return total > 9 || badges.some((b) => typeof b === 'string') ? `${Math.min(total, 9)}+` : total;
}

/** On narrow screens: the dock's other buttons, in a menu above it ("Working in…" opens in its place). */
function MoreButton({ panels }: { panels: PanelDef[] }) {
  const { open, setOpen, close, ref, menuRef, buttonRef } = usePopover();
  const [at, setAt] = useState({ right: 0, bottom: 0 });
  const [picking, setPicking] = useState(false);
  const focus = useStore((s) => s.focus);
  const screen = useMediaState().screen;
  const app = usePresence((s) => s.self?.app ?? null);
  // Alerts in the menu (say, GitHub's) show on the button, so they aren't missed.
  const [alerts, setAlerts] = useState<Record<string, number | string>>({});
  const report = useCallback((title: string, badge: number | string | null) => {
    setAlerts((all) => {
      if (badge === null ? !(title in all) : all[title] === badge) return all;
      const next = { ...all };
      if (badge === null) delete next[title];
      else next[title] = badge;
      return next;
    });
  }, []);
  const alert = combineAlerts(Object.values(alerts));
  useAlertInView(buttonRef, alert !== null);
  const toggle = () => {
    const r = ref.current!.getBoundingClientRect();
    setAt({ right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 12 });
    setPicking(false);
    setOpen((v) => !v);
  };
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && !picking) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, picking]);
  /** Closes the menu, then does `run`. */
  const pick = (run: () => void) => () => {
    close();
    run();
  };
  return (
    <div ref={ref}>
      {panels.map((p) => (
        <AlertProbe key={panelKey(p)} panel={p} report={report} />
      ))}
      <button
        ref={buttonRef}
        className={`dock-btn${open ? ' on' : ''}`}
        onClick={toggle}
        title="More"
        aria-label={alert !== null ? `More, ${Object.entries(alerts).map(([title, badge]) => `${title} ${badge}`).join(', ')}` : 'More'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreIcon />
        {alert !== null && <span className="badge-count">{alert}</span>}
      </button>
      {open &&
        createPortal(
          // The picker is wider: against the screen's edge.
          <div className="dock-menu" ref={menuRef} style={picking ? { ...at, right: 8 } : at}>
            {picking ? (
              <PresenceMenu onPicked={() => close(true)} />
            ) : (
              <div className="account-menu more-menu" role="menu" aria-label="More" ref={menu} onKeyDown={(e) => menuKeys(e, close)}>
                <button role="menuitem" onClick={pick(toggleFocus)}>
                  {focus ? <HeadphonesOffIcon size={18} /> : <HeadphonesIcon size={18} />}
                  {focus ? 'Take headphones off' : 'Put on headphones'}
                </button>
                <button role="menuitem" onClick={() => setPicking(true)}>
                  <PresenceIcon app={app} size={18} />
                  {app ? `Working in ${appInfo(app).label}` : 'Working in…'}
                </button>
                {panels.map((p) => (
                  <PanelItem key={panelKey(p)} panel={p} onPick={close} />
                ))}
                {canShareScreen && (
                  <button role="menuitem" onClick={pick(toggleScreen)}>
                    <ScreenIcon size={18} />
                    {screen ? 'Stop sharing' : 'Share your screen'}
                  </button>
                )}
                <button role="menuitem" onClick={pick(() => setPanel('build'))}>
                  <HammerIcon size={18} />
                  {canBuild() ? 'Build mode' : 'Build mode (owner only)'}
                </button>
                <button role="menuitem" onClick={pick(() => void copyInvite())}>
                  <LinkIcon size={18} />
                  Copy invite link
                </button>
                <button role="menuitem" onClick={pick(() => setState({ modal: 'settings' }))}>
                  <SettingsIcon size={18} />
                  Settings
                </button>
                <button role="menuitem" className="danger" onClick={pick(() => leaveOffice())}>
                  <LeaveIcon size={18} />
                  Leave office
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function Dock() {
  const m = useMediaState();
  const panel = useStore((s) => s.panel);
  const panels = usePanels().filter((p) => p.dock !== false);
  const narrow = useNarrow();
  // The reactions button while its menu is open.
  const [emoteAnchor, setEmoteAnchor] = useState<HTMLElement | null>(null);
  const closeEmotes = useCallback(() => setEmoteAnchor(null), []);
  useStore((s) => s.office?.settings.buildPolicy);
  const buildAllowed = canBuild();

  return (
    <nav className="dock" aria-label="Controls">
      <div className="dock-group">
        <MeButton />
        {!narrow && <PresenceDockButton />}
      </div>
      <div className="dock-group center">
        <button className={`dock-btn${m.mic ? '' : ' off'}`} onClick={() => media.setMic(!m.mic)} title={m.mic ? 'Mute (M)' : 'Unmute (M)'}>
          {m.mic ? <MicIcon /> : <MicOffIcon />}
        </button>
        <button className={`dock-btn${m.cam ? '' : ' off'}`} onClick={() => media.setCam(!m.cam)} title={m.cam ? 'Stop camera (V)' : 'Start camera (V)'}>
          {m.cam ? <CamIcon /> : <CamOffIcon />}
        </button>
        {!narrow && (
          <>
            <button className={`dock-btn${m.screen ? ' on' : ''}`} onClick={toggleScreen} title={m.screen ? 'Stop sharing' : 'Share your screen'}>
              <ScreenIcon />
            </button>
            <HeadphonesButton />
          </>
        )}
        <button
          className={`dock-btn${emoteAnchor ? ' on' : ''}`}
          onClick={(e) => {
            const button = e.currentTarget;
            setEmoteAnchor((open) => (open ? null : button));
          }}
          title="Reactions (1–9, 0)"
          aria-haspopup="menu"
          aria-expanded={!!emoteAnchor}
        >
          <SmileIcon />
        </button>
        {emoteAnchor && <EmoteMenu anchor={emoteAnchor} onClose={closeEmotes} />}
        {!narrow && (
          <button
            className={`dock-btn${panel === 'build' ? ' on' : ''}`}
            onClick={() => setPanel('build')}
            title={buildAllowed ? 'Build mode (B)' : 'Only the owner can edit this office'}
          >
            <HammerIcon />
          </button>
        )}
      </div>
      {narrow ? (
        <div className="dock-group">
          {panels
            .filter((p) => !p.inMore && !p.hideOnMobile)
            .map((p) => (
              <PanelButton key={panelKey(p)} panel={p} open={panel === p.id} />
            ))}
          <MoreButton panels={panels.filter((p) => p.inMore && !p.hideOnMobile)} />
        </div>
      ) : (
        <div className="dock-group">
          {panels.map((p) => (
            <PanelButton key={panelKey(p)} panel={p} open={panel === p.id} />
          ))}
          <button className="dock-btn hide-narrow" onClick={copyInvite} title="Copy invite link">
            <LinkIcon />
          </button>
          <button className="dock-btn" onClick={() => setState({ modal: 'settings' })} title="Settings">
            <SettingsIcon />
          </button>
          <button className="dock-btn danger" onClick={() => leaveOffice()} title="Leave office">
            <LeaveIcon />
          </button>
        </div>
      )}
    </nav>
  );
}
