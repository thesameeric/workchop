import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { MAX_CHANNEL_NAME, MAX_TOPIC, type ChatChannel, type ConvKey } from '../../../../shared/chat';
import { plainText } from '../../../../shared/chatText';
import { useStore } from '../../state/store';
import { usePopover } from '../../ui/Account';
import {
  AddIcon,
  ArchiveIcon,
  AttachIcon,
  BackIcon,
  ChevronDownIcon,
  EditIcon,
  HashIcon,
  NearbyIcon,
  SidebarIcon,
  UnarchiveIcon,
} from '../../ui/icons';
import { isTyping } from '../../world/input';
import { Composer, composerHandle } from './Composer';
import { editLast, Message } from './Message';
import { MessageList } from './MessageList';
import { Avatar, useMayModerate, useOverlayKeys } from './parts';
import {
  archiveChannel,
  closeThread,
  convWithPlayer,
  createChannel,
  emptyList,
  isDirect,
  loadConv,
  loadOlder,
  loadPeople,
  loadThread,
  openConv,
  updateChannel,
  useChat,
} from './state';

/** People you're in a call with. */
const useNearbyCount = () => useStore((s) => Object.keys(s.linked).length);

interface DmEntry {
  conv: ConvKey;
  name: string;
  online: boolean;
  guest: boolean;
  /** A guest who has left (their live messages stay until you've read them). */
  left?: boolean;
}

const byPresence = (a: DmEntry, b: DmEntry) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name);

/** People to message: everyone in the office now, and (signed in) the office's members who are away. */
function usePeopleToMessage(): DmEntry[] {
  const people = useChat((s) => s.people);
  const players = useStore((s) => s.players);
  const myUserId = useStore((s) => s.account?.id ?? null);
  return useMemo(() => {
    const out = new Map<ConvKey, DmEntry>();
    for (const p of Object.values(players)) {
      if (p.userId && p.userId === myUserId) continue;
      const conv = convWithPlayer(p.id);
      out.set(conv, { conv, name: p.name, online: true, guest: !p.userId });
    }
    if (myUserId) {
      for (const p of people) {
        const conv = `d:${p.userId}`;
        if (p.userId !== myUserId && !out.has(conv)) out.set(conv, { conv, name: p.name, online: false, guest: false });
      }
    }
    return [...out.values()].sort(byPresence);
  }, [people, players, myUserId]);
}

/**
 * Direct message partners: saved conversations, everyone in the office now, the conversation on
 * screen, and guests who left while their messages are unread.
 */
function useDmEntries(): DmEntry[] {
  const dms = useChat((s) => s.dms);
  const people = useChat((s) => s.people);
  const current = useChat((s) => s.current);
  const liveNames = useChat((s) => s.liveNames);
  const counts = useChat((s) => s.counts);
  const players = useStore((s) => s.players);
  const myUserId = useStore((s) => s.account?.id ?? null);
  return useMemo(() => {
    const out = new Map<ConvKey, DmEntry>();
    for (const d of dms) out.set(`d:${d.userId}`, { conv: `d:${d.userId}`, name: d.name, online: false, guest: false });
    for (const p of Object.values(players)) {
      if (p.userId && p.userId === myUserId) continue;
      const conv = convWithPlayer(p.id);
      const known = out.get(conv);
      if (known) out.set(conv, { ...known, name: p.name, online: true });
      else out.set(conv, { conv, name: p.name, online: true, guest: !p.userId });
    }
    // A first message to a member who is away.
    const away = current.startsWith('d:') && !out.has(current) ? people.find((p) => `d:${p.userId}` === current) : undefined;
    if (away) out.set(current, { conv: current, name: away.name, online: false, guest: false });
    for (const [conv, name] of Object.entries(liveNames)) {
      if (!out.has(conv) && (conv === current || counts[conv]?.unread)) out.set(conv, { conv, name, online: false, guest: true, left: true });
    }
    return [...out.values()].sort(byPresence);
  }, [dms, people, current, liveNames, counts, players, myUserId]);
}

