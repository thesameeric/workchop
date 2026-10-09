import { Component, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { PauseIcon, PlayIcon } from '../ui/icons';
import { CAST } from './cast';
import { arrange, Bubble, NameTag, RoomSign } from './labels';
import { HERO_ALT, POSTER, POSTER_LABELS, type PosterLabel } from './poster';
import './hero3d.css';

// The landing page's hero: a still of the little office, which comes to life (Diorama, three.js)
// once the still is showing and the hero is on screen, on devices that can take it. Under reduced
// motion, with Save-Data or a low battery it stays still until you press Play.

const Diorama = lazy(() => import('./Diorama'));

type Nav = Navigator & {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
  getBattery?: () => Promise<Battery>;
};

interface Battery extends EventTarget {
  charging: boolean;
  level: number;
}

/** Whether WebGL 2 works here (the probe's context is let go straight away). */
function hasWebgl2(): boolean {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('nowebgl')) return false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

/** At least 4 cores and 4 GB, where the browser says. */
function strongEnough(): boolean {
  const nav = navigator as Nav;
  return (nav.hardwareConcurrency || 4) >= 4 && (nav.deviceMemory ?? 4) >= 4;
}

/** Fewer pixels and frames on phones and smaller machines. */
function quality(): 'high' | 'low' {
  const nav = navigator as Nav;
  const small = (nav.hardwareConcurrency || 8) < 8 || (nav.deviceMemory ?? 8) < 8;
  return small || window.matchMedia('(pointer: coarse)').matches ? 'low' : 'high';
}

/**
 * Runs `run` once the poster is on screen (loaded, decoded and painted), the page has loaded and the
 * browser is idle, so the 3D code doesn't compete with the poster or the first paint; returns a
 * cancel function.
 */
function afterPoster(img: HTMLImageElement, run: () => void): () => void {
  let live = true;
  let cancelIdle = () => {};
  const loaded = new Promise<void>((resolve) => {
    if (document.readyState === 'complete') resolve();
    else window.addEventListener('load', () => resolve(), { once: true });
  });
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  // A poster that fails to load doesn't hold the scene back.
  void Promise.all([img.decode().catch(() => {}), loaded])
    .then(frame)
    .then(frame)
    .then(() => {
      if (!live) return;
      if ('requestIdleCallback' in window) {
        const id = requestIdleCallback(run, { timeout: 2000 });
        cancelIdle = () => cancelIdleCallback(id);
      } else {
        const id = setTimeout(run, 1500);
        cancelIdle = () => clearTimeout(id);
      }
    });
  return () => {
    live = false;
    cancelIdle();
  };
}

function useMedia(query: string): boolean {
  const list = useMemo(() => window.matchMedia(query), [query]);
  return useSyncExternalStore(
    (onChange) => {
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => list.matches,
  );
}

function useTabVisible(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
    () => document.visibilityState === 'visible',
  );
}

/** Whether the battery is low and not charging (false where the browser doesn't say). */
function useLowBattery(): boolean {
  const [low, setLow] = useState(false);
  useEffect(() => {
    const nav = navigator as Nav;
    let battery: Battery | null = null;
    let mounted = true;
    const update = () => battery && setLow(!battery.charging && battery.level <= 0.2);
    nav
      .getBattery?.()
      .then((b) => {
        if (!mounted) return;
        battery = b;
        update();
        b.addEventListener('levelchange', update);
        b.addEventListener('chargingchange', update);
      })
      .catch(() => {});
    return () => {
      mounted = false;
      battery?.removeEventListener('levelchange', update);
      battery?.removeEventListener('chargingchange', update);
    };
  }, []);
  return low;
}

/** How much of the stage is on screen (0–1). */
function useVisibleShare(el: RefObject<HTMLElement | null>): number {
  const [share, setShare] = useState(0);
  useEffect(() => {
    const target = el.current;
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => setShare(entry.intersectionRatio), { threshold: [0, 0.01, 0.2] });
    observer.observe(target);
    return () => observer.disconnect();
  }, [el]);
  return share;
}

