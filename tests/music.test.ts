import { describe, expect, it } from 'vitest';
import {
  audibleJukebox,
  jukeboxData,
  musicVolumeAt,
  MAX_LINKS,
  parseSpotifyLink,
  sanitizeJukeboxData,
  sanitizeSessionUpdate,
  sessionPosition,
  sourceOf,
  trackAt,
} from '../shared/music';
import { applyOp, sanitizeOffice } from '../shared/office';
import { createFromTemplate } from '../shared/templates';
import type { Office, OfficeItem } from '../shared/types';
import { applyMusicOp } from '../server/music';

describe('parseSpotifyLink', () => {
  it('accepts share links, locale links, URIs and Jam invites', () => {
    expect(parseSpotifyLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123')).toEqual({
      url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      kind: 'playlist',
      uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    });
    expect(parseSpotifyLink('https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC')?.uri).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(parseSpotifyLink('spotify:album:1DFixLWuPkv3KT3TnV35m3')?.url).toBe('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3');
    expect(parseSpotifyLink('https://spotify.link/AbCdEf1234')).toEqual({ url: 'https://spotify.link/AbCdEf1234', kind: 'jam' });
    expect(parseSpotifyLink('https://open.spotify.com/socialsession/abc-DEF_123')?.kind).toBe('jam');
  });

  it('rejects anything else', () => {
    for (const bad of [
      'http://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://evil.example/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://open.spotify.com.evil.example/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://open.spotify.com/user/someone',
      'https://open.spotify.com/track/<script>',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(parseSpotifyLink(bad), bad).toBeNull();
    }
  });
});

describe('jukebox data', () => {
  it('keeps only valid links, https streams and real stations', () => {
    const links = Array.from({ length: MAX_LINKS + 5 }, (_, i) => ({ id: `l${i}`, url: `https://open.spotify.com/track/4uLU6hMCjMI75M1A2tK${String(i).padStart(3, '0')}`, by: 'A', byId: 'x', at: 1 }));
    const data = sanitizeJukeboxData({
      station: 'stream',
      stream: 'http://insecure.example/stream',
      links: [...links, { id: 'bad', url: 'https://example.com', by: 'A' }, { id: 'l0', url: links[0].url }],
      tracks: [{ url: 'https://example.com/a.mp3', title: 'A' }, { url: 'ftp://x/b.mp3' }],
    });
    expect(data.station).toBeNull(); // stream rejected (not https), so nothing plays
    expect(data.stream).toBeUndefined();
    expect(data.links).toHaveLength(MAX_LINKS);
    expect(data.tracks).toEqual([{ url: 'https://example.com/a.mp3', title: 'A' }]);
    expect(sanitizeJukeboxData({ station: 'lofi' }).station).toBe('lofi');
    expect(sanitizeJukeboxData({ station: 'tracks' }).station).toBeNull();
    expect(sanitizeJukeboxData({ station: 'kiss-fm' }).station).toBeNull();
  });

  it('names untitled tracks after their file, even with broken %-escapes', () => {
    const tracks = sanitizeJukeboxData({ station: 'tracks', tracks: [{ url: 'https://x.example/m/Morning%20Coffee.mp3' }, { url: 'https://x.example/%ZZ.mp3' }] }).tracks;
    expect(tracks?.map((t) => t.title)).toEqual(['Morning Coffee.mp3', '%ZZ.mp3']);
  });

  it('round-trips through office sanitising', () => {
    const office = createFromTemplate('startup', 'abc', 'Name');
    const jukebox = office.items.find((i) => i.type === 'jukebox')!;
    expect(sourceOf(jukebox)?.kind).toBe('generated');
    expect(sanitizeOffice(JSON.parse(JSON.stringify(office)))).toEqual(office);
  });
});

describe('track timing', () => {
  const tracks = [
    { url: 'https://x/a.mp3', title: 'a', durationMs: 10_000 },
    { url: 'https://x/b.mp3', title: 'b', durationMs: 20_000 },
  ];
  it('finds the track and offset, looping', () => {
    expect(trackAt(tracks, 1000, 1000)).toEqual({ index: 0, offsetMs: 0 });
    expect(trackAt(tracks, 1000, 16_000)).toEqual({ index: 1, offsetMs: 5000 });
    expect(trackAt(tracks, 1000, 1000 + 30_000 + 2000)).toEqual({ index: 0, offsetMs: 2000 });
  });
  it('plays only tracks whose length is known', () => {
    const c = { url: 'https://x/c.mp3', title: 'c' };
    expect(trackAt([c], 0, 5)).toBeNull();
    // c (unmeasured or broken) is skipped: indexes still point into the full list.
    expect(trackAt([c, ...tracks], 1000, 16_000)).toEqual({ index: 2, offsetMs: 5000 });
    expect(trackAt([tracks[0], c, tracks[1]], 1000, 12_000)).toEqual({ index: 2, offsetMs: 1000 });
  });
  it('projects listen-along positions with the server clock', () => {
    const s = { positionMs: 1000, at: 50_000, paused: false, durationMs: 200_000 };
    expect(sessionPosition(s, 53_000)).toBe(4000);
    expect(sessionPosition({ ...s, paused: true }, 53_000)).toBe(1000);
    expect(sessionPosition({ ...s, durationMs: 2000 }, 53_000)).toBe(2000);
  });
});

