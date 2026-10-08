import { lazy } from 'react';
import { registerSceneLayer } from '../../../world/layers';

// Sky, light, fog, rain and snow for your local weather; loaded with the 3D office, not before.
registerSceneLayer({ id: 'weather', order: 10, Component: lazy(() => import('./WeatherScene')) });
