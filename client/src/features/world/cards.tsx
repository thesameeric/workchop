import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { DIFFICULTY_LABEL, plantSpecies, type PlantSpecies } from '../../../../shared/plants';
import type { OfficeItem } from '../../../../shared/types';
import { deskOf, deskOwner, MAX_NOTE_LENGTH, NOTE_COLORS, type DeskNote } from '../../../../shared/world';
import { colorFor, initials } from '../../lib/color';
import { leaveOffice } from '../../lib/session';
import { ago } from '../../lib/time';
import { canSignIn, setPanel, setState, toast, useStore } from '../../state/store';
import {
  CloseIcon,
  DeskIcon,
  DropletIcon,
  GaugeIcon,
  HumidityIcon,
  LeafIcon,
  PawIcon,
  PinIcon,
  PlantIcon,
  SignInIcon,
  SparklesIcon,
  StickyNoteIcon,
  SunIcon,
  TrashIcon,
} from '../../ui/icons';
import { claimDesk, deleteNote, leaveNote, notesILeft, releaseDesk } from './actions';
import { cardAnchor, openCard, useWorld } from './state';

const close = () => openCard(null);

/** The card next to a clicked plant or desk (a sheet at the bottom on phones). */
export function WorldCard() {
  const card = useWorld((s) => s.card);
  const item = useStore((s) => (card ? s.office?.items.find((i) => i.id === card.itemId) : undefined));
  const ref = useCallback((el: HTMLDivElement | null) => {
    cardAnchor.el = el;
  }, []);

  // Esc closes the card first (before it closes a side panel).
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [card]);

  if (!card || !item) return null;
  const species = card.kind === 'plant' ? plantSpecies(item.type) : undefined;
  return (
    <div
      ref={ref}
      key={item.id}
      className={`world-card ${card.kind}-card`}
      role="dialog"
      aria-label={species ? species.name : 'Desk'}
      // Hidden until the scene has placed it next to its item.
      style={{ visibility: 'hidden' }}
    >
      {species ? <PlantCard species={species} /> : <DeskCard desk={item} />}
    </div>
  );
}

function CardHead({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle?: ReactNode }) {
  return (
    <header className="wc-head">
      <span className="wc-icon">{icon}</span>
      <div className="wc-title">
        <h3>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <button className="icon-btn" onClick={close} title="Close (Esc)" aria-label="Close">
        <CloseIcon size={16} />
      </button>
    </header>
  );
}

const LIGHT_LEVEL: Record<PlantSpecies['lightLevel'], number> = { low: 1, medium: 2, bright: 3, sun: 4 };

function PlantCard({ species: p }: { species: PlantSpecies }) {
  return (
    <>
      <CardHead icon={<PlantIcon size={20} />} title={p.name} subtitle={<i>{p.scientific}</i>} />
      <p className="wc-origin">
        <PinIcon size={14} /> {p.origin}
      </p>
      <div className="care-grid">
        <div className="care" title="Light">
          <SunIcon size={18} className="care-icon sun" />
          <div>
            <span className="care-label">
              Light <Meter value={LIGHT_LEVEL[p.lightLevel]} />
            </span>
            {p.light}
          </div>
        </div>
        <div className="care" title="Water">
          <DropletIcon size={18} className="care-icon water" />
          <div>
            <span className="care-label">Water</span>
            {p.water}
          </div>
        </div>
        <div className="care" title="Humidity">
          <HumidityIcon size={18} className="care-icon humidity" />
          <div>
            <span className="care-label">Humidity</span>
            {p.humidity}
          </div>
        </div>
        <div className="care" title="Difficulty">
          <GaugeIcon size={18} className="care-icon gauge" />
          <div>
            <span className="care-label">Care</span>
            {DIFFICULTY_LABEL[p.difficulty]}
          </div>
        </div>
      </div>
      <p className={`wc-pets ${p.petSafe ? 'safe' : 'toxic'}`}>
        <PawIcon size={16} />
        <span>
          <b>{p.petSafe ? 'Pet-friendly' : 'Not for pets'}</b> {p.pets}
        </span>
      </p>
      <p className="wc-fact">
        <SparklesIcon size={16} />
        <span>{p.fact}</span>
      </p>
      <p className="wc-air">
        <LeafIcon size={14} /> {p.air}
      </p>
      <div className="wc-actions">
        <button className="btn small" onClick={close}>
          Close
        </button>
      </div>
    </>
  );
}

/** Four dots, filled up to `value`. */
function Meter({ value }: { value: number }) {
  return (
    <span className="meter" aria-label={`${value} of 4`}>
      {[1, 2, 3, 4].map((n) => (
        <i key={n} className={n <= value ? 'on' : ''} />
      ))}
    </span>
  );
}

function DeskCard({ desk }: { desk: OfficeItem }) {
  const owner = deskOwner(desk);
  const account = useStore((s) => s.account);
  if (!owner) return <FreeDesk desk={desk} signedIn={!!account} />;
  return <ClaimedDesk desk={desk} ownerId={owner.ownerUserId} ownerName={owner.ownerName} />;
}

