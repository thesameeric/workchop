import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { colorFor, initials } from '../lib/color';
import { setState, useStore } from '../state/store';
import { CloseIcon, ExpandIcon, MicOffIcon, ScreenIcon } from './icons';
import { useMediaState, VideoView } from './media';

interface TileProps {
  id: string;
  name: string;
  stream: MediaStream | null;
  videoOn: boolean;
  mic: boolean;
  screen: boolean;
  speaking: boolean;
  self?: boolean;
}

function Tile({ id, name, stream, videoOn, mic, screen, speaking, self }: TileProps) {
  return (
    <div className={`tile${speaking ? ' speaking' : ''}${screen ? ' screen' : ''}`}>
      {videoOn && stream ? (
        <VideoView stream={stream} mirror={self && !screen} contain={screen} />
      ) : (
        <div className="tile-avatar">
          <span style={{ background: colorFor(name) }}>{initials(name)}</span>
        </div>
      )}
      <div className="tile-name">
        {!mic && <MicOffIcon size={12} />}
        {screen && <ScreenIcon size={12} />}
        <span>{self ? `${name} (you)` : name}</span>
      </div>
      {videoOn && stream && (
        <button className="tile-expand" title="Enlarge" onClick={() => setState({ spotlight: id })}>
          <ExpandIcon size={14} />
        </button>
      )}
    </div>
  );
}

function useSelfStream() {
  const m = useMediaState();
  const stream = useMemo(() => (m.videoTrack ? new MediaStream([m.videoTrack]) : null), [m.videoTrack]);
  return { m, stream };
}

function RemoteTile({ id }: { id: string }) {
  const player = useStore((s) => s.players[id]);
  const stream = useStore((s) => s.streams[id] ?? null);
  const speaking = useStore((s) => !!s.speaking[id]);
  if (!player) return null;
  const hasVideo = !!stream?.getVideoTracks().length;
  return (
    <Tile id={id} name={player.name} stream={stream} videoOn={player.cam && hasVideo} mic={player.mic} screen={player.screen} speaking={speaking} />
  );
}

/** Video tiles of the people you're currently close to (plus yourself). */
export function VideoStrip() {
  const linked = useStore(useShallow((s) => Object.keys(s.linked).filter((id) => s.players[id])));
  const name = useStore((s) => s.me.name);
  const selfSpeaking = useStore((s) => !!s.speaking.self);
  const { m, stream } = useSelfStream();
  if (!linked.length) return null;
  return (
    <div className="video-strip">
      <Tile id="self" name={name} stream={stream} videoOn={(m.cam || m.screen) && !!stream} mic={m.mic} screen={m.screen} speaking={selfSpeaking} self />
      {linked.map((id) => (
        <RemoteTile key={id} id={id} />
      ))}
    </div>
  );
}

/** Your own camera bubble when nobody is around. */
export function SelfView() {
  const linkedCount = useStore((s) => Object.keys(s.linked).length);
  const panelOpen = useStore((s) => s.panel !== 'none');
  const { m, stream } = useSelfStream();
  if (linkedCount > 0 || !(m.cam || m.screen) || !stream) return null;
  return (
    <div className={`self-view${panelOpen ? ' beside-panel' : ''}`}>
      <VideoView stream={stream} mirror={!m.screen} contain={m.screen} />
    </div>
  );
}

/** Enlarged view of one person's video, e.g. a screen share. */
export function Spotlight() {
  const id = useStore((s) => s.spotlight);
  const player = useStore((s) => (id && id !== 'self' ? s.players[id] : null));
  const remote = useStore((s) => (id && id !== 'self' ? s.streams[id] : null));
  const myName = useStore((s) => s.me.name);
  const { m, stream: own } = useSelfStream();

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setState({ spotlight: null });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  if (!id) return null;
  const stream = id === 'self' ? own : remote;
  const name = id === 'self' ? `${myName} (you)` : player?.name ?? '';
  const screen = id === 'self' ? m.screen : !!player?.screen;
  return (
    <div className="spotlight" onClick={() => setState({ spotlight: null })}>
      <div className="spotlight-inner" onClick={(e) => e.stopPropagation()}>
        {stream ? <VideoView stream={stream} contain mirror={id === 'self' && !screen} /> : <div className="tile-avatar" />}
        <div className="spotlight-bar">
          <span>{name}</span>
          <button className="icon-btn" onClick={() => setState({ spotlight: null })} title="Close">
            <CloseIcon size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
