import type { RemotePlayer } from '../../../state/store';
import { clockAt, formatTemp } from '../format';
import { useWeather } from '../state';
import { ConditionIcon } from './ConditionIcon';

/** Someone's weather and local time on their People row, when they share it (in your units). */
export function PersonWeather({ player }: { player: RemotePlayer }) {
  const units = useWeather((s) => s.prefs.units);
  const weather = player.weather;
  if (!weather) return null;
  return (
    <span className="person-weather muted small">
      <ConditionIcon code={weather.code} isDay={weather.isDay} size={13} labelled />
      {formatTemp(weather.tempC, units)} · {clockAt(Date.now(), weather.utcOffset)}
    </span>
  );
}
