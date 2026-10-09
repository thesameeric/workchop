import { Link } from '../Account';
import { Logo } from '../Brand';
import { LEGAL_ENTITY, LEGAL_LINKED, PRIVACY_PATH, TERMS_PATH } from '../legal';
import { focusJoin } from './join';
import { BrandLink, sectionLinks } from './Nav';

/** The last call to get started, in a dark panel. */
export function FinalCta({ signIn }: { signIn: boolean }) {
  return (
    <section className="lp-section lp-final" aria-labelledby="final-title">
      <div className="lp-wrap">
        <div className="lp-final-panel" data-reveal="">
          <h2 id="final-title">Your office is one link away.</h2>
          <p>Create an office, send the link and walk in together.</p>
          {signIn ? (
            <Link to="/signup" className="lp-btn inverse">
              Get started free
            </Link>
          ) : (
            <a href="#join" className="lp-btn inverse" onClick={focusJoin}>
              Join with a link
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

/** `away`: under another page (the legal pages), so the logo and the sections lead back to the landing page. */
export function Footer({ signIn, pricing, away = false }: { signIn: boolean; pricing: boolean; away?: boolean }) {
  return (
    <footer className="lp-footer">
      <div className="lp-wrap">
        <div className="lp-footer-top">
          <div className="lp-footer-brand">
            {away ? (
              <Link to="/" className="brand lp-brand">
                <Logo size={24} />
              </Link>
            ) : (
              <BrandLink />
            )}
            <p>A 3D office in your browser.</p>
          </div>
          <nav aria-label="Footer" className="lp-footer-nav">
            <div>
              <p id="footer-product" className="lp-footer-label">
                Product
              </p>
              <ul aria-labelledby="footer-product">
                {[...sectionLinks(pricing), { href: '#faq', label: 'Questions' }].map((l) => (
                  <li key={l.href}>{away ? <Link to={`/${l.href}`}>{l.label}</Link> : <a href={l.href}>{l.label}</a>}</li>
                ))}
              </ul>
            </div>
            {signIn && (
              <div>
                <p id="footer-account" className="lp-footer-label">
                  Account
                </p>
                <ul aria-labelledby="footer-account">
                  <li>
                    <Link to="/signin">Sign in</Link>
                  </li>
                  <li>
                    <Link to="/signup">Create an account</Link>
                  </li>
                </ul>
              </div>
            )}
            {LEGAL_LINKED && (
              <div>
                <p id="footer-legal" className="lp-footer-label">
                  Legal
                </p>
                <ul aria-labelledby="footer-legal">
                  <li>
                    <Link to={PRIVACY_PATH}>Privacy</Link>
                  </li>
                  <li>
                    <Link to={TERMS_PATH}>Terms</Link>
                  </li>
                </ul>
              </div>
            )}
          </nav>
        </div>
        <p className="lp-copyright">© {new Date().getFullYear()} {LEGAL_ENTITY}</p>
      </div>
    </footer>
  );
}