function FreeDesk({ desk, signedIn }: { desk: OfficeItem; signedIn: boolean }) {
  const mine = useStore((s) => (s.account && s.office ? deskOf(s.office, s.account.id) : undefined));
  const signInOffered = useStore(canSignIn);
  const [busy, setBusy] = useState(false);
  const claim = async () => {
    setBusy(true);
    if (await claimDesk(desk.id)) {
      toast(mine ? 'Moved to your new desk' : 'This is your desk now', { icon: DeskIcon });
      close();
    }
    setBusy(false);
  };
  return (
    <>
      <CardHead icon={<DeskIcon size={20} />} title="Free desk" subtitle="Nobody has claimed it yet" />
      {signedIn ? (
        <>
          <p className="wc-text">Make it yours: your name goes on it, and people can leave you notes here.</p>
          <div className="wc-actions">
            <button className="btn small primary" onClick={claim} disabled={busy}>
              <DeskIcon size={15} /> {mine ? 'Move my desk here' : 'Make this my desk'}
            </button>
          </div>
        </>
      ) : signInOffered ? (
        <>
          <p className="wc-text">Sign in to claim a desk: your name goes on it, and people can leave you notes.</p>
          <div className="wc-actions">
            <button
              className="btn small"
              onClick={() => {
                const { officeId } = useStore.getState();
                leaveOffice();
                setState({ phase: 'lobby', officeId });
              }}
              title="Takes you to the lobby to sign in; you'll come back here after"
            >
              <SignInIcon size={15} /> Sign in
            </button>
          </div>
        </>
      ) : (
        <p className="wc-text">Desks are for signed-in members. You can still leave notes on claimed desks.</p>
      )}
    </>
  );
}

function ClaimedDesk({ desk, ownerId, ownerName }: { desk: OfficeItem; ownerId: string; ownerName: string }) {
  const isMine = useStore((s) => s.account?.id === ownerId);
  const count = useWorld((s) => s.stickies[ownerId]?.count ?? 0);
  const mayEdit = useStore((s) => !!s.office && (s.office.settings.buildPolicy === 'everyone' || s.isOwner));
  const [releasing, setReleasing] = useState(false);
  const release = async () => {
    if (!isMine && !confirm(`Free ${ownerName}’s desk? Their notes stay with them.`)) return;
    setReleasing(true);
    if (await releaseDesk(desk.id)) {
      toast(isMine ? 'You gave up your desk' : `${ownerName}’s desk is free now`);
      close();
    }
    setReleasing(false);
  };
  const subtitle = count ? `${count} note${count === 1 ? '' : 's'} on it` : 'No notes yet';
  return (
    <>
      <CardHead
        icon={
          <span className="wc-avatar" style={{ background: colorFor(ownerName) }}>
            {initials(ownerName)}
          </span>
        }
        title={isMine ? 'Your desk' : `${ownerName}’s desk`}
        subtitle={subtitle}
      />
      {isMine ? (
        <div className="wc-actions">
          <button
            className="btn small primary"
            onClick={() => {
              close();
              if (useStore.getState().panel !== 'desk') setPanel('desk');
            }}
          >
            <StickyNoteIcon size={15} /> Read my notes
          </button>
          <button className="btn small" onClick={release} disabled={releasing}>
            Give up desk
          </button>
        </div>
      ) : (
        <>
          <NoteForm desk={desk} ownerId={ownerId} ownerName={ownerName} />
          {mayEdit && (
            <button className="link-btn wc-release" onClick={release} disabled={releasing}>
              Free this desk
            </button>
          )}
        </>
      )}
    </>
  );
}

function NoteForm({ desk, ownerId, ownerName }: { desk: OfficeItem; ownerId: string; ownerName: string }) {
  const [text, setText] = useState('');
  const [color, setColor] = useState(NOTE_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<DeskNote[] | null>(null);

  const load = useCallback(async () => {
    const res = await notesILeft(ownerId);
    if (res.ok) setMine(res.notes);
  }, [ownerId]);
  useEffect(() => {
    void load();
  }, [load]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await leaveNote(desk.id, text, color);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setText('');
    toast(`Note left on ${ownerName}’s desk`, { icon: StickyNoteIcon });
    setMine((list) => [res.note, ...(list ?? [])]);
  };

  const remove = async (id: string) => {
    if (await deleteNote(id)) setMine((list) => list?.filter((n) => n.id !== id) ?? null);
  };

  return (
    <>
      <form className="note-form" onSubmit={send}>
        <textarea
          value={text}
          maxLength={MAX_NOTE_LENGTH}
          rows={3}
          placeholder={`Leave ${ownerName} a note…`}
          aria-label={`Note for ${ownerName}`}
          style={{ background: color }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e);
          }}
        />
        <div className="note-form-row">
          <div className="note-colors" role="radiogroup" aria-label="Note colour">
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === color}
                aria-label={`Colour ${NOTE_COLORS.indexOf(c) + 1}`}
                className={`note-color${c === color ? ' active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <span className={`note-count${text.length > MAX_NOTE_LENGTH - 50 ? ' near' : ''}`}>{MAX_NOTE_LENGTH - text.length}</span>
          <button className="btn small primary" disabled={!text.trim() || busy}>
            {busy ? 'Leaving…' : 'Leave note'}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
      {!!mine?.length && (
        <div className="my-notes">
          <h4>Your notes here</h4>
          <ul>
            {mine.map((n) => (
              <li key={n.id}>
                <i className="note-dot" style={{ background: n.color }} />
                <span className="my-note-text">{n.text}</span>
                <span className="muted small">{ago(n.createdAt)}</span>
                <button className="icon-btn" title="Take this note back" aria-label="Delete note" onClick={() => void remove(n.id)}>
                  <TrashIcon size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
