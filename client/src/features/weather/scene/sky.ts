import { getMoonPosition, getPosition } from 'suncalc';
import * as THREE from 'three';
import { conditionOf, type WeatherCondition, type WeatherPlace, type WeatherReport } from '../../../../../shared/weather';
import { defaultSceneLighting, type SceneLighting } from '../../../world/lighting';

// What the scene should look like for a place's sun and weather right now. The scene eases towards it.

const { clamp, lerp, smoothstep, DEG2RAD } = THREE.MathUtils;

/** The lowest the light comes from, in degrees: a lower sun casts shadows so long the office disappears in them. */
const MIN_SUN = 20;
const MIN_MOON = 40;

const color = (hex: string) => new THREE.Color(hex);

// The sky by the sun's altitude in degrees: night, dusk, sunset, day. The dark theme's is a dimmer
// one, still blue by day, so the interface stays readable over it.
const SKY: [number, THREE.Color][] = [
  [-18, color('#10152a')],
  [-12, color('#19203e')],
  [-6, color('#45467a')],
  [-1.5, color('#b8848c')],
  [2, color('#ecb790')],
  [7, color('#cbdbef')],
];
const DARK_SKY: [number, THREE.Color][] = [
  [-18, color('#0b0e1c')],
  [-12, color('#121730')],
  [-6, color('#262848')],
  [-1.5, color('#4a3448')],
  [2, color('#5a4048')],
  [7, color('#2b3f62')],
];

// In full daylight, the light from the sky is the fixed daytime look's.
const DAYTIME = defaultSceneLighting();
const DAY_SUN = color('#fff8ef');
const LOW_SUN = color('#ffb070');
const MOON = color('#a9bdff');
const HEMI_NIGHT = color('#cdd5f5');
const HEMI_WARM = color('#ffd2b5');
const HEMI_GREY = color('#e8eaef');
const GROUND_NIGHT = color('#5c5866');

interface Weather {
  /** How much sunlight (or moonlight) gets through. */
  sun: number;
  /** How grey the sky turns, and how bright it stays. */
  grey: number;
  dim: number;
  /** Light from the sky, relative to a clear one. */
  hemi: number;
  wet: number;
}

const WEATHER: Record<WeatherCondition, Weather> = {
  clear: { sun: 1, grey: 0, dim: 1, hemi: 1, wet: 0 },
  'partly-cloudy': { sun: 0.85, grey: 0.3, dim: 0.98, hemi: 1, wet: 0 },
  cloudy: { sun: 0.4, grey: 0.75, dim: 0.88, hemi: 1.05, wet: 0 },
  fog: { sun: 0.35, grey: 0.85, dim: 0.95, hemi: 1.05, wet: 0.15 },
  drizzle: { sun: 0.4, grey: 0.7, dim: 0.78, hemi: 1, wet: 0.45 },
  rain: { sun: 0.3, grey: 0.8, dim: 0.62, hemi: 0.95, wet: 0.85 },
  thunder: { sun: 0.2, grey: 0.85, dim: 0.4, hemi: 0.88, wet: 1 },
  snow: { sun: 0.45, grey: 0.85, dim: 1.03, hemi: 1.1, wet: 0 },
};

function newLook() {
  return {
    /** Background and fog colour. */
    sky: new THREE.Color(),
    sunDir: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(),
    sunIntensity: 0,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 0,
    ambientIntensity: 0,
    /** 1: clear air (the usual far-away fog); 0: thick fog starting near the camera. */
    clearAir: 1,
    /** How lit the ground around the building looks (1: as by day). */
    groundShade: 1,
    wetness: 0,
    /** Cloud shadows: how much of the ground they cover and how dark they are (0–1). */
    cloudCover: 0,
    cloudShadow: 0,
    /** How much rain or snow falls (0–1), and the wind in m/s towards +x (east) and +z (south). */
    precip: 0,
    windX: 0,
    windZ: 0,
  };
}

export type Look = ReturnType<typeof newLook>;

/** The weather scene's state, shared by its parts: the look it eases towards, where it is now, and how lit the air is (for rain and snow). */
export function newFx() {
  return { target: newLook(), current: newLook(), level: 1, ready: false };
}

export type Fx = ReturnType<typeof newFx>;

const EASED = [
  'sunIntensity',
  'hemiIntensity',
  'ambientIntensity',
  'clearAir',
  'groundShade',
  'wetness',
  'cloudCover',
  'cloudShadow',
  'precip',
  'windX',
  'windZ',
] as const;