function RailItem({ conv, icon, label, title, onPick }: { conv: ConvKey; icon: ReactNode; label: ReactNode; title?: string; onPick: () => void }) {
  const active = useChat((s) => s.current === conv);
  const counts = useChat((s) => s.counts[conv]);
  const unread = counts?.unread ?? 0;
  const mentions = counts?.mentions ?? 0;
  const badge = mentions || (isDirect(conv) ? unread : 0);
  return (
    <button
      type="button"
      className={`rail-item${active ? ' active' : ''}${unread || mentions ? ' unread' : ''}`}
      aria-current={active ? 'page' : undefined}
      title={title}
      onClick={() => {
        openConv(conv);
        onPick();
      }}
    >
      <span className="rail-icon">{icon}</span>
      <span className="rail-label">{label}</span>
      {badge > 0 ? <span className="rail-badge">{badge > 99 ? '99+' : badge}</span> : unread > 0 ? <i className="rail-dot" aria-label="Unread" /> : null}
    </button>
  );
}

function Rail({ onPick, onCreate, onMessage }: { onPick: () => void; onCreate: () => void; onMessage: () => void }) {
  const channels = useChat((s) => s.channels);
  const ready = useChat((s) => s.ready);
  const dms = useDmEntries();
  const nearby = useNearbyCount();
  const [showArchived, setShowArchived] = useState(false);
  const open = channels.filter((c) => !c.archived);
  const archived = channels.filter((c) => c.archived);
  return (
    <nav className="chat-rail" aria-label="Conversations">
      <RailItem conv="nearby" icon={<NearbyIcon size={16} />} label={<>Nearby{nearby > 0 && <span className="rail-meta">{nearby}</span>}</>} title="The people you’re talking with" onPick={onPick} />
      <div className="rail-section">
        <span>Channels</span>
        <button type="button" className="rail-add" title="New channel" onClick={onCreate}>
          <AddIcon size={15} />
        </button>
      </div>
      {!ready && <div className="rail-skeleton" />}
      {open.map((c) => (
        <RailItem key={c.id} conv={`c:${c.id}`} icon={<HashIcon size={15} />} label={c.name} title={c.topic || undefined} onPick={onPick} />
      ))}
      <div className="rail-section">
        <span>Direct messages</span>
        <button type="button" className="rail-add" title="New message" onClick={onMessage}>
          <AddIcon size={15} />
        </button>
      </div>
      {dms.length === 0 && <p className="rail-empty">No one else is here yet.</p>}
      {dms.map((d) => (
        <RailItem
          key={d.conv}
          conv={d.conv}
          icon={
            <span className="rail-person">
              <Avatar name={d.name} size={18} />
              <i className={`presence${d.online ? ' on' : ''}`} />
            </span>
          }
          label={
            <>
              {d.name}
              {d.guest && <span className="rail-meta">{d.left ? 'left' : 'guest'}</span>}
            </>
          }
          title={d.online ? `${d.name} is here` : d.left ? `${d.name} left the office` : `${d.name} is away`}
          onPick={onPick}
        />
      ))}
      {archived.length > 0 && (
        <>
          <button type="button" className={`rail-section rail-toggle${showArchived ? ' open' : ''}`} onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
            <span>Archived ({archived.length})</span>
            <ChevronDownIcon size={14} />
          </button>
          {showArchived &&
            archived.map((c) => <RailItem key={c.id} conv={`c:${c.id}`} icon={<ArchiveIcon size={15} />} label={c.name} onPick={onPick} />)}
        </>
      )}
    </nav>
  );
}

/** Unread elsewhere: shown on the rail button when the rail is folded away. */
function useOtherUnread(conv: ConvKey): boolean {
  return useChat((s) => Object.entries(s.counts).some(([k, c]) => k !== conv && (c.unread > 0 || c.mentions > 0)));
}

