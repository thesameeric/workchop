import { useId } from 'react';
import { PinIcon } from '../../../ui/icons';
import { setPrefs } from '../data';
import { placeDetail, resolvePlace, sourceLine } from '../places';
import { useWeather, type WeatherPrefs } from '../state';
import { LocationPicker } from './LocationPicker';

const UNITS: { id: WeatherPrefs['units']; label: string }[] = [
  { id: 'c', label: 'Celsius' },
  { id: 'f', label: 'Fahrenheit' },
];

function Switch({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  const hintId = useId();
  return (
    <div className="weather-switch">
      <label>
        <span>{label}</span>
        <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-describedby={hintId} onChange={(e) => onChange(e.target.checked)} />
      </label>
      <p className="muted small" id={hintId}>
        {hint}
      </p>
    </div>
  );
}

/** Settings > Weather. */
export function WeatherSettings() {
  const prefs = useWeather((s) => s.prefs);
  const here = useWeather((s) => s.here);
  // Where the weather would come from, also while it's off.
  const { source, place } = resolvePlace({ ...prefs, enabled: true }, here);
  const detail = source === 'city' && place ? placeDetail(place) : '';
  return (
    <>
      <Switch
        label="Show my local weather"
        hint="The office follows the weather and time of day where you are."
        checked={prefs.enabled}
        onChange={(enabled) => setPrefs({ enabled })}
      />
      <div className="field">
        <span id="weather-units-label">Units</span>
        <div className="theme-options weather-units" role="group" aria-labelledby="weather-units-label">
          {UNITS.map(({ id, label }) => (
            <button key={id} type="button" aria-pressed={prefs.units === id} className={`theme-option${prefs.units === id ? ' active' : ''}`} onClick={() => setPrefs({ units: id })}>
              <span className="weather-unit" aria-hidden>
                °{id.toUpperCase()}
              </span>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Location</span>
        {/* Read out when it changes, as the focus stays in the picker below. */}
        <p className="weather-source" aria-live="polite">
          <PinIcon size={16} />
          {sourceLine(source, place)}
          {detail && `, ${detail}`}
        </p>
        <LocationPicker />
      </div>
      <Switch
        label="Show my weather and local time to others"
        hint="People in the office see them next to your name. Never your location."
        checked={prefs.share}
        disabled={!prefs.enabled}
        onChange={(share) => setPrefs({ share })}
      />
      <p className="weather-credit small">
        <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">
          Weather data by Open-Meteo.com
        </a>
      </p>
    </>
  );
}
