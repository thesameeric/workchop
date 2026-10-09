import type { ReactNode } from 'react';
import {
  AttachIcon,
  BuildingIcon,
  CamIcon,
  ChatIcon,
  ComputerIcon,
  FishIcon,
  GithubIcon,
  HammerIcon,
  HashIcon,
  HeadphonesIcon,
  LockIcon,
  MoonIcon,
  MusicIcon,
  ScreenIcon,
  SunIcon,
  ThreadIcon,
  VolumeIcon,
  type IconComponent,
} from '../icons';
import { BuildPalette, ChatMock, PresenceMock } from './mocks';
import { ProximityDemo } from './ProximityDemo';
import { useWeatherOn } from './weather';

type Item = [IconComponent, string];

/** A small label over a section's heading. */
export function Eyebrow({ Icon, children }: { Icon?: IconComponent; children: ReactNode }) {
  return (
    <p className="lp-eyebrow">
      {Icon && <Icon size={14} />}
      {children}
    </p>
  );
}

/** One feature: its heading, a line and four points beside a picture of it. */
function Block({ id, Icon, eyebrow, title, lead, items, flip = false, children }: { id: string; Icon: IconComponent; eyebrow: string; title: string; lead: string; items: Item[]; flip?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={`lp-section lp-block${flip ? ' flip' : ''}`} aria-labelledby={`${id}-title`}>
      <div className="lp-wrap lp-split">
        <div className="lp-split-text">
          <Eyebrow Icon={Icon}>{eyebrow}</Eyebrow>
          <h2 id={`${id}-title`}>{title}</h2>
          <p className="lp-lead">{lead}</p>
          <ul className="lp-points">
            {items.map(([ItemIcon, text]) => (
              <li key={text}>
                <span className="lp-point-icon">
                  <ItemIcon size={18} />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <div className="lp-split-visual">{children}</div>
      </div>
    </section>
  );
}

/** Talking, presence, Build mode and chat. */
export function Features() {
  const weather = useWeatherOn();
  return (
    <>
      <Block
        id="features"
        Icon={VolumeIcon}
        eyebrow="Proximity voice and video"
        title="Talk like you’re in the same room"
        lead="Walk up to someone and start talking. Voices get quieter as you walk away, and a meeting room keeps the conversation inside."
        items={[
          [VolumeIcon, 'Full volume up close, fading out over a few steps'],
          [LockIcon, 'Meeting rooms: only the people inside hear each other'],
          [ScreenIcon, 'Share your screen with the people you’re talking to'],
          [CamIcon, 'Camera on or off, your choice'],
        ]}
      >
        <ProximityDemo />
      </Block>
      <Block
        id="presence"
        Icon={HeadphonesIcon}
        eyebrow="Presence"
        title="See who’s free without asking"
        lead="Everyone’s name tag shows what they’re up to, so you know when to walk over and when to wait."
        items={[
          [ComputerIcon, 'What you’re working in, like “In Figma”. Pick it yourself or let the desktop helper show it'],
          [HeadphonesIcon, 'Headphones on when you need to focus. People tap you on the shoulder instead'],
          [GithubIcon, 'GitHub reviews and mentions, right in the office'],
          ...(weather ? [[SunIcon, 'The weather and time of day where you are'] satisfies Item] : []),
        ]}
        flip
      >
        <PresenceMock weather={weather} />
      </Block>
      <Block
        id="build"
        Icon={HammerIcon}
        eyebrow="Build mode"
        title="Make the office yours"
        lead="Move desks, add plants and sofas, put a jukebox in the music corner and flip the lights. Everyone sees the change right away."
        items={[
          [BuildingIcon, 'Start from a ready-made office or a blank floor'],
          [MusicIcon, 'A jukebox with built-in lo-fi radio and your own tracks'],
          [FishIcon, 'Fish tanks, plants, ping pong and arcade machines'],
          [MoonIcon, 'Light switches that turn a room’s lights off'],
        ]}
      >
        <figure className="lp-visual lp-shot lp-build-shot" data-reveal="">
          <div className="lp-shot-frame">
            <img
              src="/landing/shot-lounge.webp"
              width={1200}
              height={900}
              loading="lazy"
              decoding="async"
              alt="A lounge corner in a 3D office: someone relaxes on a sofa by an orange rug and coffee table, next to a red jukebox, a yellow armchair, plants and a floor lamp."
            />
          </div>
          <BuildPalette />
        </figure>
      </Block>
      <Block
        id="chat"
        Icon={ChatIcon}
        eyebrow="Chat"
        title="Chat for everything else"
        lead="Channels, direct messages and threads, with files and reactions, all inside the office. When talking isn’t enough, share your screen."
        items={[
          [HashIcon, 'Channels for teams and topics'],
          [ThreadIcon, 'Threads keep side conversations tidy'],
          [AttachIcon, 'Drop in files and images'],
          [ScreenIcon, 'Share your screen from your desk'],
        ]}
        flip
      >
        <ChatMock />
      </Block>
    </>
  );
}
