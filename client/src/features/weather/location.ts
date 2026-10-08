import { roundCoord, type WeatherPlace } from '../../../../shared/weather';

/**
 * Your device's location, rounded to its weather cell right away (the precise one is never kept).
 * Only call it from a click: the browser asks for permission. Throws an Error with a message to show.
 */
export function locateDevice(): Promise<WeatherPlace> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Couldn’t get your location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ name: null, lat: roundCoord(coords.latitude), lon: roundCoord(coords.longitude) }),
      (err) =>
        reject(new Error(err.code === err.PERMISSION_DENIED ? 'Location access is blocked. Choose a city instead.' : 'Couldn’t get your location.')),
      { enableHighAccuracy: false, maximumAge: 3_600_000, timeout: 10_000 },
    );
  });
}
