import type { HelperDevice } from '../../../../shared/presence';

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export async function fetchDevices(): Promise<HelperDevice[]> {
  return json(await fetch('/api/me/devices', { cache: 'no-store' }));
}

export async function pairDevice(label: string): Promise<{ device: HelperDevice; token: string }> {
  return json(await fetch('/api/me/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) }));
}

export async function removeDevice(id: string): Promise<void> {
  const res = await fetch(`/api/me/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) await json(res);
}
