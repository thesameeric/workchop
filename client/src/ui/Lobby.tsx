import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { sanitizeName } from '../../../shared/avatar';
import type { AccessDenied, OfficeInfo, Role } from '../../../shared/workspace';
import { saveCharacter, signOut } from '../lib/account';
import { fetchOfficeInfo, type OfficeLookup } from '../lib/api';
import { media } from '../lib/media';
import { defaultAnswered, goHome, navigate, withNext } from '../lib/router';
import { enterOffice, JoinRefused } from '../lib/session';
import { enteredBefore, forgetGuestToken, getGuestToken, loadDevices, rememberEntered, rememberOffice } from '../lib/storage';
import { canSignIn, dismissToast, getState, setState, toast, useStore } from '../state/store';
import { AccountButton, SignInButton, SignInOptions } from './Account';
import { AvatarEditor, AvatarPreview } from './AvatarEditor';
import { Logo } from './Brand';
import { CamIcon, CamOffIcon, LockIcon, MicIcon, MicOffIcon, UserEditIcon } from './icons';
import { lobbyFor } from './lobbies';
import { useMediaState, VideoView } from './media';

const isMember = (role: Role) => role !== 'guest';

/** Whether the browser already lets this page use the microphone or camera (asking would show a prompt). */
async function granted(name: 'microphone' | 'camera'): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: name as PermissionName })).state === 'granted';
  } catch {
    return false;
  }
}

/**
 * Members who came into this workspace on this browser before go straight in: with the mic and camera
 * as they left them, but only where the browser already allows them (no prompt), else muted.
 */
async function joinStraightIn(officeId: string): Promise<void> {
  const prefs = loadDevices();
  const [mic, cam] = await Promise.all([granted('microphone'), granted('camera')]);
  if (!media.audioTrack && !media.camTrack) await media.start(mic && (prefs.micOn ?? true), cam && (prefs.camOn ?? true));
  await enterOffice(officeId);
  if (!mic && (prefs.micOn ?? true)) micOffToast();
}

/** Where a dialog fills the screen (Settings) and a toast would cover its top. */
const PHONE = '(max-width: 720px)';
const MIC_TOAST_MS = 8000;

/**
 * Says the mic is off. On a phone, not over a dialog: Settings opens on the way in from a billing
 * email's link (?billing), maybe just after, and the toast would cover its section tabs.
 */
function micOffToast(): void {
  const phone = () => matchMedia(PHONE).matches;
  if (phone() && getState().modal !== 'none') return;
  const text = matchMedia('(pointer: coarse)').matches ? 'Your mic is off. Tap the mic to talk.' : 'Your mic is off. Press M to talk.';
  const id = toast(text, { icon: MicOffIcon, action: { label: 'Unmute', run: () => void media.setMic(true) }, duration: MIC_TOAST_MS });
  const stop = useStore.subscribe((s) => {
    if (s.modal === 'none' || !phone()) return;
    stop();
    dismissToast(id);
  });
  setTimeout(stop, MIC_TOAST_MS);
}

