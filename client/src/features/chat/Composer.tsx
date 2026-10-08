import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { MAX_ATTACHMENTS, MAX_MESSAGE, type ChatAttachment, type ChatMention, type ConvKey } from '../../../../shared/chat';
import { labelsToTokens, type MentionPick } from '../../../../shared/chatText';
import type { UploadedFile } from '../../../../shared/uploads';
import { getSession } from '../../lib/session';
import { toast, useStore } from '../../state/store';
import { AtIcon, AttachIcon, CloseIcon, RotateIcon, SendIcon } from '../../ui/icons';
import { Avatar, fileIcon, formatBytes } from './parts';
import { isLive, loadPeople, send, useChat } from './state';

/** The composer on screen, for files dropped on the panel and for focusing it. */
export const composerHandle: { current: { addFiles: (files: File[]) => void; focus: () => void } | null } = { current: null };

/** Unsent text per conversation (and thread), kept while you look elsewhere. */
const drafts = new Map<string, { text: string; picks: MentionPick[] }>();

/** Forgets unsent text (when you leave the office). */
export function clearDrafts(): void {
  drafts.clear();
}

interface Suggestion {
  key: string;
  name: string;
  token: string;
  hint: string;
}

const QUERY = /(?:^|[\s(])@([\p{L}\p{N}_.'-]{0,30})$/u;

/** Who can be mentioned in a conversation: @here and people online first, then members who are away. */
function useSuggestions(conv: ConvKey, query: string | null): Suggestion[] {
  const players = useStore((s) => s.players);
  const myUserId = useStore((s) => s.account?.id ?? null);
  const people = useChat((s) => s.people);
  const dms = useChat((s) => s.dms);
  return useMemo(() => {
    if (query === null) return [];
    const all: Suggestion[] = [];
    const seen = new Set<string>();
    const add = (s: Suggestion) => {
      if (seen.has(s.token)) return;
      seen.add(s.token);
      all.push(s);
    };
    if (conv.startsWith('d:')) {
      // In a direct message, only the other person.
      const userId = conv.slice(2);
      const name = Object.values(players).find((p) => p.userId === userId)?.name ?? dms.find((d) => d.userId === userId)?.name ?? people.find((p) => p.userId === userId)?.name;
      if (name) add({ key: userId, name, token: `<@u:${userId}>`, hint: '' });
    } else {
      add({ key: 'here', name: 'here', token: '<!here>', hint: 'Everyone online' });
      for (const p of Object.values(players).sort((a, b) => a.name.localeCompare(b.name))) {
        if (p.userId && p.userId === myUserId) continue;
        add({ key: p.id, name: p.name, token: p.userId ? `<@u:${p.userId}>` : `<@p:${p.id}>`, hint: p.userId ? 'Online' : 'Guest, online' });
      }
      for (const p of people) if (p.userId !== myUserId) add({ key: p.userId, name: p.name, token: `<@u:${p.userId}>`, hint: 'Away' });
    }
    const q = query.toLowerCase();
    return all.filter((s) => !q || s.name.toLowerCase().startsWith(q) || s.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))).slice(0, 8);
  }, [conv, query, players, myUserId, people, dms]);
}

/** A textarea that grows with its text and offers @mentions as you type them. */
export function MentionInput({
  conv,
  value,
  onChange,
  picks,
  onPicks,
  onKeyDown,
  onPaste,
  placeholder,
  inputRef,
  label,
}: {
  conv: ConvKey;
  value: string;
  onChange: (v: string) => void;
  picks: MentionPick[];
  onPicks: (p: MentionPick[]) => void;
  /** Return true when the key was handled. */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  label: string;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const mentionable = !isLive(conv);
  const suggestions = useSuggestions(conv, mentionable ? query : null);
  const open = suggestions.length > 0;

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value, inputRef]);

  const look = () => {
    const el = inputRef.current;
    if (!el || !mentionable) return;
    const m = QUERY.exec(el.value.slice(0, el.selectionStart ?? el.value.length));
    const q = m ? m[1] : null;
    if (q !== null && query === null) void loadPeople();
    setQuery(q);
    if (q !== query) setActive(0);
  };

  const pick = (s: Suggestion) => {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@[\p{L}\p{N}_.'-]{0,30}$/u, '');
    const label = `@${s.name}`;
    const next = `${before}${label} ${value.slice(caret)}`;
    onChange(next);
    if (s.key !== 'here' && !picks.some((p) => p.label === label && p.token === s.token)) onPicks([...picks.filter((p) => p.label !== label), { label, token: s.token }]);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      const at = before.length + label.length + 1;
      el.setSelectionRange(at, at);
    });
  };

  return (
    <div className="mention-input">
      {open && (
        <div className="mention-menu" role="listbox" aria-label="Mention someone">
          {suggestions.map((s, i) => (
            <button
              key={s.key}
              type="button"
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              // Keep the focus (and caret) in the textarea.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
            >
              {s.key === 'here' ? (
                <span className="mention-here">
                  <AtIcon size={14} />
                </span>
              ) : (
                <Avatar name={s.name} size={22} />
              )}
              <span className="mention-name">{s.key === 'here' ? '@here' : s.name}</span>
              <span className="mention-hint">{s.hint}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        maxLength={MAX_MESSAGE + 500}
        onChange={(e) => {
          onChange(e.target.value);
          requestAnimationFrame(look);
        }}
        onSelect={look}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
              return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
              e.preventDefault();
              pick(suggestions[active] ?? suggestions[0]);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setQuery(null);
              return;
            }
          }
          if (onKeyDown?.(e)) e.preventDefault();
        }}
      />
    </div>
  );
}

