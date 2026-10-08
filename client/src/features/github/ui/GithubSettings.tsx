import { useState } from 'react';
import type { GithubStatus } from '../../../../../shared/github';
import { GithubIcon, WarningIcon } from '../../../ui/icons';
import { connectGithub, disconnectGithub } from '../data';
import { useGithub } from '../state';
import { GithubAvatar, SetupHints, SignInToConnect } from './parts';

const PRIVATE_LABEL = 'Include private repos & Actions';

function RepoWarning() {
  return (
    <p className="gh-warning small">
      <WarningIcon size={16} />
      <span>
        GitHub has no read-only option for this: its <code>repo</code> permission gives full read and write access to all your repositories.
      </span>
    </p>
  );
}

function NotConnected() {
  const connecting = useGithub((s) => s.connecting);
  const [withPrivate, setWithPrivate] = useState(false);
  return (
    <>
      <label className="gh-check">
        <input type="checkbox" checked={withPrivate} onChange={(e) => setWithPrivate(e.target.checked)} />
        {PRIVATE_LABEL}
      </label>
      {withPrivate && <RepoWarning />}
      <button className="btn primary" disabled={connecting} onClick={() => connectGithub(withPrivate ? 'private' : 'basic')}>
        <GithubIcon size={18} />
        {connecting ? 'Connecting…' : 'Connect GitHub'}
      </button>
    </>
  );
}

function Connected({ status }: { status: GithubStatus }) {
  const connecting = useGithub((s) => s.connecting);
  const [busy, setBusy] = useState(false);
  const disconnect = async () => {
    setBusy(true);
    await disconnectGithub();
    setBusy(false);
  };
  return (
    <>
      <div className="gh-account">
        <GithubAvatar status={status} />
        <div className="gh-account-who">
          <strong title={status.login ? `@${status.login}` : undefined}>{status.login ? `@${status.login}` : 'Connected'}</strong>
          <span className="muted small">{status.private ? 'Notifications + private repo details' : 'Notifications'}</span>
        </div>
        <button className="btn small" disabled={busy} onClick={() => void disconnect()}>
          {busy ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>
      {status.needsReconnect && (
        <div className="gh-alert">
          <p className="small">GitHub no longer accepts Workchop’s access. Connect again to see your notifications.</p>
          <button className="btn small primary" disabled={connecting} onClick={() => connectGithub(status.private ? 'private' : 'basic')}>
            {connecting ? 'Connecting…' : 'Reconnect GitHub'}
          </button>
        </div>
      )}
      {status.private ? (
        <p className="muted small">Private repo details are included. To leave them out, disconnect and connect again without them.</p>
      ) : (
        <div className="gh-private">
          <strong>{PRIVATE_LABEL}</strong>
          <p className="muted small">Opens the latest comment directly, and counts reviews and assignments in private repos too.</p>
          <RepoWarning />
          <button className="btn small" disabled={connecting} onClick={() => connectGithub('private')}>
            {connecting ? 'Connecting…' : PRIVATE_LABEL}
          </button>
        </div>
      )}
    </>
  );
}

/** Settings > Integrations: GitHub. */
export function GithubSettings() {
  const availability = useGithub((s) => s.availability);
  const status = useGithub((s) => s.status);
  return (
    <div className="gh-settings">
      <div className="gh-settings-head">
        <GithubIcon size={24} />
        <div>
          <strong>GitHub</strong>
          <p className="muted small">Your mentions, review requests and Actions runs, in a panel in the office.</p>
        </div>
      </div>
      {availability === 'guest' ? (
        <SignInToConnect />
      ) : !status ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {status.connected ? <Connected status={status} /> : <NotConnected />}
          <div className="gh-settings-hints">
            <strong className="small">Not seeing everything?</strong>
            <SetupHints clientId={status.clientId} />
          </div>
        </>
      )}
    </div>
  );
}
