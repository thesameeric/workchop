import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { sanitizeName } from '../../../shared/avatar';
import { media } from '../lib/media';
import { getSession } from '../lib/session';
import { setState, useStore } from '../state/store';
import { AvatarEditor, AvatarPreview } from './AvatarEditor';
import { CloseIcon } from './icons';
import { useMediaState, VideoView } from './media';

function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
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
    <Modal title="Your character" onClose={close} wide>
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

function DevicesModal() {
  const m = useMediaState();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void media.listDevices().then(setDevices);
  }, [m.version]);
  const preview = useMemo(() => (m.cam && media.camTrack ? new MediaStream([media.camTrack]) : null), [m.cam, m.version]);
  const outputSupported = 'setSinkId' in HTMLMediaElement.prototype;
  return (
    <Modal title="Audio & video" onClose={close}>
      <div className="device-preview">
        {preview ? <VideoView stream={preview} mirror /> : <div className="device-off">Camera is off</div>}
      </div>
      <DeviceSelect label="Microphone" kind="audioIn" devices={devices} />
      <DeviceSelect label="Camera" kind="videoIn" devices={devices} />
      {outputSupported && <DeviceSelect label="Speakers" kind="audioOut" devices={devices} />}
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
  if (modal === 'devices') return <DevicesModal />;
  return null;
}