/** Moves `look` a fraction `k` of the way to `target` (1: all the way). */
export function easeLook(look: Look, target: Look, k: number): void {
  look.sky.lerp(target.sky, k);
  look.sunDir.lerp(target.sunDir, k).normalize();
  look.sunColor.lerp(target.sunColor, k);
  look.hemiSky.lerp(target.hemiSky, k);
  look.hemiGround.lerp(target.hemiGround, k);
  for (const key of EASED) look[key] += (target[key] - look[key]) * k;
}

/** Sets `look` to the scene as it is now (`sky` stands in for the theme's sky), in clear air with no clouds or rain, so the weather can ease in from it. */
export function lookFrom(look: Look, l: SceneLighting, sky: THREE.Color): void {
  look.sky.copy(l.sky ?? sky);
  look.sunDir.copy(l.sunDir);
  look.sunColor.copy(l.sunColor);
  look.sunIntensity = l.sunIntensity;
  look.hemiSky.copy(l.hemiSky);
  look.hemiGround.copy(l.hemiGround);
  look.hemiIntensity = l.hemiIntensity;
  look.ambientIntensity = l.ambientIntensity;
  look.groundShade = l.groundShade;
  look.wetness = l.wetness;
  look.windX = l.windX;
  look.windZ = l.windZ;
  look.clearAir = 1;
  look.cloudCover = look.cloudShadow = look.precip = 0;
}

/**
 * The fog for `clearAir`, with the camera `distance` from you and `farthest` from the office's far corner.
 * Thick fog starts just in front of you, so the office around you stays visible at any zoom, and it
 * thins out over a big office so that even its far corner is less than 70% fogged.
 */
export function fogRange(out: Pick<SceneLighting, 'fogNear' | 'fogFar'>, clearAir: number, distance: number, farthest: number): void {
  const near = distance - 3;
  const far = Math.max(distance + 22, near + 1.6 * (farthest - near));
  out.fogNear = Math.max(0, lerp(near, DAYTIME.fogNear, clearAir));
  out.fogFar = lerp(far, DAYTIME.fogFar, clearAir);
}

const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Roughly how much light falls on the top of things. */
export function brightness(l: Pick<Look, 'hemiIntensity' | 'hemiSky' | 'ambientIntensity' | 'sunIntensity' | 'sunColor'>): number {
  return l.hemiIntensity * luminance(l.hemiSky) + l.ambientIntensity + 0.8 * l.sunIntensity * luminance(l.sunColor);
}

// The fixed daytime look's light, and the least the office ever gets, so it stays easy to read.
export const DAYTIME_BRIGHTNESS = brightness(DAYTIME);
const MIN_BRIGHTNESS = 0.45 * DAYTIME_BRIGHTNESS;

/** Unit vector towards a body at this azimuth (degrees clockwise from north) and altitude; -z is north, +x east. */
function towards(v: THREE.Vector3, azimuth: number, altitude: number): void {
  const a = azimuth * DEG2RAD;
  const e = altitude * DEG2RAD;
  v.set(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a));
}

function skyAt(stops: [number, THREE.Color][], altitude: number, out: THREE.Color): THREE.Color {
  if (altitude <= stops[0][0]) return out.copy(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    const [alt, c] = stops[i];
    if (altitude > alt) continue;
    const [prevAlt, prev] = stops[i - 1];
    return out.lerpColors(prev, c, (altitude - prevAlt) / (alt - prevAlt));
  }
  return out.copy(stops[stops.length - 1][1]);
}

const grey = new THREE.Color();

/** Rain or snow for a condition, if any. */
export function precipitationOf(condition: WeatherCondition | null): 'drizzle' | 'rain' | 'snow' | null {
  if (condition === 'drizzle') return 'drizzle';
  if (condition === 'rain' || condition === 'thunder') return 'rain';
  if (condition === 'snow') return 'snow';
  return null;
}

