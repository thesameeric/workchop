import { useEffect, useLayoutEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { getTimes } from 'suncalc';
import { conditionOf, type WeatherReport } from '../../../../../shared/weather';
import { ago } from '../../../lib/time';
import { usePopover } from '../../../ui/Account';
import { CloudyIcon, DropletIcon, FogIcon, PinIcon, SunCloudIcon, SunriseIcon, SunsetIcon, WindIcon, type IconComponent } from '../../../ui/icons';
import { clockAt, describe, formatPrecipitation, formatTemp, formatVisibility, formatWind } from '../format';
import { placeName, sourceLine } from '../places';
import { useWeather } from '../state';
import { ConditionIcon, useNow } from './ConditionIcon';
import { LocationPicker } from './LocationPicker';

const POPOVER_ID = 'weather-popover';

function Fact({ icon: Icon, label, value, className }: { icon: IconComponent; label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <dt>
        <Icon size={15} />
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Sunrise and sunset at the report's place, in its local time (none near the poles in summer or winter). */
function SunFacts({ report, now }: { report: WeatherReport; now: number }) {
  const times = getTimes(new Date(now), report.lat, report.lon);
  if (times.alwaysUp || times.alwaysDown) {
    return <Fact className="sun-start" icon={SunriseIcon} label="Daylight" value={times.alwaysUp ? 'All day' : 'None today'} />;
  }
  const at = (d: Date | null) => (d ? clockAt(d.getTime(), report.utcOffset) : '–');
  return (
    <>
      <Fact className="sun-start" icon={SunriseIcon} label="Sunrise" value={at(times.sunrise)} />
      <Fact icon={SunsetIcon} label="Sunset" value={at(times.sunset)} />
    </>
  );
}

/** The weather in detail, where it's for and where that comes from. */
function Details({ onChangeLocation }: { onChangeLocation: () => void }) {
  const units = useWeather((s) => s.prefs.units);
  const place = useWeather((s) => s.place);
  const source = useWeather((s) => s.source);
  const report = useWeather((s) => s.report);
  const status = useWeather((s) => s.status);
  const error = useWeather((s) => s.error);
  const now = useNow(30_000);
  if (!place) return null;
  const foggy = !!report && (conditionOf(report.code) === 'fog' || (report.visibility !== null && report.visibility < 1000));
  return (
    <>
      {report ? (
        <>
          <div className="weather-now">
            <ConditionIcon code={report.code} isDay={report.isDay} size={40} />
            <div>
              <div className="weather-big">{formatTemp(report.tempC, units, true)}</div>
              <div>{describe(report.code)}</div>
            </div>
          </div>
          <p>
            <strong>{placeName(place)}</strong> · {clockAt(now, report.utcOffset)} local time
          </p>
          <dl className="weather-facts">
            <Fact icon={WindIcon} label="Wind" value={formatWind(report.windKph, report.windDir, units)} />
            <Fact icon={DropletIcon} label="Precipitation" value={formatPrecipitation(report.precipitation, units)} />
            <Fact icon={CloudyIcon} label="Cloud cover" value={`${Math.round(report.cloudCover)}%`} />
            {foggy && report.visibility !== null && <Fact icon={FogIcon} label="Visibility" value={formatVisibility(report.visibility, units)} />}
            <SunFacts report={report} now={now} />
          </dl>
        </>
      ) : (
        <p>
          <strong>{placeName(place)}</strong>
          <br />
          <span className="muted">{status === 'error' ? error : 'Getting the weather…'}</span>
        </p>
      )}
      <p className="muted small">
        {sourceLine(source, place)}
        {report && (
          <>
            <br />
            Updated {ago(report.fetchedAt)}
          </>
        )}
      </p>
      {report && status === 'error' && <p className="muted small">{error}</p>}
      <button type="button" className="btn small" onClick={onChangeLocation}>
        <PinIcon size={15} />
        Change location
      </button>
    </>
  );
}

/**
 * The popover is in a portal at the end of the page, so Tab past either end goes back to the chip
 * as if it came right after it (Tab then goes on from the chip, Shift+Tab stays on it).
 */
function popoverTab(e: KeyboardEvent<HTMLDivElement>, onClose: (refocus?: boolean) => void): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled)')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (e.shiftKey ? at > 0 : at < items.length - 1) return;
  if (e.shiftKey) e.preventDefault();
  onClose(true);
}

function WeatherPopover({
  menuRef,
  chipRef,
  at,
  onClose,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  chipRef: RefObject<HTMLDivElement | null>;
  at: { top: number; left: number };
  onClose: (refocus?: boolean) => void;
}) {
  const hasPlace = useWeather((s) => !!s.place);
  const [changing, setChanging] = useState(false);
  // Take the focus when opening and switching views (unless the search box took it), so the
  // keyboard carries on in here.
  useEffect(() => {
    if (!menuRef.current?.contains(document.activeElement)) menuRef.current?.focus();
  }, [menuRef, hasPlace, changing]);
  return (
    <div
      ref={menuRef}
      id={POPOVER_ID}
      className="weather-pop"
      role="dialog"
      aria-label="Weather"
      tabIndex={-1}
      style={{ top: at.top, left: at.left, maxHeight: `calc(100dvh - ${at.top + 12}px)` }}
      onKeyDown={(e) => {
        // Keys used in here don't reach the office's shortcuts or movement.
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose(true);
        } else if (e.key === 'Tab') {
          popoverTab(e, onClose);
        }
      }}
      onBlur={(e) => {
        // Close once the focus moves on elsewhere (the chip opens and closes it itself).
        const to = e.relatedTarget;
        if (to && !e.currentTarget.contains(to) && !chipRef.current?.contains(to)) onClose();
      }}
    >
      {hasPlace && !changing ? (
        <Details onChangeLocation={() => setChanging(true)} />
      ) : (
        <>
          <h3>{hasPlace ? 'Change location' : 'Your local weather'}</h3>
          {!hasPlace && <p className="muted small">Choose a city or use your device’s location.</p>}
          <LocationPicker autoFocus={changing} onDone={() => setChanging(false)} />
          {hasPlace && (
            <button type="button" className="btn small" onClick={() => setChanging(false)}>
              Back
            </button>
          )}
        </>
      )}
      <p className="weather-credit small">
        <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">
          Weather data by Open-Meteo.com
        </a>
      </p>
    </div>
  );
}

