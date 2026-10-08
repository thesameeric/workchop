import { useState } from 'react';
import { createPortal } from 'react-dom';
import { appInfo } from '../../../../shared/apps';
import { usePopover } from '../../ui/Account';
import { icon } from '../../ui/icons';
import { AppIcon } from './AppChip';
import { usePresence } from './state';
import { StatusPicker } from './StatusPicker';

const StatusIcon = icon('user-status');

/** Next to you in the dock: what you're working in, and a quick menu to change it. */
export function PresenceDockButton() {
  const app = usePresence((s) => s.self?.app ?? null);
  const { open, setOpen, close, ref, menuRef, buttonRef } = usePopover();
  const [at, setAt] = useState({ left: 0, bottom: 0 });
  const toggle = () => {
    // Like the account menu: in a portal, so the dock (which scrolls on phones) doesn't clip it.
    const r = ref.current!.getBoundingClientRect();
    setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 388)), bottom: window.innerHeight - r.top + 12 });
    setOpen((v) => !v);
  };
  const label = app ? appInfo(app).label : null;
  return (
    <div ref={ref}>
      <button
        ref={buttonRef}
        className={`dock-btn presence-btn${open ? ' on' : ''}`}
        onClick={toggle}
        title={label ? `${label}: change what you’re working in` : 'Set what you’re working in'}
        aria-label={label ? `Working in ${label}. Change` : 'Set what you’re working in'}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={app ? { ['--app' as string]: appInfo(app).color } : undefined}
      >
        {app ? <AppIcon app={app} size={20} /> : <StatusIcon />}
        {app && <i className="presence-dot" />}
      </button>
      {open &&
        createPortal(
          <div className="dock-menu" ref={menuRef} style={at}>
            <div className="presence-menu" role="dialog" aria-label="Working in">
              <strong>Working in…</strong>
              <StatusPicker onPicked={() => close(true)} />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
