// The weather's place in the interface: the chip in the top bar, Settings > Weather, and people's
// shared weather in the People panel. Importing data.ts (through these) starts the weather itself.
import { registerPersonDetail } from '../../../ui/PeoplePanel';
import { SunCloudIcon } from '../../../ui/icons';
import { registerSettingsSection } from '../../../ui/settings';
import { registerTopBarItem } from '../../../ui/topbar';
import { PersonWeather } from './PersonWeather';
import { WeatherChip } from './WeatherChip';
import { useWeather } from '../state';
import { WeatherSettings } from './WeatherSettings';
import './weather.css';

registerTopBarItem({ id: 'weather', order: 10, Component: WeatherChip });
registerPersonDetail({ id: 'weather', order: 10, Component: PersonWeather });

// Settings > Weather, unless the server has no weather.
let removeSection: (() => void) | null = null;
const settingsSection = (available: boolean | null) => {
  if (available === false) {
    removeSection?.();
    removeSection = null;
  } else {
    removeSection ??= registerSettingsSection({ id: 'weather', title: 'Weather', icon: SunCloudIcon, order: 40, Component: WeatherSettings });
  }
};
settingsSection(useWeather.getState().available);
useWeather.subscribe((s, prev) => s.available !== prev.available && settingsSection(s.available));
