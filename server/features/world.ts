import crypto from 'node:crypto';
import type { Office, OfficeItem } from '../../shared/types';
import {
  claimDesk,
  deskOwner,
  GUEST_KEY,
  MAX_NOTES_PER_DESK,
  mayDeleteNote,
  releaseDesk,
  renameDeskOwner,
  sanitizeNoteColor,
  sanitizeNoteText,
  setLight,
  VISIBLE_STICKIES,
  whyNoNote,
  type DeskNote,
  type NoteActor,
  type StickySummary,
  type WorldChange,
  type WorldResult,
} from '../../shared/world';
import type { Feature, SocketContext } from '../features';
import { randomId } from '../officeStore';

// World micro-interactions: lamps and light switches anyone can flip, desks signed-in people claim,
// and the notes others leave on them. Lights and claims are item data (saved with the office);
// notes live in their own table, and only the desk's owner (and each note's author) gets their text.

interface NoteRow {
  id: string;
  owner_user_id: string;
  author_name: string;
  text: string;
  color: string;
  created_at: Date | string;
  read_at: Date | string | null;
}

const NOTE_COLUMNS = 'id, owner_user_id, author_name, text, color, created_at, read_at';

function toNote(r: NoteRow): DeskNote {
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    authorName: r.author_name,
    text: r.text,
    color: r.color,
    createdAt: new Date(r.created_at).getTime(),
    readAt: r.read_at === null ? null : new Date(r.read_at).getTime(),
  };
}

function hashKey(key: unknown): string | null {
  return typeof key === 'string' && GUEST_KEY.test(key) ? crypto.createHash('sha256').update(key).digest('hex') : null;
}

const NOTE_ID = /^[a-z0-9]{8,32}$/;

