// The emails Workchop sends: plain text with an HTML twin, with at most one link.

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const IGNORE = 'If you didn’t ask for this, you can ignore this email.';

function compose(subject: string, intro: string, action: { label: string; link: string } | null, outro = IGNORE): MailContent {
  const text = action ? `${intro}\n\n${action.label}: ${action.link}\n\n${outro}\n` : `${intro}\n\n${outro}\n`;
  const button = action
    ? `<p style="margin:0 0 20px"><a href="${escapeHtml(action.link)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 8px;color:#59636e;font-size:13px">Or open this link: <a href="${escapeHtml(action.link)}" style="color:#4f46e5;word-break:break-all">${escapeHtml(action.link)}</a></p>
`
    : '';
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;background:#ffffff">
<p style="margin:0 0 20px">${escapeHtml(intro)}</p>
${button}<p style="margin:0;color:#59636e;font-size:13px">${escapeHtml(outro)}</p>
</body></html>
`;
  return { subject, text, html };
}

export const mailTemplates = {
  signup: (link: string) =>
    compose('Finish signing up', 'Welcome to Workchop! Finish creating your account with the link below. It works for 24 hours.', { label: 'Finish signing up', link }),
  accountExists: (link: string) =>
    compose(
      'You already have an account',
      'Someone, hopefully you, tried to sign up for Workchop with this email address, but it already has an account. Sign in as usual, or set a new password with the link below. It works for 1 hour.',
      { label: 'Set a password', link },
    ),
  resetPassword: (link: string) =>
    compose('Reset your password', 'Choose a new password for your Workchop account with the link below. It works for 1 hour.', { label: 'Choose a new password', link }),
  setPassword: (link: string) =>
    compose('Set a password', 'Set a password for your Workchop account with the link below, to sign in with your email address. It works for 1 hour.', {
      label: 'Set a password',
      link,
    }),
  /** `account`: who asked, as "Name (how they sign in)". */
  confirmEmail: (link: string, account: string) =>
    compose(
      'Confirm your email address',
      `The Workchop account ${account} asked to use this email address. If that’s your account, open the link below while signed in to it to confirm. It works for 24 hours.`,
      { label: 'Confirm email address', link },
      'If you didn’t ask for this, ignore this email: the address won’t be added to anyone’s account.',
    ),
  emailChanged: (email: string) =>
    compose(
      'Your email address was changed',
      `The email address of your Workchop account was changed to ${email}, and your other devices were signed out.`,
      null,
      'If you didn’t do this, sign in another way (or ask whoever runs your Workchop) and change it back.',
    ),
};
