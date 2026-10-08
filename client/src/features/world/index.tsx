import { PLANTS } from '../../../../shared/plants';
import type { OfficeItem } from '../../../../shared/types';
import { deskOwner, isLightOn, isLightSwitch, LAMP_TYPES, SWITCH_TYPE, type DeskNote, type StickySummary } from '../../../../shared/world';
import { may } from '../../../../shared/workspace';
import { onSession } from '../../lib/session';
import { dismissToast, getState, setPanel, toast, useStore } from '../../state/store';
import { StickyNoteIcon } from '../../ui/icons';
import { registerOverlay } from '../../ui/overlays';
import { registerPanel, type PanelDef } from '../../ui/panels';
import { registerItemInteraction, registerNearbyAction, registerWorldModule } from '../../world/extensions';
import { areaLit, toggleLight } from './actions';
import { WorldCard } from './cards';
import { DeskPanel } from './DeskPanel';
import { initialWorld, openCard, toggleCard, useWorld } from './state';
import './world.css';

// World micro-interactions: desk monitors that wake up when someone sits down, lamps and light
// switches, plants that tell you what they are, desks people claim and the notes left on them.
// The 3D parts (./scene) load with the scene; this file only wires up the rest.

registerWorldModule(() => import('./scene'));
registerOverlay({ id: 'world-card', order: 10, Component: WorldCard });

const hover = (item: OfficeItem, on: boolean) =>
  useWorld.setState((s) => (on ? { hovered: item.id } : s.hovered === item.id ? { hovered: null } : {}));

const openNotes = () => {
  openCard(null);
  if (getState().panel !== 'desk') setPanel('desk');
};

registerItemInteraction(
  PLANTS.map((p) => p.type),
  { onClick: (item) => toggleCard('plant', item), onHover: hover },
);
registerItemInteraction([...LAMP_TYPES, SWITCH_TYPE], { onClick: toggleLight, onHover: hover });
registerItemInteraction(['desk'], {
  onClick: (item) => {
    const account = getState().account;
    // Your own desk: straight to your notes.
    if (account && deskOwner(item)?.ownerUserId === account.id) openNotes();
    else toggleCard('desk', item);
  },
  onHover: hover,
});

const touchOnly = window.matchMedia('(hover: none) and (pointer: coarse)');

// E near a light switch (or a floor lamp) switches it.
registerNearbyAction('world-lights', (office, x, z) => {
  let best: { item: OfficeItem; d: number } | null = null;
  for (const item of office.items) {
    const isSwitch = isLightSwitch(item);
    if (!isSwitch && item.type !== 'floor-lamp') continue;
    const d = Math.hypot(item.x - x, item.z - z);
    if (d < (isSwitch ? 1.5 : 1.1) && (!best || d < best.d)) best = { item, d };
  }
  if (!best) return null;
  const { item } = best;
  const on = isLightSwitch(item) ? areaLit(item) : isLightOn(item);
  const what = isLightSwitch(item) ? 'the lights' : 'the lamp';
  const how = touchOnly.matches ? `Tap the ${isLightSwitch(item) ? 'switch' : 'lamp'}` : 'Press E or click';
  return { distance: best.d, hint: `${how} to turn ${what} ${on ? 'off' : 'on'}`, run: () => toggleLight(item) };
});

// "My desk" in the dock, for members (guests can't have a desk).
const deskPanel: PanelDef = {
  id: 'desk',
  title: 'My desk',
  icon: StickyNoteIcon,
  Component: DeskPanel,
  order: 40,
  inMore: true,
  useBadge: () => {
    const unread = useWorld((s) => s.unread);
    return unread > 9 ? '9+' : unread;
  },
};
let removePanel: (() => void) | null = null;
const syncPanel = () => {
  const member = may(getState().role, 'see-members');
  if (member && !removePanel) removePanel = registerPanel(deskPanel);
  else if (!member && removePanel) {
    removePanel();
    removePanel = null;
  }
};
syncPanel();
useStore.subscribe(syncPanel);

// On phones the card is a sheet where side panels open: opening a panel closes it, and the other way round.
const narrow = window.matchMedia('(max-width: 720px)');
useStore.subscribe((s, prev) => {
  if (s.panel !== prev.panel && s.panel !== 'none' && narrow.matches) openCard(null);
});
useWorld.subscribe((s, prev) => {
  const { panel } = getState();
  if (s.card && !prev.card && narrow.matches && panel !== 'none') setPanel(panel);
});

onSession('world', (session) => {
  const { socket } = session;
  // Say how many notes are waiting once, when you come in (not after reconnecting).
  let welcome = false;
  const offJoined = session.onJoined((rejoin) => {
    if (!rejoin) welcome = true;
  });

  const onStickies = (stickies: Record<string, StickySummary>, replace: boolean) =>
    useWorld.setState((s) => {
      const next = replace ? {} : { ...s.stickies };
      for (const [owner, summary] of Object.entries(stickies)) {
        if (summary.count) next[owner] = summary;
        else delete next[owner];
      }
      return { stickies: next };
    });
  const onInbox = (officeId: string, unread: number) => {
    if (officeId !== session.officeId) return;
    useWorld.setState((s) => ({ unread, notesVersion: s.notesVersion + 1 }));
    if (!welcome) return;
    welcome = false;
    if (unread > 0) toast(`${unread} new note${unread === 1 ? '' : 's'} on your desk`, { icon: StickyNoteIcon, action: { label: 'Read', run: openNotes } });
  };
  // Notes arriving close together share one toast.
  let last: { id: number; officeId: string; count: number; at: number } | null = null;
  const onNote = (note: DeskNote, officeId: string, officeName: string) => {
    const here = officeId === session.officeId;
    const grouped = last && last.officeId === officeId && Date.now() - last.at < 6000 ? last : null;
    if (grouped) dismissToast(grouped.id);
    const count = (grouped?.count ?? 0) + 1;
    const what = count > 1 ? `${count} new notes on your desk` : `${note.authorName}${note.byGuest ? ' (guest)' : ''} left a note on your desk`;
    const text = here ? what : `${what} in ${officeName || 'another office'}`;
    const id = toast(text, here ? { icon: StickyNoteIcon, action: { label: 'Read', run: openNotes } } : { icon: StickyNoteIcon });
    last = { id, officeId, count, at: Date.now() };
  };

  socket.on('desk:stickies', onStickies);
  socket.on('desk:inbox', onInbox);
  socket.on('desk:note:new', onNote);
  return () => {
    socket.off('desk:stickies', onStickies);
    socket.off('desk:inbox', onInbox);
    socket.off('desk:note:new', onNote);
    offJoined();
    useWorld.setState(initialWorld);
  };
});
