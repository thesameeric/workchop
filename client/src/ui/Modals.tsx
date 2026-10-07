import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { sanitizeName } from '../../../shared/avatar';
import { media } from '../lib/media';
import { getSession } from '../lib/session';
import { setTheme, useTheme, type Theme } from '../lib/theme';
import { setState, useStore } from '../state/store';
import { AvatarEditor, AvatarPreview } from './AvatarEditor';
import { CloseIcon, ComputerIcon, HeadphonesIcon, MoonIcon, PaletteIcon, SunIcon } from './icons';
import { useMediaState, VideoView } from './media';

function Modal({ title, children, onClose, className }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className={`modal${className ? ` ${className}` : ''}`} role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <CloseIcon size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const close = () => setState({ modal: 'none' });

function AvatarModal() {
  const me = useStore((s) => s.me);
  const [name, setName] = useState(me.name);
  const [avatar, setAvatar] = useState(me.avatar);
  const clean = sanitizeName(name);
  return (
    <Modal title="Your character" onClose={close} className="wide">
      <div className="character-layout">
        <AvatarPreview avatar={avatar} />
        <AvatarEditor name={name} avatar={avatar} onName={setName} onAvatar={setAvatar} />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!clean}
          onClick={() => {
            getSession()?.updateProfile({ name: clean, avatar });
            close();
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

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
      <DeviceSelect label="Camera" kind="videoIn" devices={devices} />
      {outputSupported && <DeviceSelect label="Speakers" kind="audioOut" devices={devices} />}
    </>
  );
}

const THEMES: { id: Theme; label: string; Icon: typeof SunIcon }[] = [
  { id: 'system', label: 'System', Icon: ComputerIcon },
  { id: 'light', label: 'Light', Icon: SunIcon },
  { id: 'dark', label: 'Dark', Icon: MoonIcon },
];

function AppearanceSection() {
  const theme = useTheme();
  return (
    <div className="field">
      <span id="theme-label">Theme</span>
      <div className="theme-options" role="radiogroup" aria-labelledby="theme-label">
        {THEMES.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={theme === id}
            className={`theme-option${theme === id ? ' active' : ''}`}
            onClick={() => setTheme(id)}
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

// More sections (privacy, integrations…) slot in here.
const SECTIONS = [
  { id: 'appearance', label: 'Appearance', Icon: PaletteIcon, Body: AppearanceSection },
  { id: 'devices', label: 'Audio & video', Icon: HeadphonesIcon, Body: DevicesSection },
] as const;

function SettingsModal() {
  const [section, setSection] = useState<(typeof SECTIONS)[number]>(SECTIONS[0]);
  return (
    <Modal title="Settings" onClose={close} className="settings">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} className={s === section ? 'active' : ''} aria-current={s === section} onClick={() => setSection(s)}>
              <s.Icon size={18} />
              {s.label}
            </button>
          ))}
        </nav>
        <section className="settings-body" aria-label={section.label}>
          <h3>{section.label}</h3>
          <section.Body />
        </section>
      </div>
      <div className="modal-actions">
        <button className="btn primary" onClick={close}>
          Done
        </button>
      </div>
    </Modal>
  );
}

export function Modals() {
  const modal = useStore((s) => s.modal);
  if (modal === 'avatar') return <AvatarModal />;
  if (modal === 'settings') return <SettingsModal />;
  return null;
}
