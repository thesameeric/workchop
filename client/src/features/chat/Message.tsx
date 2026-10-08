import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { reactorId, type ChatReaction } from '../../../../shared/chat';
import { labelsToTokens, tokensToLabels, type MentionPick } from '../../../../shared/chatText';
import { getSession } from '../../lib/session';
import { ago } from '../../lib/time';
import { getState, toast } from '../../state/store';
import { AlertIcon, EditIcon, LinkIcon, ReactIcon, ThreadIcon, TrashIcon } from '../../ui/icons';
import { Attachments, EmojiPicker } from './Attachments';
import { MentionInput } from './Composer';
import { Avatar, Formatted, fullTime, timeLabel } from './parts';
import { convOf, deleteMessage, discard, editMessage, isMine, mentionsMe, openThread, react, retry, useChat, type UiMessage } from './state';

const setEditing = (id: string | null) => useChat.setState({ editing: id });

function whoReacted(r: ChatReaction, me: string): string {
  const names = r.by.map((b) => (b.id === me ? 'You' : b.name));
  if (names.length <= 3) return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
}

function Reactions({ m, canReact, onAdd }: { m: UiMessage; canReact: boolean; onAdd: (el: HTMLElement) => void }) {
  const selfId = getSession()?.selfId() ?? '';
  const me = reactorId(getState().account?.id, selfId);
  return (
    <div className="reactions">
      {m.reactions.map((r) => {
        const mine = r.by.some((b) => b.id === me);
        const tip = `${whoReacted(r, me)} reacted with ${r.emoji}`;
        return (
          <button key={r.emoji} type="button" className={`reaction${mine ? ' mine' : ''}`} disabled={!canReact} onClick={() => react(m, r.emoji)} aria-label={tip} aria-pressed={mine} data-tip={tip}>
            <span className="reaction-emoji">{r.emoji}</span>
            <span className="reaction-count">{r.by.length}</span>
          </button>
        );
      })}
      {canReact && (
        <button type="button" className="reaction add" title="Add a reaction" onClick={(e) => onAdd(e.currentTarget)}>
          <ReactIcon size={16} />
        </button>
      )}
    </div>
  );
}

function ThreadSummary({ m }: { m: UiMessage }) {
  return (
    <button type="button" className="thread-summary" onClick={() => openThread(m.id)}>
      <span className="thread-avatars">
        {m.replyNames.slice(0, 3).map((n) => (
          <Avatar key={n} name={n} size={20} />
        ))}
      </span>
      <span className="thread-count">
        {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}
      </span>
      {m.lastReplyAt && <span className="thread-last">Last reply {ago(m.lastReplyAt)}</span>}
      <span className="thread-view">View thread</span>
    </button>
  );
}

