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
export const MoreIcon = icon('more-horizontal');
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
export const HeadphonesOffIcon = icon('headphone-off');
export const TapIcon = icon('tap-01');
export const EnhancedMicIcon = icon('ai-mic');
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
export const AddIcon = icon('add-01');
export const HashIcon = icon('hashtag');
export const AtIcon = icon('at');
export const AttachIcon = icon('attachment-01');
export const BackIcon = icon('arrow-left-01');
export const ArrowDownIcon = icon('arrow-down-02');
export const ThreadIcon = icon('message-multiple-01');
export const EditIcon = icon('edit-02');
export const ReactIcon = icon('smile-plus');
export const FileIcon = icon('file-01');
export const FileZipIcon = icon('file-zip');
export const FilePdfIcon = icon('pdf-01');
export const FileVideoIcon = icon('file-video');
export const FileAudioIcon = icon('file-audio');
export const FileSheetIcon = icon('file-spreadsheet');
export const FileTextIcon = icon('file-text');
export const FileCodeIcon = icon('file-code');
export const DownloadIcon = icon('download-04');
export const SidebarIcon = icon('sidebar-left');
export const ArchiveIcon = icon('archive-02');
export const UnarchiveIcon = icon('archive-restore');
export const SendIcon = icon('sent');
export const AlertIcon = icon('alert-circle');
export const NearbyIcon = icon('radar-01');
export const ExternalIcon = icon('external-link');
export const CoinsIcon = icon('coins-01');
export const WalletIcon = icon('wallet-01');
export const GiftIcon = icon('gift');
export const CalendarCheckIcon = icon('calendar-check-in-01');
export const ClockIcon = icon('clock-01');
export const ArrowUpRightIcon = icon('arrow-up-right-01');
export const ArrowDownLeftIcon = icon('arrow-down-left-01');
export const MinusIcon = icon('minus-sign');
export const PlusIcon = icon('plus-sign');
export const SearchIcon = icon('search-01');
export const GpsIcon = icon('gps-01');
// Weather
export const SunCloudIcon = icon('sun-cloud-02');
export const MoonCloudIcon = icon('moon-cloud');
export const CloudyIcon = icon('cloudy');
export const FogIcon = icon('cloud-fog');
export const DrizzleIcon = icon('cloud-drizzle');
export const RainIcon = icon('cloud-rain');
export const SnowIcon = icon('cloud-snow');
export const ThunderIcon = icon('cloud-angled-zap');
export const WindIcon = icon('fast-wind');
export const DropletIcon = icon('droplet');
export const SunriseIcon = icon('sunrise');
export const SunsetIcon = icon('sunset');
// GitHub
export const GithubIcon = icon('github');
export const PullRequestIcon = icon('git-pull-request');
export const IssueIcon = icon('circle-dot');
export const CommitIcon = icon('git-commit');
export const ActionsIcon = icon('play-circle');
export const SuccessIcon = icon('checkmark-circle-02');
export const FailureIcon = icon('cancel-circle');
export const StoppedIcon = icon('circle-slash');
export const TagIcon = icon('tag-01');
export const BellIcon = icon('notification-01');
export const MarkReadIcon = icon('mail-open-01');
export const CheckIcon = icon('tick-02');
export const CheckAllIcon = icon('tick-double-02');
export const PlugIcon = icon('plug-01');
export const WarningIcon = icon('alert-02');
// World
export const PlantIcon = icon('plant-02');
export const LeafIcon = icon('leaf-01');
export const HumidityIcon = icon('humidity');
export const GaugeIcon = icon('dashboard-speed-01');
export const PawIcon = icon('paw-print');
export const SparklesIcon = icon('sparkles');
export const StickyNoteIcon = icon('sticky-note-02');
export const DeskIcon = icon('desk');
