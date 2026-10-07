import { getState, setState } from '../state/store';
import { leaveOffice } from './session';

const OFFICE_PATH = /^\/o\/([A-Za-z0-9_-]{1,40})\/?$/;

export function officeIdFromPath(path = location.pathname): string | null {
  return OFFICE_PATH.exec(path)?.[1] ?? null;
}

/** Sync the app phase with the URL. */
export function route(): void {
  const id = officeIdFromPath();
  const { phase, officeId } = getState();
  if (phase === 'office' && id !== officeId) leaveOffice();
  if (id) {
    if (getState().phase !== 'office' || id !== officeId) setState({ phase: 'lobby', officeId: id });
  } else {
    setState({ phase: 'landing', officeId: null });
  }
}

export function navigate(path: string): void {
  if (location.pathname !== path) history.pushState(null, '', path);
  route();
}

export function officeUrl(id: string): string {
  return `${location.origin}/o/${id}`;
}
