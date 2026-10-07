import type { TemplateId } from '../../../shared/templates';

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export async function fetchConfig(): Promise<{ iceServers: RTCIceServer[] }> {
  try {
    return await json(await fetch('/api/config', { signal: AbortSignal.timeout(8000) }));
  } catch {
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  }
}

export async function createOffice(name: string, template: TemplateId): Promise<{ id: string; ownerKey: string }> {
  return json(
    await fetch('/api/offices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, template }),
    }),
  );
}

export async function fetchOfficeInfo(id: string): Promise<{ id: string; name: string; online: number } | null> {
  // A server that accepts the connection but never answers counts as unreachable.
  const res = await fetch(`/api/offices/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  return json(res);
}
