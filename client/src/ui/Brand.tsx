// The Homeoffice logo: a house with someone in its doorway. The person is cut out with the even-odd
// rule, so the mark works on any background.

/** The mark's outline in a 24 × 24 box (fill it with the even-odd rule). */
export const LOGO_PATH =
  'M10.44 3.65Q12 2.4 13.56 3.65L19.64 8.55Q21.2 9.8 21.2 11.8V19.6Q21.2 21.6 19.2 21.6H4.8Q2.8 21.6 2.8 19.6V11.8Q2.8 9.8 4.36 8.55Z' +
  'M14.6 11.9A2.6 2.6 0 1 1 9.4 11.9A2.6 2.6 0 1 1 14.6 11.9Z' +
  'M7.2 21.6V20.2A4.8 4.2 0 0 1 16.8 20.2V21.6Z';

/** The mark alone, in the current colour. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block', flex: 'none' }} aria-hidden="true" focusable="false">
      <path d={LOGO_PATH} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** The mark and the name, for inside `.brand` (the mark takes `.brand-mark`'s colour). */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <>
      <span className="brand-mark">
        <LogoMark size={size} />
      </span>
      Homeoffice
    </>
  );
}
