import { useEffect, type RefObject } from 'react';

// Figures and cards marked `data-reveal=""` fade up once as they come into view (landing.css, not
// under reduced motion). Only those still below the screen are hidden first, so nothing already in
// view blinks, and text never waits on this. `key` changes when more of them render (the prices).

export function useReveal(root: RefObject<HTMLElement | null>, key: unknown): void {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.reveal = 'shown';
          io.unobserve(entry.target);
        }
      },
      { threshold: 0.15 },
    );
    for (const item of el.querySelectorAll<HTMLElement>('[data-reveal]')) {
      const state = item.dataset.reveal;
      if (state === 'shown') continue;
      if (state === '' && item.getBoundingClientRect().top < innerHeight) {
        item.dataset.reveal = 'shown';
      } else {
        item.dataset.reveal = 'hidden';
        io.observe(item);
      }
    }
    return () => io.disconnect();
  }, [root, key]);
}
