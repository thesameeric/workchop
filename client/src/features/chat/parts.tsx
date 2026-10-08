import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { findMention, type ChatMention } from '../../../../shared/chat';
import { isJumbo, parseMessage, type Inline } from '../../../../shared/chatText';
import { colorFor, initials } from '../../lib/color';
import { useStore } from '../../state/store';
import {
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FilePdfIcon,
  FileSheetIcon,
  FileTextIcon,
  FileVideoIcon,
  FileZipIcon,
  type IconComponent,
} from '../../ui/icons';
import { mentionsMe } from './state';

/** You may edit the office (the server's mayEdit): then you also manage channels and moderate them. */
export const useMayEdit = () => useStore((s) => !!s.office && (s.office.settings.buildPolicy === 'everyone' || s.isOwner));

export function Avatar({ name, size = 32, className }: { name: string; size?: number; className?: string }) {
  return (
    <span
      className={`chat-avatar${className ? ` ${className}` : ''}`}
      style={{ background: colorFor(name), width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

function renderInline(nodes: Inline[], mentions: ChatMention[], key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return n.v;
      case 'br':
        return <br key={k} />;
      case 'b':
        return <strong key={k}>{renderInline(n.c, mentions, `${k}.`)}</strong>;
      case 'i':
        return <em key={k}>{renderInline(n.c, mentions, `${k}.`)}</em>;
      case 'code':
        return <code key={k}>{n.v}</code>;
      case 'link':
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {n.href}
          </a>
        );
      case 'mention': {
        const m = findMention(mentions, n.kind, n.id);
        const label = !m ? '@unknown' : m.kind === 'here' ? '@here' : `@${m.name}`;
        return (
          <span key={k} className={`mention${m && mentionsMe([m]) ? ' me' : ''}${m ? '' : ' unknown'}`}>
            {label}
          </span>
        );
      }
    }
  });
}

/** A message's text with its formatting, as React elements (never HTML); `suffix` follows its last line. */
export function Formatted({ text, mentions, suffix }: { text: string; mentions: ChatMention[]; suffix?: ReactNode }) {
  const blocks = useMemo(() => parseMessage(text), [text]);
  if (isJumbo(text)) {
    return (
      <div className="msg-text jumbo">
        {text}
        {suffix}
      </div>
    );
  }
  const last = blocks.length - 1;
  return (
    <div className="msg-text">
      {blocks.map((b, i) =>
        b.t === 'pre' ? (
          <pre key={i}>
            <code>{b.v}</code>
          </pre>
        ) : (
          <p key={i}>
            {renderInline(b.c, mentions)}
            {i === last && suffix}
          </p>
        ),
      )}
      {blocks[last]?.t === 'pre' && suffix}
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** An icon for a file, by its type (or extension). */
export function fileIcon(contentType: string, name: string): IconComponent {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (contentType === 'application/pdf' || ext === 'pdf') return FilePdfIcon;
  if (contentType.startsWith('video/')) return FileVideoIcon;
  if (contentType.startsWith('audio/')) return FileAudioIcon;
  if (/zip|compressed|tar|gzip|7z|rar/.test(contentType) || ['zip', 'gz', 'tgz', '7z', 'rar', 'tar'].includes(ext)) return FileZipIcon;
  if (/spreadsheet|excel|csv/.test(contentType) || ['xls', 'xlsx', 'csv', 'numbers', 'ods'].includes(ext)) return FileSheetIcon;
  if (/json|javascript|typescript|xml|x-sh|x-python/.test(contentType) || ['js', 'ts', 'tsx', 'json', 'py', 'sh', 'rb', 'go', 'rs', 'java', 'html', 'css'].includes(ext)) {
    return FileCodeIcon;
  }
  if (contentType.startsWith('text/') || /word|document|rtf/.test(contentType) || ['txt', 'md', 'doc', 'docx', 'rtf', 'pages', 'odt'].includes(ext)) return FileTextIcon;
  return FileIcon;
}

/** Shown inline (the server serves these types as images); others are file cards. */
export const isImage = (contentType: string) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(contentType);

export function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fullTime(ts: number): string {
  return new Date(ts).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const dayOf = (ts: number) => new Date(ts).toDateString();

export function sameDay(a: number, b: number): boolean {
  return dayOf(a) === dayOf(b);
}

/** "Today", "Yesterday", or the date. */
export function dayLabel(ts: number): string {
  const now = Date.now();
  if (sameDay(ts, now)) return 'Today';
  if (sameDay(ts, now - 86_400_000)) return 'Yesterday';
  const d = new Date(ts);
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

/** Esc (and other keys) for an overlay, before the office's own shortcuts see them. */
export function useOverlayKeys(onKey: (e: KeyboardEvent) => boolean) {
  const handler = useRef(onKey);
  handler.current = onKey;
  useEffect(() => {
    const listen = (e: KeyboardEvent) => {
      if (handler.current(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', listen, true);
    return () => window.removeEventListener('keydown', listen, true);
  }, []);
}
