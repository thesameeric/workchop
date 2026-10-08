import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { saveAccountSettings } from '../lib/account';
import { media, type NoiseState } from '../lib/media';
import type { NoiseMode } from '../lib/noise';
import { createRegistry } from '../lib/registry';
import { getSession } from '../lib/session';
import { setTheme, useTheme, type Theme } from '../lib/theme';
import { ComputerIcon, EnhancedMicIcon, HeadphonesIcon, MicIcon, MoonIcon, PaletteIcon, SunIcon, type IconComponent } from './icons';
import { useMediaState, VideoView } from './media';

/** A section of the Settings window (opened from the dock). */
export interface SettingsSection {
  id: string;
  title: string;
  icon: IconComponent;
  /** Position in the list: Appearance 10, Audio & video 20. */
  order: number;
  /** The section's content, under its title. */
  Component: ComponentType;
}

const sections = createRegistry<SettingsSection>();

/** Adds a settings section (call it when your module loads); returns a function that removes it. */
export const registerSettingsSection = sections.register;
export const useSettingsSections = sections.useList;

function DeviceSelect({ label, kind, devices }: { label: string; kind: 'audioIn' | 'videoIn' | 'audioOut'; devices: MediaDeviceInfo[] }) {
  const domKind = kind === 'audioIn' ? 'audioinput' : kind === 'videoIn' ? 'videoinput' : 'audiooutput';
  const list = devices.filter((d) => d.kind === domKind);
  const [value, setValue] = useState(media.selectedDevice(kind) ?? '');
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={value}
        disabled={!list.length}
        onChange={async (e) => {
          setValue(e.target.value);
          await media.setDevice(kind, e.target.value);
          if (kind === 'audioOut') getSession()?.refreshAudioOutput();
        }}
      >
        {!list.length && <option value="">Not available</option>}
        {list.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

const NOISE_MODES: { id: NoiseMode; label: string; Icon: IconComponent }[] = [
  { id: 'standard', label: 'Standard', Icon: MicIcon },
  { id: 'enhanced', label: 'Enhanced', Icon: EnhancedMicIcon },
];

function noiseNote(noise: NoiseState): string {
  if (noise.mode === 'standard') return 'Your browser’s built-in filter.';
  if (noise.status === 'failed') return `${noise.error} Using standard for now.`;
  if (noise.status === 'loading') return 'Loading…';
  if (noise.status === 'waiting') return 'Starts with your next click.';
  return 'Also removes typing, fans and chatter behind you. Uses a bit more battery.';
}

function NoiseSuppression({ noise }: { noise: NoiseState }) {
  return (
    <div className="field">
      <span id="noise-label">Noise suppression</span>
      <div className="theme-options two" role="group" aria-labelledby="noise-label">
        {NOISE_MODES.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={noise.mode === id}
            className={`theme-option${noise.mode === id ? ' active' : ''}`}
            // Choosing it again after a failure tries again.
            onClick={() => (noise.mode !== id || noise.status === 'failed') && media.setNoise(id)}
          >
            <Icon size={22} />
            {label}
          </button>
        ))}
      </div>
      <p className={`small noise-note${noise.status === 'failed' ? ' failed' : ' muted'}`} role="status">
        {noiseNote(noise)}
      </p>
    </div>
  );
}

function DevicesSection() {
  const m = useMediaState();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void media.listDevices().then(setDevices);
  }, [m.version]);
  const preview = useMemo(() => (m.cam && media.camTrack ? new MediaStream([media.camTrack]) : null), [m.cam, m.version]);
  const outputSupported = 'setSinkId' in HTMLMediaElement.prototype;
  return (
    <>
      <div className="device-preview">
        {preview ? <VideoView stream={preview} mirror /> : <div className="device-off">Camera is off</div>}
      </div>
      <DeviceSelect label="Microphone" kind="audioIn" devices={devices} />
      <NoiseSuppression noise={m.noise} />
      <DeviceSelect label="Camera" kind="videoIn" devices={devices} />
      {outputSupported && <DeviceSelect label="Speakers" kind="audioOut" devices={devices} />}
    </>
  );
}

const THEMES: { id: Theme; label: string; Icon: IconComponent }[] = [
  { id: 'system', label: 'System', Icon: ComputerIcon },
  { id: 'light', label: 'Light', Icon: SunIcon },
  { id: 'dark', label: 'Dark', Icon: MoonIcon },
];

function AppearanceSection() {
  const theme = useTheme();
  return (
    <div className="field">
      <span id="theme-label">Theme</span>
      <div className="theme-options" role="group" aria-labelledby="theme-label">
        {THEMES.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={theme === id}
            className={`theme-option${theme === id ? ' active' : ''}`}
            onClick={() => {
              setTheme(id);
              // Signed in, it follows you to your other devices; not being able to save it is no matter.
              saveAccountSettings({ theme: id }).catch(() => {});
            }}
          >
            <Icon size={22} />
            {label}
          </button>
        ))}
      </div>
      <p className="muted small">System follows your device’s light or dark setting.</p>
    </div>
  );
}

registerSettingsSection({ id: 'appearance', title: 'Appearance', icon: PaletteIcon, order: 10, Component: AppearanceSection });
registerSettingsSection({ id: 'devices', title: 'Audio & video', icon: HeadphonesIcon, order: 20, Component: DevicesSection });
