// The weather's place in the interface: the chip in the top bar, Settings > Weather, and people's
// shared weather in the People panel. Importing data.ts (through these) starts the weather itself.
import { registerPersonDetail } from '../../../ui/PeoplePanel';
import { SunCloudIcon } from '../../../ui/icons';
import { registerSettingsSection } from '../../../ui/settings';
import { registerTopBarItem } from '../../../ui/topbar';
import { PersonWeather } from './PersonWeather';
import { WeatherChip } from './WeatherChip';
import { WeatherSettings } from './WeatherSettings';
import './weather.css';

registerTopBarItem({ id: 'weather', order: 10, Component: WeatherChip });
registerSettingsSection({ id: 'weather', title: 'Weather', icon: SunCloudIcon, order: 30, Component: WeatherSettings });
registerPersonDetail({ id: 'weather', order: 10, Component: PersonWeather });
