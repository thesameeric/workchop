import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { WeatherPlace } from '../../../../../shared/weather';
import { getSession } from '../../../lib/session';
import { GpsIcon, SearchIcon } from '../../../ui/icons';
import { searchPlaces, WeatherError } from '../api';
import { chooseAutomatic, chooseCity, clearLocateError, locateMe } from '../data';
import { placeDetail, placeName } from '../places';
import { useWeather } from '../state';

/** Arrow keys move between the results, and up from the first one back to the search box. */
function resultKeys(e: KeyboardEvent<HTMLUListElement>, input: HTMLInputElement | null): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  e.stopPropagation();
  const buttons = [...e.currentTarget.querySelectorAll('button')];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement) + (e.key === 'ArrowDown' ? 1 : -1);
  if (at < 0) input?.focus();
  else buttons[Math.min(at, buttons.length - 1)].focus();
}

/** Search for a city by name (Open-Meteo's geocoding, through the server). */
function CitySearch({ inputRef, autoFocus, onPick }: { inputRef: RefObject<HTMLInputElement | null>; autoFocus?: boolean; onPick: (place: WeatherPlace) => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<WeatherPlace[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const text = q.trim();

  useEffect(() => {
    setError(null);
    setFound(null);
    setSearching(text.length >= 2);
    if (text.length < 2) return;
    const ctrl = new AbortController();
    // Search once typing pauses.
    const timer = setTimeout(() => {
      const selfId = getSession()?.selfId();
      const search = selfId ? searchPlaces(text, selfId, ctrl.signal) : Promise.reject(new Error('Not connected'));
      search.then(
        (places) => {
          if (ctrl.signal.aborted) return;
          setFound(places);
          setSearching(false);
        },
        (err) => {
          if (ctrl.signal.aborted) return;
          setError(err instanceof WeatherError && err.status === 429 ? 'Too many searches. Try again later.' : 'Couldn’t search right now. Try again in a moment.');
          setSearching(false);
        },
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [text]);

  const pick = (place: WeatherPlace) => {
    setQ('');
    onPick(place);
  };

  return (
    <form
      className="weather-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (found?.[0]) pick(found[0]);
      }}
    >
      <div className="weather-search-box">
        <SearchIcon size={16} />
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' || !found?.length) return;
            e.preventDefault();
            listRef.current?.querySelector('button')?.focus();
          }}
          placeholder="Search for a city"
          aria-label="Search for a city"
          maxLength={80}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
        />
      </div>
      {(searching || found?.length === 0) && (
        <p className="muted small" role="status">
          {searching ? 'Searching…' : 'No places found.'}
        </p>
      )}
      {error && (
        <p className="form-error small" role="alert">
          {error}
        </p>
      )}
      {!!found?.length && (
        <ul className="weather-results" aria-label="Places" ref={listRef} onKeyDown={(e) => resultKeys(e, inputRef.current)}>
          {found.map((place, i) => (
            <li key={i}>
              <button type="button" onClick={() => pick(place)}>
                <span>{placeName(place)}</span>
                <span className="muted small">{placeDetail(place)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/**
 * Where your weather comes from: search for a city, use your device's location, or go back to the
 * automatic one (or clear it, when the server can't tell where you are). `onDone` runs once one is
 * chosen; without it, focus that was on a result or button that went away stays in the picker (not in
 * the search box, which would open a phone's keyboard).
 */
export function LocationPicker({ autoFocus, onDone }: { autoFocus?: boolean; onDone?: () => void }) {
  const chosen = useWeather((s) => !!(s.prefs.city || s.prefs.device));
  const automatic = useWeather((s) => !!s.here);
  const locating = useWeather((s) => s.locating);
  const locateError = useWeather((s) => s.locateError);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const done = () => {
    if (onDone) return onDone();
    // After React has removed what was clicked.
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) rootRef.current?.focus();
    });
  };
  // A location error belongs to this visit: it doesn't come back the next time the picker opens.
  useEffect(() => clearLocateError, []);
  return (
    <div className="weather-location" ref={rootRef} tabIndex={-1}>
      <CitySearch
        inputRef={inputRef}
        autoFocus={autoFocus}
        onPick={(place) => {
          chooseCity(place);
          done();
        }}
      />
      <div className="weather-location-actions">
        <button type="button" className="btn small" disabled={locating} onClick={async () => (await locateMe()) && onDone?.()}>
          <GpsIcon size={15} />
          {locating ? 'Locating…' : 'Use my location'}
        </button>
        {chosen && (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              chooseAutomatic();
              done();
            }}
          >
            {automatic ? 'Use automatic' : 'Clear location'}
          </button>
        )}
      </div>
      {locateError && (
        <p className="form-error small" role="alert">
          {locateError}
        </p>
      )}
      <p className="weather-credit small">
        <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">
          Location data based on GeoNames
        </a>
      </p>
    </div>
  );
}
