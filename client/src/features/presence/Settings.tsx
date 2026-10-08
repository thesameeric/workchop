import { useCallback, useEffect, useState } from 'react';
import { appInfo, type AppPlatform } from '../../../../shared/apps';
import type { HelperDevice, PresenceState } from '../../../../shared/presence';
import { saveAccountSettings } from '../../lib/account';
import { ago } from '../../lib/time';
import { canSignIn, toast, useStore } from '../../state/store';
import { CopyIcon, icon, TrashIcon } from '../../ui/icons';
import helperUrl from '../../../../helper/workchop-presence.cjs?url';
import { fetchDevices, pairDevice, removeDevice } from './api';
import { sendPresence, sharingPrefs, usePresence } from './state';
import { StatusPicker } from './StatusPicker';

const CheckIcon = icon('tick-02');
const PLATFORM: Record<AppPlatform, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="presence-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{label}</strong>
        <span className="muted small">{hint}</span>
      </span>
    </label>
  );
}

type Pref = 'share' | 'others';
const SETTING: Record<Pref, string> = { share: 'appShare', others: 'appOthers' };

async function savePref(pref: Pref, value: boolean): Promise<void> {
  // Tell the office at once (hiding must not wait for the save), then keep it with the account.
  sendPresence({ [pref]: value });
  try {
    await saveAccountSettings({ [SETTING[pref]]: value });
  } catch (err) {
    // Not saved: back to what is, in the office too.
    sendPresence({ [pref]: !value });
    toast((err as Error).message, 'error');
  }
}

/** Settings > Privacy & status. */
export function StatusSection() {
  const account = useStore((s) => s.account);
  const signInOffered = useStore(canSignIn);
  // Re-read when the account's settings change.
  useStore((s) => s.account?.profile.settings);
  // A switch flips at once, and back if saving fails.
  const [flipped, setFlipped] = useState<Partial<Record<Pref, boolean>>>({});
  const prefs = { ...sharingPrefs(), ...flipped };
  const flip = (pref: Pref, value: boolean) => {
    setFlipped((f) => ({ ...f, [pref]: value }));
    void savePref(pref, value).then(() =>
      setFlipped((f) => {
        const rest = { ...f };
        delete rest[pref];
        return rest;
      }),
    );
  };
  return (
    <div className="presence-settings">
      <div className="field">
        <span>Working in</span>
        <StatusPicker />
      </div>
      <p className="muted small">What you pick shows next to your name and wins over the desktop helper. It’s hidden while you’re Away.</p>
      {account ? (
        <>
          <Toggle
            label="Share what app I’m using"
            hint="From the desktop helper. Hidden while you’re on Do not disturb or wearing headphones."
            checked={prefs.share}
            onChange={(v) => flip('share', v)}
          />
          <Toggle
            label="Show other apps as “Working”"
            hint="Apps that aren’t in Workchop’s list. Their names are never sent."
            checked={prefs.others}
            onChange={(v) => flip('others', v)}
          />
        </>
      ) : signInOffered ? (
        <p className="muted small">Sign in to show the app you’re using automatically, with the desktop helper.</p>
      ) : null}
    </div>
  );
}

function guessLabel(): string {
  const p = navigator.userAgent;
  if (/Mac/.test(p)) return 'Mac';
  if (/Win/.test(p)) return 'Windows PC';
  if (/Linux|X11/.test(p)) return 'Linux PC';
  return 'My computer';
}

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="presence-command">
      <code>{text}</code>
      <button
        type="button"
        className="icon-btn"
        title="Copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            prompt('Copy this:', text);
          }
        }}
      >
        {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      </button>
    </div>
  );
}

