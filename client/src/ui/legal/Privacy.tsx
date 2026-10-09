import { Link } from '../Account';
import { LockIcon } from '../icons';
import { LegalPage, Mail, type LegalSection } from './LegalPage';
import { LEGAL_ENTITY, TERMS_PATH } from '.';

// What Homeoffice keeps and why. Each statement follows the code (README, "What is stored"): change
// this page, and its date in LegalPage.tsx, along with what it describes.

const sections: LegalSection[] = [
  {
    id: 'summary',
    title: 'The short version',
    body: (
      <ul>
        <li>We keep what we need to run your office: your account, your workspaces, and what you write and share in them.</li>
        <li>
          Calls go directly between browsers, relayed through Cloudflare only when a direct connection isn’t possible and a relay is configured. We don’t
          record or store them.
        </li>
        <li>Card payments go through Paystack. Your card number never reaches us.</li>
        <li>No ads, no analytics trackers, and we don’t sell your information.</li>
        <li>
          To delete your account or get a copy of your information, email <Mail />.
        </li>
      </ul>
    ),
  },
  {
    id: 'who',
    title: 'Who we are',
    body: (
      <>
        <p>
          {LEGAL_ENTITY} runs homeoffice.town, a 3D office in your browser. When this policy says “we” or “us”, it means {LEGAL_ENTITY}. You can
          reach us at <Mail />.
        </p>
        <p>
          A workspace on Homeoffice belongs to its owner, who decides who comes in. If you’re a customer at a business’s help desk, see{' '}
          <a href="#workspaces">Workspaces and help desks</a>.
        </p>
      </>
    ),
  },
  {
    id: 'collect',
    title: 'What we collect',
    body: (
      <>
        <h3>Your account</h3>
        <p>When you create an account, we keep:</p>
        <ul>
          <li>your name and email address, and whether the address is confirmed;</li>
          <li>your password, only as a scrypt hash, so nobody can read it back, us included;</li>
          <li>your character (how you look in the office), your status, and settings such as your theme and weather;</li>
          <li>the ways you sign in: for Google, Apple or GitHub, that account’s id and the email address it gives us, and your profile picture from Google or GitHub;</li>
          <li>your sign-ins: a hash of each sign-in token, the browser it came from, and when it was last used;</li>
          <li>the workspaces you belong to, your role in each, when you joined and last visited each, and when you last used Homeoffice.</li>
        </ul>

        <h3>Guests</h3>
        <p>
          Guests come in with a link, without an account. The name and character they pick stay in their browser. Our server holds them only while
          they’re in an office, apart from the name on what they write or share there.
        </p>

        <h3>Workspaces</h3>
        <p>
          For each workspace we keep its layout, furniture and settings, who has claimed which desk, its members and their roles, its guest link,
          invitations (the email address, the role and who sent it), notes left on desks (with a hash of a key a guest’s browser keeps, so guests can
          delete their own), what its info boards say, and its jukebox settings, tracks and shared Spotify links.
        </p>

        <h3>Chat and files</h3>
        <p>
          We store channel messages, threads, reactions and mentions, direct messages between people who are signed in, the files attached to them, and
          how far each signed-in person has read. Nearby chat and direct messages with guests aren’t stored: they only pass through our server. Files
          sent in them are stored, like other files.
        </p>

        <h3>Calls</h3>
        <p>
          Voice, video and screen shares go directly between browsers (WebRTC), encrypted. They’re relayed, still encrypted, through Cloudflare’s TURN
          service only when a direct connection isn’t possible and a relay is configured. To set up a call, your browser also asks a STUN server for a way
          to reach you: Google’s, or Cloudflare’s when a Cloudflare relay is configured and reachable. Because calls are direct, your IP address is passed
          to the people you talk with.
        </p>
        <p>We never record or store calls. Who’s online, where people stand and who is talking with whom is kept in memory only, while you’re there.</p>

        <h3>Presence</h3>
        <p>
          When you’re signed in, your status (available, do not disturb or away) is saved with your account. Whether your headphones are on, and where
          you are in the office, are kept in memory only.
        </p>
        <p>
          The app shown next to your name is the one you pick by hand or, only if you install and pair the desktop helper, the app in front on your
          computer. The helper sends only an app’s id from Homeoffice’s list (like “Figma”), or “other”: never window titles, web addresses or what’s on
          your screen. We keep it in memory only. For each paired computer we keep its name, when it was paired and last used, and a hash of its token.
        </p>

        <h3>Weather</h3>
        <p>
          The weather feature, when it’s on, shows the weather where you are. For that we use a city you choose, your device’s location (only after you
          click <em>Use my location</em>), or roughly where your connection comes from, which Cloudflare works out from your IP address. Locations are
          rounded to about 11 km before we ask Open-Meteo for the forecast, and Open-Meteo never sees your IP address.
        </p>
        <p>
          When you’re signed in, your weather settings and chosen city are saved with your account, but never your device’s location. Others see your
          weather and local time only if you turn that on, and never your place.
        </p>

        <h3>Customer support</h3>
        <p>
          When you ask a business for help at its Homeoffice help desk, we keep the name you give, your email address if you give it, your question, the
          ticket’s chat and files, the rating you give, and when it all happened. We also keep a scrambled form (a hash) of your IP address, to limit how
          many tickets one network can have open, and of a key your browser keeps to find your ticket again.
        </p>

        <h3>Paying for a workspace</h3>
        <p>
          Paystack processes card payments: your card number goes to Paystack, never to us. We keep the card’s brand, last 4 digits, expiry and bank, and
          Paystack’s authorization code, which lets us charge renewals to that card. We also keep the email address you pay with, a record of every charge,
          who changed what in billing, and the payment notices Paystack sends us (without the authorization code). Those notices hold what Paystack has
          about each payment, such as the payer’s name, phone number and IP address, and the card’s first 6 digits.
        </p>

        <h3>GitHub</h3>
        <p>
          If you connect GitHub to see your notifications, we keep your GitHub account’s id and login and its access tokens, encrypted. The tokens never
          reach your browser. Your notifications are kept in memory only, while you’re in an office and for 10 minutes after. If you sign in with GitHub,
          we read your name, picture and email address, then cancel that access right away.
        </p>

        <h3>Spotify</h3>
        <p>
          For listen-along, you connect your own Spotify account in your browser. That sign-in stays in your browser and never reaches our server. We only
          pass on what’s playing, and where in the track, to the others in your office.
        </p>

        <h3>Your connection</h3>
        <p>
          Like every website, we see your IP address and your browser’s details with each request. We use your IP address to limit how often one visitor
          can do things like try passwords, and for the weather as above, when that feature is on. We don’t keep it with your account, but it can appear in
          Cloudflare’s logs, in Paystack’s payment notices and, scrambled, in support tickets.
        </p>
      </>
    ),
  },
  {
    id: 'use',
    title: 'How we use it',
    body: (
      <>
        <p>We use your information only to:</p>
        <ul>
          <li>
            run Homeoffice: sign you in, let you into your workspaces, connect calls, deliver messages and files, and show the weather when that feature
            is on;
          </li>
          <li>
            send the emails you need: sign-up links, password resets, email changes, workspace invitations, and billing emails (receipts and reminders to
            a workspace’s owner, and to its admins when it pauses);
          </li>
          <li>charge for paid plans and keep a record of payments;</li>
          <li>keep Homeoffice safe: limit abuse, stop spam and look into problems;</li>
          <li>answer you when you write to us.</li>
        </ul>
        <p>
          We do this because it’s needed to give you the service you asked for, to keep it safe, or to meet legal duties. We use your device’s location
          only when you ask us to. We don’t sell your information, show ads, or track you around the web.
        </p>
      </>
    ),
  },
  {
    id: 'share',
    title: 'Who sees it',
    body: (
      <>
        <p>
          People in your workspaces see what you’d expect: your name, character and status, when you joined and last visited, and what you write and
          share there. Direct messages are shown only to the two of you in Homeoffice. Owners and admins also see members’ email addresses. Anyone who has
          a file’s link can open it, so share links with care.
        </p>
        <p>These companies help us run Homeoffice, and each gets only what its job needs:</p>
        <ul>
          <li>
            <strong>Cloudflare</strong> hosts Homeoffice and stores uploaded files (R2). It relays calls (TURN) only when a direct connection isn’t possible
            and a relay is configured, and, when the weather feature is on, tells us roughly where you are for it.
          </li>
          <li>
            <strong>PlanetScale</strong> hosts our database, in the United States (AWS us-east-1).
          </li>
          <li>
            <strong>Resend</strong> sends our emails.
          </li>
          <li>
            <strong>Paystack</strong> processes card payments.
          </li>
          <li>
            <strong>Open-Meteo</strong>, when the weather feature is on, provides forecasts and city search, from rounded locations only.
          </li>
          <li>
            <strong>Google, Apple and GitHub</strong>, when you sign in with them or connect GitHub.
          </li>
          <li>
            <strong>Spotify</strong>, when you use listen-along, straight from your browser.
          </li>
        </ul>
        <p>
          Your browser also loads some things straight from other sites, which see your IP address as any website does: Google’s STUN server when it helps
          set up a call, profile pictures from Google and GitHub, and the music streams and audio files added to a jukebox.
        </p>
        <p>We may also share information when the law requires it, or to protect someone’s safety.</p>
      </>
    ),
  },
  {
    id: 'where',
    title: 'Where it’s kept',
    body: (
      <>
        <p>
          Homeoffice runs on Cloudflare’s network, which has data centres around the world. Our database is hosted by PlanetScale in the United States
          (AWS us-east-1), uploaded files are kept in Cloudflare R2, and Resend sends our emails. So your information is handled outside Nigeria and may be
          handled outside your country. Backups of the database are kept by PlanetScale, and sometimes by us before an update.
        </p>
        <p>
          When your information is handled outside Nigeria, we rely on our providers’ data protection agreements to keep it protected, as the Nigeria
          Data Protection Act requires.
        </p>
      </>
    ),
  },
  {
    id: 'retention',
    title: 'How long we keep it',
    body: (
      <>
        <ul>
          <li>
            <strong>Your account:</strong> until you ask us to delete it. See below for what stays after.
          </li>
          <li>
            <strong>Workspaces:</strong> until their owner asks us to delete them.
          </li>
          <li>
            <strong>Sign-ins:</strong> until you sign out, or 30 days after you last used them.
          </li>
          <li>
            <strong>Emailed links:</strong> 24 hours (1 hour to reset a password); invitations, 14 days. Expired ones are deleted by a regular clean-up.
          </li>
          <li>
            <strong>Chat and files:</strong> until they’re deleted, or their workspace is. Deleting a message deletes its files, and files not attached to
            a message within a day are deleted. Files sent in nearby chat or in direct messages with guests can’t be deleted in Homeoffice: they’re kept
            until their workspace is deleted, or you ask us to delete them.
          </li>
          <li>
            <strong>Support tickets</strong>, with the customer’s name and email address and the ticket’s chat: until the business’s workspace is deleted,
            or the business asks us to delete them.
          </li>
          <li>
            <strong>Live information</strong> (who’s online, positions, calls, the app you’re in): in memory only, while you’re there.
          </li>
          <li>
            <strong>Billing records</strong>, including Paystack’s payment notices: kept for our accounts, also after a plan ends or its workspace is
            deleted.
          </li>
          <li>
            <strong>Backups:</strong> what’s deleted from Homeoffice stays in backups of the database until they’re deleted.
          </li>
          <li>
            <strong>Logs:</strong> Cloudflare keeps logs of requests and of our server’s messages for a limited time.
          </li>
        </ul>
        <p>
          When your account is deleted, what you wrote and shared in workspaces stays there under your name: messages, files and notes on desks. Delete
          them first, or ask us to, if you don’t want that. Billing records stay too.
        </p>
      </>
    ),
  },
  {
    id: 'cookies',
    title: 'Cookies and local storage',
    body: (
      <>
        <p>
          We use one cookie to keep you signed in. It lasts 30 days from your last visit, and scripts on the page can’t read it. While you sign in with
          Google, Apple or GitHub, a second cookie remembers that sign-in for up to 10 minutes.
        </p>
        <p>
          Your browser’s local storage keeps things like your theme, sound and device choices, weather settings, the workspaces you’ve visited recently, a
          guest’s name and character, guest links you’ve opened, and your Spotify sign-in. It stays on your device, and clearing your browser’s data removes it.
        </p>
        <p>There are no advertising or analytics cookies, and no third-party trackers.</p>
      </>
    ),
  },
  {
    id: 'choices',
    title: 'Your choices',
    body: (
      <>
        <ul>
          <li>Change your name, character, email address or password in your profile.</li>
          <li>Add or remove ways to sign in, as long as one remains, and sign out your other devices.</li>
          <li>Leave a workspace, and edit or delete messages you wrote.</li>
          <li>Disconnect GitHub, or remove a computer paired with the desktop helper (we keep a record of it, marked as removed, until your account is deleted).</li>
          <li>Turn off sharing the app you’re in, and choose whether others see your weather.</li>
        </ul>
        <p>
          To delete your account or a workspace you own, or to get a copy of your information, email <Mail /> from the address on your account.
          There’s no button for this yet, so we do it by hand and tell you when it’s done.
        </p>
        <p>
          Depending on where you live, you may have the right to see, correct or delete your information, get a copy of it, object to how we use it, and
          complain to a data protection authority (in Nigeria, the Nigeria Data Protection Commission). Email us to use any of them.
        </p>
      </>
    ),
  },
  {
    id: 'security',
    title: 'Keeping it safe',
    body: (
      <>
        <ul>
          <li>Homeoffice only runs over HTTPS.</li>
          <li>Passwords are hashed with scrypt. Sign-ins, emailed links and desktop helper tokens are stored only as hashes.</li>
          <li>GitHub tokens are encrypted, and card numbers never reach us.</li>
        </ul>
        <p>
          No system is perfectly secure. If a breach affects your information, we’ll tell you and the Nigeria Data Protection Commission, as the law
          requires.
        </p>
      </>
    ),
  },
  {
    id: 'workspaces',
    title: 'Workspaces and help desks',
    body: (
      <>
        <p>
          A workspace’s owner decides who can come in and can remove members. Owners and admins can rename and archive channels, and delete messages in
          them.
        </p>
        <p>
          If you’re a customer at a business’s help desk, that business decides how your question is handled and is responsible for telling you how it
          uses your information. Its staff see your name and email address and read your ticket; other visitors see you only as a visitor number. We store
          and handle your information for the business. Ask them, or us, if you have questions.
        </p>
        <p>
          If you tick <em>Remember me on this device</em>, your browser keeps your name and email for next time. Otherwise this browser forgets them when
          you’re done. Either way, the business keeps them with your question.
        </p>
      </>
    ),
  },
  {
    id: 'children',
    title: 'Children',
    body: (
      <p>
        Homeoffice is for people aged 18 and over. Children shouldn’t create an account or come in. If you think a child has given us information, email
        us and we’ll delete it.
      </p>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to this policy',
    body: (
      <p>
        When what we collect or how we use it changes, we’ll update this page and the date at the top. If a change matters, we’ll tell people with an
        account by email or in Homeoffice before it applies.
      </p>
    ),
  },
  {
    id: 'contact',
    title: 'Contact',
    body: (
      <p>
        Questions or requests about your information: <Mail />. See also our <Link to={TERMS_PATH}>Terms</Link>.
      </p>
    ),
  },
];

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      Icon={LockIcon}
      intro={<p>What Homeoffice collects when you use homeoffice.town, why, where it’s kept, and the choices you have.</p>}
      sections={sections}
    />
  );
}
