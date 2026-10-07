import type { Server, Socket } from 'socket.io';
import { EMOTES, sanitizeAvatar, sanitizeName, sanitizeStatus } from '../shared/avatar';
import { buildColliders, findFreeSpot } from '../shared/geometry';
import { applyOp, OpError } from '../shared/office';
import type {
  AnimState,
  ChatMessage,
  ClientToServerEvents,
  Office,
  OfficeOp,
  PlayerPatch,
  PlayerState,
  ServerToClientEvents,
} from '../shared/types';
import type { OfficeStore } from './officeStore';
import { randomId } from './officeStore';
import { type LinkChanges, Room } from './room';

export const MAX_PLAYERS_PER_ROOM = 100;
const ANIMS: AnimState[] = ['idle', 'walk', 'sit'];

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
type ClientSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/** Token bucket: `rate` actions per second with bursts up to `burst`. */
function limiter(rate: number, burst: number) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

const roomName = (officeId: string) => `office:${officeId}`;

/** A free spot near the office's spawn point that isn't on top of someone else. */
export function spawnSpot(office: Office, others: Iterable<PlayerState>): { x: number; z: number } {
  const colliders = buildColliders(office);
  const { spawn } = office.settings;
  const taken = [...others];
  for (let i = 0; i < 30; i++) {
    const radius = 1 + Math.floor(i / 8);
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * radius;
    const p = findFreeSpot(spawn.x + Math.cos(angle) * r, spawn.z + Math.sin(angle) * r, colliders, office.settings);
    if (taken.every((o) => Math.hypot(o.x - p.x, o.z - p.z) > 0.9)) return p;
  }
  return findFreeSpot(spawn.x, spawn.z, colliders, office.settings);
}

