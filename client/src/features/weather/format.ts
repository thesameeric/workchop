import { conditionOf, type WeatherCondition } from '../../../../shared/weather';
import type { WeatherPrefs } from './state';

// Weather in words and numbers, in the units you chose.

type Units = WeatherPrefs['units'];

const CONDITION: Record<WeatherCondition, string> = {
  clear: 'Clear',
  'partly-cloudy': 'Partly cloudy',
  cloudy: 'Cloudy',
  fog: 'Fog',
  drizzle: 'Drizzle',
  rain: 'Rain',
  snow: 'Snow',
  thunder: 'Thunderstorm',
};

/** Names for the WMO codes worth telling apart; the rest go by their condition. */
const CODES: Record<number, string> = {
  1: 'Mostly clear',
  3: 'Overcast',
  48: 'Freezing fog',
  51: 'Light drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Heavy showers',
  85: 'Snow showers',
  86: 'Snow showers',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
};

/** "Light rain", "Partly cloudy"… */
export function describe(code: number): string {
  return CODES[code] ?? CONDITION[conditionOf(code)];
}

/** "24°", or "24°C" with the unit. */
export function formatTemp(tempC: number, units: Units, withUnit = false): string {
  const n = Math.round(units === 'f' ? (tempC * 9) / 5 + 32 : tempC);
  return `${n}°${withUnit ? units.toUpperCase() : ''}`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** "12 km/h NW" (where it blows from), or "Calm". */
export function formatWind(kph: number, fromDeg: number, units: Units): string {
  const n = Math.round(units === 'f' ? kph / 1.609344 : kph);
  if (!n) return 'Calm';
  return `${n} ${units === 'f' ? 'mph' : 'km/h'} ${COMPASS[Math.round((((fromDeg % 360) + 360) % 360) / 45) % 8]}`;
}

/** The last 15 minutes' precipitation (Open-Meteo's current value) as a rate: "1.6 mm/h" or "0.06 in/h". */
export function formatPrecipitation(mm: number, units: Units): string {
  const perHour = mm * 4;
  if (units === 'f') return `${Number((perHour / 25.4).toFixed(2))} in/h`;
  return `${Number(perHour.toFixed(1))} mm/h`;
}

/** "800 m", "2.5 km" or "0.5 mi". */
export function formatVisibility(m: number, units: Units): string {
  if (units === 'f') return `${Number((m / 1609.344).toFixed(1))} mi`;
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${Number((m / 1000).toFixed(1))} km`;
}

// The locale's short time ("3:14 PM", "15:14" or "01:44"): a bare "1:44" could be either.
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'short', timeZone: 'UTC' });

/** The time of day at `ms` where the offset from UTC is `utcOffset` seconds, e.g. "3:14 PM". */
export function clockAt(ms: number, utcOffset: number): string {
  return clock.format(ms + utcOffset * 1000);
}
