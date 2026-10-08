import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { sanitizeName } from '../../../shared/avatar';
import { saveCharacter } from '../lib/account';
import { fetchOfficeInfo } from '../lib/api';
import { media } from '../lib/media';
import { navigate } from '../lib/router';
import { enterOffice } from '../lib/session';
import { rememberOffice } from '../lib/storage';
import { setState, useStore } from '../state/store';
import { AccountButton, SignInButton } from './Account';
import { AvatarEditor, AvatarPreview } from './AvatarEditor';
import { CamIcon, CamOffIcon, MicIcon, MicOffIcon } from './icons';
import { useMediaState, VideoView } from './media';

type OfficeInfo = { name: string; online: number };

export function Lobby() {
  const officeId = useStore((s) => s.officeId)!;
  const ready = useStore((s) => s.accountReady);
  const accountId = useStore((s) => s.account?.id ?? null);
  const [info, setInfo] = useState<OfficeInfo | null | undefined>(undefined);
  const [unreachable, setUnreachable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    // null means the server answered "not found"; a thrown error means we couldn't ask it.
    fetchOfficeInfo(officeId)
      .then((i) => {
        if (!alive) return;
        setInfo(i);
        setUnreachable(false);
      })
      .catch(() => alive && setUnreachable(true))
      .finally(() => alive && setRetrying(false));
    return () => {
      alive = false;
    };
  }, [officeId, attempt]);

  // Ask for camera/mic once, so people can check how they look before going in.
  useEffect(() => {
    if (!media.audioTrack && !media.camTrack) void media.start();
  }, []);

  if (unreachable) {
    return (
      <div className="lobby centered">
        <div className="card narrow">
          <h2>Can’t reach the server</h2>
          <p className="muted">The Workchop server isn’t responding. Check that it’s running, then try again.</p>
          <button
            className="btn primary"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              setAttempt((n) => n + 1);
            }}
          >
            {retrying ? 'Trying…' : 'Try again'}
          </button>
        </div>
      </div>
    );
  }

  if (info === null) {
    return (
      <div className="lobby centered">
        <div className="card narrow">
          <h2>Office not found</h2>
          <p className="muted">The link may be wrong, or the office was removed.</p>
          <button className="btn primary" onClick={() => navigate('/')}>
            Back home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="lobby">
      <header className="lobby-header">
        <button className="brand link" onClick={() => navigate('/')}>
          <span className="brand-mark">◆</span> Workchop
        </button>
        <div className="lobby-header-end">
          <div className="lobby-office">
            {info ? (
              <>
                <strong title={info.name}>{info.name}</strong>
                <span className="muted">
                  {info.online === 0 ? 'Nobody is here yet' : `${info.online} ${info.online === 1 ? 'person' : 'people'} inside`}
                </span>
              </>
            ) : (
              <span className="muted">Loading…</span>
            )}
          </div>
          {ready && (accountId ? <AccountButton /> : <SignInButton />)}
        </div>
      </header>
      {/* Signed in, the form starts from the account's character: wait to know who you are, and
          start afresh when you sign in or out here. */}
      {ready ? <LobbyForm key={accountId ?? 'guest'} info={info} /> : <p className="lobby-wait muted">Loading…</p>}
    </div>
  );
}

function LobbyForm({ info }: { info: OfficeInfo | undefined }) {
  const officeId = useStore((s) => s.officeId)!;
  const me = useStore((s) => s.me);
  const [name, setName] = useState(me.name);
  const [avatar, setAvatar] = useState(me.avatar);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = useMediaState();

  const preview = useMemo(() => (m.videoTrack ? new MediaStream([m.videoTrack]) : null), [m.videoTrack]);
  const cleanName = sanitizeName(name);

  const join = async (e: FormEvent) => {
    e.preventDefault();
    if (!cleanName) return;
    setJoining(true);
    setError(null);
    setState((s) => ({ me: { ...s.me, name: cleanName, avatar } }));
    void saveCharacter({ name: cleanName, avatar });
    try {
      await enterOffice(officeId);
      rememberOffice(officeId, info?.name ?? officeId);
    } catch (err) {
      setError((err as Error).message);
      setJoining(false);
    }
  };

  return (
    <form className="lobby-body" onSubmit={join}>
      <section className="card lobby-character">
        <h2>Your character</h2>
        <div className="character-layout">
          <AvatarPreview avatar={avatar} />
          <AvatarEditor name={name} avatar={avatar} onName={setName} onAvatar={setAvatar} />
        </div>
      </section>
      <aside className="card lobby-devices">
        <h2>Camera & mic</h2>
        <div className="device-preview">
          {preview && m.cam ? <VideoView stream={preview} mirror /> : <div className="device-off">Camera is off</div>}
          <div className="device-toggles">
            <button type="button" className={`round-btn${m.mic ? '' : ' off'}`} onClick={() => media.setMic(!m.mic)} title={m.mic ? 'Mute' : 'Unmute'}>
              {m.mic ? <MicIcon /> : <MicOffIcon />}
            </button>
            <button type="button" className={`round-btn${m.cam ? '' : ' off'}`} onClick={() => media.setCam(!m.cam)} title={m.cam ? 'Turn camera off' : 'Turn camera on'}>
              {m.cam ? <CamIcon /> : <CamOffIcon />}
            </button>
          </div>
        </div>
        {m.error && <p className="form-error">{m.error}</p>}
        <p className="muted small">
          You’ll hear and see people when you walk close to them. You can change this any time.
        </p>
        <button className="btn primary wide big" disabled={!cleanName || joining || info === undefined}>
          {joining ? 'Joining…' : cleanName ? 'Join office' : 'Enter a name to join'}
        </button>
        {error && <p className="form-error">{error}</p>}
      </aside>
    </form>
  );
}
