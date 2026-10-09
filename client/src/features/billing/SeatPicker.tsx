import { useEffect, useState } from 'react';
import { MAX_SEATS } from '../../../../shared/billing';
import { MinusIcon, PlusIcon } from '../../ui/icons';

/** − / number / +, between `min` and MAX_SEATS. */
export function SeatPicker({ value, min, onChange }: { value: number; min: number; onChange: (seats: number) => void }) {
  // What's typed, which may be on its way to a number (empty, or below `min`).
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const set = (n: number) => onChange(Math.min(MAX_SEATS, Math.max(min, n)));
  return (
    <div className="seat-picker">
      <button type="button" className="icon-btn" onClick={() => set(value - 1)} disabled={value <= min} aria-label="One seat less">
        <MinusIcon size={16} />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={MAX_SEATS}
        value={draft}
        aria-label="Seats"
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isInteger(n) && n >= min && n <= MAX_SEATS) onChange(n);
        }}
        onBlur={() => setDraft(String(value))}
      />
      <button type="button" className="icon-btn" onClick={() => set(value + 1)} disabled={value >= MAX_SEATS} aria-label="One seat more">
        <PlusIcon size={16} />
      </button>
    </div>
  );
}
