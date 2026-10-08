import { setFocus, toggleFocus } from '../lib/focus';
import { useStore } from '../state/store';
import { HeadphonesIcon, HeadphonesOffIcon } from './icons';

/** Dock toggle for noise-cancelling headphones. */
export function HeadphonesButton() {
  const focus = useStore((s) => s.focus);
  return (
    <button
      className={`dock-btn${focus ? ' focus-on' : ''}`}
      onClick={toggleFocus}
      aria-pressed={focus}
      title={focus ? 'Take headphones off (H) · you can’t hear others' : 'Noise-cancelling headphones (H)'}
    >
      <HeadphonesIcon />
    </button>
  );
}

/** Under the top bar while your headphones are on. */
export function FocusIndicator() {
  const focus = useStore((s) => s.focus);
  if (!focus) return null;
  return (
    <div className="focus-indicator" role="status">
      <HeadphonesIcon size={15} />
      <strong>Headphones on</strong>
      <span>You can’t hear others</span>
      <button onClick={() => setFocus(false)} title="Take headphones off (H)">
        <HeadphonesOffIcon size={14} />
        Take off
      </button>
    </div>
  );
}

/** Marks someone wearing headphones (name tags, video tiles, the people list). */
export function FocusBadge({ size = 12 }: { size?: number }) {
  return (
    <span className="focus-badge" title="Wearing headphones" aria-label="Wearing headphones" role="img">
      <HeadphonesIcon size={size} />
    </span>
  );
}