/** Editing a sent message in place: Enter saves, Esc cancels. */
function EditBox({ m }: { m: UiMessage }) {
  const start = useRef(tokensToLabels(m.text, m.mentions));
  const [text, setText] = useState(start.current.text);
  const [picks, setPicks] = useState<MentionPick[]>(start.current.picks);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = input.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = async () => {
    const body = text.trim();
    if (busy) return;
    if (body === start.current.text.trim()) return setEditing(null);
    if (!body && !m.attachments.length) return toast('A message can’t be empty. Delete it instead.', 'error');
    setBusy(true);
    const ok = await editMessage(m.id, labelsToTokens(body, picks));
    setBusy(false);
    if (ok) setEditing(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return false;
    if (e.key === 'Enter' && !e.shiftKey) {
      void save();
      return true;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      setEditing(null);
      return true;
    }
    return false;
  };
  return (
    <div className="edit-box">
      <div className="composer-box">
        <MentionInput conv={convOf(m)} value={text} onChange={setText} picks={picks} onPicks={setPicks} onKeyDown={onKeyDown} placeholder="Edit your message" inputRef={input} label="Edit message" />
      </div>
      <div className="edit-actions">
        <span>
          <kbd>Esc</kbd> to cancel · <kbd>Enter</kbd> to save
        </span>
        <button type="button" className="btn small" onClick={() => setEditing(null)}>
          Cancel
        </button>
        <button type="button" className="btn small primary" onClick={() => void save()} disabled={busy}>
          Save
        </button>
      </div>
    </div>
  );
}

async function copyLink(m: UiMessage) {
  const officeId = getState().officeId;
  const url = `${location.origin}/o/${officeId}?msg=${m.id}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    prompt('Copy this link:', url);
  }
}

interface Props {
  m: UiMessage;
  /** Follows a message by the same person, a moment earlier: no avatar or name. */
  grouped: boolean;
  /** Shown in a thread view (no thread summary or "reply in thread"). */
  inThread?: boolean;
  highlight?: boolean;
  /** May delete others' messages in channels. */
  canModerate: boolean;
}

export const Message = memo(function Message({ m, grouped, inThread, highlight, canModerate }: Props) {
  const editing = useChat((s) => s.editing === m.id);
  const [confirming, setConfirming] = useState(false);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState(false);
  const mine = isMine(m);
  const saved = !m.live && !m.pending;
  const canReact = saved && !m.deleted;
  const canReply = saved && !m.deleted && !m.parentId && !inThread;
  const canEdit = saved && mine && !m.deleted;
  const canDelete = saved && !m.deleted && (mine || (canModerate && !!m.channelId));
  const hasActions = (canReact || canReply || canEdit || canDelete) && !editing;
  const classes = ['msg'];
  if (grouped) classes.push('grouped');
  if (!m.deleted && mentionsMe(m.mentions) && !mine) classes.push('mentions-me');
  if (highlight) classes.push('flash');
  if (m.pending) classes.push(`pending ${m.pending}`);
  if (editing) classes.push('editing');
  if (active || picker || confirming) classes.push('active');
  const edited = m.editedAt ? (
    <span className="msg-edited" title={`Edited ${fullTime(m.editedAt)}`}>
      {' '}
      (edited)
    </span>
  ) : null;

  return (
    <div
      className={classes.join(' ')}
      data-msg={m.id}
      // Touch screens have no hover: a tap shows the actions.
      onClick={(e) => {
        if (matchMedia('(hover: none)').matches && !(e.target as Element).closest('button, a, textarea')) setActive((v) => !v);
      }}
    >
      <div className="msg-gutter">
        {grouped ? (
          <time className="msg-hover-time" title={fullTime(m.createdAt)}>
            {timeLabel(m.createdAt)}
          </time>
        ) : (
          <Avatar name={m.name} size={34} />
        )}
      </div>
      <div className="msg-main">
        {!grouped && (
          <div className="msg-head">
            <span className="msg-name">{m.name}</span>
            {!m.userId && <span className="msg-tag">guest</span>}
            <time title={fullTime(m.createdAt)}>{m.pending === 'sending' ? 'Sending…' : timeLabel(m.createdAt)}</time>
          </div>
        )}
        {m.inChannel && m.parentId && !inThread && (
          <button type="button" className="msg-replied" onClick={() => openThread(m.parentId!)}>
            <ThreadIcon size={14} />
            <span>
              replied to a thread{m.parent ? ': ' : ''}
              {m.parent && <b>{m.parent.name}</b>} {m.parent && (m.parent.text || 'a deleted message')}
            </span>
          </button>
        )}
        {editing ? (
          <EditBox m={m} />
        ) : m.deleted ? (
          <p className="msg-deleted">This message was deleted.</p>
        ) : m.text ? (
          <Formatted text={m.text} mentions={m.mentions} suffix={edited} />
        ) : (
          edited
        )}
        {!m.deleted && <Attachments items={m.attachments} />}
        {m.reactions.length > 0 && <Reactions m={m} canReact={canReact} onAdd={setPicker} />}
        {!inThread && m.replyCount > 0 && <ThreadSummary m={m} />}
        {m.pending === 'failed' && (
          <div className="msg-failed">
            <AlertIcon size={16} />
            <span>{m.error ?? 'Not sent.'}</span>
            <button type="button" onClick={() => retry(m)}>
              Try again
            </button>
            <button type="button" onClick={() => discard(m)}>
              Discard
            </button>
          </div>
        )}
      </div>
      {hasActions && (
        <div className="msg-actions" role="toolbar" aria-label="Message actions">
          {confirming ? (
            <div className="msg-confirm">
              <span>Delete this message?</span>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setConfirming(false);
                  void deleteMessage(m.id);
                }}
              >
                Delete
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <>
              {canReact && (
                <button type="button" title="Add a reaction" onClick={(e) => setPicker(e.currentTarget)}>
                  <ReactIcon size={17} />
                </button>
              )}
              {canReply && (
                <button type="button" title="Reply in thread" onClick={() => openThread(m.id)}>
                  <ThreadIcon size={17} />
                </button>
              )}
              {canEdit && (
                <button type="button" title="Edit" onClick={() => setEditing(m.id)}>
                  <EditIcon size={17} />
                </button>
              )}
              <button type="button" title="Copy link" onClick={() => void copyLink(m)}>
                <LinkIcon size={17} />
              </button>
              {canDelete && (
                <button type="button" title="Delete" className="danger" onClick={() => setConfirming(true)}>
                  <TrashIcon size={17} />
                </button>
              )}
            </>
          )}
        </div>
      )}
      {picker && (
        <EmojiPicker
          anchor={picker}
          onPick={(emoji) => {
            react(m, emoji);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
});

/** Starts editing your latest message in a list (Up in an empty composer). */
export function editLast(messages: UiMessage[]): void {
  const last = [...messages].reverse().find((m) => isMine(m) && !m.pending && !m.live && !m.deleted);
  if (last) setEditing(last.id);
}