describe('who hears the music', () => {
  const base = createFromTemplate('blank', 'b', 'B');
  const jukebox: OfficeItem = { id: 'j', type: 'jukebox', x: 10, z: 8, rot: 0, data: { station: 'lofi', links: [] } };
  const office: Office = applyOp(base, { t: 'add', item: jukebox });
  const placed = office.items.find((i) => i.id === 'j')!;

  it('fades with distance in the open', () => {
    expect(musicVolumeAt(office, placed, 10, 9)).toBe(1);
    const mid = musicVolumeAt(office, placed, 14, 8);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(musicVolumeAt(office, placed, 18, 8)).toBe(0);
  });

  it('fills a private area and stays inside it', () => {
    const zoned = applyOp(office, { t: 'zone:add', zone: { id: 'z', name: 'Lounge', x: 6, z: 4, w: 8, d: 8, color: '#ff9f6c' } });
    const j = zoned.items.find((i) => i.id === 'j')!;
    expect(musicVolumeAt(zoned, j, 6.5, 4.5)).toBe(1); // far corner of the area
    expect(musicVolumeAt(zoned, j, 14.5, 8)).toBe(0); // just outside it
    expect(audibleJukebox(zoned, 7, 5)?.item.id).toBe('j');
    expect(audibleJukebox(zoned, 15, 8)).toBeNull();
  });

  it("an open-air jukebox doesn't leak into private areas", () => {
    const zoned = applyOp(office, { t: 'zone:add', zone: { id: 'z', name: 'Booth', x: 11, z: 8, w: 2, d: 2, color: '#ff9f6c' } });
    const j = zoned.items.find((i) => i.id === 'j')!;
    expect(musicVolumeAt(zoned, j, 11.5, 8.5)).toBe(0);
  });
});

