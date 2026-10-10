import { useState } from 'react';
import { goHome } from '../lib/router';
import { getSession } from '../lib/session';
import { useStore } from '../state/store';
import { LobbyMessage } from './Lobby';

/** This tab stepped aside: you came into this office in another tab or on another device. */
export function Elsewhere() {
  const name = useStore((s) => s.office?.settings.name || 'this office');
  const note = useStore((s) => s.connectionNote);
  const [joining, setJoining] = useState(false);
  const useHere = () => {
    setJoining(true);
    void getSession()?.useHere();
  };
  return (
    <LobbyMessage title="Homeoffice is open in another tab" text={`You’re in ${name} in another tab or on another device. You can be in one place at a time.`}>
      <div className="lobby-message-actions">
        <button className="btn primary wide" autoFocus disabled={joining} onClick={useHere}>
          {joining ? 'Joining…' : 'Use here'}
        </button>
        <button className="btn wide" onClick={() => goHome()}>
          Back home
        </button>
      </div>
      {joining && note && (
        <p className="muted small" role="status">
          {note}
        </p>
      )}
    </LobbyMessage>
  );
}
