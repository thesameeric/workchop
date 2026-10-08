import type { HTMLAttributes, ReactElement } from 'react';
import { HUGEICONS, type HugeiconName } from './hugeicons';

type P = HTMLAttributes<HTMLSpanElement> & { size?: number };

/** Any of the icons below (e.g. for a panel, a settings section or a toast). */
export type IconComponent = (props: P) => ReactElement;

/** A Hugeicons glyph from the subset font (add new names to icon-names.json, then run `npm run icons`). */
export function icon(name: HugeiconName) {
  const glyph = String.fromCodePoint(HUGEICONS[name]);
  return function Icon({ size = 20, className, style, ...rest }: P) {
    return (
      <span className={className ? `hgi ${className}` : 'hgi'} style={{ fontSize: size, ...style }} aria-hidden {...rest}>
        {glyph}
      </span>
    );
  };
}

export const MicIcon = icon('mic-01');
export const MicOffIcon = icon('mic-off-01');
export const CamIcon = icon('video-01');
export const CamOffIcon = icon('video-off');
export const ScreenIcon = icon('computer-screen-share');
export const SmileIcon = icon('smile');
export const HammerIcon = icon('hammer');
export const ChatIcon = icon('bubble-chat');
export const PeopleIcon = icon('user-multiple');
export const LinkIcon = icon('link-04');
export const SettingsIcon = icon('settings-01');
export const LeaveIcon = icon('logout-01');
export const CloseIcon = icon('cancel-01');
export const RotateIcon = icon('rotate-01');
export const TrashIcon = icon('delete-02');
export const CopyIcon = icon('copy-01');
export const LockIcon = icon('square-lock-02');
export const PinIcon = icon('location-01');
export const ShuffleIcon = icon('shuffle');
export const ExpandIcon = icon('arrow-expand-02');
export const MusicIcon = icon('music-note-03');
export const PlayIcon = icon('play');
export const VolumeIcon = icon('volume-high');
export const VolumeLowIcon = icon('volume-low');
export const VolumeOffIcon = icon('volume-off');
export const HeadphonesIcon = icon('headphones');
export const UserEditIcon = icon('user-edit-01');
export const PaletteIcon = icon('paint-board');
export const HelpIcon = icon('help-circle');
export const SunIcon = icon('sun-03');
export const MoonIcon = icon('moon-02');
export const ComputerIcon = icon('computer');
export const SignInIcon = icon('login-03');
export const SignOutIcon = icon('logout-03');
export const ChevronDownIcon = icon('arrow-down-01');
export const BuildingIcon = icon('building-06');