describe('applyMusicOp', () => {
  const office = createFromTemplate('startup', 'm', 'M');
  const jukeboxId = office.items.find((i) => i.type === 'jukebox')!.id;
  const guest = { id: 'g1', name: 'Guest', canEdit: false };
  const editor = { id: 'e1', name: 'Editor', canEdit: true };
  const ok = (r: ReturnType<typeof applyMusicOp>) => {
    if ('error' in r) throw new Error(r.error);
    return r;
  };
  const data = (o: Office) => jukeboxData(o.items.find((i) => i.id === jukeboxId)!);

  it('lets anyone switch built-in stations or turn it off', () => {
    let o = ok(applyMusicOp(office, { t: 'station', itemId: jukeboxId, station: 'ambient' }, guest)).office;
    expect(data(o).station).toBe('ambient');
    o = ok(applyMusicOp(o, { t: 'station', itemId: jukeboxId, station: null }, guest)).office;
    expect(data(o).station).toBeNull();
    expect('error' in applyMusicOp(o, { t: 'station', itemId: jukeboxId, station: 'nope' as never }, guest)).toBe(true);
  });

  it('only editors set up the office’s own stream and tracks; anyone can then play them', () => {
    expect(applyMusicOp(office, { t: 'station', itemId: jukeboxId, station: 'stream', stream: 'https://s.example/live' }, guest)).toHaveProperty('error');
    let o = ok(applyMusicOp(office, { t: 'station', itemId: jukeboxId, station: 'stream', stream: 'https://s.example/live' }, editor)).office;
    o = ok(applyMusicOp(o, { t: 'station', itemId: jukeboxId, station: 'lofi' }, guest)).office;
    o = ok(applyMusicOp(o, { t: 'station', itemId: jukeboxId, station: 'stream' }, guest)).office;
    expect(data(o)).toMatchObject({ station: 'stream', stream: 'https://s.example/live' });

    expect(applyMusicOp(o, { t: 'station', itemId: jukeboxId, station: 'tracks', tracks: [{ url: 'https://x/a.mp3' }] }, guest)).toHaveProperty('error');
    o = ok(applyMusicOp(o, { t: 'station', itemId: jukeboxId, station: 'tracks', tracks: [{ url: 'https://x/a.mp3', title: 'A' }] }, editor)).office;
    expect(data(o).tracks).toEqual([{ url: 'https://x/a.mp3', title: 'A' }]);
  });

  it('takes track lengths from listeners, but only editors can correct them', () => {
    const list = [{ url: 'https://x/a.mp3' }, { url: 'https://x/b.mp3' }];
    let o = ok(applyMusicOp(office, { t: 'station', itemId: jukeboxId, station: 'tracks', tracks: list }, editor)).office;
    const report = (durations: { url: string; durationMs: number }[], who: typeof guest) =>
      applyMusicOp(o, { t: 'track:durations', itemId: jukeboxId, durations }, who);
    // Several lengths in one report; nonsense and unknown tracks are ignored.
    o = ok(report([{ url: 'https://x/a.mp3', durationMs: 123_456 }, { url: 'https://x/zzz.mp3', durationMs: 5000 }, { url: 'https://x/b.mp3', durationMs: 20 }], guest)).office;
    expect(data(o).tracks!.map((t) => t.durationMs)).toEqual([123_456, undefined]);
    // A guest can't change a known length; nothing changes, so nothing is said.
    expect(report([{ url: 'https://x/a.mp3', durationMs: 1000 }], guest)).toEqual({ error: '' });
    // An editor's player can correct it (small differences are ignored).
    expect(report([{ url: 'https://x/a.mp3', durationMs: 124_000 }], editor)).toEqual({ error: '' });
    o = ok(report([{ url: 'https://x/a.mp3', durationMs: 200_000 }], editor)).office;
    expect(data(o).tracks![0].durationMs).toBe(200_000);
    // Saving the list again starts measuring afresh (also ignoring lengths sent with it).
    o = ok(applyMusicOp(o, { t: 'station', itemId: jukeboxId, station: 'tracks', tracks: [{ url: 'https://x/a.mp3', durationMs: 1000 } as never, ...list.slice(1)] }, editor)).office;
    expect(data(o).tracks!.map((t) => t.durationMs)).toEqual([undefined, undefined]);
    expect(applyMusicOp(o, { t: 'track:durations', itemId: jukeboxId, durations: 'x' as never }, guest)).toEqual({ error: '' });
  });

  it('manages the Spotify board', () => {
    const url = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
    const added = ok(applyMusicOp(office, { t: 'link:add', itemId: jukeboxId, url }, guest));
    expect(added.added).toMatchObject({ kind: 'playlist', by: 'Guest', byId: 'g1' });
    expect(applyMusicOp(added.office, { t: 'link:add', itemId: jukeboxId, url: `${url}?si=x` }, editor)).toHaveProperty('error'); // duplicate
    expect(applyMusicOp(office, { t: 'link:add', itemId: jukeboxId, url: 'https://example.com' }, guest)).toHaveProperty('error');
    const linkId = added.added!.id;
    // Someone else can't remove it, but its author or an editor can.
    expect(applyMusicOp(added.office, { t: 'link:remove', itemId: jukeboxId, linkId }, { id: 'g2', name: 'Other', canEdit: false })).toHaveProperty('error');
    expect(data(ok(applyMusicOp(added.office, { t: 'link:remove', itemId: jukeboxId, linkId }, guest)).office).links).toHaveLength(0);
    expect(data(ok(applyMusicOp(added.office, { t: 'link:remove', itemId: jukeboxId, linkId }, editor)).office).links).toHaveLength(0);
    // Titles come only from the server.
    expect(applyMusicOp(added.office, { t: 'link:meta', itemId: jukeboxId, linkId, title: 'Spoofed' }, guest)).toHaveProperty('error');
    const meta = ok(applyMusicOp(added.office, { t: 'link:meta', itemId: jukeboxId, linkId, title: 'Lofi Beats', image: 'https://i.scdn.co/image/abc' }, { ...editor, server: true }));
    expect(data(meta.office).links[0]).toMatchObject({ title: 'Lofi Beats', image: 'https://i.scdn.co/image/abc' });
  });

  it('rejects unknown jukeboxes and non-jukebox items', () => {
    expect(applyMusicOp(office, { t: 'station', itemId: 'nope', station: 'lofi' }, guest)).toHaveProperty('error');
    const desk = office.items.find((i) => i.type === 'desk')!;
    expect(applyMusicOp(office, { t: 'station', itemId: desk.id, station: 'lofi' }, guest)).toHaveProperty('error');
  });
});

describe('listen-along updates', () => {
  it('accepts only well-formed track updates', () => {
    expect(sanitizeSessionUpdate({ uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', name: 'Song', artists: 'Band', durationMs: 1000, positionMs: 5, paused: false })).toMatchObject({ uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' });
    expect(sanitizeSessionUpdate({ uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' })).toBeNull();
    expect(sanitizeSessionUpdate({ uri: 'spotify:track:x' })).toBeNull();
    expect(sanitizeSessionUpdate({ uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', image: 'https://evil.example/x.png' })?.image).toBeUndefined();
  });
});
