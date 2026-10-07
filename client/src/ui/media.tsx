import { useEffect, useRef, useSyncExternalStore } from 'react';
import { media } from '../lib/media';

interface MediaSnapshot {
  mic: boolean;
  cam: boolean;
  screen: boolean;
  videoTrack: MediaStreamTrack | null;
  error: string | null;
  version: number;
}

let snapshot: MediaSnapshot | null = null;
function getSnapshot(): MediaSnapshot {
  if (!snapshot || snapshot.version !== media.version) {
    snapshot = {
      mic: media.micOn,
      cam: media.camOn,
      screen: media.screenOn,
      videoTrack: media.videoTrack,
      error: media.error,
      version: media.version,
    };
  }
  return snapshot;
}

/** Re-render whenever local media (mic/camera/screen) changes. */
export function useMediaState(): MediaSnapshot {
  return useSyncExternalStore((cb) => media.subscribe(cb), getSnapshot);
}

export function VideoView({ stream, mirror = false, contain = false }: { stream: MediaStream; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    void el.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className={`video${mirror ? ' mirror' : ''}${contain ? ' contain' : ''}`} />;
}
