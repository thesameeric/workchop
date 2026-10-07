import { useEffect, useState, type FormEvent } from 'react';
import {
  isJukebox,
  jukeboxData,
  musicArea,
  STATIONS,
  type MusicLink,
  type SpotifySession,
  type StationChoice,
} from '../../../shared/music';
import type { OfficeItem } from '../../../shared/types';
import { getSession } from '../lib/session';
import { canBuild, setMusicPrefs, setState, useStore } from '../state/store';
import { CloseIcon, LinkIcon } from './icons';

const KIND_LABEL: Record<MusicLink['kind'], string> = {
  track: 'Track',
  album: 'Album',
  playlist: 'Playlist',
  artist: 'Artist',
  episode: 'Episode',
  show: 'Podcast',
  jam: 'Jam invite',
};

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function VolumeControl() {
  const { volume, muted, blocked } = useStore((s) => s.music);
  return (
    <div className="music-volume">
      <button
        className="icon-btn"
        title={muted ? 'Unmute music' : 'Mute music'}
        onClick={() => setMusicPrefs({ muted: !muted })}
        aria-label={muted ? 'Unmute music' : 'Mute music'}
      >
        {muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        onChange={(e) => setMusicPrefs({ volume: Number(e.target.value), muted: false })}
        aria-label="Music volume"
      />
      {blocked && (
        <button className="btn small primary" onClick={() => getSession()?.radio.unblock()}>
          Enable sound
        </button>
      )}
    </div>
  );
}

function RadioSection({ item }: { item: OfficeItem }) {
  const data = jukeboxData(item);
  const editor = canBuild();
  const [editing, setEditing] = useState<'tracks' | 'stream' | null>(null);
  const [tracksText, setTracksText] = useState('');
  const [streamText, setStreamText] = useState('');

  useEffect(() => {
    setTracksText((data.tracks ?? []).map((t) => `${t.title} | ${t.url}`).join('\n'));
    setStreamText(data.stream ?? '');
  }, [data.tracks, data.stream]);

  const choose = (station: StationChoice | null) => getSession()?.music({ t: 'station', itemId: item.id, station });

  const saveTracks = (e: FormEvent) => {
    e.preventDefault();
    const tracks = tracksText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const bar = line.lastIndexOf('|');
        return bar >= 0 ? { title: line.slice(0, bar).trim(), url: line.slice(bar + 1).trim() } : { url: line };
      });
    getSession()?.music({ t: 'station', itemId: item.id, station: 'tracks', tracks });
    setEditing(null);
  };

  const saveStream = (e: FormEvent) => {
    e.preventDefault();
    getSession()?.music({ t: 'station', itemId: item.id, station: 'stream', stream: streamText.trim() });
    setEditing(null);
  };

  const option = (station: StationChoice | null, title: string, subtitle: string, disabled = false) => (
    <button
      key={station ?? 'off'}
      className={`station${data.station === station ? ' active' : ''}`}
      disabled={disabled}
      onClick={() => choose(station)}
    >
      <span className="station-dot" />
      <span className="station-text">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </span>
    </button>
  );

  return (
    <section className="music-section">
      <h3>Radio</h3>
      <p className="muted small">Everyone near the jukebox hears the same thing at the same moment. Anyone can change the station.</p>
      <div className="stations">
        {option(null, 'Off', 'Silence')}
        {STATIONS.map((s) => option(s.id, s.name, `${s.genre} · made live in your browser`))}
        {option('tracks', 'Our tracks', data.tracks?.length ? `${data.tracks.length} track${data.tracks.length > 1 ? 's' : ''}, looped` : 'None added yet', !data.tracks?.length)}
        {option('stream', 'Our live stream', data.stream ? new URL(data.stream).hostname : 'Not set up yet', !data.stream)}
      </div>
      {editor && (
        <div className="music-edit-links">
          <button className="btn small" onClick={() => setEditing(editing === 'tracks' ? null : 'tracks')}>
            {data.tracks?.length ? 'Edit our tracks' : 'Add our own tracks'}
          </button>
          <button className="btn small" onClick={() => setEditing(editing === 'stream' ? null : 'stream')}>
            {data.stream ? 'Change our stream' : 'Add a live stream'}
          </button>
        </div>
      )}
      {editing === 'tracks' && (
        <form className="music-form" onSubmit={saveTracks}>
          <label className="small muted" htmlFor="tracks">
            One audio file per line (MP3, OGG, M4A…), optionally as <code>Title | https://…</code>. Only add music you have the rights to
            play to your team.
          </label>
          <textarea id="tracks" rows={5} value={tracksText} onChange={(e) => setTracksText(e.target.value)} placeholder="Morning Coffee | https://example.com/music/coffee.mp3" />
          <div className="row-end">
            <button type="button" className="btn small" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn small primary">Save & play</button>
          </div>
        </form>
      )}
      {editing === 'stream' && (
        <form className="music-form" onSubmit={saveStream}>
          <label className="small muted" htmlFor="stream">
            An https:// address of a live audio stream your organisation is licensed to play (e.g. your own Icecast server or a business
            music provider).
          </label>
          <input id="stream" value={streamText} onChange={(e) => setStreamText(e.target.value)} placeholder="https://stream.example.com/radio.mp3" />
          <div className="row-end">
            <button type="button" className="btn small" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn small primary">Save & play</button>
          </div>
        </form>
      )}
    </section>
  );
}

