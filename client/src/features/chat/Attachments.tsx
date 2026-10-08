import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { QUICK_REACTIONS, type ChatAttachment } from '../../../../shared/chat';
import { ArrowDownIcon, BackIcon, CloseIcon, DownloadIcon, ExternalIcon, FileIcon } from '../../ui/icons';
import { fileIcon, formatBytes, isImage, useOverlayKeys } from './parts';
import { recentEmoji } from './state';

/** The tallest an image preview gets in the message list. */
const MAX_H = 240;
const MAX_H_MANY = 150;

function ImageThumb({ a, many, onOpen }: { a: ChatAttachment; many: boolean; onOpen: () => void }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const img = useRef<HTMLImageElement>(null);
  // Already in the cache (e.g. back in a conversation): no fade-in.
  useLayoutEffect(() => {
    if (img.current?.complete && img.current.naturalWidth) setState('loaded');
  }, []);
  const maxH = many ? MAX_H_MANY : MAX_H;
  // With the sender's size we keep the space from the start, so the list doesn't jump as it loads.
  const style: CSSProperties = a.w && a.h ? { aspectRatio: `${a.w} / ${a.h}`, width: Math.min(a.w, Math.round((maxH * a.w) / a.h)) } : { height: maxH * 0.75 };
  if (state === 'failed') {
    return (
      <a className="att-file" href={a.url} download={a.name}>
        <span className="att-file-icon">
          <FileIcon size={22} />
        </span>
        <span className="att-file-text">
          <strong>{a.name}</strong>
          <span>Preview unavailable · {formatBytes(a.size)}</span>
        </span>
      </a>
    );
  }
  return (
    <button type="button" className={`att-image ${state}${a.w && a.h ? ' sized' : ''}`} style={style} onClick={onOpen} title={a.name} aria-label={`Open ${a.name}`}>
      <img
        ref={img}
        src={a.url}
        alt={a.name}
        loading="lazy"
        decoding="async"
        style={{ maxHeight: maxH }}
        onLoad={() => setState('loaded')}
        onError={() => setState('failed')}
      />
    </button>
  );
}

function FileCard({ a }: { a: ChatAttachment }) {
  const Icon = fileIcon(a.contentType, a.name);
  const ext = a.name.includes('.') ? a.name.split('.').pop()!.toUpperCase().slice(0, 6) : '';
  return (
    <a className="att-file" href={a.url} download={a.name} title={`Download ${a.name}`}>
      <span className="att-file-icon">
        <Icon size={22} />
      </span>
      <span className="att-file-text">
        <strong>{a.name}</strong>
        <span>
          {formatBytes(a.size)}
          {ext && ` · ${ext}`}
        </span>
      </span>
      <DownloadIcon size={18} className="att-file-dl" />
    </a>
  );
}

function Lightbox({ images, index, onIndex, onClose }: { images: ChatAttachment[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const a = images[index];
  const many = images.length > 1;
  useOverlayKeys((e) => {
    if (e.key === 'Escape') onClose();
    else if (many && e.key === 'ArrowLeft') onIndex((index - 1 + images.length) % images.length);
    else if (many && e.key === 'ArrowRight') onIndex((index + 1) % images.length);
    else return false;
    return true;
  });
  return createPortal(
    <div className="lightbox" role="dialog" aria-label={a.name} onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-title">
          <strong>{a.name}</strong>
          <span>
            {formatBytes(a.size)}
            {many && ` · ${index + 1} of ${images.length}`}
          </span>
        </div>
        <a className="lightbox-btn" href={a.url} target="_blank" rel="noopener noreferrer" title="Open in a new tab">
          <ExternalIcon size={18} />
        </a>
        <a className="lightbox-btn" href={a.url} download={a.name} title="Download">
          <DownloadIcon size={18} />
        </a>
        <button className="lightbox-btn" onClick={onClose} title="Close (Esc)">
          <CloseIcon size={18} />
        </button>
      </div>
      <img key={a.id} className="lightbox-img" src={a.url} alt={a.name} onClick={(e) => e.stopPropagation()} />
      {many && (
        <>
          <button
            className="lightbox-nav prev"
            title="Previous (←)"
            onClick={(e) => {
              e.stopPropagation();
              onIndex((index - 1 + images.length) % images.length);
            }}
          >
            <BackIcon size={20} />
          </button>
          <button
            className="lightbox-nav next"
            title="Next (→)"
            onClick={(e) => {
              e.stopPropagation();
              onIndex((index + 1) % images.length);
            }}
          >
            <BackIcon size={20} />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

/** A message's files: images as previews (click for full size), anything else as a download card. */
export function Attachments({ items }: { items: ChatAttachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!items.length) return null;
  const images = items.filter((a) => isImage(a.contentType));
  const files = items.filter((a) => !isImage(a.contentType));
  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className="att-images">
          {images.map((a, i) => (
            <ImageThumb key={a.id} a={a} many={images.length > 1} onOpen={() => setOpen(i)} />
          ))}
        </div>
      )}
      {files.map((a) => (
        <FileCard key={a.id} a={a} />
      ))}
      {open !== null && images[open] && <Lightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Quick reactions and recently used ones, next to the button that opened it. */
export function EmojiPicker({ anchor, onPick, onClose }: { anchor: HTMLElement; onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<CSSProperties>({ visibility: 'hidden' });
  const recent = recentEmoji()
    .filter((e) => !QUICK_REACTIONS.includes(e))
    .slice(0, 6);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const box = ref.current!.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - box.width, window.innerWidth - box.width - 8));
    const above = r.top - box.height - 6 > 8;
    setAt({ left, top: above ? r.top - box.height - 6 : Math.min(r.bottom + 6, window.innerHeight - box.height - 8) });
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [anchor, onClose]);
  useOverlayKeys((e) => {
    if (e.key !== 'Escape') return false;
    onClose();
    return true;
  });
  const grid = (list: string[]) => (
    <div className="emoji-grid">
      {list.map((e) => (
        <button key={e} type="button" onClick={() => onPick(e)} aria-label={`React with ${e}`}>
          {e}
        </button>
      ))}
    </div>
  );
  return createPortal(
    <div className="emoji-picker" ref={ref} style={at} role="dialog" aria-label="Add a reaction">
      {grid(QUICK_REACTIONS)}
      {recent.length > 0 && (
        <>
          <div className="emoji-label">Recent</div>
          {grid(recent)}
        </>
      )}
    </div>,
    document.body,
  );
}

/** Shown over the list when new messages arrive while you're scrolled up. */
export function JumpButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button className="jump-latest" onClick={onClick}>
      <ArrowDownIcon size={16} />
      {count > 0 ? `${count} new message${count === 1 ? '' : 's'}` : 'Jump to latest'}
    </button>
  );
}
