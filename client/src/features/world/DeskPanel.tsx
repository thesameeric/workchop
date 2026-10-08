import { useEffect, useState } from 'react';
import { deskOf, type DeskNote } from '../../../../shared/world';
import { ago } from '../../lib/time';
import { toast, useStore } from '../../state/store';
import { CheckAllIcon, CheckIcon, DeskIcon, StickyNoteIcon, TrashIcon } from '../../ui/icons';
import { deleteNote, markRead, myNotes, releaseDesk } from './actions';
import { sceneActions, useWorld } from './state';

/** "My desk": the notes people left on your desk, for signed-in people. */
export function DeskPanel() {
  const desk = useStore((s) => (s.account && s.office ? deskOf(s.office, s.account.id) : undefined));
  const version = useWorld((s) => s.notesVersion);
  const unread = useWorld((s) => s.unread);
  const [notes, setNotes] = useState<DeskNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void myNotes().then((res) => {
      if (!live) return;
      if (res.ok) {
        setNotes(res.notes);
        setError(null);
      } else {
        setError(res.error);
      }
    });
    return () => {
      live = false;
    };
  }, [version]);

  const read = async (id: string) => {
    setNotes((list) => list?.map((n) => (id === 'all' || n.id === id ? { ...n, readAt: n.readAt ?? Date.now() } : n)) ?? null);
    await markRead(id);
  };
  const remove = async (id: string) => {
    if (await deleteNote(id)) setNotes((list) => list?.filter((n) => n.id !== id) ?? null);
  };
  const release = async () => {
    if (!desk || !confirm('Give up your desk? Your notes stay here, and you can claim another desk any time.')) return;
    if (await releaseDesk(desk.id)) toast('You gave up your desk');
  };

  return (
    <div className="panel-body desk-panel">
      <div className="desk-summary">
        <span className="desk-summary-icon">
          <DeskIcon size={20} />
        </span>
        {desk ? (
          <>
            <div className="desk-summary-text">
              <strong>Your desk</strong>
              <span className="muted small">{unread ? `${unread} unread note${unread === 1 ? '' : 's'}` : 'All caught up'}</span>
            </div>
            <button className="btn small" onClick={() => sceneActions.sitAtDesk?.(desk.id)} title="Walk to your desk and sit down">
              Go there
            </button>
          </>
        ) : (
          <div className="desk-summary-text">
            <strong>No desk yet</strong>
            <span className="muted small">Click a free desk and choose “Make this my desk”.</span>
          </div>
        )}
      </div>

      {error && <p className="form-error pad">{error}</p>}
      {notes && notes.length > 0 && (
        <div className="desk-notes-head">
          <span className="muted small">
            {notes.length} note{notes.length === 1 ? '' : 's'}
          </span>
          {unread > 0 && (
            <button className="btn small" onClick={() => void read('all')}>
              <CheckAllIcon size={15} /> Mark all as read
            </button>
          )}
        </div>
      )}
      <div className="desk-notes">
        {notes?.length === 0 && (
          <div className="desk-empty">
            <StickyNoteIcon size={28} />
            <p>No notes yet. When someone leaves you one, it shows up here.</p>
          </div>
        )}
        {notes?.map((n) => (
          <article key={n.id} className={`desk-note${n.readAt ? '' : ' unread'}`} style={{ ['--note' as string]: n.color }}>
            <p className="desk-note-text">{n.text}</p>
            <footer>
              <span className="desk-note-by">— {n.authorName}</span>
              {n.byGuest && (
                <span className="desk-note-tag" title="Anyone with the office’s link can leave a note as a guest, under any name">
                  guest
                </span>
              )}
              <time dateTime={new Date(n.createdAt).toISOString()} title={new Date(n.createdAt).toLocaleString()}>
                {ago(n.createdAt)}
              </time>
              {!n.readAt && (
                <button className="note-btn" onClick={() => void read(n.id)} title="Mark as read" aria-label="Mark as read">
                  <CheckIcon size={15} />
                </button>
              )}
              <button className="note-btn" onClick={() => void remove(n.id)} title="Throw away" aria-label="Delete note">
                <TrashIcon size={15} />
              </button>
            </footer>
          </article>
        ))}
      </div>
      {desk && (
        <button className="link-btn desk-release" onClick={() => void release()}>
          Give up this desk
        </button>
      )}
    </div>
  );
}