function ListenAlong({ item, session }: { item: OfficeItem; session: SpotifySession | undefined }) {
  const status = useStore((s) => s.spotify);
  const selfId = useStore((s) => s.selfId);
  const spotify = getSession()?.spotify;
  if (status.status === 'disabled') return null;
  const mine = session?.dj === selfId;
  return (
    <div className="listen-along">
      <div className="listen-along-head">
        <strong>Listen along</strong>
        <span className="badge">Spotify Premium</span>
      </div>
      {session ? (
        <div className="now-spotify">
          {session.image ? <img src={session.image} alt="" /> : <div className="cover-placeholder">♫</div>}
          <div className="now-spotify-text">
            <strong>{session.name}</strong>
            <span>{session.artists}</span>
            <span className="muted small">
              {mine ? 'You’re the DJ' : `DJ: ${session.djName}`}
              {session.paused ? ' · paused' : ''}
            </span>
          </div>
          <button className="btn small" onClick={() => getSession()?.stopSpotify(item.id)}>
            Stop
          </button>
        </div>
      ) : (
        <p className="muted small">Press “Play for everyone” on a shared link. Everyone connected hears it on their own Spotify, in sync.</p>
      )}
      {status.status === 'ready' ? (
        <div className="row-between small">
          <span className="muted">Spotify connected</span>
          <button className="btn small ghost" onClick={() => spotify?.disconnect()}>
            Disconnect
          </button>
        </div>
      ) : (
        <div className="listen-along-connect">
          <button className="btn small primary" disabled={status.status === 'connecting'} onClick={() => void spotify?.connect()}>
            {status.status === 'connecting' ? 'Connecting…' : session ? 'Connect Spotify to listen along' : 'Connect Spotify'}
          </button>
          <span className="muted small">Your account must be approved by whoever runs this Workchop (Spotify allows a few per app).</span>
        </div>
      )}
      {status.error && <p className="form-error small">{status.error}</p>}
    </div>
  );
}

