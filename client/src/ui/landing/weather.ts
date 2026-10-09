import { useEffect, useState } from 'react';
import type { WeatherHere } from '../../../../shared/weather';

/**
 * Whether this server has the weather on, so the page only mentions it where it's there. Asked once
 * (GET /api/weather/here answers `off` when it isn't); left out until it answers.
 */
export function useWeatherOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    fetch('/api/weather/here', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<WeatherHere>) : null))
      .then((here) => live && here !== null && setOn(!here.off))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return on;
}
