import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { getEntry } from '../../../../shared/catalog';
import { FocusBadge } from '../../features/audio/Headphones';
import { AppChip } from '../../features/presence/AppChip';
import { colorFor, initials } from '../../lib/color';
import { FileIcon, GithubIcon, HashIcon, PeopleIcon, SendIcon, SunIcon, ThreadIcon } from '../icons';

// Small pictures of the app made from its own parts (the People list, name tags, chat, the Build
// catalogue), for the landing page. Everyone in them is made up.

/**
 * Someone's colour (`colorFor`) and the ink for their initials, at 4.5:1 or more: white or dark,
 * whichever reads, and where neither does, dark on the colour lightened a little.
 */
export function discColors(name: string): { background: string; color: string } {
  const background = colorFor(name);
  const [h, s, l] = (background.match(/[\d.]+/g) ?? []).map(Number);
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
  if (1.05 / (luminance + 0.05) >= 4.5) return { background, color: '#ffffff' };
  // #1d2030 has a luminance of 0.0145.
  if ((luminance + 0.05) / 0.0645 >= 4.5) return { background, color: '#1d2030' };
  return { background: `color-mix(in srgb, ${background} 75%, #fff)`, color: '#1d2030' };
}

/** Someone's initials on their colour. */
function Disc({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span className="person-avatar lp-disc" style={{ width: size, height: size, ...discColors(name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

// The same people as in the hero: Utibe in Figma, Ama in Notion, Kayode with headphones on.
const PEOPLE: { name: string; status: ReactNode }[] = [
  {
    name: 'Utibe',
    status: (
      <>
        <i className="status-dot available" />
        <AppChip app="figma" variant="list" />
      </>
    ),
  },
  {
    name: 'Ama',
    status: (
      <>
        <i className="status-dot available" />
        <AppChip app="notion" variant="list" />
      </>
    ),
  },
  {
    name: 'Kayode',
    status: (
      <>
        {/* The text says it; the badge's own label would say it twice. */}
        <span aria-hidden="true">
          <FocusBadge size={14} />
        </span>
        Headphones on
      </>
    ),
  },
  {
    name: 'Promise',
    status: (
      <>
        <i className="status-dot busy" />
        Do not disturb
      </>
    ),
  },
  {
    name: 'Deji',
    status: (
      <>
        <i className="status-dot away" />
        Away
      </>
    ),
  },
];

/** The People list, with what everyone is up to. */
export function PresenceMock({ weather }: { weather: boolean }) {
  return (
    <figure className="lp-visual lp-mock-stage" data-reveal="">
      <div className="lp-mock">
        <span className="nametag lp-mock-tag" aria-hidden="true">
          <i className="status-dot" />
          Utibe
          <AppChip app="figma" variant="tag" />
        </span>
        <div className="lp-mock-head">
          <PeopleIcon size={18} />
          People
          <span className="lp-mock-count">{PEOPLE.length} here</span>
        </div>
        <ul className="lp-people">
          {PEOPLE.map((p) => (
            <li key={p.name} className="person">
              <Disc name={p.name} />
              <div className="person-info">
                <strong>{p.name}</strong>
                <span className="lp-person-status">{p.status}</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="lp-mock-chips">
          <span className="lp-mock-chip">
            <GithubIcon size={14} />2 reviews waiting
          </span>
          {weather && (
            <span className="lp-mock-chip">
              <SunIcon size={14} />
              Sunny, 31°
            </span>
          )}
        </div>
      </div>
      <figcaption className="sr-only">An example of the People list with each person’s status.</figcaption>
    </figure>
  );
}

/** A chat channel with a file, a reaction and a thread. */
export function ChatMock() {
  return (
    <figure className="lp-visual lp-mock-stage" data-reveal="">
      <div className="lp-mock lp-chat">
        <div className="lp-mock-head">
          <HashIcon size={18} />
          design
        </div>
        <ol className="lp-chat-list">
          <li className="lp-msg">
            <Disc name="Utibe" size={34} />
            <div className="lp-msg-main">
              <div className="lp-msg-head">
                <strong>Utibe</strong>
                <time>10:42</time>
              </div>
              <p>New lobby layout is up, have a look</p>
              <span className="lp-attach">
                <FileIcon size={16} />
                lobby-v2.png · 240 KB
              </span>
            </div>
          </li>
          <li className="lp-msg">
            <Disc name="Kayode" size={34} />
            <div className="lp-msg-main">
              <div className="lp-msg-head">
                <strong>Kayode</strong>
                <time>10:44</time>
              </div>
              <p>Looks good. Can we move the fish tank?</p>
              <div className="lp-msg-extras">
                <span className="lp-reaction">👍 2</span>
                <span className="lp-replies">
                  <ThreadIcon size={14} />2 replies
                </span>
              </div>
            </div>
          </li>
        </ol>
        <div className="lp-composer" aria-hidden="true">
          <span>Message #design</span>
          <SendIcon size={18} />
        </div>
      </div>
      <figcaption className="sr-only">An example of a chat channel: a message with a file, and a reply with a reaction and a thread.</figcaption>
    </figure>
  );
}

const PALETTE = ['desk', 'sofa', 'jukebox', 'aquarium', 'ping-pong', 'monstera'];

/** A strip of the Build catalogue (it scrolls sideways on phones, and only then takes keyboard focus). */
export function BuildPalette() {
  const strip = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={strip} className="lp-palette" role="region" aria-label="Some of what you can add in Build mode" tabIndex={scrolls ? 0 : undefined}>
      <ul>
        {PALETTE.map((type) => {
          const entry = getEntry(type);
          if (!entry) return null;
          return (
            <li key={type}>
              <span className="lp-palette-icon" aria-hidden="true">
                {entry.icon}
              </span>
              {entry.label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