function SpotifySection({ item }: { item: OfficeItem }) {
  const data = jukeboxData(item);
  const selfId = useStore((s) => s.selfId);
  const session = useStore((s) => s.spotifySessions[item.id]);
  const status = useStore((s) => s.spotify.status);
  const editor = canBuild();
  const [url, setUrl] = useState('');

  const share = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    getSession()?.music({ t: 'link:add', itemId: item.id, url: url.trim() });
    setUrl('');
  };

  const play = async (link: MusicLink) => {
    try {
      await getSession()?.playForEveryone(item.id, link);
    } catch {
      // The error is shown in the listen-along box.
    }
  };

  return (
    <section className="music-section">
      <h3>Spotify</h3>
      <p className="muted small">
        Share playlists, albums, tracks, or a Jam invite (in Spotify: <em>Start a Jam → Share</em>). Everyone opens them in their own
        Spotify app.
      </p>
      <form className="share-form" onSubmit={share}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://open.spotify.com/playlist/…" aria-label="Spotify link" />
        <button className="btn small primary" disabled={!url.trim()}>
          Share
        </button>
      </form>
      <ListenAlong item={item} session={session} />
      <div className="links">
        {data.links.length === 0 && <p className="muted small center">Nothing shared yet.</p>}
        {data.links.map((l) => (
          <div key={l.id} className="link-row">
            {l.image ? <img src={l.image} alt="" /> : <div className="cover-placeholder">{l.kind === 'jam' ? '👥' : '♫'}</div>}
            <div className="link-text">
              <strong>{l.title ?? KIND_LABEL[l.kind]}</strong>
              <span className="muted small">
                {l.title ? `${KIND_LABEL[l.kind]} · ` : ''}
                {l.by} · {ago(l.at)}
              </span>
            </div>
            <div className="link-actions">
              {status === 'ready' && l.uri && l.kind !== 'jam' && (
                <button className="icon-btn" title="Play for everyone (listen along)" onClick={() => void play(l)}>
                  ▶
                </button>
              )}
              <a className="icon-btn" href={l.url} target="_blank" rel="noopener noreferrer" title={l.kind === 'jam' ? 'Join the Jam in Spotify' : 'Open in Spotify'}>
                <LinkIcon size={15} />
              </a>
              {(l.byId === selfId || editor) && (
                <button className="icon-btn" title="Remove" onClick={() => getSession()?.music({ t: 'link:remove', itemId: item.id, linkId: l.id })}>
                  <CloseIcon size={15} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function MusicPanel() {
  const office = useStore((s) => s.office);
  const chosen = useStore((s) => s.musicItemId);
  const nearId = useStore((s) => s.music.nowPlaying?.itemId ?? null);
  const jukeboxes = office?.items.filter(isJukebox) ?? [];
  const item = jukeboxes.find((j) => j.id === chosen) ?? jukeboxes.find((j) => j.id === nearId) ?? jukeboxes[0];

  if (!office || !item) {
    return (
      <div className="panel-body pad">
        <p className="muted">There’s no jukebox in this office yet. In build mode, add one from Fun → Jukebox.</p>
      </div>
    );
  }
  const area = musicArea(office, item);
  return (
    <div className="panel-body music">
      {jukeboxes.length > 1 && (
        <div className="chips pad-x">
          {jukeboxes.map((j, i) => {
            const zone = musicArea(office, j).zone;
            return (
              <button key={j.id} className={`chip${j.id === item.id ? ' active' : ''}`} onClick={() => setState({ musicItemId: j.id })}>
                {zone ? zone.name : `Jukebox ${i + 1}`}
              </button>
            );
          })}
        </div>
      )}
      <div className="music-where">
        <span className="music-where-icon">🎵</span>
        <span>{area.zone ? `Heard by everyone in ${area.zone.name}` : `Heard within ${area.radius} m of the jukebox`}</span>
      </div>
      <VolumeControl />
      <RadioSection item={item} />
      <SpotifySection item={item} />
    </div>
  );
}

/** Small "now playing" chip shown while you can hear a jukebox. */
export function NowPlayingPill() {
  const now = useStore((s) => s.music.nowPlaying);
  const session = useStore((s) => (now ? s.spotifySessions[now.itemId] : undefined));
  const spotifyPlaying = useStore((s) => s.music.spotifyPlaying);
  const { muted, blocked } = useStore((s) => s.music);
  if (!now || (now.kind === 'off' && !session)) return null;
  const title = session && spotifyPlaying ? `${session.name} — ${session.artists}` : now.kind === 'off' && session ? `${session.djName} is playing on Spotify` : now.title;
  return (
    <div className="now-playing">
      <span className={`eq${muted || blocked ? ' still' : ''}`}>
        <i />
        <i />
        <i />
      </span>
      <button className="now-playing-title" onClick={() => setState({ panel: 'music', musicItemId: now.itemId, mode: 'play' })} title="Open the jukebox">
        {title}
      </button>
      {blocked ? (
        <button className="btn small primary" onClick={() => getSession()?.radio.unblock()}>
          Enable sound
        </button>
      ) : (
        <button className="icon-btn" onClick={() => setMusicPrefs({ muted: !muted })} title={muted ? 'Unmute music' : 'Mute music'}>
          {muted ? '🔇' : '🔊'}
        </button>
      )}
    </div>
  );
}