function ChannelMenu({ channel, onEdit }: { channel: ChatChannel; onEdit: () => void }) {
  const { open, setOpen, close, ref, buttonRef } = usePopover();
  const canManage = useMayModerate();
  return (
    <div className="chat-menu-wrap" ref={ref}>
      <button type="button" ref={buttonRef} className="icon-btn" title="Channel settings" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronDownIcon size={18} />
      </button>
      {open && (
        <div className="chat-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onEdit();
            }}
          >
            <EditIcon size={16} />
            {canManage && !channel.isDefault ? 'Rename or set topic' : 'Set topic'}
          </button>
          {canManage && !channel.isDefault && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                void archiveChannel(channel.id, !channel.archived);
              }}
            >
              {channel.archived ? <UnarchiveIcon size={16} /> : <ArchiveIcon size={16} />}
              {channel.archived ? 'Unarchive channel' : 'Archive channel'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ConvHeader({ conv, onRail, onEdit }: { conv: ConvKey; onRail: () => void; onEdit: (c: ChatChannel) => void }) {
  const channel = useChat((s) => (conv.startsWith('c:') ? s.channels.find((c) => `c:${c.id}` === conv) : undefined));
  const dm = useDmEntries().find((d) => d.conv === conv);
  const nearby = useNearbyCount();
  const otherUnread = useOtherUnread(conv);
  let title: ReactNode;
  let sub: ReactNode = null;
  if (channel) {
    title = (
      <>
        <HashIcon size={17} />
        <span className="conv-name">{channel.name}</span>
      </>
    );
    sub = (
      <button type="button" className="conv-topic" onClick={() => onEdit(channel)} title={channel.topic ? 'Change the topic' : 'Add a topic'}>
        {channel.topic || (channel.archived ? 'Archived' : 'Add a topic')}
      </button>
    );
  } else if (conv === 'nearby') {
    title = (
      <>
        <NearbyIcon size={17} />
        <span className="conv-name">Nearby</span>
      </>
    );
    sub = <span className="conv-sub">{nearby ? `${nearby + 1} people in your conversation` : 'Walk up to someone to talk'}</span>;
  } else {
    const name = dm?.name ?? 'Someone';
    title = (
      <>
        <span className="rail-person">
          <Avatar name={name} size={22} />
          <i className={`presence${dm?.online ? ' on' : ''}`} />
        </span>
        <span className="conv-name">{name}</span>
      </>
    );
    sub = (
      <span className="conv-sub">
        {!dm || dm.left ? 'Left the office' : conv.startsWith('p:') ? 'Not saved: guests’ messages last while you’re both here' : dm.online ? 'Here now' : 'Away'}
      </span>
    );
  }
  return (
    <header className="conv-head">
      <button type="button" className="icon-btn rail-toggle" onClick={onRail} title="Conversations">
        <SidebarIcon size={18} />
        {otherUnread && <i className="rail-toggle-dot" />}
      </button>
      <div className="conv-title">
        <div className="conv-line">{title}</div>
        {sub}
      </div>
      {channel && <ChannelMenu channel={channel} onEdit={() => onEdit(channel)} />}
    </header>
  );
}

function Intro({ conv }: { conv: ConvKey }) {
  const channel = useChat((s) => (conv.startsWith('c:') ? s.channels.find((c) => `c:${c.id}` === conv) : undefined));
  const dm = useDmEntries().find((d) => d.conv === conv);
  if (channel) {
    return (
      <div className="chat-intro">
        <span className="chat-intro-icon">
          <HashIcon size={22} />
        </span>
        <h3>Welcome to #{channel.name}</h3>
        <p>{channel.topic || (channel.isDefault ? 'Everyone in the office is here. Say hi!' : 'This is the very start of the channel.')}</p>
      </div>
    );
  }
  if (conv === 'nearby') {
    return (
      <div className="chat-intro">
        <span className="chat-intro-icon">
          <NearbyIcon size={22} />
        </span>
        <h3>Nearby</h3>
        <p>Messages here go to the people you’re talking with right now. They aren’t saved.</p>
      </div>
    );
  }
  const name = dm?.name ?? 'them';
  return (
    <div className="chat-intro">
      <Avatar name={dm?.name ?? '?'} size={44} />
      <h3>{name}</h3>
      <p>{conv.startsWith('p:') ? 'Messages with guests aren’t saved: they’re gone when you leave the office.' : `This is the start of your conversation with ${name}.`}</p>
    </div>
  );
}

function ConversationView({ conv, onRail, onEdit }: { conv: ConvKey; onRail: () => void; onEdit: (c: ChatChannel) => void }) {
  const list = useChat((s) => s.convs[conv]) ?? emptyList();
  const channel = useChat((s) => (conv.startsWith('c:') ? s.channels.find((c) => `c:${c.id}` === conv) : undefined));
  const dm = useDmEntries().find((d) => d.conv === conv);
  const canManage = useMayModerate();
  useEffect(() => void loadConv(conv), [conv]);
  const placeholder = channel ? `Message #${channel.name}` : conv === 'nearby' ? 'Message the people nearby' : `Message ${dm?.name ?? ''}`;
  let footer: ReactNode = null;
  if (channel?.archived) {
    footer = (
      <div className="chat-footer-note">
        <ArchiveIcon size={16} />
        <span>This channel is archived.</span>
        {canManage && (
          <button type="button" className="btn small" onClick={() => void archiveChannel(channel.id, false)}>
            Unarchive
          </button>
        )}
      </div>
    );
  } else if (conv.startsWith('p:') && (!dm || dm.left)) {
    footer = <div className="chat-footer-note">They’ve left the office.</div>;
  }
  return (
    <>
      <ConvHeader conv={conv} onRail={onRail} onEdit={onEdit} />
      <MessageList key={`list:${conv}`} conv={conv} list={list} intro={<Intro conv={conv} />} onOlder={() => void loadOlder(conv)} onRetry={() => void loadConv(conv)} />
      {footer ?? <Composer key={`composer:${conv}`} conv={conv} placeholder={placeholder} label={placeholder} onEditLast={() => editLast(list.messages)} />}
    </>
  );
}

function ThreadView({ id, conv }: { id: string; conv: ConvKey }) {
  const thread = useChat((s) => s.threads[id]) ?? { ...emptyList(), parent: null };
  const channel = useChat((s) => (conv.startsWith('c:') ? s.channels.find((c) => `c:${c.id}` === conv) : undefined));
  const dm = useDmEntries().find((d) => d.conv === conv);
  const where = channel ? `#${channel.name}` : dm ? dm.name : 'the conversation';
  const canManage = useMayModerate();
  const parent = thread.parent;
  const closed = !!parent?.deleted || !!channel?.archived;
  return (
    <>
      <header className="conv-head">
        <button type="button" className="icon-btn" onClick={closeThread} title="Back (Esc)">
          <BackIcon size={18} />
        </button>
        <div className="conv-title">
          <div className="conv-line">
            <span className="conv-name">Thread</span>
          </div>
          <span className="conv-sub">in {where}</span>
        </div>
      </header>
      <MessageList
        key={`list:${id}`}
        conv={conv}
        list={thread}
        inThread
        intro={null}
        head={
          parent && (
            <div className="thread-parent">
              <Message m={parent} grouped={false} inThread canModerate={canManage} />
              <div className="thread-divider">
                <span>{parent.replyCount ? `${parent.replyCount} ${parent.replyCount === 1 ? 'reply' : 'replies'}` : 'No replies yet'}</span>
              </div>
            </div>
          )
        }
        onOlder={() => void loadThread(id, true)}
        onRetry={() => void loadThread(id)}
      />
      {closed ? (
        <div className="chat-footer-note">{channel?.archived ? 'This channel is archived.' : 'This message was deleted, so its thread is closed.'}</div>
      ) : (
        <Composer
          key={`composer:${id}`}
          conv={conv}
          parentId={id}
          placeholder="Reply…"
          label="Reply in thread"
          alsoTo={channel ? `#${channel.name}` : dm?.name}
          onCancel={closeThread}
          onEditLast={() => editLast(thread.messages)}
          quote={
            parent && !parent.deleted ? (
              <span className="quote-text">
                Replying to <b>{parent.name}</b>
                {parent.text ? `: ${plainText(parent.text, parent.mentions, 80)}` : ''}
              </span>
            ) : undefined
          }
        />
      )}
    </>
  );
}

/** Creating a channel, or renaming one / setting its topic. */
function ChannelForm({ channel, onClose }: { channel: ChatChannel | null; onClose: () => void }) {
  const canManage = useMayModerate();
  const guestEditor = useStore((s) => !s.account && s.office?.settings.buildPolicy === 'everyone');
  const canRename = !channel || (canManage && !channel.isDefault);
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useOverlayKeys((e) => {
    if (e.key !== 'Escape') return false;
    onClose();
    return true;
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const err = channel
      ? await updateChannel(channel.id, { name: canRename && name !== channel.name ? name : undefined, topic: topic !== channel.topic ? topic : undefined })
      : await createChannel(name, topic);
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };
  return (
    <div className="chat-dialog-scrim" onPointerDown={onClose}>
      <form className="chat-dialog" onPointerDown={(e) => e.stopPropagation()} onSubmit={submit} aria-label={channel ? 'Edit channel' : 'New channel'}>
        <h3>{channel ? `#${channel.name}` : 'New channel'}</h3>
        {!channel && <p className="muted small">Channels are open to everyone in the office.</p>}
        <label className="field">
          <span>Name</span>
          <div className={`channel-name-input${canRename ? '' : ' disabled'}`}>
            <HashIcon size={16} />
            <input
              value={name}
              autoFocus={canRename}
              disabled={!canRename}
              maxLength={MAX_CHANNEL_NAME}
              placeholder="e.g. design"
              onChange={(e) => {
                setError(null);
                setName(
                  e.target.value
                    .toLowerCase()
                    .replace(/\s/g, '-')
                    .replace(/[^a-z0-9_-]/g, '')
                    .slice(0, MAX_CHANNEL_NAME),
                );
              }}
            />
          </div>
        </label>
        <label className="field">
          <span>Topic (optional)</span>
          <input value={topic} autoFocus={!canRename} maxLength={MAX_TOPIC} placeholder="What’s it about?" onChange={(e) => setTopic(e.target.value)} />
        </label>
        {channel && !canRename && (
          <p className="muted small">
            {channel.isDefault ? '#general keeps its name.' : guestEditor ? 'Sign in to rename channels.' : 'Only people who can edit this office can rename channels.'}
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="chat-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name}>
            {channel ? 'Save' : 'Create channel'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Starting a direct message with someone here, or (signed in) a member who is away. */
function NewMessage({ onClose }: { onClose: () => void }) {
  const everyone = usePeopleToMessage();
  const signedIn = useStore((s) => !!s.account);
  const [query, setQuery] = useState('');
  useEffect(() => void loadPeople(), []);
  useOverlayKeys((e) => {
    if (e.key !== 'Escape') return false;
    onClose();
    return true;
  });
  const q = query.trim().toLowerCase();
  const found = q ? everyone.filter((p) => p.name.toLowerCase().includes(q)) : everyone;
  const pick = (conv: ConvKey) => {
    openConv(conv);
    onClose();
  };
  return (
    <div className="chat-dialog-scrim" onPointerDown={onClose}>
      <div className="chat-dialog new-message" role="dialog" aria-label="New message" onPointerDown={(e) => e.stopPropagation()}>
        <h3>New message</h3>
        <input
          value={query}
          autoFocus
          placeholder="Find someone"
          aria-label="Find someone"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && found[0]) pick(found[0].conv);
          }}
        />
        <div className="people-pick">
          {found.map((p) => (
            <button key={p.conv} type="button" onClick={() => pick(p.conv)}>
              <span className="rail-person">
                <Avatar name={p.name} size={24} />
                <i className={`presence${p.online ? ' on' : ''}`} />
              </span>
              <span className="people-pick-name">{p.name}</span>
              <span className="people-pick-hint">{p.online ? (p.guest ? 'Guest, here' : 'Here') : 'Away'}</span>
            </button>
          ))}
          {!found.length && <p className="muted small">{q ? 'No one by that name.' : 'No one else has been here yet.'}</p>}
        </div>
        {!signedIn && <p className="muted small">Sign in to message people who are away.</p>}
        <div className="chat-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files');

export function ChatPanel() {
  const current = useChat((s) => s.current);
  const thread = useChat((s) => s.thread);
  const [railOpen, setRailOpen] = useState(false);
  const [form, setForm] = useState<{ channel: ChatChannel | null } | null>(null);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  // The office's Enter shortcut (which opens the chat, and runs first) also puts you in the composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.defaultPrevented && !isTyping()) requestAnimationFrame(() => composerHandle.current?.focus());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className={`chat-panel${railOpen ? ' rail-open' : ''}`}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        depth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        composerHandle.current?.addFiles([...e.dataTransfer.files]);
      }}
    >
      <Rail
        onPick={() => setRailOpen(false)}
        onCreate={() => {
          setRailOpen(false);
          setForm({ channel: null });
        }}
        onMessage={() => {
          setRailOpen(false);
          setPicking(true);
        }}
      />
      {railOpen && <div className="rail-scrim" onClick={() => setRailOpen(false)} />}
      <section className="chat-main" aria-label="Messages">
        {!current ? (
          <div className="chat-scroll-wrap">
            <div className="chat-skeleton" />
          </div>
        ) : thread ? (
          <ThreadView id={thread} conv={current} />
        ) : (
          <ConversationView conv={current} onRail={() => setRailOpen((v) => !v)} onEdit={(c) => setForm({ channel: c })} />
        )}
      </section>
      {dragging && (
        <div className="drop-overlay">
          <AttachIcon size={28} />
          <strong>Drop files to share</strong>
          <span>Up to 5 at a time</span>
        </div>
      )}
      {form && <ChannelForm channel={form.channel} onClose={() => setForm(null)} />}
      {picking && <NewMessage onClose={() => setPicking(false)} />}
    </div>
  );
}
