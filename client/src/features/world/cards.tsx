import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { DIFFICULTY_LABEL, plantSpecies, type PlantSpecies } from '../../../../shared/plants';
import type { OfficeItem } from '../../../../shared/types';
import {
  deskOf,
  deskOwner,
  MAX_BOARD_TEXT,
  MAX_BOARD_TITLE,
  MAX_NOTE_LENGTH,
  NOTE_COLORS,
  sanitizeBoardData,
  type BoardData,
  type DeskNote,
} from '../../../../shared/world';
import { may } from '../../../../shared/workspace';
import { colorFor, initials } from '../../lib/color';
import { backToLobby } from '../../lib/session';
import { ago } from '../../lib/time';
import { finePointer } from '../../lib/touch';
import { canBuild, canSignIn, setPanel, toast, useStore } from '../../state/store';
import {
  CloseIcon,
  DeskIcon,
  DropletIcon,
  EditIcon,
  FishIcon,
  GaugeIcon,
  HelpIcon,
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
import { claimDesk, deleteNote, leaveNote, notesILeft, releaseDesk, writeBoard } from './actions';
import { FISH } from './fish';
import { cardAnchor, openCard, useWorld } from './state';

const close = () => openCard(null);

/** The card next to a clicked plant, desk, info board or fish tank (a sheet at the bottom on phones). */
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
  const label = species ? species.name : card.kind === 'board' ? 'Info board' : card.kind === 'aquarium' ? 'Fish tank' : 'Desk';
  return (
    <div
      ref={ref}
      key={item.id}
      className={`world-card ${card.kind}-card`}
      role="dialog"
      aria-label={label}
      // Hidden until the scene has placed it next to its item.
      style={{ visibility: 'hidden' }}
    >
      {species ? (
        <PlantCard species={species} />
      ) : card.kind === 'board' ? (
        <BoardCard board={item} />
      ) : card.kind === 'aquarium' ? (
        <AquariumCard />
      ) : (
        <DeskCard desk={item} />
      )}
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

/** What an info board says; owners and admins can change it. */
function BoardCard({ board }: { board: OfficeItem }) {
  const data = sanitizeBoardData(board.data);
  // Like the server (world:board): the owner and admins.
  const mayWrite = useStore((s) => s.isOwner || s.role === 'admin');
  const [editing, setEditing] = useState(false);
  if (editing) return <BoardForm board={board} data={data} onDone={() => setEditing(false)} />;
  return (
    <>
      <CardHead icon={<HelpIcon size={20} />} title={data?.title || 'Info board'} />
      {data?.text ? <p className="wc-text board-text">{data.text}</p> : <p className="wc-text board-empty">Nothing on this board yet.</p>}
      <div className="wc-actions">
        {mayWrite && (
          <button className="btn small" onClick={() => setEditing(true)}>
            <EditIcon size={15} /> Edit
          </button>
        )}
        <button className="btn small" onClick={close}>
          Close
        </button>
      </div>
    </>
  );
}

function BoardForm({ board, data, onDone }: { board: OfficeItem; data: BoardData | undefined; onDone: () => void }) {
  const [title, setTitle] = useState(data?.title ?? '');
  const [text, setText] = useState(data?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await writeBoard(board.id, { title, text });
    setBusy(false);
    if (res.ok) onDone();
    else setError(res.error);
  };
  return (
    <>
      <CardHead icon={<EditIcon size={20} />} title="Edit board" subtitle="Everyone here sees it" />
      <form className="board-form" onSubmit={save}>
        <input value={title} maxLength={MAX_BOARD_TITLE} placeholder="Title" aria-label="Title" autoFocus={finePointer()} onChange={(e) => setTitle(e.target.value)} />
        <textarea value={text} maxLength={MAX_BOARD_TEXT} rows={7} placeholder="What it says" aria-label="Text" onChange={(e) => setText(e.target.value)} />
        <div className="note-form-row">
          <span className={`note-count${text.length > MAX_BOARD_TEXT - 50 ? ' near' : ''}`}>{MAX_BOARD_TEXT - text.length}</span>
          <button type="button" className="btn small" onClick={onDone}>
            Cancel
          </button>
          <button className="btn small primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
    </>
  );
}

function AquariumCard() {
  return (
    <>
      <CardHead icon={<FishIcon size={20} />} title="Fish tank" subtitle="Fish from South America" />
      <ul className="fish-list">
        {FISH.map((f) => (
          <li key={f.name}>
            <i className="fish-dot" style={{ background: f.color }} />
            <div>
              <b>{f.name}</b> <i className="fish-latin">{f.scientific}</i>
              <span className="fish-origin">{f.origin}</span>
              <span>{f.fact}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="wc-actions">
        <button className="btn small" onClick={close}>
          Close
        </button>
      </div>
    </>
  );
}

function DeskCard({ desk }: { desk: OfficeItem }) {
  const owner = deskOwner(desk);
  if (!owner) return <FreeDesk desk={desk} />;
  return <ClaimedDesk desk={desk} ownerId={owner.ownerUserId} ownerName={owner.ownerName} />;
}

/** A desk nobody has: members can make it theirs. */
function FreeDesk({ desk }: { desk: OfficeItem }) {
  const member = useStore((s) => may(s.role, 'see-members'));
  const signedIn = useStore((s) => !!s.account);
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
      {member ? (
        <>
          <p className="wc-text">Make it yours: your name goes on it, and people can leave you notes here.</p>
          <div className="wc-actions">
            <button className="btn small primary" onClick={claim} disabled={busy}>
              <DeskIcon size={15} /> {mine ? 'Move my desk here' : 'Make this my desk'}
            </button>
          </div>
        </>
      ) : signInOffered && !signedIn ? (
        <>
          <p className="wc-text">Sign in to claim a desk: your name goes on it, and people can leave you notes.</p>
          <div className="wc-actions">
            <button className="btn small" onClick={backToLobby} title="Takes you to the lobby to sign in; you'll come back here after">
              <SignInIcon size={15} /> Sign in
            </button>
          </div>
        </>
      ) : (
        <p className="wc-text">Desks are for members of this workspace. You can still leave notes on claimed desks.</p>
      )}
    </>
  );
}

function ClaimedDesk({ desk, ownerId, ownerName }: { desk: OfficeItem; ownerId: string; ownerName: string }) {
  const isMine = useStore((s) => s.account?.id === ownerId);
  const count = useWorld((s) => s.stickies[ownerId]?.count ?? 0);
  const mayEdit = useStore(canBuild);
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
