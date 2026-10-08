import { useState } from 'react';
import { APPS, appInfo, HEADS_DOWN, OTHER_APP } from '../../../../shared/apps';
import { serverNow } from '../../lib/clock';
import { useStore } from '../../state/store';
import { AppIcon } from './AppChip';
import { EXPIRIES, loadExpiry, saveExpiry, setManual, untilFor, usePresence, type Expiry } from './state';

const CHOICES = [HEADS_DOWN, ...APPS.map((a) => a.id), OTHER_APP];

function untilText(until: number | null): string {
  if (until === null) return 'until you clear it';
  const d = new Date(until - (serverNow() - Date.now()));
  return `until ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/** "Working in …": pick an app (or heads-down) by hand, optionally for a while. */
export function StatusPicker({ onPicked }: { onPicked?: () => void }) {
  const inOffice = useStore((s) => s.phase === 'office');
  const manual = usePresence((s) => s.self?.manual ?? null);
  const [expiry, setExpiry] = useState<Expiry>(loadExpiry);
  if (!inOffice) return <p className="muted small">Join an office to set what you’re working in.</p>;
  return (
    <div className="app-picker">
      <div className="app-options" role="group" aria-label="Working in">
        {CHOICES.map((id) => {
          const on = manual?.app === id;
          return (
            <button
              key={id}
              type="button"
              className={`app-option${on ? ' active' : ''}`}
              style={{ ['--app' as string]: appInfo(id).color }}
              aria-pressed={on}
              onClick={() => {
                setManual(on ? null : { app: id, until: untilFor(expiry) });
                onPicked?.();
              }}
            >
              <AppIcon app={id} size={16} />
              <span>{appInfo(id).label}</span>
            </button>
          );
        })}
      </div>
      <div className="app-picker-foot">
        <label className="app-expiry">
          <span>Clear after</span>
          <select
            value={expiry}
            onChange={(e) => {
              const next = e.target.value as Expiry;
              setExpiry(next);
              saveExpiry(next);
              if (manual) setManual({ app: manual.app, until: untilFor(next) });
            }}
          >
            {EXPIRIES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        {manual && (
          <button type="button" className="btn small" onClick={() => setManual(null)}>
            Clear
          </button>
        )}
      </div>
      {manual && (
        <p className="muted small app-picker-note">
          {appInfo(manual.app).label}, {untilText(manual.until)}.
        </p>
      )}
    </div>
  );
}
