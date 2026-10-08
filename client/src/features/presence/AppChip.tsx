import { appInfo } from '../../../../shared/apps';
import { HUGEICONS, type HugeiconName } from '../../ui/hugeicons';
import { useStore } from '../../state/store';
import { usePresence } from './state';

/** An app's icon from shared/apps.ts. */
export function AppIcon({ app, size = 14 }: { app: string; size?: number }) {
  const name = appInfo(app).icon;
  const code = HUGEICONS[name as HugeiconName] ?? HUGEICONS.work;
  return (
    <span className="hgi" style={{ fontSize: size }} aria-hidden>
      {String.fromCodePoint(code)}
    </span>
  );
}

export type ChipVariant = 'tag' | 'list' | 'tile';

/** "Figma", with its icon and colour: the app someone is working in. */
export function AppChip({ app, variant = 'list' }: { app: string; variant?: ChipVariant }) {
  const info = appInfo(app);
  return (
    <span className={`app-chip app-chip-${variant}`} style={{ ['--app' as string]: info.color }} title={info.id === 'other' || info.id === 'focus' ? info.label : `In ${info.label}`}>
      <AppIcon app={app} size={variant === 'tag' ? 11 : 12} />
      <span className="app-chip-label">{info.label}</span>
    </span>
  );
}

/** The app chip of someone in the office (`self` for you). */
export function PlayerApp({ id, self = false, variant }: { id?: string; self?: boolean; variant?: ChipVariant }) {
  const theirs = useStore((s) => (!self && id ? (s.players[id]?.app ?? null) : null));
  const mine = usePresence((s) => (self ? (s.self?.app ?? null) : null));
  const app = self ? mine : theirs;
  return app ? <AppChip app={app} variant={variant} /> : null;
}
