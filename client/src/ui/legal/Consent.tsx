import { LEGAL_LINKED, PRIVACY_PATH, TERMS_PATH } from '.';
import './consent.css';

/**
 * Under the buttons that make an account (`signIn`: on the sign-in page, where Google, Apple and GitHub
 * make one the first time). The pages open in a new tab, so a half-filled form stays as it is. Nothing
 * while the pages aren't linked yet.
 */
export function Consent({ signIn = false }: { signIn?: boolean }) {
  if (!LEGAL_LINKED) return null;
  return (
    <p className="auth-alt auth-consent muted small">
      {signIn ? 'By continuing' : 'By creating an account'}, you agree to the{' '}
      <a href={TERMS_PATH} target="_blank" rel="noopener">
        Terms
      </a>{' '}
      and confirm you’ve read the{' '}
      <a href={PRIVACY_PATH} target="_blank" rel="noopener">
        Privacy Policy
      </a>
      .
    </p>
  );
}