/** If the 3D scene fails, the still stays (quietly). */
class Fallback extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (import.meta.env.DEV) console.error('The 3D hero failed; showing the still instead.', error);
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The still's labels, where the live scene has them at that moment (made room for the same way). */
function PosterLabels({ labels }: { labels: PosterLabel[] }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      const [w, h] = [el.clientWidth, el.clientHeight];
      const nodes = [...el.children] as HTMLElement[];
      const placed = labels.map((l, i) => ({ group: l.kind === 'sign' ? 'sign' : l.who, kind: l.kind, x: (l.x / 100) * w, y: (l.y / 100) * h, el: nodes[i] }));
      arrange(placed, w, h).forEach((m, i) => {
        nodes[i].style.translate = `${m.dx}px ${m.dy}px`;
        nodes[i].style.setProperty('--shift', `${m.shift}px`);
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [labels]);
  return (
    <div ref={box} className="hero-stage-labels" aria-hidden="true">
      {labels.map((l) => (
        <div
          key={l.kind === 'sign' ? 'sign' : `${l.kind}:${l.who}`}
          className={`world-label${l.kind === 'tag' && !l.speaking ? ' quiet' : ''}`}
          style={{ left: `${l.x}%`, top: `${l.y}%`, transform: `translate(-50%, ${l.kind === 'bubble' ? '-100%' : '-50%'})` }}
        >
          {l.kind === 'sign' ? (
            <RoomSign active={l.active} />
          ) : l.kind === 'bubble' ? (
            <Bubble text={l.text} />
          ) : (
            <NameTag actor={CAST.find((a) => a.id === l.who)!} speaking={l.speaking} inLine={false} />
          )}
        </div>
      ))}
    </div>
  );
}

type Choice = 'auto' | 'play' | 'pause';

/** The hero's 3D office: no props, as wide as its container (4:3, or 6:5 on phones), no outer margin. */
export function HeroStage() {
  const figure = useRef<HTMLElement>(null);
  const narrow = useMedia('(max-width: 639px)');
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const tabVisible = useTabVisible();
  const lowBattery = useLowBattery();
  const share = useVisibleShare(figure);
  const posterImg = useRef<HTMLImageElement>(null);
  /** Whether this device can run it: unknown until the poster is showing. */
  const [able, setAble] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [choice, setChoice] = useState<Choice>('auto');
  const [started, setStarted] = useState(false);
  const [ready, setReady] = useState(false);
  const [posterGone, setPosterGone] = useState(false);
  const saveData = useMemo(() => !!(navigator as Nav).connection?.saveData, []);
  const level = useMemo(quality, []);

  useEffect(() => {
    const img = posterImg.current;
    return img ? afterPoster(img, () => setAble(hasWebgl2() && strongEnough())) : undefined;
  }, []);

  // The capture tool (DEV only): /?capture=<receiver> renders the stills and the og image.
  useEffect(() => {
    if (import.meta.env.DEV) {
      const receiver = new URLSearchParams(location.search).get('capture');
      if (receiver) void import('./capture').then((m) => m.capture(receiver));
    }
  }, []);

  const canAnimate = able === true && !failed;
  const wanted = choice === 'play' || (choice === 'auto' && !reduced && !saveData && !lowBattery);
  // It starts once a fifth of it is on screen, and stops when it's all but gone.
  const running = canAnimate && wanted && tabVisible && share >= (started ? 0.01 : 0.2);

  useEffect(() => {
    if (running) setStarted(true);
  }, [running]);

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setPosterGone(true), reduced ? 0 : 350);
    return () => clearTimeout(t);
  }, [ready, reduced]);

  const fail = () => {
    setFailed(true);
    setStarted(false);
    setReady(false);
    setPosterGone(false);
  };

  const state = !ready ? 'poster' : running ? 'live' : 'paused';
  return (
    <figure ref={figure} className="hero-stage" data-state={state} data-ready={ready ? '' : undefined}>
      <div className="hero-stage-frame" role="img" aria-label={HERO_ALT}>
        {!posterGone && (
          <>
            <picture className="hero-stage-poster">
              <source media="(max-width: 639px)" srcSet={POSTER.narrow.src} width={POSTER.narrow.width} height={POSTER.narrow.height} />
              <img ref={posterImg} src={POSTER.wide.src} width={POSTER.wide.width} height={POSTER.wide.height} alt="" fetchPriority="high" decoding="async" />
            </picture>
            <PosterLabels labels={POSTER_LABELS[narrow ? 'narrow' : 'wide']} />
          </>
        )}
        {started && (
          <Fallback onError={fail}>
            <Suspense fallback={null}>
              <Diorama paused={!running} quality={level} onReady={() => setReady(true)} onSlow={fail} pointerArea={figure} />
            </Suspense>
          </Fallback>
        )}
      </div>
      {canAnimate && (
        <button
          type="button"
          className="hero-stage-toggle"
          onClick={() => setChoice(wanted ? 'pause' : 'play')}
          aria-label={wanted ? 'Pause the animation' : 'Play the animation'}
        >
          {wanted ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>
      )}
    </figure>
  );
}