/** How to install and pair the helper, with the token shown this once. */
function Install({ token, onDone }: { token: string; onDone: () => void }) {
  const [os, setOs] = useState<'unix' | 'windows'>(/Win/.test(navigator.userAgent) ? 'windows' : 'unix');
  const origin = location.origin;
  const url = new URL(helperUrl, origin).href;
  // The token isn't part of the command, so it stays out of shell history: the helper asks for it.
  const unix = `curl -fsSL ${url} -o ~/workchop-presence.cjs && node ~/workchop-presence.cjs pair ${origin} && node ~/workchop-presence.cjs run`;
  const win = `iwr ${url} -OutFile $HOME\\workchop-presence.cjs; node $HOME\\workchop-presence.cjs pair ${origin}; node $HOME\\workchop-presence.cjs run`;
  return (
    <div className="presence-install">
      <p>
        <strong>1. Copy your token now:</strong> it’s shown only once.
      </p>
      <Copyable text={token} />
      <p>
        <strong>2. Run this in a terminal</strong> (needs{' '}
        <a href="https://nodejs.org" target="_blank" rel="noreferrer">
          Node.js
        </a>{' '}
        18 or newer) and paste the token when it asks.
      </p>
      <div className="chips" role="group" aria-label="Your system">
        <button type="button" className={`chip${os === 'unix' ? ' active' : ''}`} aria-pressed={os === 'unix'} onClick={() => setOs('unix')}>
          macOS / Linux
        </button>
        <button type="button" className={`chip${os === 'windows' ? ' active' : ''}`} aria-pressed={os === 'windows'} onClick={() => setOs('windows')}>
          Windows (PowerShell)
        </button>
      </div>
      <Copyable text={os === 'unix' ? unix : win} />
      <p className="muted small">
        It sends only which app is in front, from Workchop’s list (others as “Working”), never window titles. Afterwards, start it again with{' '}
        <code>node ~/workchop-presence.cjs run</code>.
      </p>
      <button type="button" className="btn small" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

function helperText(h: PresenceState['helper']): string {
  if (!h) return 'No helper running right now.';
  if (h.unsupported) return `Your ${PLATFORM[h.platform]} helper can’t tell which app is in front on this desktop.`;
  return `Your ${PLATFORM[h.platform]} helper sees: ${h.app ? appInfo(h.app).label : 'nothing (locked or idle)'}.`;
}

/** Settings > Desktop helper: pair computers, see and remove them. */
export function HelperSection() {
  const account = useStore((s) => s.account);
  const helper = usePresence((s) => s.self?.helper ?? null);
  const inOffice = useStore((s) => s.phase === 'office');
  const [devices, setDevices] = useState<HelperDevice[] | null>(null);
  const [label, setLabel] = useState(guessLabel);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchDevices()
      .then(setDevices)
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(() => {
    if (account) load();
  }, [account?.id, load]);

  if (!account) return <p className="muted">Sign in to pair the desktop helper. It shows your office which app you’re using, like “In Figma”.</p>;

  return (
    <div className="presence-settings">
      <p className="muted small">
        A small program for your computer that shows which app you’re using, like “In Figma”. Only the app is shared, from Workchop’s list; never window titles or
        what’s on screen. Turn it off any time in Privacy &amp; status.
      </p>
      {inOffice && <p className="small">{helperText(helper)}</p>}
      {token ? (
        <Install
          token={token}
          onDone={() => {
            setToken(null);
            load();
          }}
        />
      ) : (
        <form
          className="presence-pair"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const res = await pairDevice(label);
              setToken(res.token);
              load();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field">
            <span>Computer name</span>
            <input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <button className="btn primary" disabled={busy}>
            Pair a computer
          </button>
        </form>
      )}
      {error && <p className="form-error">{error}</p>}
      {devices && devices.length > 0 && (
        <ul className="presence-devices" aria-label="Paired computers">
          {devices.map((d) => (
            <li key={d.id}>
              <span className={`status-dot${d.active ? '' : ' idle'}`} />
              <span className="presence-device-info">
                <strong>{d.label}</strong>
                <span className="muted small">
                  {d.active ? `Active now${d.platform ? ` · ${PLATFORM[d.platform]}` : ''}` : d.lastUsedAt ? `Last seen ${ago(d.lastUsedAt)}` : 'Not used yet'}
                </span>
              </span>
              <button
                type="button"
                className="icon-btn"
                title={`Remove ${d.label}`}
                onClick={async () => {
                  try {
                    await removeDevice(d.id);
                    setDevices((list) => list?.filter((x) => x.id !== d.id) ?? null);
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              >
                <TrashIcon size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