/** Mentions picked in the composer, as the message will show them until the server's copy arrives. */
export function picksToMentions(text: string, picks: MentionPick[]): ChatMention[] {
  const out: ChatMention[] = [];
  for (const p of picks) {
    if (!text.includes(p.token)) continue;
    const m = /^<@([up]):(.+)>$/.exec(p.token);
    if (m) out.push({ kind: m[1] === 'u' ? 'user' : 'player', id: m[2], name: p.label.slice(1) });
  }
  if (text.includes('<!here>')) out.push({ kind: 'here' });
  return out;
}

interface PendingFile {
  key: string;
  file: File;
  name: string;
  /** Waiting for a turn: only a few go up at once. */
  status: 'waiting' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
  result?: UploadedFile;
  /** An image's size, and a preview of it. */
  w?: number;
  h?: number;
  preview?: string;
  abort: AbortController;
}

let fileKey = 0;
/** Files uploading at once (the server takes 3 at a time from each visitor). */
const PARALLEL = 3;

/** Where you write: text with mentions and formatting, files (attach, drop, paste), Enter to send. */
export function Composer({
  conv,
  parentId,
  placeholder,
  label,
  quote,
  alsoTo,
  onCancel,
  onEditLast,
}: {
  conv: ConvKey;
  parentId?: string;
  placeholder: string;
  label: string;
  /** Shown above the text: what you're replying to. */
  quote?: ReactNode;
  /** For thread replies: the conversation to also send them to ("#general"). */
  alsoTo?: string;
  onCancel?: () => void;
  /** Up in an empty composer: edit your last message. */
  onEditLast?: () => void;
}) {
  const draftKey = `${conv}|${parentId ?? ''}`;
  const saved = drafts.get(draftKey);
  const [text, setText] = useState(saved?.text ?? '');
  const [picks, setPicks] = useState<MentionPick[]>(saved?.picks ?? []);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [also, setAlso] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  /** Keys of the files going up now. */
  const running = useRef(new Set<string>());
  const closed = useRef(false);

  useEffect(() => {
    if (text || picks.length) drafts.set(draftKey, { text, picks });
    else drafts.delete(draftKey);
  }, [draftKey, text, picks]);

  // Uploads still running when the composer goes away are cancelled.
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      for (const f of filesRef.current) {
        f.abort.abort();
        if (f.preview) URL.revokeObjectURL(f.preview);
      }
    };
  }, []);

  const update = (key: string, patch: Partial<PendingFile>) => setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const upload = (f: PendingFile) => {
    const session = getSession();
    if (!session) {
      update(f.key, { status: 'error', error: 'Not connected' });
      return;
    }
    running.current.add(f.key);
    update(f.key, { status: 'uploading', progress: 0 });
    session
      .upload(f.file, { name: f.name, signal: f.abort.signal, onProgress: (p) => update(f.key, { progress: p }) })
      .then((result) => update(f.key, { status: 'done', progress: 1, result }))
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        update(f.key, { status: 'error', error: err.message });
        toast(`${f.name}: ${err.message}`, 'error');
      })
      .finally(() => {
        running.current.delete(f.key);
        startWaiting();
      });
  };

  /** Starts waiting files while there's room. */
  const startWaiting = () => {
    for (const f of filesRef.current) {
      if (closed.current || running.current.size >= PARALLEL) return;
      if (f.status === 'waiting' && !running.current.has(f.key)) upload(f);
    }
  };
  useEffect(startWaiting, [files]);

  const addFiles = (list: File[]) => {
    const room = MAX_ATTACHMENTS - filesRef.current.length;
    if (list.length > room) toast(`Up to ${MAX_ATTACHMENTS} files per message.`, 'error');
    const added = list.slice(0, Math.max(0, room)).map((file): PendingFile => {
      // Pasted screenshots are all called image.png.
      const name = /^image\.(png|jpe?g|gif|webp)$/i.test(file.name) ? `Pasted image ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.${file.name.split('.').pop()}` : file.name || 'file';
      const f: PendingFile = { key: `f${++fileKey}`, file, name, status: 'waiting', progress: 0, abort: new AbortController() };
      if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
        f.preview = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => update(f.key, { w: img.naturalWidth, h: img.naturalHeight });
        img.src = f.preview;
      }
      return f;
    });
    if (!added.length) return;
    setFiles((cur) => [...cur, ...added]);
    input.current?.focus();
  };

  const dropFile = (key: string) => {
    setFiles((list) => {
      const f = list.find((x) => x.key === key);
      f?.abort.abort();
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return list.filter((x) => x.key !== key);
    });
  };

  useEffect(() => {
    const handle = { addFiles, focus: () => input.current?.focus() };
    composerHandle.current = handle;
    return () => {
      if (composerHandle.current === handle) composerHandle.current = null;
    };
  });

  // Ready to type when it opens, except on touch screens (where that pops up the keyboard).
  useEffect(() => {
    if (matchMedia('(pointer: fine)').matches) input.current?.focus();
  }, [draftKey]);

  const uploading = files.some((f) => f.status === 'uploading' || f.status === 'waiting');
  const failed = files.some((f) => f.status === 'error');
  const body = text.trim();
  const canSend = (!!body || files.length > 0) && !uploading && !failed;

  const submit = () => {
    if (!canSend) {
      if (uploading) toast('Wait for your files to finish uploading.');
      else if (failed) toast('Remove the files that didn’t upload, or try them again.', 'error');
      return;
    }
    const tokens = labelsToTokens(body, picks);
    if (tokens.length > MAX_MESSAGE) {
      toast(`Messages can be up to ${MAX_MESSAGE.toLocaleString()} characters.`, 'error');
      return;
    }
    const attachments: ChatAttachment[] = files.map((f) => ({ ...f.result!, w: f.w, h: f.h }));
    send(conv, { text: tokens, attachments, mentions: picksToMentions(tokens, picks) }, { parentId, alsoToChannel: parentId ? also : undefined });
    for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
    setFiles([]);
    setText('');
    setPicks([]);
    setAlso(false);
    drafts.delete(draftKey);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return false;
    if (e.key === 'Enter' && !e.shiftKey) {
      submit();
      return true;
    }
    if (e.key === 'ArrowUp' && !text && !files.length && onEditLast) {
      onEditLast();
      return true;
    }
    // Esc cancels the reply, or else leaves the box (a second Esc then closes the panel).
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (onCancel) onCancel();
      else input.current?.blur();
      return true;
    }
    return false;
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (!pasted.length) return;
    e.preventDefault();
    addFiles(pasted);
  };

  return (
    <div className="composer">
      {quote && (
        <div className="composer-quote">
          {quote}
          {onCancel && (
            <button type="button" className="icon-btn" onClick={onCancel} title="Cancel (Esc)">
              <CloseIcon size={14} />
            </button>
          )}
        </div>
      )}
      <div className="composer-box" onClick={(e) => e.target === e.currentTarget && input.current?.focus()}>
        {files.length > 0 && (
          <div className="composer-files">
            {files.map((f) => {
              const Icon = fileIcon(f.file.type, f.name);
              return (
                <div key={f.key} className={`upload-chip ${f.status}`} title={f.error ?? f.name}>
                  {f.preview ? <img src={f.preview} alt="" /> : <span className="upload-icon"><Icon size={20} /></span>}
                  <span className="upload-text">
                    <strong>{f.name}</strong>
                    <span>
                      {f.status === 'waiting'
                        ? 'Waiting…'
                        : f.status === 'uploading'
                          ? `Uploading ${Math.round(f.progress * 100)}%`
                          : f.status === 'error'
                            ? f.error
                            : formatBytes(f.file.size)}
                    </span>
                  </span>
                  {f.status === 'error' && (
                    <button
                      type="button"
                      className="upload-btn"
                      title="Try again"
                      onClick={() => update(f.key, { status: 'waiting', progress: 0, error: undefined, abort: new AbortController() })}
                    >
                      <RotateIcon size={14} />
                    </button>
                  )}
                  <button type="button" className="upload-btn" title="Remove" onClick={() => dropFile(f.key)}>
                    <CloseIcon size={14} />
                  </button>
                  {f.status === 'uploading' && <span className="upload-bar" style={{ transform: `scaleX(${Math.max(0.04, f.progress)})` }} />}
                </div>
              );
            })}
          </div>
        )}
        <MentionInput
          conv={conv}
          value={text}
          onChange={setText}
          picks={picks}
          onPicks={setPicks}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          inputRef={input}
          label={label}
        />
        <div className="composer-tools">
          <button type="button" className="icon-btn" title="Attach files" onClick={() => fileInput.current?.click()} disabled={files.length >= MAX_ATTACHMENTS}>
            <AttachIcon size={18} />
          </button>
          {!isLive(conv) && (
            <button
              type="button"
              className="icon-btn"
              title="Mention someone"
              onClick={() => {
                const el = input.current;
                if (!el) return;
                const caret = el.selectionStart ?? text.length;
                const spacer = caret > 0 && !/\s$/.test(text.slice(0, caret)) ? ' ' : '';
                setText(`${text.slice(0, caret)}${spacer}@${text.slice(caret)}`);
                requestAnimationFrame(() => {
                  el.focus();
                  el.setSelectionRange(caret + spacer.length + 1, caret + spacer.length + 1);
                });
              }}
            >
              <AtIcon size={18} />
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          {parentId && alsoTo && (
            <label className="composer-also">
              <input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} />
              Also send to {alsoTo}
            </label>
          )}
          <span className="composer-hint">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
          </span>
          <button type="button" className={`composer-send${canSend ? ' ready' : ''}`} onClick={submit} title="Send (Enter)" aria-label="Send">
            <SendIcon size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
