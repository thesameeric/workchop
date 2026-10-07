/** Keys currently held down (KeyboardEvent.code), ignoring keys typed into form fields. */
export const pressed = new Set<string>();

export function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
    pressed.add(e.code);
  });
  window.addEventListener('keyup', (e) => pressed.delete(e.code));
  window.addEventListener('blur', () => pressed.clear());
  document.addEventListener('focusin', () => {
    if (isTyping()) pressed.clear();
  });
}

export function axis(): { x: number; y: number; run: boolean } {
  const has = (...codes: string[]) => codes.some((c) => pressed.has(c));
  const x = (has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0);
  const y = (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0);
  return { x, y, run: has('ShiftLeft', 'ShiftRight') };
}