export function attachRealtime(io: IO, store: OfficeStore) {
  const rooms = new Map<string, Room>();

  const emitLinks = (changes: LinkChanges) => {
    for (const { a, b, sid } of changes.added) {
      io.to(a).emit('peer:connect', b, sid, a < b);
      io.to(b).emit('peer:connect', a, sid, b < a);
    }
    for (const { a, b } of changes.removed) {
      io.to(a).emit('peer:disconnect', b);
      io.to(b).emit('peer:disconnect', a);
    }
  };

  io.on('connection', (socket: ClientSocket) => {
    let room: Room | null = null;
    let isOwner = false;
    const canChat = limiter(1, 5);
    const canEmote = limiter(2, 4);
    const canEdit = limiter(20, 60);
    const canProfile = limiter(2, 6);
    const canMove = limiter(40, 80);

    const me = (): PlayerState | undefined => room?.players.get(socket.id);
    const office = () => (room ? store.peek(room.officeId)?.office : undefined);

    const leave = () => {
      if (!room) return;
      const r = room;
      room = null;
      socket.leave(roomName(r.officeId));
      emitLinks(r.removePlayer(socket.id));
      io.to(roomName(r.officeId)).emit('player:left', socket.id);
      if (r.players.size === 0) {
        rooms.delete(r.officeId);
        void store.evict(r.officeId, () => rooms.has(r.officeId));
      }
    };

    socket.on('join', async (req, ack) => {
      if (typeof ack !== 'function') return;
      if (!req || typeof req !== 'object') return ack({ ok: false, error: 'Bad request' });
      leave();
      let stored;
      try {
        stored = await store.get(String(req.officeId));
      } catch (err) {
        console.error('[store] could not load office:', err);
        return ack({ ok: false, error: 'Could not load this office right now. Please try again.' });
      }
      if (!stored) return ack({ ok: false, error: 'This office does not exist.' });
      if (socket.disconnected) return;
      const id = stored.office.id;
      let r = rooms.get(id);
      if (!r) {
        r = new Room(id);
        rooms.set(id, r);
      }
      if (r.players.size >= MAX_PLAYERS_PER_ROOM) return ack({ ok: false, error: 'This office is full.' });

      isOwner = typeof req.ownerKey === 'string' && req.ownerKey === stored.ownerKey;
      const spot = spawnSpot(stored.office, r.players.values());
      const player: PlayerState = {
        id: socket.id,
        name: sanitizeName(req.name) || 'Guest',
        avatar: sanitizeAvatar(req.avatar),
        status: sanitizeStatus(req.status),
        x: spot.x,
        z: spot.z,
        ry: 0,
        anim: 'idle',
        mic: req.mic === true,
        cam: req.cam === true,
        screen: false,
      };
      room = r;
      r.players.set(socket.id, player);
      socket.join(roomName(id));
      ack({
        ok: true,
        selfId: socket.id,
        office: stored.office,
        players: [...r.players.values()],
        chat: r.chat.filter((m) => m.scope === 'all'),
        isOwner,
      });
      socket.to(roomName(id)).emit('player:joined', player);
      emitLinks(r.recompute(stored.office.zones, [socket.id]));
    });

    socket.on('move', (x, z, ry, anim) => {
      const p = me();
      const o = office();
      if (!p || !o || !room || !canMove()) return;
      if (![x, z, ry].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
      p.x = Math.max(0, Math.min(o.settings.width, x));
      p.z = Math.max(0, Math.min(o.settings.depth, z));
      p.ry = ry;
      p.anim = ANIMS.includes(anim) ? anim : 'idle';
      socket.volatile.to(roomName(room.officeId)).emit('player:moved', [p.id, p.x, p.z, p.ry, p.anim]);
      emitLinks(room.recompute(o.zones, [p.id]));
    });

    socket.on('profile', (patch) => {
      const p = me();
      const o = office();
      if (!p || !o || !room || !patch || typeof patch !== 'object' || !canProfile()) return;
      const clean: PlayerPatch = {};
      if ('name' in patch) clean.name = sanitizeName(patch.name) || p.name;
      if ('avatar' in patch) clean.avatar = sanitizeAvatar(patch.avatar);
      if ('status' in patch) clean.status = sanitizeStatus(patch.status);
      for (const key of ['mic', 'cam', 'screen'] as const) if (key in patch) clean[key] = patch[key] === true;
      Object.assign(p, clean);
      io.to(roomName(room.officeId)).emit('player:updated', p.id, clean);
      if ('status' in clean) emitLinks(room.recompute(o.zones, [p.id]));
    });

    socket.on('chat', (text, scope, to) => {
      const p = me();
      if (!p || !room || typeof text !== 'string' || !canChat()) return;
      const body = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 1000);
      if (!body) return;
      const msg: ChatMessage = { id: randomId(12), from: p.id, name: p.name, text: body, scope: 'all', ts: Date.now() };
      if (scope === 'nearby') {
        msg.scope = 'nearby';
        io.to([p.id, ...room.linkedPeers(p.id)]).emit('chat', msg);
      } else if (scope === 'dm') {
        if (typeof to !== 'string' || !room.players.has(to) || to === p.id) return;
        msg.scope = 'dm';
        msg.to = to;
        io.to([p.id, to]).emit('chat', msg);
      } else {
        room.addChat(msg);
        io.to(roomName(room.officeId)).emit('chat', msg);
      }
    });

    socket.on('emote', (emoji) => {
      if (!room || !EMOTES.includes(emoji) || !canEmote()) return;
      io.to(roomName(room.officeId)).emit('emote', socket.id, emoji);
    });

    socket.on('office:op', (op: OfficeOp) => {
      if (!room) return;
      const stored = store.peek(room.officeId);
      if (!stored) return;
      const reject = (reason: string) => socket.emit('office:sync', stored.office, reason);
      if (!canEdit()) return reject('You are editing too quickly.');
      if (stored.office.settings.buildPolicy === 'owner' && !isOwner) return reject('Only the owner can edit this office.');
      if (op?.t === 'settings' && op.settings && 'buildPolicy' in op.settings && !isOwner) {
        return reject('Only the owner can change who may edit.');
      }
      let next;
      try {
        next = applyOp(stored.office, op);
      } catch (err) {
        return reject(err instanceof OpError ? err.message : 'Invalid edit');
      }
      store.update(room.officeId, next);
      // Broadcast the normalised edit (to the sender too, so everybody converges on the server's order).
      let normalized: OfficeOp = op;
      if (op.t === 'add' || op.t === 'update') normalized = { t: op.t, item: next.items.find((i) => i.id === op.item.id)! };
      else if (op.t === 'zone:add' || op.t === 'zone:update') normalized = { t: op.t, zone: next.zones.find((z) => z.id === op.zone.id)! };
      else if (op.t === 'settings') normalized = { t: 'settings', settings: next.settings };
      else if (op.t === 'remove' || op.t === 'zone:remove') normalized = { t: op.t, id: op.id };
      io.to(roomName(room.officeId)).emit('office:op', normalized, socket.id);
      if (op.t.startsWith('zone:') || op.t === 'settings') emitLinks(room.recompute(next.zones));
    });

    socket.on('rtc:signal', (to, sid, data) => {
      if (!room || typeof to !== 'string' || typeof sid !== 'number' || !data || typeof data !== 'object') return;
      // Only relay between people who are currently linked, on their current connection.
      if (room.linkSid(socket.id, to) !== sid) return;
      if (JSON.stringify(data).length > 100_000) return;
      io.to(to).emit('rtc:signal', socket.id, sid, data);
    });

    socket.on('disconnect', leave);
  });

  return {
    rooms,
    onlineCount: (officeId: string) => rooms.get(officeId)?.players.size ?? 0,
  };
}
