import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { conditionOf, type WeatherPlace, type WeatherReport } from '../../../../../shared/weather';
import { local } from '../../../lib/positions';
import { useDarkTheme } from '../../../lib/theme';
import { useStore } from '../../../state/store';
import { useSceneColors } from '../../../world/Environment';
import { resetSceneLighting, sceneLighting } from '../../../world/lighting';
import { useWeather } from '../state';
import { CloudShadows } from './CloudShadows';
import { Precipitation } from './Precipitation';
import { brightness, computeLook, DAYTIME_BRIGHTNESS, easeLook, flashAt, fogRange, lookFrom, newFx, precipitationOf } from './sky';

// Your local time of day and weather in your view of the office: sky, sun or moon, fog, cloud shadows,
// rain, snow, lightning, and the wind the plants sway in. It eases into each change; with nothing to show it
// leaves the fixed daytime look.

/** How often the sun moves on (ms), and how quickly the scene follows a change (time constant, s). */
const REFRESH = 20_000;
const EASE = 0.6;

const FLASH_SKY = { light: new THREE.Color('#e4e8ff'), dark: new THREE.Color('#4a5378') };
const WHITE = new THREE.Color('#ffffff');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const onReducedMotion = (cb: () => void) => {
  reducedMotion.addEventListener('change', cb);
  return () => reducedMotion.removeEventListener('change', cb);
};

/** No falling rain or snow, drifting clouds or lightning when the device asks for less motion. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(onReducedMotion, () => reducedMotion.matches);
}

export default function WeatherScene() {
  const enabled = useWeather((s) => s.prefs.enabled);
  // Only once the server says it has weather (WEATHER=off keeps the fixed daytime look).
  const available = useWeather((s) => s.available);
  const place = useWeather((s) => s.place);
  const report = useWeather((s) => s.report);
  const settings = useStore((s) => s.office?.settings);
  if (!enabled || !available || !place || !settings) return null;
  return <LocalWeather place={place} report={report} width={settings.width} depth={settings.depth} />;
}

function LocalWeather({ place, report, width, depth }: { place: WeatherPlace; report: WeatherReport | null; width: number; depth: number }) {
  const dark = useDarkTheme();
  const still = useReducedMotion();
  const building = useStore((s) => s.mode === 'build');
  const { sky } = useSceneColors();
  // Phones and small windows get fewer drops.
  const small = useMemo(() => window.matchMedia('(pointer: coarse), (max-width: 700px)').matches, []);
  // It starts from the scene as it is when it mounts, so the first look eases in like any other change.
  const fx = useMemo(() => {
    const fx = newFx();
    lookFrom(fx.current, sceneLighting, new THREE.Color(sky));
    return fx;
  }, []);
  const skyColor = useMemo(() => new THREE.Color(), []);
  // How far build mode has cleared the air (0–1).
  const clearing = useRef(building ? 1 : 0);
  const flash = useRef({ age: Infinity, wait: 3 + Math.random() * 6 });

  const condition = report ? conditionOf(report.code) : null;
  const thunder = condition === 'thunder' && !still;
  // Keep the last kind of rain or snow while it eases out.
  const precipitation = precipitationOf(condition);
  const [kind, setKind] = useState(precipitation);
  if (precipitation && precipitation !== kind) setKind(precipitation);

  useEffect(() => {
    const update = () => {
      computeLook(fx.target, new Date(), place, report, dark);
      fx.ready = true;
    };
    update();
    const timer = setInterval(update, REFRESH);
    return () => clearInterval(timer);
  }, [fx, place, report, dark]);

  useEffect(() => resetSceneLighting, []);

  // Before the office's own components read sceneLighting this frame.
  useFrame((state, dt) => {
    if (!fx.ready) return;
    const look = fx.current;
    // Straight to the first look if the office hasn't been drawn yet.
    const k = state.gl.info.render.frame > 0 ? 1 - Math.exp(-dt / EASE) : 1;
    easeLook(look, fx.target, k);
    clearing.current += ((building ? 1 : 0) - clearing.current) * k;

    // Lightning every 5–14 s while it thunders.
    let bolt = 0;
    if (thunder) {
      const f = flash.current;
      f.wait -= dt;
      if (f.wait <= 0) {
        f.age = 0;
        f.wait = 5 + Math.random() * 9;
      }
      f.age += dt;
      bolt = flashAt(f.age);
    }

    const l = sceneLighting;
    l.sky = skyColor.copy(look.sky).lerp(FLASH_SKY[dark ? 'dark' : 'light'], 0.5 * bolt);
    l.sunDir.copy(look.sunDir);
    l.sunColor.copy(look.sunColor);
    l.sunIntensity = look.sunIntensity;
    l.hemiSky.copy(look.hemiSky).lerp(WHITE, bolt);
    l.hemiGround.copy(look.hemiGround);
    l.hemiIntensity = look.hemiIntensity + 1.4 * bolt;
    l.ambientIntensity = look.ambientIntensity + 0.2 * bolt;
    l.groundShade = look.groundShade;
    l.wetness = look.wetness;
    l.windX = look.windX;
    l.windZ = look.windZ;
    // No thick fog while you build, so you can see the whole office.
    const air = THREE.MathUtils.lerp(look.clearAir, 1, clearing.current);
    const cam = state.camera.position;
    const distance = Math.hypot(cam.x - local.x, cam.y - 0.9, cam.z - local.z);
    const farthest = Math.hypot(Math.max(cam.x, width - cam.x), cam.y, Math.max(cam.z, depth - cam.z));
    fogRange(l, air, distance, farthest);
    // Rain and snow catch the light around them.
    fx.level = Math.min(1, 0.15 + brightness(look) / DAYTIME_BRIGHTNESS) + bolt;
  }, -1);

  return (
    <>
      <CloudShadows fx={fx} width={width} depth={depth} still={still} />
      {kind && !still && <Precipitation kind={kind} fx={fx} width={width} depth={depth} small={small} />}
    </>
  );
}