/** The weather in the top bar (condition, temperature, place); click it for details and to change the place. */
export function WeatherChip() {
  const enabled = useWeather((s) => s.prefs.enabled);
  const available = useWeather((s) => s.available);
  const units = useWeather((s) => s.prefs.units);
  const place = useWeather((s) => s.place);
  const report = useWeather((s) => s.report);
  const { open, setOpen, close, ref, menuRef, buttonRef } = usePopover();
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const shown = enabled && !!available;

  // In a portal (so it shows above the video strip and the side panel), under the chip. It follows
  // the chip while rows above it in the top bar come and go (the zone, the music) and the window resizes.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const bar = ref.current?.parentElement;
    if (!open || !shown || !button || !bar) return;
    const follow = () => {
      const r = button.getBoundingClientRect();
      setAt((prev) => (prev?.top === r.bottom + 8 && prev.left === r.left ? prev : { top: r.bottom + 8, left: r.left }));
    };
    follow();
    const rows = new ResizeObserver(follow);
    rows.observe(bar);
    window.addEventListener('resize', follow);
    return () => {
      rows.disconnect();
      window.removeEventListener('resize', follow);
    };
  }, [open, shown, buttonRef, ref]);

  if (!shown) return null;
  // The name has the words the chip shows in it (for voice control).
  const label = report && place ? `Weather: ${formatTemp(report.tempC, units, true)}, ${describe(report.code)}, ${placeName(place)}` : place ? `Weather: ${placeName(place)}` : 'Weather';
  return (
    <div className="weather" ref={ref}>
      <button
        ref={buttonRef}
        className="weather-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? POPOVER_ID : undefined}
        aria-label={label}
        title="Weather"
      >
        {report ? (
          <>
            <ConditionIcon code={report.code} isDay={report.isDay} size={18} />
            <span className="weather-temp">{formatTemp(report.tempC, units)}</span>
            {place?.name && <span className="weather-place">{place.name}</span>}
          </>
        ) : place ? (
          <>
            <SunCloudIcon size={18} />
            <span className="weather-place">{placeName(place)}</span>
          </>
        ) : (
          <>
            <PinIcon size={16} />
            Weather
          </>
        )}
      </button>
      {open && at && createPortal(<WeatherPopover menuRef={menuRef} chipRef={ref} at={at} onClose={close} />, document.body)}
    </div>
  );
}
