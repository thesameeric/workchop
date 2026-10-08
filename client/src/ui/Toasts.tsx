import { dismissToast, useStore } from '../state/store';

/** Toasts on every page (inside an office they sit under the top bar). */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const inOffice = useStore((s) => s.phase === 'office');
  return (
    <div className={`toasts${inOffice ? '' : ' page'}`} aria-live="polite">
      {toasts.map(({ id, text, kind, icon: Icon, action }) => (
        <div key={id} className={`toast ${kind}${action ? ' actionable' : ''}`}>
          {Icon && <Icon size={18} className="toast-icon" />}
          <span>{text}</span>
          {action && (
            <button
              className="toast-action"
              onClick={() => {
                dismissToast(id);
                action.run();
              }}
            >
              {action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
