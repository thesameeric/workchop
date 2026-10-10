# Homeoffice

A 3D virtual office in the browser at [homeoffice.town](https://homeoffice.town), in the spirit of [Gather](https://www.gather.town/): walk around with your own character, and when you get close to someone you can hear and see them. Teams can rebuild the office together in build mode.

The code, the npm package and the repository are still called `workchop`.

## Features

**Proximity audio and video**
- Walk within about 4 m of someone to start a WebRTC call. You keep hearing them until about 5 m, and their volume fades with distance.
- **Private areas** (meeting rooms, booths): everyone inside hears only the others inside, however far apart they are. Someone standing just outside the glass hears nothing.
- Screen sharing, mute and camera toggles, device selection (mic, camera, speakers), and a talking indicator on video tiles and characters.
- Click a video tile to enlarge it, e.g. to follow a screen share.
- A "Do not disturb" status keeps you out of conversations except inside private areas.
- **Noise-cancelling headphones** (🎧 dock button or `H`): put them on to focus. You stop hearing everyone and the lounge music, even inside a private area, while people can still hear you (unless you're muted). Everyone sees the headphones on your character, name tag, video tile and in the people list. People who walk up see "wearing headphones" and can **tap you on the shoulder** (click your character, or the tap button in the people list): you get a toast and a soft knock, at most once every 30 s from each person (and three times in 30 s in all). Taking them off brings everything back at once; they come off when you leave the office.
- **Noise suppression** (Settings → Audio & video): *Standard* is the browser's built-in filter. *Enhanced* also runs [RNNoise](https://github.com/xiph/rnnoise) in your browser to remove typing, fans and background chatter (loaded only when chosen; it falls back to Standard by itself if the browser or device can't run it).

**Your character**
- A procedurally built 3D character: skin tone, 7 hairstyles (or bald) and hair colour, T-shirt / hoodie / suit / dress, colours for top, bottoms and shoes, hats (cap, beanie, top hat, crown, headphones), glasses, and facial hair. You can also pick custom colours.
- Walking animation, sitting on chairs, sofas and stools, and 10 reactions everyone sees (`1`–`9`, `0`): 👋 waves, ❤️ sends hearts floating up, 😂, 👍, 🎉 pops 3D confetti (and showers your own screen a little), ✋ raises a hand, 💃 dances for a few seconds (until you walk off), 👏 claps, 🔥 lights little flames and 🙌 throws both arms up.
- Your look and name are saved in the browser and can be changed at any time, even inside an office.

**Accounts and workspaces**
- Sign up with your email address and a password, or with Google, Apple or GitHub (see [Accounts and sign-in](#accounts-and-sign-in)): you choose your name and character once, change them in *Profile*, and keep them with your status, theme and weather settings on every device.
- **Workspaces** (see [Workspaces](#workspaces)): each office has an owner, admins and members. Making one needs an account. New workspaces let in their members only; turn on a **guest link** to let others in without an account. Owners and admins add people by email: someone with an account joins at once, anyone else gets an invitation. Signed in, Homeoffice opens your most recent workspace; the others are on the home page and in the menu on the office's name.
- A workspace is a team office or a **customer support** workspace (see below).
- **One of you per office:** come into an office in another tab, or on another device with your account, and the newest one takes over; the older tab says *Homeoffice is open in another tab* and offers **Use here** to take it back. Open tabs follow signing in or out in another tab.
- Light and dark themes, or follow the device (*Settings > Appearance*).

**Customer support** (like Intercom, in 3D; see [Support workspaces](#support-workspaces))
- Staff sit at **help desks**; customers come in with the workspace's public **customer link**, without an account, say how we can help, and wait in a big lobby with things to look at (fish tanks, FAQ boards, a music corner, a coffee bar, games). Others see them as "Visitor #45"; staff see their names.
- Each conversation is a **ticket**. Customers see their place in the queue ("You're #45 · 3 ahead"); staff see who's waiting and who's away, and press **Next**: the next customer walks over to their desk and sits down across from them. They talk by voice, video and the ticket's chat (with files), one customer per agent at a time, and nobody else hears them. Customers never hear each other.
- **Resolve** ends it; the customer rates it from 1 to 5 and can ask another question. Staff search past tickets with their chat and what happened on them. A *Now serving* screen over the desks shows who's at which desk and how many are waiting.
- **Hand over** a visitor to a colleague at a free desk (they accept or decline; the visitor walks over to them), or **invite a colleague** into the conversation from wherever they are (up to two).

**The office**
- Two starting templates for team workspaces: a furnished startup office with desk pods, a glass meeting room, a lounge, a kitchen and ping pong, or a blank floor. Support workspaces start from the *Support lobby* (see [Support workspaces](#support-workspaces)).
- **Build mode** (hammer button or `B`): 49 pieces of furniture, structure and plants in 7 categories; help desks and the queue screen are offered only in support workspaces. Place, drag, rotate (`R`), duplicate (`Ctrl/Cmd+D`), recolour and delete (`Del`) items, and draw private areas by dragging on the floor.
- Office settings: name, floor size, floor style and colour, wall colour, and spawn point. Members build by default; the owner can leave building to themselves and the admins.
- Every edit is synced live to everyone in the office and saved on the server.

**Little things in the world**
- **Desk monitors** are off until someone sits at the desk: then the screen wakes up (a glow and a logo) and shows the app they're working in, when they share it, or a calm wallpaper with their name and the time. Everyone sees it, and it goes dark a second after they get up.
- **Lights:** click a floor lamp or desk lamp to switch it on or off for everyone. A **light switch** (Build → Structure; put it against a wall) works the ceiling lights of the private area in front of it, or of the open office: switched off, that area goes dark for everyone, while its lamps and lit monitors keep glowing. Walk up to one and press `E`, or click it.
- **Plants:** 13 species (Build → Plants), from a monstera and a bird of paradise to a bonsai and a barrel cactus. Small ones stand on desks, tables and shelves. Click one to see what it is: where it comes from, how much light and water it needs, whether it's safe for pets (per the ASPCA where it lists the plant), and a fun fact.
- **Info boards** (Build → Decor) show a title on the board; click one, or walk up and press `E`, to read it. Owners and admins edit what it says from that card.
- **Fish tanks** (Build → Decor) have fish swimming in them; click one to see which fish they are.
- **Your desk:** members click a free desk and choose *Make this my desk* (one per office; claiming another moves you). Your name goes on a name plate. Anyone, guests included, can click your desk and leave you a sticky note (up to 500 characters, in four colours); notes from guests are marked *guest*, since anyone with a guest link can join under any name, and a desk takes at most 10 unread ones from guests, so there's always room for your coworkers'. The notes stack up on the desk for everyone to see, but only you read them: you get a toast when one arrives, or a reminder when you come in, and *My desk* in the dock (in its More menu on phones) lists them to mark as read or throw away. Whoever wrote a note can take it back. Owners and people who can edit the office can free a desk.

**GitHub notifications**
- People who sign in can connect their GitHub account (optional, needs a GitHub OAuth App, see [GitHub](#github)). The GitHub panel sorts their unread notifications into Mentions, Reviews, Actions and Activity, with a badge for unread mentions, review requests and failed runs. Click one to open it on GitHub. Marking items read or done in the panel does the same on GitHub.
- A failed Actions run you started pops up as a message with a link to it, and a small red badge pulses on your own desk's monitor (only you see it) until you open the panel or mark the run read or done.

**Lounge music**
- A **jukebox** (in the startup lounge, or add one from Build → Fun) plays music for everyone in the private area it stands in, or within about 7 m if it's out in the open. Click it, the 🎵 dock button, or the "now playing" chip to open it. Everyone has their own volume and mute.
- **Radio:** two built-in stations, *Homeoffice Lo-fi* and *Homeoffice Ambient*, are composed live in each browser from the server clock, so everyone hears the same notes at the same moment, with nothing to license or stream. Editors can also add **the office's own tracks** (audio files, looped in sync for everyone) or **a live stream** (an https Icecast/Shoutcast URL). Anyone can switch stations.
- **Spotify board:** share Spotify playlists, albums, tracks, podcasts, or a **Jam** invite. Everyone opens them in their own Spotify app.
- **Spotify listen-along** (optional, needs `SPOTIFY_CLIENT_ID`, see below): people connect their own Spotify Premium account, someone presses ▶ "Play for everyone", and everyone connected at that jukebox hears the same track at the same position on their own account. Homeoffice only syncs what's playing; it never streams audio from one person to another.

**Chat**
- **Channels** for the whole office: every office starts with #general, anyone can add more (with a topic), and the owner and admins rename and archive them.
- **Direct messages**, saved when both people are signed in (they wait for whoever is away: start one with **+** next to Direct messages). With guests they're live: they last while you're both in the office, and what a guest sent you stays until you've read it. **Nearby** is a live chat with the people you're talking with.
- **Threads** (reply to any message, optionally also in the channel), **@mentions** of people here or away and `@here` for everyone online, **reactions**, editing and deleting your messages, and light formatting: `**bold**`, `_italic_`, `` `code` ``, code blocks and links.
- **Files:** attach, drag in or paste up to 5 per message. Images show as previews that open full size; other files as cards to download.
- Unread channels are bold, with a count of your mentions. The dock's chat button counts your mentions and direct messages, and a mention or direct message also shows a notice that takes you to it.

**Local weather**
- Everyone sees the weather and time of day where *they* are: the sky and sunlight follow their local time, with clouds, fog, rain, snow or thunderstorms around the office. A chip in the top bar shows the conditions, temperature and place; click it for details. Data from [Open-Meteo](https://open-meteo.com/) (see [Weather](#weather)).
- The place is a city you pick, your device's location (only when you ask), or roughly where your connection comes from. You can also show your weather and local time on your row in the people list (off by default, and never the place).

**Getting around**
- `WASD` or the arrow keys move you relative to the camera, and `Shift` runs. Click the floor to walk there (with pathfinding); click a chair to walk over and sit. Getting up steps you forward, or back when there's no room in front (at a desk).
- Drag to orbit the camera and scroll to zoom. Walls and shelves between you and the camera fade out.
- The people list shows who's in a conversation, with "go to" and "message" buttons.
- Works on phones: tap to walk, drag to look around.

**Current app** (like Tandem)
- Show what you're working in next to your name: "Figma", "VS Code", "Heads-down"… on your name tag, in the people list, on video tiles and on your desk's monitor while you sit at it.
- Pick it by hand (the status button next to you in the dock, or *Settings > Privacy & status*), for 30 minutes, an hour, today or until you clear it.
- Or let the optional [desktop helper](#current-app-and-the-desktop-helper) show it automatically (signed-in people). *Share what app I'm using* turns it off everywhere at once.

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | Move (`Shift` to run) |
| `E` | Sit / stand, or switch the lights or lamp you're next to |
| `1`–`9`, `0` | Reactions |
| `M` / `V` | Toggle microphone / camera |
| `H` | Noise-cancelling headphones (focus mode) |
| `B` | Build mode |
| `Enter` | Open chat (in chat: send; `Shift+Enter` for a new line) |
| `↑` / `Esc` | In chat: edit your last message / cancel a reply or an edit, or leave the message box (`Esc` again closes the chat) |
| `R`, `Del`, `Ctrl+D`, `Esc` | Rotate, delete, duplicate, cancel (build mode) |

## Getting started

Requires Node.js 22.12+ or 24+ (the current LTS releases). Check with `node --version`.

```bash
npm install
npm run dev
```

Open the `Local:` address it prints (normally http://localhost:5173), sign up (without `RESEND_API_KEY` the email's link is printed in the terminal; `DEV_LOGIN=true npm run dev` adds a sign-in with just a name), create a workspace and go in. Allow the camera and microphone when the browser asks.

Data is kept in `./data`: an embedded Postgres ([PGlite](https://pglite.dev), no setup) in `data/db` and uploaded files in `data/uploads`. Only one server can use a data folder at a time.

`npm run dev` starts the API and realtime server on port 3001 (reloading on change) and Vite on port 5173, which proxies `/api` and `/socket.io` to the server. If port 3001 is taken, run it on another one, e.g. `PORT=4001 npm run dev` (the proxy follows `PORT`; on Windows use `$env:PORT=4001; npm run dev` in PowerShell or `set PORT=4001&& npm run dev` in cmd). Stop it with `Ctrl+C`.

### Testing a call

**On your own:** turn on the guest link (*Invite people* in the dock), copy it and open it in a private/incognito window, which comes in as a guest with its own name and character. New arrivals start next to each other, so the video tiles at the top show up straight away. Walk apart (WASD, or click the floor) and they disappear; walk back and they return. Use headphones or mute one window to avoid echo.

**With other people or your phone:** browsers only allow the camera and microphone on HTTPS (or `localhost`). The `Network:` address Vite prints works on your Wi-Fi, but people joining that way can only watch and listen. For full two-way calls, run the production build behind any HTTPS tunnel and share the `https://…` address it prints:

```bash
npm run build && npm start                        # serves the app on http://localhost:3001

# then, in a second terminal (use the same port as above if you changed PORT):
cloudflared tunnel --url http://localhost:3001    # or: ngrok http 3001
```

`cloudflared` works without an account; `ngrok` needs a free account and a one-time `ngrok config add-authtoken <token>`. Use the production build for this: Vite's dev server rejects unfamiliar host names such as tunnel addresses.

## Deploying

Browsers only allow the camera and microphone over **HTTPS**, so a deployment needs a domain name and a certificate. The included Docker Compose setup takes care of both.

### Docker Compose (recommended)

Runs three containers: the app, **Postgres** for storage, and **Caddy**, which gets an HTTPS certificate automatically and forwards WebSockets. You need a server with Docker, a domain (or subdomain) whose DNS points at it, and ports 80 and 443 open.

```bash
cp .env.example .env      # set DOMAIN and a long random POSTGRES_PASSWORD
docker compose up -d --build
```

Then open `https://<your DOMAIN>`. Update later with `git pull && docker compose up -d --build`. To try the stack on your own machine, set `DOMAIN=localhost` and accept the browser's warning about Caddy's local certificate.

- **Where the data lives:** in the `db-data` Docker volume (offices, accounts and, unless you set up a bucket, uploaded files), and it survives restarts and `docker compose down`. Only `docker compose down -v` deletes it. Back it up with `docker compose exec db pg_dump -U workchop workchop > backup.sql`.
- **Sign-in:** making a workspace needs an account, so set up at least one way to sign in: see [Accounts and sign-in](#accounts-and-sign-in). Compose sets `PUBLIC_URL` to `https://<DOMAIN>`.
- **GitHub sign-in and notifications (optional):** set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env` for sign-in, and `TOKEN_ENCRYPTION_KEY` as well for notifications, see [GitHub](#github).
- **Paid plans (optional):** set `PAYSTACK_SECRET_KEY` in `.env` to charge for workspaces through Paystack, see [Billing](#billing).
- **TURN (optional):** people behind strict corporate firewalls may need a relay for calls to connect. The simplest is [Cloudflare's TURN service](#cloudflare-turn-for-calls). To run your own instead, set `TURN_URL=turn:<DOMAIN>:3478`, `TURN_USERNAME` and `TURN_CREDENTIAL` in `.env`, open TCP/UDP 3478 and UDP 49160–49200, and start with `docker compose --profile turn up -d --build`.

### Hosting on Cloudflare

There are three ways, from the least change to the most:

| | What runs where | Code changes | Rough monthly cost, small team |
| --- | --- | --- | --- |
| **Cloudflare Tunnel** | The Docker Compose stack on any server, with Cloudflare in front for HTTPS (no open ports) | None (`deploy/cloudflare-tunnel.yml`) | Your server (about $5–25) + Cloudflare Free |
| **Cloudflare Containers** | Everything on Cloudflare: the app's Docker image runs as a Container, pages are served from Cloudflare's edge, offices live in a hosted Postgres | Ready in `cloudflare/` | $5 Workers Paid plan + about $2–7 of usage + Postgres (free tiers work) |
| **Workers + Durable Objects** | One Durable Object per office, no container or database server | A rewrite of the realtime server (not done) | About $5 |

You need a domain on Cloudflare for your own hostname. With a Tunnel, the free certificate covers `example.com` and `office.example.com` but not deeper names like `office.team.example.com`. A custom domain on the Worker (Containers) gets its own certificate at any depth.

#### Cloudflare Tunnel

Keep running the Compose stack on your server, but let Cloudflare handle HTTPS instead of Caddy:

1. In the Cloudflare dashboard, go to *Networking > Tunnels*, create a tunnel, and copy its token.
2. Add a published application route from your hostname to `http://app:3001`.
3. In `.env`, add `CLOUDFLARE_TUNNEL_TOKEN=<token>` and `COMPOSE_FILE=docker-compose.yml:deploy/cloudflare-tunnel.yml`, and set `DOMAIN` to the tunnel's hostname. With `COMPOSE_FILE` set, every plain `docker compose` command, including updates, uses the tunnel setup.
4. If the stack already runs with Caddy, stop it first with `docker compose down` before adding `COMPOSE_FILE`. Then start it with `docker compose up -d --build`.

Caddy isn't started, so you can close ports 80 and 443: nothing needs to be reachable from the internet. Calls still go directly between people, so use [Cloudflare TURN](#cloudflare-turn-for-calls) for people behind strict firewalls. To let the weather use each visitor's approximate location, turn on Cloudflare's *Add visitor location headers* and set `GEO_HEADERS=cloudflare` (see [Weather](#weather)).

#### Cloudflare Containers

The `cloudflare/` folder deploys the same Docker image to [Cloudflare Containers](https://developers.cloudflare.com/containers/). A small Worker sends the API and realtime connections to one container and serves the app's pages from Cloudflare's edge.

What you need:
- A Cloudflare account on the **Workers Paid** plan ($5/month; Containers aren't on the free plan).
- Docker running on the machine you deploy from, because wrangler builds the image there.
- A **Postgres database reachable from the internet**, because a container's disk is wiped whenever it stops. For example, [Neon](https://neon.com)'s free tier: it sleeps when idle and wakes in well under a second, which Homeoffice's start-up retries cover.

```bash
npm install                                 # in the repo root
cd cloudflare && npm install
npx wrangler login
npx wrangler secret put DATABASE_URL        # e.g. postgresql://…neon.tech/neondb?sslmode=require
npm run deploy                              # builds the app and the image, then deploys
```

The first deploy takes a few minutes while Cloudflare prepares the container. Homeoffice is then at `https://workchop.<your-subdomain>.workers.dev`. For your own domain, add it as a zone in the same Cloudflare account (its nameservers must point at Cloudflare), list it under `routes` in `cloudflare/wrangler.jsonc` with `"custom_domain": true` (Cloudflare adds the DNS records and the certificate when you deploy), and set `PUBLIC_URL` to it. Every other address the Worker answers, the `workers.dev` one and `www.` included, then redirects to `PUBLIC_URL` with the same path: sign-in cookies, OAuth callbacks and realtime connections only work there. Update the callback URLs of your OAuth apps (GitHub, Google, Apple), Spotify's redirect URI and Paystack's webhook URL to the new address at the same time. Optional settings are wrangler secrets as well: `SPOTIFY_CLIENT_ID` (register `https://<your host>/spotify-callback.html` as its redirect URI), `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN`, the [sign-in](#accounts-and-sign-in) keys, `OPEN_METEO_API_KEY` (for the [weather](#weather) in commercial use), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` (for [GitHub](#github) sign-in and notifications), `PAYSTACK_SECRET_KEY` and `BILLING_INTERNAL_TOKEN` (for [paid plans](#billing)), and an R2 bucket for uploaded files (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; without one, files go into Postgres, which fills a free database quickly). Set `PUBLIC_URL` (in `wrangler.jsonc`) to the address people use; sign-in needs it.

How it behaves:
- **Starts on demand.** The first visit starts the container, which takes a few seconds. It stops about 15 minutes after the last person closes Homeoffice. Open tabs check in every few minutes, which keeps it running. [Desktop helpers](#current-app-and-the-desktop-helper) don't: their reports never start the container or keep it running.
- **Restarts.** Deploys, changed secrets, and now and then Cloudflare's host maintenance briefly disconnect everyone. People see "Reconnecting…" for a few seconds, then carry on. Office edits are saved first. When you change a secret, the server restarts on the next visit so it picks up the new value.
- **Placement.** Set `constraints.regions` in `cloudflare/wrangler.jsonc` to keep the container near your team and your database. Set `LOCATION_HINT` too, but **before the first visit**: Cloudflare places the coordinating Durable Object once and never moves it.
- **Billing's daily run.** With [billing](#billing) on, a Cron Trigger (`triggers.crons` in `wrangler.jsonc`, 06:00 UTC, 07:00 in Lagos) starts the container if it's asleep and runs the renewals, retries and locks through `/api/internal/billing/tick` with `BILLING_INTERNAL_TOKEN`; the Worker answers 404 to that path (and any `/internal/` path) from outside. The container then stops 15 minutes later as usual: about 7.5 hours a month. Try it locally with `npx wrangler dev --test-scheduled` and `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+6+*+*+*"` (the log then shows `[workchop] billing tick`; `/__scheduled` gets the app's page instead).
- **Size.** It runs as a single container (live rooms are in memory), on `basic` (¼ vCPU, 1 GiB) by default. That's plenty for a few dozen people; use `standard-1` for more.
- **Cost.** The $5 plan includes 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk a month. On `basic`, Homeoffice uses about $1.50 beyond that if it runs only during office hours, or about $7 if someone always leaves a tab open. Container logs count toward Workers Logs (20 million events a month included) and move to Cloudflare Observability pricing on 1 December 2026; turn `observability` off in `wrangler.jsonc` if you don't need them.

Local check: `npm run dev` in `cloudflare/` runs the Worker and the container on your machine (Docker required, with `DATABASE_URL` in `cloudflare/.dev.vars`).

#### Workers + Durable Objects

Not built. This would replace the Node server with one Durable Object per office, and Socket.IO with plain WebSockets. It would remove the container, the database server and the single-server limit, and cost about $5 a month for most teams. It's a few days of work, because Socket.IO and Express don't run on Workers.

#### Cloudflare TURN for calls

Most calls connect directly between browsers. People behind strict corporate firewalls need a relay (TURN).
1. Create a TURN key in the Cloudflare dashboard (*Realtime > TURN*).
2. Set `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN`, in `.env` for Compose or as wrangler secrets for Containers.

Homeoffice then hands each visitor short-lived credentials and refreshes them for long sessions. They last 24 hours by default (`CLOUDFLARE_TURN_TTL`), and a call relayed through TURN is cut when its credentials expire, so keep the TTL longer than your longest call. The first 1,000 GB a month are free, then $0.05/GB. Only calls that actually need the relay use it.

### What is stored

| Data | Where |
| --- | --- |
| Offices: layout, furniture, private areas, settings, kind, who besides members may come in, the guest link's token, the owner key of offices made before accounts | The database: Postgres when `DATABASE_URL` is set, otherwise PGlite in `DATA_DIR/db` |
| Accounts (people who signed in): name, email and whether it's verified, character and settings, sign-in methods, sessions, which offices they belong to and their role there | The database. Passwords are stored as a scrypt hash, sessions as a SHA-256 of the cookie's token |
| Invitations to a workspace: the address, the role, who sent it, when it expires | The database, as a SHA-256 of the link's token. Each works once, for 14 days; a clean-up every hour deletes expired ones |
| Emailed links (signing up, setting or resetting a password, changing the email address): the address, the account, when the link expires | The database, as a SHA-256 of the link's token. Each works once, for 24 hours (1 hour for password links); a clean-up every hour deletes expired ones |
| Emails in development (the dev outbox, without `RESEND_API_KEY`) | In memory (the last 50) and the server's log, which shows their links |
| GitHub connections: the GitHub account's id and login, access and refresh tokens, their scopes and expiry | The database, with the tokens encrypted (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`). Tokens never reach browsers. The notifications are kept in memory only, while their owner is in an office and for 10 minutes after they leave |
| GitHub connections being made: who started them, the PKCE verifier, the page to go back to, a SHA-256 of the `state` | The database. Each can be used once, within 10 minutes; a clean-up every hour deletes unfinished ones |
| Uploaded files | An S3/R2 bucket when `S3_*` is set, otherwise the database with Postgres, or `DATA_DIR/uploads` with PGlite (`UPLOADS_STORAGE` picks one). Files not attached to a chat message within a day are deleted |
| Names and characters of guests, guest links opened | Each person's browser (local storage) |
| Jukebox settings: station, own tracks/stream, shared Spotify links | With the office (part of the jukebox item) |
| Lamps and light switches (on or off), who has claimed which desk, what info boards say | With the office (part of each item) |
| Support tickets: number, status, the customer's name, optional email and first message, SHA-256s of their browser's key and of their address, who served it at which desk, the rating, when; and their history: handed from whom to whom, colleagues joining and leaving, when | The database (`support_tickets` and `support_ticket_events`; their chat with the other chat messages). Kept until deleted with their chat after `CHAT_RETENTION_DAYS` from when they closed. Who sits at which desk, which customer is here, colleagues helping and open hand-over and invitation offers are in memory only |
| This browser's id (one of you per office) | Each person's browser (local storage); the server keeps only its SHA-256, in memory, while you're connected |
| Notes left on desks: text, colour, author, when, read or not | The database (`desk_notes`), until the desk's owner or the author throws them away. Each owner keeps at most 50 per office; the oldest read ones make room |
| Spotify sign-in | Each listener's browser (local storage); never sent to the Homeoffice server |
| Chat: channels, messages, threads, reactions, mentions, who has read what | The database (attached files with the uploads). Kept until deleted, or for `CHAT_RETENTION_DAYS`. Nearby messages and direct messages with guests are never stored |
| Headphones (focus mode) | In memory only, while you're in the office |
| Noise suppression choice, devices | Each person's browser (local storage) |
| Coin wallets and every coin movement (a ledger), only with `COINS=on` (off for now) | The database |
| Weather settings: on/off, units, sharing, the chosen city or the rounded device location | Each person's browser (local storage). For signed-in people, also with their account, except the device location. The weather itself is cached in memory only, per ~11 km cell |
| Who's online, positions, calls | In memory only (live state) |
| Current app (picked by hand or from the desktop helper) | In memory only, never stored; a helper's report expires after 45 s without a heartbeat |
| Desktop helper pairings: computer name, when paired and last used | The database (`api_tokens`), with only a SHA-256 of each token |
| Billing, only with `PAYSTACK_SECRET_KEY`: each workspace's plan, seats and dates, its saved card (Paystack's authorization code, the card's brand, last 4 digits, expiry and bank) and the email it's charged with; every charge (a ledger with the workspace's name at the time), Paystack's webhooks (without the authorization code), which billing emails went out, and who changed what | The database (`billing_*`). Card numbers never reach Homeoffice: Paystack keeps them. The ledger, webhooks and log stay when a workspace is deleted |

**Postgres or PGlite?** Use Postgres for anything hosted. Each office is a single document, so it's stored as a `jsonb` row in an `offices` table; the tables are created and upgraded automatically on start-up. Managed Postgres (Neon, Supabase, RDS, Render, Railway, Fly…) works too: set `DATABASE_URL`, plus `DATABASE_SSL=no-verify` if the provider uses a certificate Node doesn't trust. Without `DATABASE_URL`, the server runs PGlite, Postgres compiled to WebAssembly, inside its own process: no setup, fine for development and a single small server with a persistent disk, but it needs about 300–500 MB of memory and every query briefly pauses the server. Switching between the two doesn't move data over.

Earlier versions saved offices as JSON files (`DATA_DIR/offices/*.json`, or `DATA_DIR/*.json`). On its first start, the server copies them into the database and moves them to `DATA_DIR/offices.imported`.

Run **one app instance**. Live rooms (who's where, call links) are kept in memory, so several instances behind a load balancer would split an office in two. One instance comfortably serves many offices.

### Without Compose

```bash
npm run build      # client -> dist/client, server -> dist/server
npm start          # serves both on PORT (default 3001)
```

or `docker build -t workchop . && docker run -p 3001:3001 -e DATABASE_URL=postgres://… workchop` (leave out `DATABASE_URL` to keep everything in PGlite in the `/app/data` volume). Put it behind any HTTPS reverse proxy that forwards WebSockets (Caddy, nginx, a cloud load balancer).

### Configuration

Everything is set with environment variables: in `.env` for Docker Compose (see `.env.example`), and on Cloudflare Containers as wrangler secrets (`npx wrangler secret put NAME`) or, for the ones that aren't secret, under `vars` in `cloudflare/wrangler.jsonc`. Keep the ones marked secret out of the repository and of logs.

**Deploy checklist.** Required: a database (`DATABASE_URL`; Compose runs its own Postgres, and needs `DOMAIN` and `POSTGRES_PASSWORD` in `.env`) and `PUBLIC_URL`, the HTTPS address people use (Compose sets it from `DOMAIN`). Making workspaces needs an account, so set up at least one way to sign in: email through Resend (signing up with an email address and password) or Google, Apple or GitHub; without one, the home page only offers joining with a link. Then, as needed: a bucket for uploaded files (R2 on Cloudflare), TURN for people behind strict firewalls, GitHub notifications, Spotify listen-along, an Open-Meteo key for commercial use, how long to keep chat, and paid plans (Paystack). Everything else has a sensible default.

| Variable | Needed? | Secret? | Default | What it's for, and where to get it |
| --- | --- | --- | --- | --- |
| `PUBLIC_URL` | Yes, in production (sign-in and GitHub need it) | No | `http://localhost:5173` in development; Compose: `https://<DOMAIN>` | The address people open Homeoffice at, e.g. `https://office.example.com`. Sign-in redirects are built from it, and Socket.IO refuses connections whose `Origin` differs |
| `DATABASE_URL` | Yes for anything hosted (Compose sets it) | Yes | – | Postgres connection string, from your database host (Neon, Supabase, RDS…). Without it, data is kept in PGlite in `DATA_DIR/db` |
| `DATABASE_SSL` | No | No | – | `require` (verified TLS) or `no-verify` (TLS without certificate checks, for some managed providers) |
| `DATA_DIR` | No | No | `./data` (`/app/data` in Docker) | Data folder: the PGlite database (`db/`), uploaded files with `UPLOADS_STORAGE=fs` (`uploads/`), and old office JSON files to import |
| `PORT`, `HOST` | No | No | `3001`, `0.0.0.0` | Where the server listens (in `npm run dev`, the API port Vite proxies to) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | For "Sign in with Google" | The secret | – | A *Web application* OAuth client in the Google Cloud console (see [Accounts and sign-in](#accounts-and-sign-in)) |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | For "Sign in with Apple" | The private key | – | From the Apple Developer portal: the Services ID, team ID, key ID and the `.p8` key (PEM, with `\n` for line breaks, or base64) |
| `RESEND_API_KEY` | For signing up with email, password resets and email changes | Yes | – (development: the dev outbox) | An API key from [Resend](https://resend.com) with sending access, for a domain you verified there (see [Email](#email)). Without it, `npm run dev` prints the emails to the server's log instead, and in production email is off |
| `EMAIL_FROM` | With `RESEND_API_KEY` | No | – | The sender, on the domain verified in Resend: `Homeoffice <noreply@mail.example.com>`, or just the address. With a key and no valid `EMAIL_FROM`, the server doesn't start |
| `DEV_LOGIN` | Development only | No | – | `true` allows signing in with just a name and email. Ignored by the built server (`npm start`, Docker) and when `NODE_ENV=production`, unless `DEV_LOGIN_IN_PRODUCTION=true` (never on a real server) |
| `UPLOADS_STORAGE` | No | No | `s3` when `S3_BUCKET` is set, else `db` with Postgres, `fs` with PGlite | Where uploaded files (chat attachments, office tracks) go: `s3`, `db` or `fs`. Each file remembers where it went, so switching keeps old files readable |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | Recommended on Cloudflare (R2) | The access key and its secret | –, `auto` for the region | An S3-compatible bucket for uploads, with path-style URLs. Cloudflare R2: create a bucket and an API token with object read and write; the endpoint is `https://<account id>.r2.cloudflarestorage.com` |
| `UPLOAD_MAX_BYTES`, `UPLOADS_QUOTA_MB` | No | No | `10485760`, `1024` | Largest file, and the total each office may keep |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | For "Sign in with GitHub" and [GitHub notifications](#github) | The secret | – | An OAuth App on GitHub (*Developer settings > OAuth Apps*), with the callback URLs for both (see [Accounts and sign-in](#accounts-and-sign-in) and [GitHub](#github)). Both need `PUBLIC_URL`; notifications also need `TOKEN_ENCRYPTION_KEY` |
| `TOKEN_ENCRYPTION_KEY` | For GitHub notifications | Yes | – | Encrypts the saved GitHub tokens: 32 random bytes in base64, from `openssl rand -base64 32`. Without a valid key, GitHub notifications stay off and the log says why (signing in with GitHub only needs the client ID and secret). Keep it: with a new key, everyone has to connect GitHub again |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_KEY_API_TOKEN` | For people behind strict firewalls (or the TURN settings below) | The API token | – | Cloudflare's TURN service, from the dashboard (*Realtime > TURN*): short-lived credentials per visitor (replaces the static ICE servers below) |
| `CLOUDFLARE_TURN_TTL` | No | No | `86400` | How long those credentials last, in seconds (600 to 172800) |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | No | The credential | – | Your own TURN server, e.g. Compose's coturn (comma-separate several URLs) |
| `ICE_SERVERS` | No | Yes, if it holds credentials | Google STUN | JSON array of `RTCIceServer`s, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` (instead of the `TURN_*` shortcut) |
| `CLIENT_IP_HEADER` | Behind a proxy | No | – (Compose: `x-forwarded-for`; set on Containers and with the Tunnel) | Header with each visitor's IP: `x-forwarded-for` directly behind the bundled Caddy, `cf-connecting-ip` when every request comes through Cloudflare. Only use a header the visitor can't set: leave it unset when nothing sits in front, and don't use `cf-connecting-ip` if your server can also be reached without going through Cloudflare |
| `SPOTIFY_CLIENT_ID` | For Spotify listen-along | No (a public PKCE client) | – | An app at <https://developer.spotify.com/dashboard> (see [Music and Spotify](#music-and-spotify)) |
| `CHAT_RETENTION_DAYS` | No | No | – (keep) | Delete chat messages (with their threads) that have been quiet for this many days, with their files (see [Chat](#chat)), and support tickets closed that long ago, with their chat |
| `WEATHER` | No | No | on | `off` turns the [weather](#weather) off: no calls to Open-Meteo, and everyone sees the usual daytime office |
| `OPEN_METEO_API_KEY` | For commercial use of the weather | Yes | – | Key for a paid [Open-Meteo plan](https://open-meteo.com/en/pricing) (the free API is non-commercial only, see [Weather](#weather)). A value that can't be a key (spaces, more than 200 characters) is ignored with a warning |
| `GEO_HEADERS` | No | No | – (`workchop` on Containers) | Who sets the headers with each visitor's approximate location, for the weather: `workchop` (Homeoffice's Cloudflare Worker) or `cloudflare` (Cloudflare's *Add visitor location headers* Managed Transform, e.g. with the Tunnel). Like `CLIENT_IP_HEADER`, only set it when every request comes through that proxy, or visitors could fake their location |
| `PAYSTACK_SECRET_KEY` | For paid plans ([Billing](#billing)) | Yes | – (billing off) | Your Paystack secret key (`sk_live_…`, or `sk_test_…` to try it) from the dashboard (*Settings > API Keys & Webhooks*). Without it every workspace is free and unlimited. Needs `PUBLIC_URL` |
| `BILLING_INTERNAL_TOKEN` | With billing on Cloudflare (or another outside scheduler) | Yes | – | At least 32 random characters (`openssl rand -hex 32`), shown by the daily cron to `POST /api/internal/billing/tick`. Without it that route answers 404, and only the server's own hourly run renews plans |
| `BILLING_TEAM_SEAT_PRICE`, `BILLING_SUPPORT_SEAT_PRICE` | No | No | `750000`, `18000000` | Prices in kobo: Team per seat per month (₦7,500), Support per seat per year (₦180,000). A price that isn't a whole number from 5000 to 10000000000 stops the server. Workspaces keep the price they signed up at |
| `COINS` | Development only | No | off | `on` brings back the old experimental coins (see [Coins](#coins-off-for-now)); don't set it on a real server |

Compose's own settings in `.env`: `DOMAIN` (required, your host name), `POSTGRES_PASSWORD` (required, secret: a long random password for the bundled database), and for the Tunnel `CLOUDFLARE_TUNNEL_TOKEN` (secret) and `COMPOSE_FILE`. Cloudflare Containers also has `LOCATION_HINT` and `EPHEMERAL_STORAGE` in `wrangler.jsonc` (see [Cloudflare Containers](#cloudflare-containers)).

STUN alone is enough on most home and office networks. People behind strict corporate NATs or firewalls need a **TURN server** (for example [coturn](https://github.com/coturn/coturn)) for calls to connect.

### Accounts and sign-in

Making a workspace needs an account; coming into one with its guest link doesn't (see [Workspaces](#workspaces)). People with an account choose their name and character once, when they sign up, and change them in *Profile*; offices show them as their account has them (the lobby doesn't ask again). They keep their status, theme and weather settings across devices, and the home page lists the workspaces they belong to (with who's in them right now), most recently used first. The sign-in options (on the home page, and in an office's lobby, which you come back to after signing in) appear for the methods that are set up:

- **Email and password** (needs [email](#email)): people enter their address and get a link that works for 24 hours, where they choose their name, character and password (at least 10 characters, not the email address, no other rules). They then sign in with the address and password. *Forgot password?* mails a link that works for an hour, and using it signs the account out everywhere else (setting a first password this way signs no one out); changing the password in *Profile* signs out its other devices. Changing the email address in *Profile* asks for the password (when the account has one) and mails a link to the new address, which must be opened while signed in to the account that asked; only the newest such link works. Once confirmed, the old address gets a note about it and the account's other devices are signed out. Answers never tell whether an address has an account: signing up with an address that has one sends an email saying so, with a link to set a password, and asking for an address another account has sends nothing. Passwords are hashed with scrypt.
- **Google:** in the Google Cloud console (Google Auth Platform), set up the branding, set the audience to *External* and publish it to *In production* (for just name, email and profile no review is needed). Create a *Web application* client with the redirect URI `https://<your host>/api/auth/google/callback` (and `http://localhost:5173/api/auth/google/callback` for development), copy the secret right away (it's shown once), and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Google deletes clients that go unused for six months.
- **Apple** (needs a paid Apple Developer membership): enable *Sign in with Apple* on an App ID, create a *Services ID* with your domain and the return URL `https://<your host>/api/auth/apple/callback` (HTTPS only, no localhost), and create a *Sign in with Apple* key. Set `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` (the `.p8` file). Apple sends a person's name only the first time they sign in.
- **GitHub:** uses the OAuth App of [GitHub notifications](#github) (create it as described there), and is on whenever `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set (with `PUBLIC_URL` in production; `TOKEN_ENCRYPTION_KEY` isn't needed for it). Register `${PUBLIC_URL}/api/auth/github/callback` as another callback URL next to `…/api/integrations/github/callback` (and `http://localhost:5173/api/auth/github/callback` for development); the server's log prints it when GitHub sign-in is on. Existing setups with GitHub notifications get the button as soon as they update, so add the callback first, or GitHub refuses the sign-in (people come back with "Sign-in didn't work", and the log names both callback URLs). Signing in asks only for the `user:email` scope, to read the GitHub profile (name, picture) and email address. Homeoffice then revokes that token right away (only that one: a connection for notifications stays) and keeps no access to the GitHub account. GitHub asks every time which account to use. Signing in only starts from Homeoffice's own pages, or from a link opened outside the browser (from an email or chat app, say, which can lead through another site first); other sites' pages can't start it. Signing in with GitHub doesn't connect GitHub notifications: that's still *Connect GitHub* (scope `notifications`).
- **Development:** `DEV_LOGIN=true npm run dev` adds a sign-in with just a name and email.

**One account per email address.** An address is verified when someone used a link Homeoffice sent to it, or when Google, Apple or GitHub vouch for it: on GitHub, the verified primary address (a public profile email doesn't count); on Google, only Gmail and Google Workspace addresses (a personal Google account can be made with any address, like a former work one, so those are kept unverified). The first time someone signs in with a Google, Apple or GitHub account whose verified address an account already has, they're signed in to that account and can use either method from then on (and a password, set from a link sent to that address). Signing in again with an account made before, once its provider vouches for its address, verifies it too. Unverified addresses, and the dev login's, are never linked: they get accounts of their own. Accounts that already shared an address before this version aren't merged; the oldest keeps it as its verified address. *Profile* lists an account's sign-in methods, each on its own (two GitHub accounts show their logins): *Connect* adds another (not one that belongs to another account), and one can be removed while a password or another method remains. *Sign out other devices* there ends every session but the current one.

Sessions last 30 days from the last visit, in an HttpOnly cookie (`__Host-wc_session` over HTTPS).

#### Email

Homeoffice emails sign-up links, password resets, email-change confirmations and workspace invitations through [Resend](https://resend.com):

1. Add a domain you own in Resend (a subdomain such as `mail.example.com` works) and create the DNS records it lists (SPF and DKIM). A `workers.dev` address can't send email.
2. Create an API key with sending access and set it as `RESEND_API_KEY` (a secret), and set `EMAIL_FROM` to the sender, e.g. `Homeoffice <noreply@mail.example.com>`. With a key but no valid `EMAIL_FROM`, the server doesn't start; the log says what's wrong. The links in the emails point at `PUBLIC_URL`.

Without a key, `npm run dev` keeps the emails in a dev outbox and prints their links to the server's log, so signing up works locally. In production without a key, email is off: signing up with email and password resets aren't offered (people who have a password can still sign in with it), and the log says so. The server never logs the key or whole addresses. Resend's free plan has a daily sending limit (see its pricing page). Apple's private relay addresses only get email from domains registered with Apple (*Sign in with Apple for Email Communication* in the Apple Developer portal).

### Workspaces

Each office is a workspace with one **owner**, and **admins** and **members** who signed in. Its kind, a team office or a [support workspace](#support-workspaces), is fixed when it's made.

| Who | Can |
| --- | --- |
| Owner | Everything: add and remove admins and members, change roles, hand the workspace to another member (becoming an admin), the guest link, who may build |
| Admin | Add and remove members, the guest link, always build |
| Member | Build (unless the owner left building to the admins), leave |
| Guest | Come in with the guest link; build only in offices made before workspaces. In support workspaces guests are customers |

- **Coming in.** After their first visit on a browser, members go straight in, skipping the lobby: the microphone and camera come on only if the browser already allows them (otherwise a toast says to press `M`), and when the browser blocks sound until a click, a pill says so. Leaving takes you home, and that tab stays there (no going back in by itself). Guest links (`#guest=`) are kept per office in the browser and taken out of the address. The dock has *Invite people* for owners and admins and *Copy link* for members.
- **Who comes in.** Members always. New workspaces let in nobody else until an owner or admin turns on the **guest link** (*Settings > Workspace*): `/o/<id>#guest=<token>`. Anyone with it comes in as a guest, without an account; a new link stops the old one working (guests already in stay until they leave or reconnect), and turning it off takes the guests out. Signing in never makes someone a member: they're added. Guests take at most 90 of an office's 100 places (with [billing](#billing) on, 3 at once on the Free plan and 25 on Team). Owners and admins moderate chat (rename and archive channels, delete messages). The workspace's name is changed in *Settings > Workspace* (or the Build panel's *Office* tab), by whoever may build there.
- **Adding people.** Owners and admins (with a confirmed email address) add people by email. An account that has confirmed that address joins at once and gets an email saying so; anyone else gets an invitation to `/invite#t=…` that works once, for 14 days. That page shows the workspace and makes their account (or accepts it signed in with that address) and takes them in; signing up or confirming that address later joins them too. Answers say whether an address has an account, so adding people is limited (30 an hour per person, 100 a day per workspace). With [billing](#billing) on, everyone added or invited takes a seat: when they're all taken, the answer is 402 `seats-full` (and 403 `locked` while the workspace is paused).
- **Offices made before workspaces** stay open to anyone with the address until their owner turns the guest link on or off (it can't be opened up again). People who had signed in there stay members, and owners stay owners; where an office had several, the earliest keeps it and the others are admins. Offices made without an account belong to whoever kept the owner key: signed in, they add them to their account from the home page (or by coming in), and until then the key still lets them edit. **When updating a server from before workspaces:** existing offices stay open, and in one nobody owns yet nobody can be added as a member until someone signs in with the creator's browser and claims it.

The members API, for owners and admins (members can list members and leave): `GET /api/offices/<id>/members`, `POST …/members {email, role}` (201 added, 202 invited; with billing, 402 `seats-full` or 403 `locked`), `PATCH …/members/<userId> {role}`, `DELETE …/members/<userId>`, `POST …/owner {userId}`, `DELETE …/invites/<id>`, `POST …/invites/<id>/resend` (with billing on, only an invitation that hasn't expired, as an expired one holds no seat: 404, add the address again), `PUT …/access {guests: "off" | "link"}` and `POST …/access/reset`. People who aren't members get 403 without the workspace's name.

### Billing

Paid plans, collected with [Paystack](https://paystack.com) in naira. Billing is off, and every workspace free and unlimited as before, until `PAYSTACK_SECRET_KEY` is set: self-hosted servers, development and the tests stay that way.

| Plan | For | Price | People | Guests at once |
| --- | --- | --- | --- | --- |
| Free | Team workspaces | – | 3 | 3 |
| Team | Team workspaces | ₦7,500 per seat a month (`BILLING_TEAM_SEAT_PRICE`) | The seats bought | 25 |
| Support | Support workspaces (there's no free use) | ₦180,000 per seat a year, ₦15,000 a month (`BILLING_SUPPORT_SEAT_PRICE`) | The seats bought | Customers as before |

- **Seats.** The owner, admins and members, and invitations still open, each take a seat; guests and customers don't. Only the owner buys seats (*Settings > Billing*), with a confirmed email address, and upgrading from Free charges every seat, the owner's included. Admins fill free seats; when they're all taken, adding someone says to ask the owner for more. Seats added during a period are charged at once for the rest of it (less than ₦50, or in its last hour, goes on the next renewal instead), one payment at a time: while the bank confirms one, adding seats again points to the bank's page. Seats removed take effect at the next renewal, never below the seats in use. A payment for fewer seats than are in use when it arrives (people added while the owner was on Paystack's page) gives the seats in use, and the next renewal charges for the ones not paid for.
- **Paying.** The first payment and changing the card go through Paystack's checkout page, by card only (a Visa or Mastercard, or a Verve card that allows recurring payments); changing the card charges ₦50, credited to the next renewal. Paystack sends people back to `/billing/return`, which asks Paystack about the payment; Paystack's webhook does the same, and whichever comes first counts, once. Renewals and added seats are charged to the saved card. The scheduled run asks Paystack about payments whose answer never came: charges to saved cards first and every time, a checkout 15 minutes after it was started and again a day later, when it's given up if it isn't paid (a late payment still counts). Paying twice for the same thing refunds the second payment by itself (asked again at each scheduled run while Paystack can't be reached; one it refuses is logged and left to its dashboard), and the owner's payment history shows where that refund is: due, asked of Paystack, or refused. A payment Paystack confirms that doesn't match what was charged for (amount, currency, workspace, payer) isn't applied: it's refunded the same way, and a saved card it came from isn't charged again by itself (the owner pays from Billing). Other refunds are made in Paystack's dashboard.
- **Unpaid.** Until it's paid, a support workspace has 3 seats and lets in only its owner and admins, at most 3 at once as when paused (below), and no customers. A renewal that fails is tried again 1, 3 and 6 days later (the owner trying it again in *Billing* doesn't use these up). Seven days after the period ended (failed, cancelled, or no card to renew with) the workspace **pauses**: only the owner and admins can come in, at most 3 at once (an admin can't come in while 3 people are in it, but the owner always can; when it pauses, the admins who came in last leave until 3 are left), and everyone else is taken out, as is an admin made a member while it's paused. Paying starts a new period. A team with 3 people or fewer goes on the Free plan instead of pausing: at once when its plan was cancelled or has no card to renew with, and after a failed renewal when the seven days are up (it keeps its plan and the retries until then, and the emails say it goes on the Free plan). Once a period ends, the plan shows as active until the next run charges its renewal, and its seats can't be changed until then. A renewal that hasn't been tried never pauses a workspace: when no run happened for more than a day after the period ended (the server was down), the seven days and the retries count from the first try. When the bank wants the owner to confirm a renewal, *Billing* links to its page. The owner gets emails (receipts, failed payments, reminders, a yearly renewal coming, a card expiring), and since email is off in production without Resend, everything also shows in the app: a banner for the owner and admins, and a badge on the workspace's card at home.
- **Cancelling** ends the plan at the end of its period; it can be resumed until then, and after it until the workspace pauses, as long as the renewal wasn't tried (the saved card is then charged at the next run; after a failed payment, pay instead). Cancelled after the period ended (its renewal not charged yet, or failed), the plan ends at once. A renewal already under way when the plan is cancelled still counts if it's paid: the plan then runs for that period and ends.
- **A new owner.** Handing the workspace to another member keeps the paid period, removes the old owner's card and stops renewing until the new owner adds a card (the transfer dialog says so).
- **Workspaces from before billing.** The first time the server starts with a key, every support workspace there is, and every team with more than 3 people, gets 30 days to choose a plan (then pauses as above); the other teams are on the Free plan, and teams made before then keep 90 guests for those 30 days.
- **Who sees what.** Admins see the plan, seats and dates; amounts, the card, the history and every change are the owner's.

Setting it up:
1. Use a Paystack account for Homeoffice alone (payments of other apps on it are ignored), ideally for a registered business: a Starter Business account stops at ₦8,000,000 collected in all. In the dashboard, turn on international payments and have the business pay the fees (so what's charged is what Homeoffice asked for). Don't turn on the IP allowlist: Cloudflare Containers have no fixed address. Prices are taken to include VAT; ask an accountant.
2. Set `PAYSTACK_SECRET_KEY`, and on Cloudflare `BILLING_INTERNAL_TOKEN` (both secrets). `PUBLIC_URL` must be set.
3. In Paystack's dashboard (*Settings > API Keys & Webhooks*), set the webhook URL to `https://<your host>/api/billing/paystack/webhook`; test and live mode each have their own. Homeoffice sends the callback address itself. On a custom domain behind Cloudflare, keep that path out of bot and firewall rules.
4. Renewals need a run each day. A server that keeps running (Docker Compose) does it hourly by itself. On Cloudflare Containers the container sleeps, so the Worker's Cron Trigger wakes it once a day (see [Cloudflare Containers](#cloudflare-containers)). Who may come in is always worked out from the stored dates, so a late run never lets anyone in or keeps them out by mistake.

**Complimentary workspaces** (your own, or for testing) are never charged or limited. There's no admin page; set it with SQL:

```sql
INSERT INTO billing_accounts (office_id, status, comp) VALUES ('<office id>', 'free', true)
ON CONFLICT (office_id) DO UPDATE SET comp = true;
```

**Trying it without Paystack:** `npx tsx tests/helpers/paystack.ts` starts a stand-in for Paystack with its own checkout page (Pay, Decline, Cancel) and prints the settings to start the server with (`PAYSTACK_SECRET_KEY=sk_test_mock PAYSTACK_API_BASE=…`). With Paystack's own test keys, the test cards 4084 0840 8408 4081 (succeeds), 4084 0800 0067 0037 (insufficient funds) and 5192 6027 2058 4796 (bank check) work on the real checkout page; Paystack can't reach a webhook on `localhost`, but the return page settles the payment.

The billing API: `GET /api/billing/status` (the prices, or `{available: false}`), `GET /api/offices/<id>/billing` (owner and admins; for the owner only, `details`: amounts, what paying now would charge while a payment is overdue (`due`), the card, and the last 24 payments, without checkouts that were never paid but with the saved card's failed charges), and for the owner `POST …/billing/checkout {seats?}` (→ `{url}`, Paystack's page), `…/seats {seats}`, `…/cancel`, `…/resume` and `…/retry`. `POST /api/billing/verify {reference}` (signed in) settles a payment for the return page. Changes are sent live to the owner and admins in the office (`billing:state`).

### Chat

Chat works out of the box; it keeps its messages in the database and attached files with the other uploads (`UPLOAD_MAX_BYTES` per file, `UPLOADS_QUOTA_MB` per office). Who may do what:

- Everyone in an office, guests included, can read and write in its channels, create channels, set a channel's topic, and edit or delete their own messages. Guests are known by their connection, so after a reload they can no longer edit what they wrote before.
- The owner and admins can also rename and archive channels and delete anyone's channel messages; members and guests can't. #general can't be renamed or archived. Archived channels keep their history and can be unarchived.
- Direct messages are only ever sent to, and readable by, the two people in them.

Deleting a message deletes its files too, and files nobody attached to a message within a day are deleted. Set `CHAT_RETENTION_DAYS` to have messages deleted automatically, with their threads and files, once nobody has written in them (or in their thread) for that many days; files sent in live messages go after that long too. The server checks at most hourly, when someone comes in. A support ticket's chat goes with its ticket instead (see [Support workspaces](#support-workspaces)).

A message's link (its "Copy link" action) opens the office at that message, for anyone who can see it.

### Support workspaces

Pick *Customer support* when making a workspace. It starts from the *Support lobby* template (56 × 40 m): six help desks along the north wall under a *Now serving* screen, the entrance and a welcome board in the south, lounges, fish tanks, FAQ boards, a coffee bar, games and a music corner. Only the owner and admins build there; they also write what the info boards say (click one, then *Edit*).

- **Customers** come in with the **customer link**, the workspace's guest link, which is on from the start (*Settings > Workspace* shows it; turning it off takes the customers out, and *Reset* makes a new one). They need no account: they give their name, optionally an email address, and what they need help with, and wait. Everyone else sees them as "Visitor" and then "Visitor #45" (never their account, if they're signed in); staff see their real names. Customers can't see channels, direct messages or who belongs to the workspace, can't build, switch the lights, change the music, leave notes or send coins, only ever hear (and tap) the agent serving them and the colleagues helping, and send files only in their open ticket. They count as guests (90 of the 100 places); see [Limits](#limits) for how many may come from one address. Customers here 15 minutes without an open ticket are taken out, to make room. Staff can **take a visitor out**: their ticket ends, that browser can't open tickets for 4 hours, and their address can't come back for an hour.
- **Staff** are the workspace's owner, admins and members. Each takes a free help desk (one each; it follows you to your newest tab) and presses **Next**: the first customer in the queue who is here is called, walks to the customer's side of that desk and sits facing them (or is placed there if they haven't arrived in 25 seconds, and at once when their tab is in the background). Everyone sees them sit down as it happens. Two agents pressing Next at once get different customers; an agent serves one customer at a time. While serving, the agent and the customer are in a call wherever they are (at full volume), and the agent is out of the other staff's calls. **Resolve** ends the ticket. Staff see the queue (with how long each customer has waited, and who stepped away), the desks in use, and past tickets with their chat, searched by name, email or number.
- **Hand over:** the agent serving a visitor can hand them to a colleague who is at a desk and serving nobody (*Hand over* on the ticket). The colleague sees "Mia wants to hand you Visitor #45" with **Accept** and **Decline**; the offer lapses after a minute, and the agent can take it back. On Accept the ticket, its desk and the call move to the colleague at once, the visitor is told who will help them now and walks over to their desk, the chat carries on, and the first agent is free for the next visitor. One offer at a time from each agent, and to each colleague.
- **Invite a colleague:** the agent can also invite a colleague who isn't serving anyone (*Invite*) into the conversation, wherever they are: on Accept they're in the call with the agent and the visitor at full volume, write in the ticket's chat, and the visitor sees they joined. Up to two colleagues per ticket. The agent stays in charge (only they hand over or resolve) and can end a colleague's part; colleagues can leave, and their part ends with the ticket, or after 30 seconds away. Helping, they can't call the next visitor.
- **Ticket chat:** every ticket has its own chat. The customer writes in it under the name they gave while the ticket is open (their first message starts it), the agent serving it and the colleagues helping write too, and all staff can read every ticket's chat. A ticket's history also shows who handed it to whom, and who joined and left its conversation.
- **Stepping away:** a customer who leaves (or reloads, or loses their connection) keeps their place for 10 minutes; coming back on the same browser picks the ticket up where it is: still waiting, being served, or, if it ended meanwhile, the thanks and the rating (or a note that their place ran out). After 10 minutes away a waiting ticket is closed as abandoned. An agent who leaves while serving gets 10 minutes to come back to their desk and customer; after that the customer goes back to the front of the queue. A desk whose agent isn't serving anyone waits 30 seconds for them. A restart keeps tickets: people come back to them as they reconnect, and a ticket being served in a workspace nobody comes back to closes once its customer has been gone 10 minutes.
- **Build mode:** moving or removing a desk in use frees it; its customer goes back to the front of the queue.
- **Made a member:** a customer made a member while inside becomes staff at once: their ticket ends, and the others see them by their account's name.
- **Keeping tickets:** tickets are kept until `CHAT_RETENTION_DAYS` after they closed, then deleted with their chat and its files (without it, they're kept). Numbers keep counting up.

### GitHub

People who sign in can connect their own GitHub account and follow their GitHub notifications without leaving the office. The GitHub panel (the GitHub button in the dock, or in its More menu on phones) shows what's unread in their GitHub inbox, in four tabs:

- **Mentions:** you, or a team you're on, were @mentioned, or you were assigned.
- **Reviews:** someone asked for your review. The tab also shows how many open pull requests are waiting for your review; that count stays until you've reviewed them, even once the notifications are read.
- **Actions:** workflow runs you started (green: succeeded, red: failed, grey: cancelled or skipped), and deployments waiting for your approval (amber).
- **Activity:** everything else, such as comments on issues and pull requests you opened or follow.

The dock badge counts unread mentions, review requests and failed runs. Clicking an item opens it on GitHub and marks it read; *Mark read*, *Done* and *Mark all read* change your inbox on GitHub too (*Mark all read* leaves unread what arrived after the panel last checked). Like GitHub's unread view, the panel lists unread notifications only: read ones leave it with the next update. A new failed run also pops up as a message with an *Open* button, and a small red badge pulses on the monitor of your own desk (the one you claimed, or else the one you sit at) until you open the panel or the run is read or done. Only your browser draws it: nothing about your GitHub reaches the office. People connect and disconnect in *Settings > Integrations*; guests see "Sign in, then connect GitHub here". On a server without the settings below, or where nobody can sign in, GitHub doesn't appear at all.

**Setting it up.** GitHub needs people to sign in and `PUBLIC_URL`. The OAuth App below also gives them [Sign in with GitHub](#accounts-and-sign-in) (Google, Apple and `DEV_LOGIN` work too). Then:
1. Create an **OAuth App** (not a GitHub App: GitHub's notifications API doesn't accept GitHub App tokens). Create it under your company's GitHub organization (*Organization settings > Developer settings > OAuth Apps > New OAuth App*), because apps an organization owns get access to its data automatically. A personal one (<https://github.com/settings/applications/new>) works too, but then each organization that restricts OAuth Apps has to approve it first (see below).
2. Name it (people see the name when they connect) and use your Homeoffice address as the *Homepage URL*. Set the *Authorization callback URL* to `${PUBLIC_URL}/api/integrations/github/callback`, e.g. `https://office.example.com/api/integrations/github/callback`, and add `${PUBLIC_URL}/api/auth/github/callback` for signing in. They must match exactly. An app can have up to 10 callback URLs, so development (`http://localhost:5173/api/integrations/github/callback` and `…/api/auth/github/callback`) and production can share one app. Leave *Enable Device Flow* off.
3. Keep *Expire user access tokens* on (the default). Access tokens then last 8 hours, and Homeoffice renews them with the refresh token GitHub gives it, which lasts 6 months without use.
4. Generate a client secret and copy it right away (GitHub shows it only once).
5. Generate the encryption key with `openssl rand -base64 32`.
6. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` (in `.env` for Compose, or with `npx wrangler secret put NAME` on Cloudflare Containers) and restart. If only one of the client ID and secret is set, or `PUBLIC_URL` isn't set (in production), GitHub stays off; if the key is missing or invalid, only notifications do (signing in with GitHub doesn't need it). The server's log says why. When they're on, the log says so, with the callback URLs to register. A `PUBLIC_URL` that isn't an http(s) address stops the server from starting. One that differs from the address people use, or from the callback URL above, makes connecting fail at GitHub.

Keep `TOKEN_ENCRYPTION_KEY` safe and don't change it. The saved tokens can only be read with it, so with a new key everyone has to connect GitHub again, and anyone who has both the key and the database can use the tokens.

**Scopes.** Connecting asks GitHub only for the `notifications` scope: reading your notifications and marking them read or done. It gives no access to code. Links then go to the pull request, issue, Actions or repository page, worked out from the notification. *Include private repos & Actions* in *Settings > Integrations* connects again with the `repo` scope as well. Homeoffice then asks GitHub for the exact page (such as the latest comment) of up to 10 new notifications per poll; the others keep the link worked out from the notification. With `repo`, the review and assignment counts include private repositories too. **`repo` gives full read and write access to all your repositories**, public and private, because GitHub has no read-only alternative for OAuth Apps. Homeoffice only reads with it, but turn it on only if you're comfortable with that. Connecting again replaces the previous token and revokes it at GitHub (renewing it first if it has expired, so there's a live token to revoke).

**What each person should turn on.** The panel shows what GitHub puts in your inbox at <https://github.com/notifications>, so:
- In GitHub's [notification settings](https://github.com/settings/notifications), choose *On GitHub* for *Participating* and *Watching*, and under *System > Actions* choose *On GitHub* (optionally only for failed workflows). Without it, Actions runs, and maybe everything else, are missing. GitHub only notifies you about workflow runs you started.
- **Organizations** restrict OAuth Apps by default: until an owner approves Homeoffice's app, nothing from that organization's private repositories comes through. Ask for approval at `https://github.com/settings/connections/applications/<client id>` (Homeoffice's settings link there). Apps the organization owns are approved automatically.
- **SAML single sign-on:** for organizations that use it, you need an active SSO session with each of them when you connect, or their notifications are missing. Sign in to the organization on GitHub, then connect again.

**Polling and rate limits.** The server asks GitHub for new notifications only for people who are in an office right now, and stops when they leave. It sends `If-Modified-Since`, so a "nothing new" answer doesn't count against GitHub's rate limit, and between polls it waits as long as GitHub's `X-Poll-Interval` asks, at least a minute. Each poll reads the newest 100 unread notifications at most (two pages of 50); when there are more, the panel says so and links to your inbox on GitHub. Every 5 minutes, two searches count the open pull requests waiting for your review and the open issues and pull requests assigned to you (in public repositories only, unless `repo` is on). These requests use the person's own GitHub rate limit: 5,000 requests an hour, shared with every other app and token acting for them, and 30 searches a minute. Homeoffice uses a small part of it. When GitHub says to slow down (403 or 429), the server waits as long as GitHub asks (at most an hour), or a minute when it doesn't say; after other errors, and when it keeps saying so, it waits longer each time, up to 15 minutes. Each person can start connecting at most 5 times in 10 minutes (then Homeoffice asks them to wait a few minutes), because every connection makes a new token: GitHub asks people to authorize again after 10 new tokens in an hour, and keeps only 10 per app and scope, revoking the oldest.

**What's stored.** The GitHub account's id and login, the access and refresh tokens, their scopes and expiry times, in the database. The tokens are encrypted with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`, never sent to browsers and never logged; browsers only get the notifications. The notifications themselves are kept in memory only, while you're in an office and for 10 minutes after you leave (so a reload doesn't fetch them all again). A connection being made is stored with who started it, its PKCE verifier, the page to go back to and a SHA-256 of its `state`; it can be used once, within 10 minutes, and a clean-up every hour deletes unfinished ones. Connecting only starts from Homeoffice's own pages, or from a link opened outside the browser (which can lead through another site first): when another site's page sends someone to it, it's refused. A GitHub account can be connected to one Homeoffice account at a time: connecting it from another one moves it there.

**Disconnecting and expiry.** *Disconnect* deletes the saved connection, stops polling and revokes the token at GitHub. If the access token has expired, Homeoffice renews it first, so there's a live token to revoke. If GitHub can't be reached then, the connection is still deleted; revoke the app on GitHub to be sure. It revokes only this server's token, so other Homeoffice servers that share the OAuth App stay connected. To remove Homeoffice's access completely, revoke the app at <https://github.com/settings/applications>. Homeoffice renews access tokens itself, in the last 5 minutes before they expire. When GitHub stops accepting the saved tokens (revoked on GitHub, a refresh token unused for 6 months, or a changed `TOKEN_ENCRYPTION_KEY`), polling stops and Homeoffice asks you to reconnect.

**Trying it locally.** A mock GitHub stands in for github.com and its API, with sample notifications in every tab:

```bash
npx tsx tests/helpers/github.ts               # on port 3999 (or PORT); prints the settings to use
DEV_LOGIN=true <those settings> npm run dev   # in a second terminal
```

Sign in with the dev login (or with GitHub, through the mock), open an office and connect GitHub: the mock asks which test account to authorize. Add notifications at `http://localhost:3999/_mock`; they show up with the next poll, within about a minute. The mock keeps everything in memory, so connect again after restarting it. To try the real GitHub, add `http://localhost:5173/api/integrations/github/callback` and `http://localhost:5173/api/auth/github/callback` to your OAuth App's callback URLs and start `DEV_LOGIN=true npm run dev` with its `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` and a `TOKEN_ENCRYPTION_KEY`.

### Music and Spotify

The built-in radio stations work out of the box. Two things to know before adding your own music:

- **Your own tracks and streams** must be music your organisation may play to its staff, e.g. royalty-free or licensed tracks, your own Icecast server, or a business music provider's stream URL. Most consumer radio stations and services (including YouTube, SoundCloud, and Spotify itself) don't allow being re-played inside another app. URLs must be `https://`. Audio files need range requests (any normal web server or bucket has them) so late joiners can start in the middle of a track.
- **Spotify listen-along** uses Spotify's Web Playback SDK, which has strict rules:
  1. Create an app at <https://developer.spotify.com/dashboard>, tick **Web Playback SDK** and **Web API**, and add the redirect URI `https://<your domain>/spotify-callback.html`. For local testing, open Homeoffice at `http://127.0.0.1:5173` (not `localhost`; Spotify only accepts loopback IPs over plain http) and register `http://127.0.0.1:5173/spotify-callback.html`.
  2. Set `SPOTIFY_CLIENT_ID` (in `.env` for Docker Compose) and restart. No client secret is needed (sign-in uses PKCE).
  3. Every listener needs **Spotify Premium** and a desktop browser. Apps in Spotify's *development mode* work only for accounts you add under *User Management* (currently up to 5). Spotify grants wider access only to established organisations, and its developer policy doesn't allow apps aimed at businesses. So treat listen-along as a feature for small teams and friends, and use the board's links and Jams for everyone else.

### Headphones and noise suppression

Nothing to set up: no environment variables, keys or third-party services. Enhanced noise suppression runs RNNoise ([@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor), MIT) in an AudioWorklet in each browser; its worklet and WebAssembly files (about 130 KB gzipped) are part of the build and are only downloaded by people who turn it on. It needs a browser with AudioWorklet (Chrome, Edge, Firefox 76+, Safari 14.1+) and 48 kHz audio; elsewhere it says so and keeps Standard. If you put a Content-Security-Policy in front of Homeoffice (in Caddy or the Worker), allow `'wasm-unsafe-eval'` and scripts from `'self'`.

### Current app and the desktop helper

Browsers can't see which app you're using, so Homeoffice has two ways to show it:

- **By hand**, for everyone (guests too): the status button next to you in the dock, or *Settings > Privacy & status*. What you pick wins over the helper. Nothing shows while you're *Away*.
- **The desktop helper** (signed-in people, so only on servers where people can sign in): *Settings > Desktop helper > Pair a computer* creates a token for that computer, shown once, and a command to copy into a terminal, which asks for the token (so it stays out of your shell history). The command downloads one script (`helper/workchop-presence.cjs`, no packages, needs [Node.js](https://nodejs.org) 18+), pairs it and starts it. Later, start it with `node ~/workchop-presence.cjs run`; `status` shows what it would send, `unpair` forgets the token. Remove a computer in the same settings section and its token stops working at once.

**Privacy.** Every 5 seconds the helper reads only the identifier of the app in front (a macOS bundle id, a Windows process name or a Linux window class), never window titles, URLs or the screen. It turns that into an id from Homeoffice's list (`shared/apps.ts`) **on your computer** and sends only the id, or `other` for any app not on the list (shown as "Working", or hidden if you turn off *Show other apps as "Working"*). It sends on a change plus a heartbeat every 15 s. The server keeps it in memory only. It's hidden while you're on *Do not disturb* or wearing headphones, and turning off *Share what app I'm using* hides it everywhere at once. Its token is kept in `~/.config/workchop/helper.json` (`%APPDATA%\Workchop\helper.json` on Windows), readable only by you.

**Per system:**
- **macOS:** reads `NSWorkspace.frontmostApplication` through `osascript` (JavaScript for Automation). It sends no Apple Events, so macOS asks for no Automation, Accessibility or Screen Recording permission.
- **Windows:** one hidden PowerShell process reads the foreground window's process name (`GetForegroundWindow`). Where PowerShell is locked down (AppLocker/WDAC "ConstrainedLanguage"), the helper reports that it can't tell. Some company security tools flag PowerShell calling Windows APIs; ask your IT team first on a managed computer.
- **Linux:** on X11 it uses `xprop` (`WM_CLASS` only). On Wayland it works on Sway, Hyprland and niri, and on GNOME with the [Focused Window D-Bus](https://github.com/flexagoon/focused-window-dbus) extension (which shows the focused window's title to other programs on your session bus too; Homeoffice drops it). Other Wayland desktops, including KDE Plasma, can't tell yet: the helper says so in *Settings > Desktop helper*, and picking a status by hand still works.

**Starting it at login:** macOS, a LaunchAgent (`~/Library/LaunchAgents/com.workchop.presence.plist` running `node ~/workchop-presence.cjs run` with `RunAtLoad`); Windows, a shortcut in `shell:startup` to `node %USERPROFILE%\workchop-presence.cjs run` (or Task Scheduler); Linux, a systemd user service (`ExecStart=/usr/bin/node %h/workchop-presence.cjs run`, `systemctl --user enable --now workchop-presence`).

**Server side.** `PUT /api/me/app-presence` with `Authorization: Bearer wcp_…` and `{"app": "<id>" | "other" | null, "platform": "macos" | "windows" | "linux", "v": 1}` answers 204. The server takes about one report per 2 s per token. When none of your tabs is in an office, it answers with `Retry-After: 300` and the helper waits (so it can take up to 5 minutes after you open Homeoffice for your app to show). On Cloudflare Containers, the Worker answers helper reports itself (204) when the container isn't running (`Retry-After: 60`), and passes reports on only within 5 minutes of someone using Homeoffice (open tabs check in every 4 minutes). While the container is still running without visitors, it asks helpers to wait 16 minutes, longer than the 15-minute idle timeout, so a helper never starts the container and can't keep it running. Nothing to configure: the feature needs no settings of its own.

### Coins (off for now)

Coins are switched off. The owner wants actual coins rather than coins earned through activity, so the feature is disabled until it's redesigned: by default there's no wallet, no balance, no "Send coins", no celebrations, no coin tables, routes or timers. `COINS=on` turns the old experimental version (welcome and daily bonuses, coins for being present, tips; see `docs/specs/coins.md`) back on, **for development only**; don't set it on a real server. Its code and tests stay in the repository for the redesign.

### Weather

Everyone sees the weather and time of day where they are, in their own view of the office. The weather comes from [Open-Meteo](https://open-meteo.com/) through the Homeoffice server and works without any setup, but check the licence below. `WEATHER=off` turns it off.

**Whose location.** For each person, the first of these that's available:
1. A city they pick in *Settings > Weather*.
2. Their device's location, only after they click *Use my location* (the browser asks first; it needs HTTPS or localhost).
3. Roughly where their connection comes from, when the server is told (see below). This is usually the nearest city, and wrong for people on a VPN or a company proxy.
4. None: the usual daytime office, without weather.

The weather popover shows which one is used. *Show my local weather* in Settings turns it off for yourself.

**Privacy.**
- Coordinates are rounded to 0.1° (about 11 km) in the browser, so precise positions never leave it. The server rounds again before asking Open-Meteo, which keeps its request logs for 90 days, and never stores GPS positions.
- The browser keeps the chosen city, or the rounded device location labelled "Your location". For signed-in people, the weather settings and chosen city (not the device location) are also saved with their account.
- Showing your weather to others is opt-in (*Settings > Weather*, off by default). They then see your conditions, temperature and local time on your row in the people list, never the place.

**Licence.** Open-Meteo's free API is for **non-commercial use only** (see their [terms](https://open-meteo.com/en/terms)). For commercial use, for example if Homeoffice is sold, shows ads or is part of a company's product, take a [paid plan](https://open-meteo.com/en/pricing) and set `OPEN_METEO_API_KEY`, or set `WEATHER=off`. With a key, the server uses Open-Meteo's customer servers and sends the key in a header, never in a URL. The data is licensed CC BY 4.0, so the app shows "Weather data by Open-Meteo.com" next to the weather, and "Location data based on GeoNames" with the city search.

**Location from the connection.**
- **Cloudflare Containers:** automatic. The Worker passes each visitor's approximate location (Cloudflare's guess from their IP address) to the server, after removing any copies sent by the visitor, and starts the server with `GEO_HEADERS=workchop`.
- **Cloudflare Tunnel:** in the Cloudflare dashboard, turn on the *Add visitor location headers* Managed Transform for your domain (under *Rules*), and add `GEO_HEADERS=cloudflare` to `.env`. Only do this when the server can't be reached without going through Cloudflare (with the Tunnel and closed ports, it can't); otherwise visitors could fake their location.
- **Anything else** (Caddy, plain Docker): there's no location from the connection, so people pick a city or use their device's location.

**Caching and limits.** The free API allows fewer than 10,000 calls a day, 5,000 an hour and 600 a minute per IP address, shared by everyone on your server. So the server:
- answers only people who are in an office, and keeps the weather of each ~11 km cell for 16 to 19 minutes (city searches for a day), so people in the same city share one call;
- limits the calls each visitor can cause (only requests that make the server ask Open-Meteo count): 20 weather lookups and 30 city searches per 10 minutes per connection, and per IP address (an IPv6 /64 counts as one) 60 of each per 10 minutes and 1,000 lookups and 300 searches a day. People behind one address, such as a company network or a VPN, share these; someone over a limit still gets their place's last weather if it's at most 3 hours old;
- sends one request at a time, and makes at most 8,000 calls a day and 1,000 an hour (city searches and failed calls included; the counts restart on the UTC day and hour), so no one can use up a day's calls in an hour. With `OPEN_METEO_API_KEY` (paid plans start at 1 million calls a month), it sends two at a time and allows 30,000 a day and 3,750 an hour;
- after a "too many requests" answer, waits until Open-Meteo's limit resets (the next minute, hour or day, in UTC; a minute for other limits), and after a failed call waits a minute before asking for that place or search again (for a place, twice as long after each further failure in a row, up to 15 minutes);
- while it can't ask Open-Meteo, keeps serving each place's last weather for up to 3 hours. After that, people there get no weather until it can ask again: once the day's calls are spent, that's midnight UTC.

These counts and pauses are kept in memory, per server run: a restart (a deploy, a changed setting, or Cloudflare stopping an idle container) starts them over, so a server that restarts on a busy day can make more calls that day.

Each browser asks again a little after its place's weather in the server's cache runs out, so about every 20 minutes. A hidden tab waits until you're back, unless you share your weather (so others see it up to date).

On Cloudflare Containers the outgoing IP address may be shared with other Cloudflare customers, which can use up the free limits; set an API key if the weather stops updating there.

## How it works

```
client/   React + react-three-fiber app (Vite)
  src/world/   3D scene: furniture models, avatar, movement, camera, build tools
  src/landing3d/  The live 3D office on the home page: a scripted demo with its own small office, no server
  src/ui/      Landing page (ui/landing/), lobby, character editor, dock, people and build panels,
               the side panel (panels.tsx) and settings (settings.tsx) registries
  src/lib/     Socket session and its hooks (session.ts), sign-in and account (account.ts),
               WebRTC mesh (peers.ts), local media (media.ts) and its RNNoise pipeline (noise.ts),
               speaking detection, file uploads (upload.ts),
               lounge radio (radio.ts, genmusic.ts), Spotify listen-along (spotify.ts)
  src/features/  Client features, loaded automatically (see Development)
    chat/      Chat panel: channels, direct messages, threads, mentions, reactions, files
    audio/     Headphones (focus mode) and shoulder taps, reaction particles and confetti
    presence/  Current app: status picker, app chips, desktop helper settings
    coins/     Wallet panel, tips and their celebrations (off unless the server has COINS=on)
    weather/   Local weather: settings, top-bar chip, sky, light and weather effects
    github/    GitHub panel, its settings and live notifications
    world/     Desk monitors, lights, plant cards, desk claims and notes
server/   Express + Socket.IO
  realtime.ts  Presence, movement, office edits, WebRTC signalling relay, jukebox and listen-along sessions
  turn.ts      Short-lived Cloudflare TURN credentials
  room.ts      Who is linked to whom
  music.ts     Jukebox changes and who may make them, Spotify link previews
  officeStore.ts  Cache of open offices, debounced saves, flush on shutdown
  repos.ts     Offices in SQL (one jsonb row each)
  db/          The database (Postgres or PGlite), migrations, import of old JSON offices
  auth/        Sign-in with email and password, Google, Apple, GitHub or the dev login; cookie sessions
  accounts.ts  Users, sign-in identities and passwords, one account per verified email
  workspaces.ts  Members, roles, invitations, guest links: who may come into an office
  mail.ts      Sending email through Resend, or the dev outbox (templates in mailTemplates.ts)
  uploads.ts   File uploads and downloads (database, disk or S3/R2)
  features.ts  Hooks for features: routes, socket handlers, tables (list in features/index.ts)
  features/chat/  Channels, messages, threads, mentions, reactions, read markers (tables chat_*)
  features/audio.ts  Shoulder taps for people wearing headphones
  features/presence/  Current app from the status picker or the desktop helper (table api_tokens)
  features/coins/  Wallets, the coin ledger, daily and presence coins, tips (only with COINS=on)
  features/weather/  Open-Meteo proxy with a cache per ~11 km cell, location from proxy headers
  features/github/  Connecting GitHub (an OAuth App), encrypted tokens, the notifications poller
  features/world.ts  Lamps and light switches, desk claims, desk notes (table desk_notes), info boards
  features/support/  Support workspaces: tickets and the queue (tables support_tickets and
               support_ticket_events), desks, Next, handing over and inviting colleagues, who
               customers are in a call with (link.ts), ticket chat (chat's conversation t:<id>)
  features/billing/  Paid plans with Paystack: plans and seats (state.ts), checkout, renewals, the
               webhook and the scheduled run (tables billing_*; off without PAYSTACK_SECRET_KEY)
shared/   Code used by both sides: types, furniture catalog, avatar options,
          office validation and edits, collision, pathfinding and proximity rules,
          world interactions (world.ts), what each plant is (plants.ts), support tickets (support.ts),
          billing's plans and prices (billing.ts)
cloudflare/  Worker that runs the Docker image on Cloudflare Containers, passes on visitors'
             approximate location and runs billing's daily cron (wrangler.jsonc, worker.ts, geo.ts)
helper/   The optional desktop helper for the current-app indicator (workchop-presence.cjs)
```

- **The server decides who talks to whom.** Clients stream their position to the server, which runs the proximity and private-area rules in `shared/geometry.ts`. When two people should be connected it sends `peer:connect` to both, with a link id and which side makes the WebRTC offer. When they drift apart it sends `peer:disconnect`. Signalling messages are relayed only between currently linked people, on their current link id, so nobody can open a call with someone they shouldn't hear.
- **Moves are cheap, changes are sure.** Clients send their position about 15 times a second while walking. A walking step may be dropped for someone whose connection is busy, since the next one replaces it. Stopping, sitting down, standing up and jumps are queued for everyone and arrive in order. Sitting down and getting up are sent the moment they happen (a click, `E`, arriving at a chair, a support customer called to a desk), not with the next frame, so a tab in the background still tells the others. Each client also repeats where it is every 5 seconds while it stands or sits still. Other people are drawn standing, not walking on the spot, once their steps stop coming.
- **Coming back by itself.** Both sides notice a dead connection within about 20 seconds (a 10 s heartbeat). The page then connects and joins again on its own, at the spot where the person is (sitting stays sitting). The join carries a secret the page made for this visit, so the server replaces that page's old connection if it still has it. Nobody sees a double, nobody is in a call with a ghost, and the old connection doesn't count against any limit. A page coming back by itself never takes the office over from the person's other tab: if they're in on another connection, it's turned away and shows *Homeoffice is open in another tab* (only a new visit or *Use here* takes over). If the server turns the rejoin away for a passing reason (the office is full for now, the server just restarted), the page tries again, 1 to 15 s apart, and the connection banner says why. Only a real refusal (removed, guest link reset) goes back to the lobby. Calls come back on the new links, and the microphone, camera and screen share carry on as they were (a camera that stopped by itself is picked up again). The browser's "online" event reconnects at once.
- **Calls repair themselves.** A call that doesn't come up within 15 s, or breaks while the office connection stays (`disconnected` for 4 s, or `failed`), gets an ICE restart from the side making offers; the other side asks it for one (`{ restart: true }`). After two restarts, either side asks the server to start the call over (`rtc:relink`), which sends both a new `peer:connect` with a new link id. Calls that keep failing are tried less often, up to every 2 minutes.
- **Media is peer-to-peer** (a mesh). Every connection always has one audio and one video transceiver, so muting, turning the camera on or off, or starting a screen share is just `replaceTrack`, with no renegotiation. Remote audio volume is set from the distance between the two people.
- **Headphones mute, they don't disconnect.** Focus mode mutes the `<audio>` element of each call (`el.muted`, since iOS ignores `volume`) and turns the music down to zero, but keeps every call connected, so taking the headphones off is instant. Remote audio stays on media elements rather than Web Audio, so the browser's echo cancellation keeps working.
- **Enhanced noise suppression** sends the microphone through a 48 kHz AudioContext (mono mix → RNNoise → a MediaStreamDestination) and sends that track instead, with `replaceTrack` like a mute. Muting disables the processed track. The pipeline is built once per visit and closed when you leave; if the worklet fails, the context isn't running (no click yet, or a phone call on iOS), or the mic can't be connected, the plain microphone is sent instead so nobody hears silence. A replaced or unplugged mic is picked up again.
- **Office edits are operations** (`add`, `update`, `remove`, `zone:*`, `settings`). They are applied optimistically on the client and validated and normalised by the server with the same `applyOp` code. The server then echoes them to everyone in its own order, so all clients converge. Rejected edits trigger a full resync.
- **Music is synced by clock, not streamed.** Clients estimate the server's clock (`time` pings). The built-in stations are generated from it with a seeded pattern, so every browser plays the same bar. Track lists play from a shared start time. Listen-along sessions store the DJ's track, position and server time, and listeners seek to match (the DJ re-sends on track changes, pauses and seeks).
- **One of you per office.** Each join carries a secret the browser keeps (in local storage) besides the page's own. Two connections in one office with the same account, or the same browser, are the same person: a new visit or *Use here* takes the other one out (`office:removed` `'elsewhere'`, and that tab stops reconnecting), while a page coming back by itself is turned away instead, so two tabs never take turns. Anything that follows the person (a support desk, a colleague's part in a conversation) moves to the newest connection as after a reload.
- **Support calls follow the tickets.** In support workspaces a link rule overrides distance: customers are never linked with each other or with staff, except with the agent serving them and the colleagues helping, who are linked with them wherever they are (and with no other staff meanwhile). Calling Next, resolving, handing over, colleagues joining and leaving, and people leaving or coming back re-check everyone's calls.
- **Chat is stored, except what's live.** Channel messages, direct messages between signed-in people and support tickets' chats are rows in `chat_messages`; the server checks every mention (a member of the office, a guest who is here, or `@here`) before saving and notifying anyone, keeps mentions for people who are away, and remembers how far each signed-in person has read. Nearby messages and direct messages with guests only pass through the server.
- **Weather is each viewer's own.** Each browser asks the server for the weather at its own rounded location and draws the sky, light and weather itself; none of it is part of the office. The server only fetches and caches Open-Meteo's answers.
- **Everything in the world is generated in code** (furniture, characters, floor textures), so there are no asset files to load.
- **GitHub tokens stay on the server.** It polls GitHub for each connected person who is in an office and sends the changes to that person's sockets only. Browsers get notifications, never tokens.

## Development

```bash
npm run typecheck
npm test          # unit tests for geometry/office rules + server integration tests
```

Tests use an in-memory PGlite. They run against real Postgres instead when `TEST_DATABASE_URL` points at a database they may write to (each test file gets its own schema), e.g. `TEST_DATABASE_URL=postgres://user:pass@localhost:5432/workchop_test npm test`. Run both before changing SQL: production may run Postgres 16 while PGlite is Postgres 18.

**Adding a server feature:** create `server/features/<name>.ts` exporting `feature: Feature` (`name`, optional `migrations`, `register(ctx)`) and add it to the list in `server/features/index.ts`. `register(ctx)` gets: `app`, an Express router mounted at `/api` (after `express.json`, before the API's 404; a guard already refuses cross-site `POST`/`PATCH`/`DELETE`); `io`; `db`, the database; `store`, the office store; `auth.userFromRequest(req)` and the `auth.requireUser` middleware (401 for guests, else the user in `res.locals.user`); `uploads` (`uploads.remove(ids)` deletes stored files; `uploads.addCheck((socketId, officeId, bytes) => why | null)` refuses an upload before it's read); `publicOrigin` (`PUBLIC_URL`'s origin, or null); `clientIp(req)` (the visitor's IP address, from `CLIENT_IP_HEADER` behind a proxy, for per-visitor limits) and `socketIp(socket)` (the same for a connection, which stays put when a guest reconnects); `quiet` (true in tests: leave out messages that only say things are working); `onClose(fn)` (runs when the server closes, before the database does: stop timers there); `mailer` (sends email; with `mailer.kind === 'off'` it sends nothing, as in production without Resend, so show anything important in the app too); `keepRawBody(path)` (JSON requests to `/api<path>` keep their bytes in `req.rawBody`, typed `WithRawBody` from `server/features.ts`, to check a webhook's signature); `workspaces.setPolicy(policy)` (who may come into offices and how many people they may have, for one feature only, billing: `WorkspacePolicy` in `server/workspaces.ts`, described in `docs/specs/README.md`); and `realtime`: `onSocket`, `onJoin`, `onLeave`, `emitToOffice`, `emitToUser`, `playersOfUser`, `players(officeId)`, `updatePlayer` (changes a player and tells the office), `contextOf(socketId)`, `onlineCount`, `linkedPeers`, `addLinkRule(rule)` (a say in who is in a call with whom: `(officeId) => ((a, b) => boolean | null) | null`, set up once per check of an office's calls and asked about each pair before distance and private areas; any false keeps two people apart, otherwise any true links them wherever they are), `relink(officeId, playerIds?)` (after a rule's answers changed), `addJoinCheck((officeId, s, role) => why | null)` (refuses people coming in), `removePlayer(officeId, playerId, reason)`, `lockChanged(officeId, locked, staffCap?)` (after the workspace policy locked or unlocked an office: when locked, everyone but the owner and admins is taken out with `office:removed` 'locked', then the admins who came in last until `staffCap` people are left), `onRoleChange((s, before) => …)` and `onOfficeChange((officeId, office) => …)` (after an office:op). Each connection's context (`s`) has `socket`, `user` (null for guests), `room()`, `me()`, `office()`, `role()` (`owner`, `admin`, `member` or `guest`; check permissions with `may()` from `shared/workspace.ts`), `isOwner()`, `mayEdit()`, `mayChangeWorld()` (false for customers, the guests of support workspaces: check it before changing what everyone shares, like lights or music) and `limiter(rate, burst)`. A feature can own chat conversations with keys of its own (`t:<id>` for support tickets): `registerConversation(ctx, prefix, { access, audience, ownsGuestMessage, nameOf? })` from `features/chat` decides who reads and writes them, who gets new messages and the name people write under; `postToConversation` and `deleteConversations` add and remove messages. Socket ids are visible to everyone in the office, so an HTTP route shouldn't trust an `X-Workchop-Socket` header alone: also limit by `clientIp(req)`, or check a secret only that socket has (like the upload key). Declare the feature's socket events in `shared/<name>.ts` by augmenting `ClientToServerEvents`/`ServerToClientEvents` (and `PlayerState`) from `shared/types.ts`. Migration ids are global: core uses 1–99, features take the next free id from 100. `onSocket`/`onJoin`/`onLeave` callbacks may be async (failures are logged), but catch errors in your own `socket.on` handlers. Files are uploaded with `POST /api/offices/<id>/uploads` (the file as the body, its name URL-encoded in `X-Filename`, and `X-Workchop-Socket`/`X-Workchop-Upload-Key` from the join answer's `selfId`/`uploadKey`); a busy server answers 429 or 503 with `Retry-After`.

**Adding a client feature:** create `client/src/features/<name>/index.ts` (or `.tsx`); every such file is loaded at startup, so nothing else needs editing. From there:

- `registerPanel({ id, title, icon, Component, order, dock?, hideOnMobile?, inMore?, useBadge?, badgeTone?, shortcut? })` from `ui/panels.tsx` adds a side panel and its dock button (Support 5 for staff in support workspaces, chat 10, music 20, people 30, coins' wallet 35 when on, My desk 40, GitHub 45; `setPanel(id)` toggles it; customers' chat panel is the support feature's, under the same id `chat`). `dock: false` gives it no button (build mode has its own) and `hideOnMobile` none on phones. On phone-sized screens the dock has room for two panel buttons: the first two by order that aren't `inMore` get them, and the rest (always those with `inMore`) go in its More menu; an alert badge there shows on the More button too. `useBadge` is a hook giving the button's badge (a count or short text; red with `badgeTone: 'alert'`, the default, grey with `'neutral'`), and `shortcut` names a key in its tooltip (chat's `Enter`; the office's own keys are listed above, so pick one that isn't taken). Registering returns a function that removes the panel again, for features that show only on some servers (GitHub) or for some people (My desk).
- `registerSettingsSection({ id, title, icon, order, Component })` from `ui/settings.tsx` adds a section to Settings (Workspace is 5, Billing 6, Appearance 10, Audio & video 20, Privacy & status 30, Desktop helper 35, Weather 40, Integrations 45).
- `registerTopBarItem({ id, order, Component })` from `ui/topbar.ts` adds something to the top bar, after the music that's playing (billing's banner is 5, weather 10). `Component` renders null when there's nothing to show.
- `registerPage({ path, Component })` from `ui/pages.ts` gives the feature a page of its own at a path outside the offices (billing's `/billing/return`): opening that path shows `Component` alone (the store's `phase` is `'page'`, and `page` its path). Register it when the module loads.
- `registerPersonDetail({ id, order, Component })` from `ui/PeoplePanel.tsx` adds a line under other people's names in the People panel (weather is 10). `Component` gets `{ player }` and renders null when there's nothing to show for them.
- `registerPersonAction({ id, order, Component })` from `ui/personActions.ts` adds a button next to other people in the People panel, after "Go to" and "Message" (coins' "Send coins" is 10, when coins are on). `Component` gets `{ player }` and renders null when it doesn't apply to them.
- `registerSceneLayer({ id, order, Component })` from `world/layers.ts` adds a component to the 3D office, rendered inside the Canvas after the office (weather is 10; the world feature's monitors, darkened areas, lamp lights and item cards 20–50). Each layer has its own `Suspense` and error boundary, so it can be `lazy`, and one that fails doesn't take the office down. To change the sky, fog, light, wind (plants sway with it) or how the ground looks, write to `sceneLighting` (in `world/lighting.ts`) from `useFrame` with priority `-1`, so before the office's own components read it each frame. Call `resetSceneLighting()` (same module) when your layer unmounts, or the office keeps your sky and light.
- `onSession(id, (session) => cleanup)` from `lib/session.ts` runs for every office visit, after the socket is created and before it connects: add handlers with `session.socket.on(…)` (typed, including your augmented events; they run after the app's own), act after joining with `session.onJoined((rejoin) => …)` (rejoins follow reconnects), and read `session.officeId` and `session.selfId()`; `session.onLeave(fn)` runs `fn` as the person leaves. The function you return runs when the person leaves, and also when the hook is registered again under the same `id` (a hot reload) or unregistered mid-visit, so undo there what the hook added (`socket.off`, the function `onJoined` returns). `session.upload(file, { name, onProgress, signal })` uploads a file into the office and resolves to `{ id, url, name, contentType, size }`, or throws an Error whose message can be shown ("File too large (max 10 MB)", the server's reason…). `session.setFullVolume(playerIds)` hears those people at full volume wherever they are (a support agent, their customer and the colleagues helping; `[]` for nobody).
- `registerLobby({ id, match(info), Component, media? })` from `ui/lobbies.ts` gives some visitors a lobby of their own instead of the usual one (support customers): the first whose `match` takes the workspace's info is used, and `media` says whether the mic and camera start on.
- `registerConvView(prefix, { open, looking, notify })` from `features/chat/state.ts` shows a feature's own saved conversations (support tickets, `t:<id>`) outside the chat panel: how to open one, whether it's on screen now, and whether a new message in it gets a toast.
- `toast(text, 'error' | { kind, icon, action: { label, run }, duration })` from `state/store.ts` shows a message, optionally with an icon and a button, and returns its id for `dismissToast(id)`. Toasts look the same with headphones on (they make no sound).
- For signed-in people, `getState().account` is their account, `saveCharacter(patch)` saves their look, and `saveAccountSettings({ key: value })` from `lib/account.ts` saves small preferences with it, merged key by key with the saved ones (at most 50 keys per account, so prefix yours, e.g. `weather.unit`; guests have none: show a "Sign in to …" hint instead).
- The 3D world has hooks too, in `world/extensions.ts`: `registerItemModel(type, Component)` for new item types, `registerItemDecor({ id, order, types, Component })` for extra 3D parts on items (the world feature's screens, GitHub badge, name plates and notes on desks are 10–30) (other scene content is a scene layer, above), `registerItemInteraction(types, { onClick, onHover })` for what clicking an item does, and `registerNearbyAction(id, find)` for what `E` does near something. Keep three.js out of your feature's `index.ts` (it loads with the landing page): put the 3D code in a module you register with `registerWorldModule(() => import('./scene'))`, which loads with the scene. `registerOverlay({ id, order, Component })` from `ui/overlays.tsx` shows something over the office, such as a card pinned next to an item.
- Item types can keep their own data: give the catalog entry (`shared/catalog.ts`) a `sanitizeData(raw)`, and change the data through your feature's own socket events. Build edits never change it: a moved item keeps its data, a new or copied one starts from `sanitizeData(undefined)`.
- Catalog entries can turn a seat (`seats: [{ x, z, turn }]`, in quarter turns: 2 faces back across the item, like a help desk's customer seat) and offer an item only in some workspace types (`kinds: ['support']`). `standUpSpot` and `inFrontOf` in `shared/geometry.ts` say where someone stands after getting up, and in front of an item. `E` doesn't sit people on items that have their own `registerItemInteraction` (help desks decide who sits there).

**Landing page.** Signed out, `/` is the landing page (`client/src/ui/landing/`). Its hero is a small 3D office played from a script (`client/src/landing3d/`). three.js loads only once the hero is on screen; until then, under reduced motion, without WebGL and on slow devices it shows a still (`client/public/landing/hero-*.webp`). After changing the 3D models or the script, capture the stills again: run `node scripts/capture-landing.mjs`, then open the dev server, signed out (a private window works), at `/?capture=<the address it prints>`.

**Legal pages.** `/privacy` and `/terms` (`client/src/ui/legal/`). They describe what the code does (what's stored, who it's shared with, billing), so change them, and their date, along with it. They're published but not linked yet: `LEGAL_LINKED` in `client/src/ui/legal/index.tsx` is off until `LEGAL_ENTITY` (next to it) holds the company's registered name and the contact address in `LegalPage.tsx` receives mail. Until then they're reachable only at their address and ask search engines not to list them; turned on, the landing page's footer, the sign-up pages and the customer lobby link to them.

Icons come from the [Hugeicons](https://hugeicons.com) font in `scripts/hugeicons/`. The app ships only the glyphs it uses: to add one, put its name (from `icons.css`) in `client/src/ui/icon-names.json`, export a component for it in `client/src/ui/icons.tsx` and run `npm run icons`. That regenerates `client/src/ui/hugeicons.ts` and the cut-down font `client/src/assets/hgi-subset.woff2`, and needs fontTools (`pip install fonttools brotli`).

`GITHUB_OAUTH_BASE` and `GITHUB_API_BASE` (by default `https://github.com` and `https://api.github.com`) point GitHub sign-in and the [GitHub](#github) integration at another server. They're only for the tests and the mock GitHub (`npx tsx tests/helpers/github.ts`); don't set them anywhere else.

`PAYSTACK_API_BASE` (by default `https://api.paystack.co`) points [billing](#billing) at the stand-in Paystack (`npx tsx tests/helpers/paystack.ts`); only for the tests and trying it locally. The billing tests (`tests/billing*.test.ts`) turn billing on themselves with that stand-in and a clock they move; the others run with it off, as vitest doesn't read `.env`.

Coins are off (see [Coins](#coins-off-for-now)): `COINS=on npm run dev` brings back the old version to work on it. Its tests (`tests/coins.test.ts`, `tests/client-coins.test.ts`) turn it on themselves and also check that it's off by default.

## Limits

- Calls are a mesh: each person sends their stream to every person they're near. That works well for conversations of up to about 8 people. Larger groups (stages, all-hands) would need an SFU such as LiveKit or mediasoup.
- A guest link is a shared secret: anyone it's passed on to comes in until it's reset or turned off. Offices made before workspaces are open to anyone with their address until their owner changes that. An office takes 100 people, at most 90 of them guests.
- Workspaces: each account makes up to 10 an hour (and each visitor 30), adds or invites up to 30 people an hour, and a workspace takes 100 new people or invitations a day.
- Sign-in: each visitor (an IPv4 address, or an IPv6 /64) can make 60 sign-in requests (signing in or up, emailed links, password and email changes) per 15 minutes. An address can be tried with 10 wrong passwords per 15 minutes from each visitor and 100 from everyone, so strangers can't easily lock someone out. Each address gets at most 5 emails an hour, plus a password reset every 15 minutes whatever else was sent, and each visitor can have 20 emails sent an hour. Checking a password takes scrypt about 100 ms and 32 MB: the server checks one sign-in at a time, keeps a second slot for sign-up links, resets and changes, and lets up to 16 wait for each; past that, people are asked to try again in a moment. Sign-ins for addresses without a password and wrong passwords share a budget of 600 checks per 15 minutes; past it, addresses without a password only wait as long as a check would take.
- Chat: each person can send about one message a second (bursts of 6) and create a channel every 20 seconds (bursts of 3); an office has up to 200 open channels. Messages are up to 4,000 characters with up to 5 files, and history loads 50 messages at a time.
- Support: from one address (an IPv4 address or an IPv6 /64), at most 3 customers at once in a workspace, 30 new tickets an hour and 10 open ones; one open ticket per connection. A first message is up to 500 characters, and a customer can send 20 MB of files per ticket. Agents serve one customer at a time, with up to two colleagues helping, and history loads 30 tickets at a time. Customers taken out by staff stay out a while, but only in memory (a restart forgets it).
- Billing: each owner can start 10 checkouts an hour, each workspace 20 a day (and 3 card changes a day); seat changes, cancelling and resuming 10 an hour per workspace; trying a failed payment again 3 an hour; the return page's checks 30 per 10 minutes per person. A workspace buys up to 500 seats.
- Uploads: each office keeps up to `UPLOADS_QUOTA_MB` of files. Each visitor (IP address) can send 3 files at once and 60 per 10 minutes, and the server holds at most 4 files of the maximum size in memory at a time.
- Weather: each ~11 km place with someone online costs up to 4 Open-Meteo calls an hour, so the budget of 8,000 a day covers at least 80 places online around the clock (300 with an API key). Past it, the server serves each place's last weather for up to 3 hours, then none until midnight UTC (open tabs keep showing what they have). The count is per server run: a restart starts it over.
