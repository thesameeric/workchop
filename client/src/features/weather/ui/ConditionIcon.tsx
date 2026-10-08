import { useEffect, useState } from 'react';
import { conditionOf, type WeatherCondition } from '../../../../../shared/weather';
import {
  CloudyIcon,
  DrizzleIcon,
  FogIcon,
  MoonCloudIcon,
  MoonIcon,
  RainIcon,
  SnowIcon,
  SunCloudIcon,
  SunIcon,
  ThunderIcon,
  type IconComponent,
} from '../../../ui/icons';
import { describe } from '../format';

/** Each condition's icon by day and by night. */
const ICONS: Record<WeatherCondition, [IconComponent, IconComponent]> = {
  clear: [SunIcon, MoonIcon],
  'partly-cloudy': [SunCloudIcon, MoonCloudIcon],
  cloudy: [CloudyIcon, CloudyIcon],
  fog: [FogIcon, FogIcon],
  drizzle: [DrizzleIcon, DrizzleIcon],
  rain: [RainIcon, RainIcon],
  snow: [SnowIcon, SnowIcon],
  thunder: [ThunderIcon, ThunderIcon],
};

/** The icon for a WMO weather code; `labelled` names the condition for screen readers. */
export function ConditionIcon({ code, isDay, size, labelled }: { code: number; isDay: boolean; size?: number; labelled?: boolean }) {
  const Icon = ICONS[conditionOf(code)][isDay ? 0 : 1];
  return labelled ? <Icon size={size} role="img" aria-hidden={false} aria-label={describe(code)} /> : <Icon size={size} />;
}

/** The time now, refreshed every `ms`. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