export const feature: Feature = {
  name: 'world',
  migrations: [
    {
      id: 200,
      name: 'desk_notes',
      sql: `
        CREATE TABLE desk_notes (
          id             text PRIMARY KEY,
          office_id      text NOT NULL REFERENCES offices ON DELETE CASCADE,
          -- The desk it was left on; notes follow their owner if they move to another desk.
          item_id        text NOT NULL,
          owner_user_id  text NOT NULL REFERENCES users ON DELETE CASCADE,
          author_user_id text REFERENCES users ON DELETE SET NULL,
          -- SHA-256 of a guest author's key, so guests can delete what they wrote.
          author_key     text,
          author_name    text NOT NULL,
          text           text NOT NULL,
          color          text NOT NULL,
          created_at     timestamptz NOT NULL DEFAULT now(),
          read_at        timestamptz
        );
        CREATE INDEX desk_notes_owner_idx ON desk_notes (office_id, owner_user_id, created_at);`,
    },
  ],
  register(ctx) {
    const { db, store, realtime } = ctx;

    /** Saves an office change made through a world op and tells everyone in the office. */
    const commit = (officeId: string, change: { office: Office; items: OfficeItem[] }, by: string) => {
      if (!change.items.length) return;
      store.update(officeId, change.office);
      for (const item of change.items) realtime.emitToOffice(officeId, 'office:op', { t: 'update', item }, by);
    };

    /** Applies a change to the office this socket is in; returns an error message or null. */
    const change = (s: SocketContext, make: (office: Office) => WorldChange): string | null => {
      const room = s.room();
      const stored = room && store.peek(room.officeId);
      if (!room || !stored) return 'Join the office first.';
      const result = make(stored.office);
      if ('error' in result) return result.error;
      commit(room.officeId, result, s.socket.id);
      return null;
    };

    const stickies = async (officeId: string, ownerUserId?: string): Promise<Record<string, StickySummary>> => {
      const { rows } = await db.query<{ owner_user_id: string; count: number; colors: string[] }>(
        `SELECT owner_user_id, count(*)::int AS count,
                (array_agg(color ORDER BY created_at DESC, id DESC))[1:${VISIBLE_STICKIES}] AS colors
         FROM desk_notes WHERE office_id = $1 ${ownerUserId ? 'AND owner_user_id = $2' : ''}
         GROUP BY owner_user_id`,
        ownerUserId ? [officeId, ownerUserId] : [officeId],
      );
      const out: Record<string, StickySummary> = {};
      for (const r of rows) out[r.owner_user_id] = { count: r.count, colors: [...r.colors].reverse() };
      if (ownerUserId && !out[ownerUserId]) out[ownerUserId] = { count: 0, colors: [] };
      return out;
    };

    const unread = async (officeId: string, userId: string): Promise<number> => {
      const { rows } = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM desk_notes WHERE office_id = $1 AND owner_user_id = $2 AND read_at IS NULL',
        [officeId, userId],
      );
      return rows[0].n;
    };

    /** After a desk's notes changed: everyone sees the new stickies, its owner the new unread count. */
    const notesChanged = async (officeId: string, ownerUserId: string) => {
      try {
        realtime.emitToOffice(officeId, 'desk:stickies', await stickies(officeId, ownerUserId), false);
        realtime.emitToUser(ownerUserId, 'desk:inbox', officeId, await unread(officeId, ownerUserId));
      } catch (err) {
        console.error('[world] could not send the new note counts:', err);
      }
    };

    const failed = (what: string, err: unknown) => {
      console.error(`[world] could not ${what}:`, err);
      return { ok: false as const, error: 'Something went wrong. Please try again.' };
    };

    realtime.onSocket((s) => {
      const { socket } = s;
      const canLight = s.limiter(3, 8);
      const canClaim = s.limiter(1, 4);
      const canNote = s.limiter(0.2, 3);
      const canRead = s.limiter(5, 20);
      const actor = (guestKey: unknown): NoteActor => ({ userId: s.user?.id ?? null, guestKeyHash: s.user ? null : hashKey(guestKey) });
      const reply = <T extends object>(ack: unknown, res: WorldResult<T>) => {
        if (typeof ack === 'function') ack(res);
      };

      socket.on('world:light', (itemId, on) => {
        if (typeof itemId !== 'string' || typeof on !== 'boolean' || !canLight()) return;
        const error = change(s, (office) => setLight(office, itemId, on));
        if (error) socket.emit('notice', error);
      });

      socket.on('desk:claim', (itemId, ack) => {
        const me = s.me();
        if (typeof itemId !== 'string' || !me) return reply(ack, { ok: false, error: 'Join the office first.' });
        if (!s.user) return reply(ack, { ok: false, error: 'Sign in to claim a desk.' });
        if (!canClaim()) return reply(ack, { ok: false, error: 'One moment…' });
        const user = { id: s.user.id, name: me.name };
        const error = change(s, (office) => claimDesk(office, itemId, user));
        reply(ack, error ? { ok: false, error } : { ok: true });
      });

      socket.on('desk:release', (itemId, ack) => {
        if (typeof itemId !== 'string') return reply(ack, { ok: false, error: 'That desk is gone.' });
        if (!canClaim()) return reply(ack, { ok: false, error: 'One moment…' });
        const error = change(s, (office) => releaseDesk(office, itemId, { userId: s.user?.id ?? null, mayEdit: s.mayEdit() }));
        reply(ack, error ? { ok: false, error } : { ok: true });
      });

      socket.on('desk:note', async (itemId, note, ack) => {
        const room = s.room();
        const me = s.me();
        const desk = room ? store.peek(room.officeId)?.office.items.find((i) => i.id === itemId) : undefined;
        if (!room || !me || typeof ack !== 'function') return;
        if (!canNote()) return ack({ ok: false, error: 'You’re leaving notes very quickly. Try again in a moment.' });
        const why = whyNoNote(desk, { userId: s.user?.id ?? null });
        if (why) return ack({ ok: false, error: why });
        const owner = deskOwner(desk)!;
        const text = sanitizeNoteText(note?.text);
        if (!text) return ack({ ok: false, error: 'Write something first.' });
        const color = sanitizeNoteColor(note?.color);
        let saved: DeskNote | null;
        try {
          saved = await db.transaction(async (tx) => {
            // A full desk makes room by dropping its oldest read notes; unread ones are never dropped.
            const { rows } = await tx.query<{ total: number; read: number }>(
              `SELECT count(*)::int AS total, (count(*) FILTER (WHERE read_at IS NOT NULL))::int AS read
               FROM desk_notes WHERE office_id = $1 AND owner_user_id = $2`,
              [room.officeId, owner.ownerUserId],
            );
            const extra = rows[0].total - MAX_NOTES_PER_DESK + 1;
            if (extra > rows[0].read) return null;
            if (extra > 0) {
              await tx.query(
                `DELETE FROM desk_notes WHERE id IN (
                   SELECT id FROM desk_notes WHERE office_id = $1 AND owner_user_id = $2 AND read_at IS NOT NULL
                   ORDER BY created_at LIMIT $3)`,
                [room.officeId, owner.ownerUserId, extra],
              );
            }
            const res = await tx.query<NoteRow>(
              `INSERT INTO desk_notes (id, office_id, item_id, owner_user_id, author_user_id, author_key, author_name, text, color)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${NOTE_COLUMNS}`,
              [randomId(16), room.officeId, desk!.id, owner.ownerUserId, s.user?.id ?? null, actor(note?.guestKey).guestKeyHash, me.name, text, color],
            );
            return toNote(res.rows[0]);
          });
        } catch (err) {
          return ack(failed('save a desk note', err));
        }
        if (!saved) return ack({ ok: false, error: `${owner.ownerName}’s desk is covered in unread notes. Try again later.` });
        ack({ ok: true, note: saved });
        const officeName = store.peek(room.officeId)?.office.settings.name ?? '';
        realtime.emitToUser(owner.ownerUserId, 'desk:note:new', saved, room.officeId, officeName);
        await notesChanged(room.officeId, owner.ownerUserId);
      });

      socket.on('desk:notes', async (ack) => {
        const room = s.room();
        if (typeof ack !== 'function') return;
        if (!room || !s.user) return ack({ ok: false, error: 'Sign in to have a desk.' });
        if (!canRead()) return ack({ ok: false, error: 'One moment…' });
        try {
          const { rows } = await db.query<NoteRow>(
            `SELECT ${NOTE_COLUMNS} FROM desk_notes WHERE office_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC LIMIT ${MAX_NOTES_PER_DESK}`,
            [room.officeId, s.user.id],
          );
          ack({ ok: true, notes: rows.map(toNote) });
        } catch (err) {
          ack(failed('load desk notes', err));
        }
      });

      socket.on('desk:authored', async (ownerUserId, guestKey, ack) => {
        const room = s.room();
        if (typeof ack !== 'function') return;
        const who = actor(guestKey);
        if (!room || typeof ownerUserId !== 'string' || (!who.userId && !who.guestKeyHash)) return ack({ ok: true, notes: [] });
        if (!canRead()) return ack({ ok: false, error: 'One moment…' });
        try {
          const { rows } = await db.query<NoteRow>(
            `SELECT ${NOTE_COLUMNS} FROM desk_notes
             WHERE office_id = $1 AND owner_user_id = $2 AND (author_user_id = $3 OR author_key = $4)
             ORDER BY created_at DESC LIMIT ${MAX_NOTES_PER_DESK}`,
            [room.officeId, ownerUserId, who.userId, who.guestKeyHash],
          );
          ack({ ok: true, notes: rows.map(toNote) });
        } catch (err) {
          ack(failed('load your notes', err));
        }
      });

      socket.on('desk:note:read', async (id, ack) => {
        const room = s.room();
        if (!room || !s.user || typeof id !== 'string' || (id !== 'all' && !NOTE_ID.test(id))) return reply(ack, { ok: false, error: 'That note is gone.' });
        if (!canRead()) return reply(ack, { ok: false, error: 'One moment…' });
        const userId = s.user.id;
        try {
          // Only notes on your own desk.
          await db.query(
            `UPDATE desk_notes SET read_at = now()
             WHERE office_id = $1 AND owner_user_id = $2 AND read_at IS NULL ${id === 'all' ? '' : 'AND id = $3'}`,
            id === 'all' ? [room.officeId, userId] : [room.officeId, userId, id],
          );
        } catch (err) {
          return reply(ack, failed('mark a note as read', err));
        }
        reply(ack, { ok: true });
        await notesChanged(room.officeId, userId);
      });

      socket.on('desk:note:delete', async (id, guestKey, ack) => {
        const room = s.room();
        if (typeof ack !== 'function') return;
        if (!room || typeof id !== 'string' || !NOTE_ID.test(id)) return ack({ ok: false, error: 'That note is gone.' });
        if (!canRead()) return ack({ ok: false, error: 'One moment…' });
        let owner: string;
        try {
          const { rows } = await db.query<{ owner_user_id: string; author_user_id: string | null; author_key: string | null }>(
            'SELECT owner_user_id, author_user_id, author_key FROM desk_notes WHERE id = $1 AND office_id = $2',
            [id, room.officeId],
          );
          const note = rows[0];
          if (!note) return ack({ ok: false, error: 'That note is gone.' });
          owner = note.owner_user_id;
          const authorship = { ownerUserId: note.owner_user_id, authorUserId: note.author_user_id, authorKey: note.author_key };
          if (!mayDeleteNote(authorship, actor(guestKey))) return ack({ ok: false, error: 'Only the desk’s owner or the note’s author can remove it.' });
          await db.query('DELETE FROM desk_notes WHERE id = $1', [id]);
        } catch (err) {
          return ack(failed('remove a note', err));
        }
        ack({ ok: true });
        await notesChanged(room.officeId, owner);
      });
    });

    realtime.onJoin(async (s) => {
      const room = s.room();
      const me = s.me();
      if (!room || !me) return;
      const { officeId } = room;
      // The name plate on your desk follows your name.
      if (s.user) change(s, (office) => renameDeskOwner(office, { id: s.user!.id, name: me.name }));
      const all = await stickies(officeId);
      if (s.room()?.officeId !== officeId) return;
      s.socket.emit('desk:stickies', all, true);
      if (s.user) s.socket.emit('desk:inbox', officeId, await unread(officeId, s.user.id));
    });
  },
};
