import { useEffect, useState, type ReactNode } from 'react';
import { sanitizeName } from '../../../shared/avatar';
import { signOut } from '../lib/account';
import { getSession } from '../lib/session';
import { setState, useStore } from '../state/store';
import { AvatarEditor, AvatarPreview } from './AvatarEditor';
import { CloseIcon } from './icons';
import { ProfileSections } from './Profile';
import { useSettingsSections } from './settings';

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

/** A guest's name and character (signed-in people edit theirs in the profile). */
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

function SettingsModal() {
  const sections = useSettingsSections();
  const [id, setId] = useState<string | null>(null);
  const section = sections.find((s) => s.id === id) ?? sections[0];
  return (
    <Modal title="Settings" onClose={close} className="settings">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map((s) => (
            <button key={s.id} className={s === section ? 'active' : ''} aria-current={s === section} onClick={() => setId(s.id)}>
              <s.icon size={18} />
              {s.title}
            </button>
          ))}
        </nav>
        {section && (
          <section className="settings-body" aria-label={section.title}>
            <h3>{section.title}</h3>
            <section.Component />
          </section>
        )}
      </div>
      <div className="modal-actions">
        <button className="btn primary" onClick={close}>
          Done
        </button>
      </div>
    </Modal>
  );
}

function ProfileModal() {
  const account = useStore((s) => s.account);
  if (!account) return null;
  return (
    <Modal title="Profile" onClose={close} className="wide profile-modal">
      {/* Signing out leaves the office for its lobby, which closes this. */}
      <ProfileSections account={account} onSignOut={() => void signOut()} />
    </Modal>
  );
}

export function Modals() {
  const modal = useStore((s) => s.modal);
  if (modal === 'avatar') return <AvatarModal />;
  if (modal === 'settings') return <SettingsModal />;
  if (modal === 'profile') return <ProfileModal />;
  return null;
}