export function Lobby() {
  const officeId = useStore((s) => s.officeId)!;
  const ready = useStore((s) => s.accountReady);
  const account = useStore((s) => s.account);
  const accountId = account?.id ?? null;
  const guestLink = useStore((s) => s.linkToken);
  const [lookup, setLookup] = useState<OfficeLookup | undefined>(undefined);
  const [unreachable, setUnreachable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Going straight in (members back on this browser), and whether that failed (then the lobby shows).
  const [straight, setStraight] = useState<'no' | 'joining' | 'failed'>('no');
  const tried = useRef(false);

  // What you'd be here depends on who you are: asked again after signing in or out, or opening a guest link.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    // null means the server answered "not found"; a thrown error means we couldn't ask it.
    fetchOfficeInfo(officeId, getGuestToken(officeId))
      .then((l) => {
        if (!alive) return;
        // A guest link that no longer works is forgotten.
        if (l && 'denied' in l && l.denied === 'link') forgetGuestToken(officeId);
        // Your default workspace turned you away: home instead.
        if (defaultAnswered(officeId, l === null || 'denied' in l)) return;
        setLookup(l);
        setUnreachable(false);
      })
      .catch(() => alive && setUnreachable(true))
      .finally(() => alive && setRetrying(false));
    return () => {
      alive = false;
    };
  }, [officeId, attempt, ready, accountId, guestLink]);

  const info = lookup && !('denied' in lookup) ? lookup : undefined;
  // A feature's own lobby for this visitor (support customers), else the usual one.
  const custom = info && lobbyFor(info);
  // The first time in each workspace (per account, on this browser) is through the lobby: camera and mic first.
  const goStraight = !!info && !!account?.profile.avatar && isMember(info.role) && enteredBefore(account.id, officeId);

  useEffect(() => {
    if (!goStraight || tried.current) return;
    tried.current = true;
    setStraight('joining');
    joinStraightIn(officeId).then(
      () => rememberOffice(officeId, info!.name),
      (err: unknown) => {
        setStraight('failed');
        if (err instanceof JoinRefused && err.reason) setLookup({ denied: err.reason });
        else toast((err as Error).message, 'error');
      },
    );
  }, [goStraight, officeId, info]);

  // Ask for camera/mic once we know you'll stay here, so people can check how they look before going
  // in.
  const showLobby = ready && lookup !== undefined && (!goStraight || straight === 'failed');
  const startMic = custom?.media?.mic;
  const startCam = custom?.media?.cam;
  useEffect(() => {
    if (showLobby && !media.audioTrack && !media.camTrack) void media.start(startMic, startCam).then(() => elsewhere() && media.stopAll());
  }, [showLobby, startMic, startCam]);
  // Off to another page (not into the office), they go off again; checked once this render is done,
  // as React also unmounts and remounts once in development.
  useEffect(() => () => void setTimeout(() => elsewhere() && media.stopAll()), []);

  const retry = () => {
    setRetrying(true);
    setAttempt((n) => n + 1);
  };

  if (unreachable) {
    return (
      <LobbyMessage title="Can’t reach the server" text="The Homeoffice server isn’t responding. Check that it’s running, then try again.">
        <button className="btn primary" disabled={retrying} onClick={retry}>
          {retrying ? 'Trying…' : 'Try again'}
        </button>
      </LobbyMessage>
    );
  }

  if (lookup === null) {
    return (
      <LobbyMessage title="Office not found" text="The link may be wrong, or the office was removed.">
        <button className="btn primary" onClick={() => goHome()}>
          Back home
        </button>
      </LobbyMessage>
    );
  }

  if (lookup && 'denied' in lookup) return <AccessDeniedPage reason={lookup.denied} />;

  return (
    <div className="lobby">
      <LobbyHeader>
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
      </LobbyHeader>
      {/* Wait to know who you are and what this workspace is: signed in, you come in as your profile
          says; guests pick a name and a character here; some workspaces have a lobby of their own. */}
      {!ready || !info || (goStraight && straight !== 'failed') ? (
        <p className="lobby-wait muted">{straight === 'joining' ? 'Joining…' : 'Loading…'}</p>
      ) : custom ? (
        <custom.Component info={info} />
      ) : accountId ? (
        <SignedInJoin info={info} />
      ) : (
        <LobbyForm info={info} />
      )}
    </div>
  );
}

/** Not on a page of this office any more (left it for another page). */
const elsewhere = () => getState().phase !== 'lobby' && getState().phase !== 'office';

function LobbyHeader({ children }: { children?: ReactNode }) {
  const ready = useStore((s) => s.accountReady);
  const signedIn = useStore((s) => !!s.account);
  return (
    <header className="lobby-header">
      <button className="brand link" onClick={() => goHome()}>
        <Logo />
      </button>
      <div className="lobby-header-end">
        {children}
        {ready && (signedIn ? <AccountButton /> : <SignInButton />)}
      </div>
    </header>
  );
}

