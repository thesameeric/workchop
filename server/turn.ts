/**
 * Short-lived credentials for Cloudflare Realtime TURN (https://developers.cloudflare.com/realtime/turn/).
 * Cloudflare's TURN servers only accept credentials minted from a TURN key, so they're fetched per
 * visitor instead of being configured statically like other TURN servers.
 */

export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface CloudflareTurn {
  keyId: string;
  apiToken: string;
  /** How long minted credentials stay valid, in seconds (Cloudflare allows up to 48 hours). */
  ttl: number;
}

const MAX_TTL = 48 * 3600;

export function cloudflareTurnFromEnv(env: NodeJS.ProcessEnv = process.env): CloudflareTurn | null {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const apiToken = env.CLOUDFLARE_TURN_KEY_API_TOKEN?.trim();
  if (!keyId || !apiToken) return null;
  const ttl = Number(env.CLOUDFLARE_TURN_TTL ?? 86400);
  return { keyId, apiToken, ttl: Number.isFinite(ttl) && ttl >= 600 ? Math.min(Math.round(ttl), MAX_TTL) : 86400 };
}

/** Ask Cloudflare for a fresh set of ICE servers (its STUN server plus TURN with new credentials). */
export async function mintCloudflareIceServers(turn: CloudflareTurn, fetchImpl: typeof fetch = fetch): Promise<RTCIceServerLike[]> {
  const res = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turn.keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${turn.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: turn.ttl }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}`);
  const body = (await res.json()) as { iceServers?: unknown };
  const list = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
  const servers: RTCIceServerLike[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const urls = (Array.isArray(raw?.urls) ? raw.urls : [raw?.urls])
      .filter((u): u is string => typeof u === 'string' && /^(stuns?|turns?):/.test(u))
      // Browsers block port 53, so that alternate URL would only ever time out.
      .filter((u) => !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    const server: RTCIceServerLike = { urls };
    if (typeof raw.username === 'string') server.username = raw.username;
    if (typeof raw.credential === 'string') server.credential = raw.credential;
    servers.push(server);
  }
  if (!servers.some((s) => [s.urls].flat().some((u) => u.startsWith('turn')))) throw new Error('Cloudflare TURN returned no TURN servers');
  return servers;
}