/** The look for `place` at `date` with `report`'s weather (none yet: a clear sky), for the light or dark theme. */
export function computeLook(out: Look, date: Date, place: WeatherPlace, report: WeatherReport | null, dark: boolean): void {
  const condition = report ? conditionOf(report.code) : null;
  const w = WEATHER[condition ?? 'clear'];
  const sun = getPosition(date, place.lat, place.lon);
  const alt = sun.altitude;
  // 0 at night (sun below -12°), 1 in the day (above 6°), and the warm light around sunset.
  const day = smoothstep(alt, -12, 6);
  const warm = clamp(1 - Math.abs(alt - 1) / 7, 0, 1);

  skyAt(dark ? DARK_SKY : SKY, alt, out.sky);
  grey.setScalar(luminance(out.sky));
  out.sky.lerp(grey, w.grey).multiplyScalar(w.dim);
  // The ground around the building darkens with the sky at night.
  out.groundShade = lerp(0.4, 1, day);

  // The sun when it's up, else the moon; they hand over when both are faint.
  const sunlight = DAYTIME.sunIntensity * smoothstep(alt, -4, 14) * w.sun;
  const moonlight = 0.55 * (1 - smoothstep(alt, -10, -2)) * lerp(0.5, 1, w.sun);
  if (sunlight >= moonlight) {
    towards(out.sunDir, sun.azimuth, Math.max(alt, MIN_SUN));
    out.sunColor.lerpColors(DAY_SUN, LOW_SUN, 1 - smoothstep(alt, 2, 30));
  } else {
    const moon = getMoonPosition(date, place.lat, place.lon);
    towards(out.sunDir, moon.azimuth, Math.max(moon.altitude, MIN_MOON));
    out.sunColor.copy(MOON);
  }
  out.sunIntensity = sunlight + moonlight;

  out.hemiSky.lerpColors(HEMI_NIGHT, DAYTIME.hemiSky, day).lerp(HEMI_WARM, 0.45 * warm).lerp(HEMI_GREY, 0.8 * w.grey);
  out.hemiGround.lerpColors(GROUND_NIGHT, DAYTIME.hemiGround, day);
  out.hemiIntensity = lerp(1.1, DAYTIME.hemiIntensity, day) * w.hemi;
  out.ambientIntensity = lerp(0.32, DAYTIME.ambientIntensity, day) + 0.08 * w.grey;
  // Never darker than the least light: make up the difference with light from the sky.
  const direct = 0.8 * out.sunIntensity * luminance(out.sunColor);
  const diffuse = brightness(out) - direct;
  if (direct + diffuse < MIN_BRIGHTNESS) {
    const k = (MIN_BRIGHTNESS - direct) / diffuse;
    out.hemiIntensity *= k;
    out.ambientIntensity *= k;
  }

  // Visibility in metres: from 3 km down it gets foggy.
  const visibility = report?.visibility ?? null;
  out.clearAir = visibility === null ? 1 : clamp((visibility - 150) / 2850, 0, 1);
  if (condition === 'fog') out.clearAir = Math.min(out.clearAir, visibility === null ? 0.25 : 0.5);
  out.wetness = w.wet;

  const clouds = condition === 'clear' || condition === 'partly-cloudy' || condition === 'cloudy';
  const cover = (report?.cloudCover ?? 0) / 100;
  out.cloudCover = clouds ? Math.min(cover, 0.75) : 0;
  out.cloudShadow = clouds && cover >= 0.1 ? (condition === 'cloudy' ? 0.16 : 0.24) * smoothstep(alt, 0, 12) : 0;

  // Over the last 15 minutes, in mm (snow in cm). Per hour, light rain is about 1 mm and heavy 8+; heavy snow 3+ cm.
  const kind = precipitationOf(condition);
  const perHour = 4 * ((kind === 'snow' ? report?.snowfall : report?.precipitation) ?? 0);
  const least = condition === 'thunder' ? 0.7 : condition === 'rain' ? 0.45 : 0.3;
  out.precip = kind ? clamp(0.3 + 0.7 * Math.sqrt(perHour / (kind === 'snow' ? 3 : 10)), least, 1) : 0;

  // Wind blows from windDir (0: from the north), so it moves things the other way.
  const speed = (report?.windKph ?? 0) / 3.6;
  const from = (report?.windDir ?? 0) * DEG2RAD;
  out.windX = -Math.sin(from) * speed;
  out.windZ = Math.cos(from) * speed;
}

/** A lightning flash `age` seconds after it starts: a short double flicker (0–1). */
export function flashAt(age: number): number {
  if (age < 0.07) return 1;
  if (age < 0.15) return 0.15;
  if (age < 0.25) return 0.8;
  if (age < 0.6) return 0.8 * (1 - (age - 0.25) / 0.35);
  return 0;
}
