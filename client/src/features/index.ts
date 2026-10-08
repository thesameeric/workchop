// Client features: each client/src/features/<name>/index.ts(x) is loaded at startup, nothing to
// list here. When imported, a feature registers what it adds:
//   - side panels with their dock buttons: registerPanel (ui/panels.tsx)
//   - Settings sections: registerSettingsSection (ui/settings.tsx)
//   - socket events and other per-office work: onSession (lib/session.ts)
import.meta.glob('./*/index.{ts,tsx}', { eager: true });