/** A page with a message and what to do (also a feature page's, like billing's return page). */
export function LobbyMessage({ title, text, locked, children }: { title: string; text: ReactNode; locked?: boolean; children?: ReactNode }) {
  return (
    <div className="lobby">
      <LobbyHeader />
      <div className="lobby-message">
        <div className="card narrow">
          {locked && (
            <span className="auth-icon">
              <LockIcon size={24} />
            </span>
          )}
          <h2>{title}</h2>
          <p className="muted">{text}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Why you can't come in (GET /api/offices/:id answered 403), and what to do about it. */
function AccessDeniedPage({ reason }: { reason: AccessDenied }) {
  const account = useStore((s) => s.account);
  const signIn = useStore(canSignIn);
  const officeId = useStore((s) => s.officeId);
  const home = (
    <button className="btn wide" onClick={() => goHome()}>
      Back home
    </button>
  );
  // Its plan lapsed (shared/billing.ts): only the owner and admins can come in. Only members are told
  // why; someone with its guest (or customer) link is a visitor, signed in or not.
  if (reason === 'locked') {
    const member = !!account && !(officeId && getGuestToken(officeId));
    return (
      <LobbyMessage
        title={member ? 'Paused' : 'Closed for now'}
        text={member ? 'This workspace is paused until its owner pays for it.' : 'This workspace isn’t open right now. Please try again later.'}
        locked
      >
        {home}
      </LobbyMessage>
    );
  }
  if (account && reason === 'members-only') {
    return (
      <LobbyMessage
        title="Members only"
        locked
        text={
          <>
            You’re signed in as <strong>{account.name}</strong>. Ask an admin to add {account.email ? <strong>{account.email}</strong> : 'you'}.
          </>
        }
      >
        <div className="lobby-message-actions">
          <button className="btn primary wide" onClick={() => void signOut()}>
            Use another account
          </button>
          {home}
        </div>
      </LobbyMessage>
    );
  }
  const text =
    reason === 'link'
      ? `This guest link no longer works. Ask whoever sent it for a new one${account || !signIn ? '' : ', or sign in if you’re a member'}.`
      : 'This workspace is for its members. Sign in with the account they added, or open the guest link you were sent.';
  return (
    <LobbyMessage title={reason === 'link' ? 'Link expired' : 'Members only'} text={text} locked>
      {!account && signIn && (
        <div className="lobby-sign-in">
          <SignInOptions next={location.pathname} />
        </div>
      )}
      {home}
    </LobbyMessage>
  );
}

/** Goes in; `prepare` runs first (a guest's name and character). */
export function useJoin(info: OfficeInfo | undefined, prepare?: () => void) {
  const officeId = useStore((s) => s.officeId)!;
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = async () => {
    setJoining(true);
    setError(null);
    prepare?.();
    try {
      await enterOffice(officeId);
      rememberOffice(officeId, info?.name ?? officeId);
      // Next time, this account goes straight in here.
      const account = getState().account;
      if (account) rememberEntered(account.id, officeId);
    } catch (err) {
      setError((err as Error).message);
      setJoining(false);
    }
  };
  return { join, joining, error };
}

/** Signed in: you come in as your profile says, so only the camera and mic to check. */
function SignedInJoin({ info }: { info: OfficeInfo | undefined }) {
  const me = useStore((s) => s.me);
  const { join, joining, error } = useJoin(info);
  const named = !!sanitizeName(me.name);
  return (
    <form
      className="lobby-body compact"
      onSubmit={(e) => {
        e.preventDefault();
        if (named) void join();
      }}
    >
      <section className="card lobby-me">
        <AvatarPreview avatar={me.avatar} height={240} />
        <p className="lobby-me-line">
          <span className="muted">Joining as</span> <strong title={me.name}>{me.name}</strong>
          {info?.role === 'guest' && <span className="badge neutral">guest</span>}
        </p>
        <button type="button" className="btn small" onClick={() => navigate(withNext('/profile', location.pathname))}>
          <UserEditIcon size={16} /> Edit profile
        </button>
      </section>
      <DeviceCheck joinLabel={named ? 'Join office' : 'Add your name in your profile'} canJoin={named && info !== undefined} joining={joining} error={error} />
    </form>
  );
}

function LobbyForm({ info }: { info: OfficeInfo | undefined }) {
  const me = useStore((s) => s.me);
  const [name, setName] = useState(me.name);
  const [avatar, setAvatar] = useState(me.avatar);
  const cleanName = sanitizeName(name);
  const { join, joining, error } = useJoin(info, () => {
    setState((s) => ({ me: { ...s.me, name: cleanName, avatar } }));
    void saveCharacter({ name: cleanName, avatar });
  });

  return (
    <form
      className="lobby-body"
      onSubmit={(e) => {
        e.preventDefault();
        if (cleanName) void join();
      }}
    >
      <section className="card lobby-character">
        <h2>Your character</h2>
        <div className="character-layout">
          <AvatarPreview avatar={avatar} />
          <AvatarEditor name={name} avatar={avatar} onName={setName} onAvatar={setAvatar} />
        </div>
      </section>
      <DeviceCheck joinLabel={cleanName ? 'Join office' : 'Enter a name to join'} canJoin={!!cleanName && info !== undefined} joining={joining} error={error} />
    </form>
  );
}

/** Camera and mic, to see how you look before going in, and the Join button. */
export function DeviceCheck({
  joinLabel,
  canJoin,
  joining,
  error,
  note = 'You’ll hear and see people when you walk close to them. You can change this any time.',
}: {
  joinLabel: string;
  canJoin: boolean;
  joining: boolean;
  error: string | null;
  /** What happens to your mic and camera inside. */
  note?: string;
}) {
  const m = useMediaState();
  const preview = useMemo(() => (m.videoTrack ? new MediaStream([m.videoTrack]) : null), [m.videoTrack]);
  return (
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
      <p className="muted small">{note}</p>
      <button className="btn primary wide big" disabled={!canJoin || joining}>
        {joining ? 'Joining…' : joinLabel}
      </button>
      {error && <p className="form-error">{error}</p>}
    </aside>
  );
}
