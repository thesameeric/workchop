# Workchop

A 3D virtual office in the browser, in the spirit of [Gather](https://www.gather.town/): walk around with your own character, and when you get close to someone you can hear and see them. Teams can rebuild the office together in build mode.

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

**Accounts (optional)**
- Sign in with Google or Apple (see [Accounts and sign-in](#accounts-and-sign-in)) to keep your character, status, theme and weather settings on every device, and find the offices you visit under *Your spaces*. Anyone with an office link can still join as a guest.
- Light and dark themes, or follow the device (*Settings > Appearance*).

**The office**
- Two starting templates: a furnished startup office with desk pods, a glass meeting room, a lounge, a kitchen and ping pong, or a blank floor.
- **Build mode** (hammer button or `B`): 45 pieces of furniture, structure and plants in 7 categories. Place, drag, rotate (`R`), duplicate (`Ctrl/Cmd+D`), recolour and delete (`Del`) items, and draw private areas by dragging on the floor.
- Office settings: name, floor size, floor style and colour, wall colour, and spawn point. The owner can lock building to themselves.
- Every edit is synced live to everyone in the office and saved on the server.

**Little things in the world**
- **Desk monitors** are off until someone sits at the desk: then the screen wakes up (a glow and a logo) and shows the app they're working in, when they share it, or a calm wallpaper with their name and the time. Everyone sees it, and it goes dark a second after they get up.
- **Lights:** click a floor lamp or desk lamp to switch it on or off for everyone. A **light switch** (Build → Structure; put it against a wall) works the ceiling lights of the private area in front of it, or of the open office: switched off, that area goes dark for everyone, while its lamps and lit monitors keep glowing. Walk up to one and press `E`, or click it.
- **Plants:** 13 species (Build → Plants), from a monstera and a bird of paradise to a bonsai and a barrel cactus. Small ones stand on desks, tables and shelves. Click one to see what it is: where it comes from, how much light and water it needs, whether it's safe for pets (per the ASPCA where it lists the plant), and a fun fact.
- **Your desk:** signed-in people click a free desk and choose *Make this my desk* (one per office; claiming another moves you). Your name goes on a name plate. Anyone, guests included, can click your desk and leave you a sticky note (up to 500 characters, in four colours); notes from guests are marked *guest*, since anyone with the link can join under any name, and a desk takes at most 10 unread ones from guests, so there's always room for your coworkers'. The notes stack up on the desk for everyone to see, but only you read them: you get a toast when one arrives, or a reminder when you come in, and *My desk* in the dock (in its More menu on phones) lists them to mark as read or throw away. Whoever wrote a note can take it back. Owners and people who can edit the office can free a desk.

**GitHub notifications**
- People who sign in can connect their GitHub account (optional, needs a GitHub OAuth App, see [GitHub](#github)). The GitHub panel sorts their unread notifications into Mentions, Reviews, Actions and Activity, with a badge for unread mentions, review requests and failed runs. Click one to open it on GitHub. Marking items read or done in the panel does the same on GitHub.
- A failed Actions run you started pops up as a message with a link to it, and a small red badge pulses on your own desk's monitor (only you see it) until you open the panel or mark the run read or done.

**Lounge music**
- A **jukebox** (in the startup lounge, or add one from Build → Fun) plays music for everyone in the private area it stands in, or within about 7 m if it's out in the open. Click it, the 🎵 dock button, or the "now playing" chip to open it. Everyone has their own volume and mute.
- **Radio:** two built-in stations, *Workchop Lo-fi* and *Workchop Ambient*, are composed live in each browser from the server clock, so everyone hears the same notes at the same moment, with nothing to license or stream. Editors can also add **the office's own tracks** (audio files, looped in sync for everyone) or **a live stream** (an https Icecast/Shoutcast URL). Anyone can switch stations.
- **Spotify board:** share Spotify playlists, albums, tracks, podcasts, or a **Jam** invite. Everyone opens them in their own Spotify app.
- **Spotify listen-along** (optional, needs `SPOTIFY_CLIENT_ID`, see below): people connect their own Spotify Premium account, someone presses ▶ "Play for everyone", and everyone connected at that jukebox hears the same track at the same position on their own account. Workchop only syncs what's playing; it never streams audio from one person to another.

**Chat**
- **Channels** for the whole office: every office starts with #general, anyone can add more (with a topic), and the owner and signed-in people who may edit the office rename and archive them.
- **Direct messages**, saved when both people are signed in (they wait for whoever is away: start one with **+** next to Direct messages). With guests they're live: they last while you're both in the office, and what a guest sent you stays until you've read it. **Nearby** is a live chat with the people you're talking with.
- **Threads** (reply to any message, optionally also in the channel), **@mentions** of people here or away and `@here` for everyone online, **reactions**, editing and deleting your messages, and light formatting: `**bold**`, `_italic_`, `` `code` ``, code blocks and links.
- **Files:** attach, drag in or paste up to 5 per message. Images show as previews that open full size; other files as cards to download.
- Unread channels are bold, with a count of your mentions. The dock's chat button counts your mentions and direct messages, and a mention or direct message also shows a notice that takes you to it.

**Local weather**
- Everyone sees the weather and time of day where *they* are: the sky and sunlight follow their local time, with clouds, fog, rain, snow or thunderstorms around the office. A chip in the top bar shows the conditions, temperature and place; click it for details. Data from [Open-Meteo](https://open-meteo.com/) (see [Weather](#weather)).
- The place is a city you pick, your device's location (only when you ask), or roughly where your connection comes from. You can also show your weather and local time on your row in the people list (off by default, and never the place).

**Getting around**
- `WASD` or the arrow keys move you relative to the camera, and `Shift` runs. Click the floor to walk there (with pathfinding); click a chair to walk over and sit.
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

Open the `Local:` address it prints (normally http://localhost:5173), create an office, pick a name and join. Allow the camera and microphone when the browser asks.

Data is kept in `./data`: an embedded Postgres ([PGlite](https://pglite.dev), no setup) in `data/db` and uploaded files in `data/uploads`. Only one server can use a data folder at a time.

`npm run dev` starts the API and realtime server on port 3001 (reloading on change) and Vite on port 5173, which proxies `/api` and `/socket.io` to the server. If port 3001 is taken, run it on another one, e.g. `PORT=4001 npm run dev` (the proxy follows `PORT`; on Windows use `$env:PORT=4001; npm run dev` in PowerShell or `set PORT=4001&& npm run dev` in cmd). Stop it with `Ctrl+C`.

### Testing a call

**On your own:** copy the invite link (link button in the top bar) and open it in a private/incognito window, which gets its own name and character. New arrivals start next to each other, so the video tiles at the top show up straight away. Walk apart (WASD, or click the floor) and they disappear; walk back and they return. Use headphones or mute one window to avoid echo.

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
- **Sign-in (optional):** see [Accounts and sign-in](#accounts-and-sign-in). Compose sets `PUBLIC_URL` to `https://<DOMAIN>`.
- **GitHub notifications (optional):** set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` in `.env`, see [GitHub](#github).
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
- A **Postgres database reachable from the internet**, because a container's disk is wiped whenever it stops. For example, [Neon](https://neon.com)'s free tier: it sleeps when idle and wakes in well under a second, which Workchop's start-up retries cover.

```bash
npm install                                 # in the repo root
cd cloudflare && npm install
npx wrangler login
npx wrangler secret put DATABASE_URL        # e.g. postgresql://…neon.tech/neondb?sslmode=require
npm run deploy                              # builds the app and the image, then deploys
```

The first deploy takes a few minutes while Cloudflare prepares the container. Workchop is then at `https://workchop.<your-subdomain>.workers.dev`. Add your own hostname under the Worker's *Settings > Domains & Routes*. Optional settings are wrangler secrets as well: `SPOTIFY_CLIENT_ID` (register `https://<your host>/spotify-callback.html` as its redirect URI), `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN`, the [sign-in](#accounts-and-sign-in) keys, `OPEN_METEO_API_KEY` (for the [weather](#weather) in commercial use), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` (for [GitHub](#github)), and an R2 bucket for uploaded files (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; without one, files go into Postgres, which fills a free database quickly). Set `PUBLIC_URL` (in `wrangler.jsonc`) to the address people use; sign-in needs it.

How it behaves:
- **Starts on demand.** The first visit starts the container, which takes a few seconds. It stops about 15 minutes after the last person closes Workchop. Open tabs check in every few minutes, which keeps it running. [Desktop helpers](#current-app-and-the-desktop-helper) don't: their reports never start the container or keep it running.
- **Restarts.** Deploys, changed secrets, and now and then Cloudflare's host maintenance briefly disconnect everyone. People see "Reconnecting…" for a few seconds, then carry on. Office edits are saved first. When you change a secret, the server restarts on the next visit so it picks up the new value.
- **Placement.** Set `constraints.regions` in `cloudflare/wrangler.jsonc` to keep the container near your team and your database. Set `LOCATION_HINT` too, but **before the first visit**: Cloudflare places the coordinating Durable Object once and never moves it.
- **Size.** It runs as a single container (live rooms are in memory), on `basic` (¼ vCPU, 1 GiB) by default. That's plenty for a few dozen people; use `standard-1` for more.
- **Cost.** The $5 plan includes 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk a month. On `basic`, Workchop uses about $1.50 beyond that if it runs only during office hours, or about $7 if someone always leaves a tab open. Container logs count toward Workers Logs (20 million events a month included) and move to Cloudflare Observability pricing on 1 December 2026; turn `observability` off in `wrangler.jsonc` if you don't need them.

Local check: `npm run dev` in `cloudflare/` runs the Worker and the container on your machine (Docker required, with `DATABASE_URL` in `cloudflare/.dev.vars`).

#### Workers + Durable Objects

Not built. This would replace the Node server with one Durable Object per office, and Socket.IO with plain WebSockets. It would remove the container, the database server and the single-server limit, and cost about $5 a month for most teams. It's a few days of work, because Socket.IO and Express don't run on Workers.

#### Cloudflare TURN for calls

Most calls connect directly between browsers. People behind strict corporate firewalls need a relay (TURN).
1. Create a TURN key in the Cloudflare dashboard (*Realtime > TURN*).
2. Set `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN`, in `.env` for Compose or as wrangler secrets for Containers.

Workchop then hands each visitor short-lived credentials and refreshes them for long sessions. They last 24 hours by default (`CLOUDFLARE_TURN_TTL`), and a call relayed through TURN is cut when its credentials expire, so keep the TTL longer than your longest call. The first 1,000 GB a month are free, then $0.05/GB. Only calls that actually need the relay use it.

### What is stored

| Data | Where |
| --- | --- |
| Offices: layout, furniture, private areas, settings, owner key | The database: Postgres when `DATABASE_URL` is set, otherwise PGlite in `DATA_DIR/db` |
| Accounts (people who signed in): name, email, character and settings, sign-in methods, sessions, which offices they belong to | The database. Sessions are stored as a SHA-256 of the cookie's token |
| GitHub connections: the GitHub account's id and login, access and refresh tokens, their scopes and expiry | The database, with the tokens encrypted (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`). Tokens never reach browsers. The notifications are kept in memory only, while their owner is in an office and for 10 minutes after they leave |
| GitHub connections being made: who started them, the PKCE verifier, the page to go back to, a SHA-256 of the `state` | The database. Each can be used once, within 10 minutes; a clean-up every hour deletes unfinished ones |
| Uploaded files | An S3/R2 bucket when `S3_*` is set, otherwise the database with Postgres, or `DATA_DIR/uploads` with PGlite (`UPLOADS_STORAGE` picks one) |
| Names and characters of guests | Each person's browser (local storage) |
| Jukebox settings: station, own tracks/stream, shared Spotify links | With the office (part of the jukebox item) |
| Lamps and light switches (on or off), who has claimed which desk | With the office (part of each item) |
| Notes left on desks: text, colour, author, when, read or not | The database (`desk_notes`), until the desk's owner or the author throws them away. Each owner keeps at most 50 per office; the oldest read ones make room |
| Spotify sign-in | Each listener's browser (local storage); never sent to the Workchop server |
| Chat: channels, messages, threads, reactions, mentions, who has read what | The database (attached files with the uploads). Kept until deleted, or for `CHAT_RETENTION_DAYS`. Nearby messages and direct messages with guests are never stored |
| Headphones (focus mode) | In memory only, while you're in the office |
| Noise suppression choice, devices | Each person's browser (local storage) |
| Coin wallets and every coin movement (a ledger), only with `COINS=on` (off for now) | The database |
| Weather settings: on/off, units, sharing, the chosen city or the rounded device location | Each person's browser (local storage). For signed-in people, also with their account, except the device location. The weather itself is cached in memory only, per ~11 km cell |
| Who's online, positions, calls | In memory only (live state) |
| Current app (picked by hand or from the desktop helper) | In memory only, never stored; a helper's report expires after 45 s without a heartbeat |
| Desktop helper pairings: computer name, when paired and last used | The database (`api_tokens`), with only a SHA-256 of each token |

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

**Deploy checklist.** Required: a database (`DATABASE_URL`; Compose runs its own Postgres, and needs `DOMAIN` and `POSTGRES_PASSWORD` in `.env`) and `PUBLIC_URL`, the HTTPS address people use (Compose sets it from `DOMAIN`). Then, as needed: sign-in (Google and/or Apple), a bucket for uploaded files (R2 on Cloudflare), TURN for people behind strict firewalls, GitHub notifications, Spotify listen-along, an Open-Meteo key for commercial use, and how long to keep chat. Everything else has a sensible default.

| Variable | Needed? | Secret? | Default | What it's for, and where to get it |
| --- | --- | --- | --- | --- |
| `PUBLIC_URL` | Yes, in production (sign-in and GitHub need it) | No | `http://localhost:5173` in development; Compose: `https://<DOMAIN>` | The address people open Workchop at, e.g. `https://office.example.com`. Sign-in redirects are built from it, and Socket.IO refuses connections whose `Origin` differs |
| `DATABASE_URL` | Yes for anything hosted (Compose sets it) | Yes | – | Postgres connection string, from your database host (Neon, Supabase, RDS…). Without it, data is kept in PGlite in `DATA_DIR/db` |
| `DATABASE_SSL` | No | No | – | `require` (verified TLS) or `no-verify` (TLS without certificate checks, for some managed providers) |
| `DATA_DIR` | No | No | `./data` (`/app/data` in Docker) | Data folder: the PGlite database (`db/`), uploaded files with `UPLOADS_STORAGE=fs` (`uploads/`), and old office JSON files to import |
| `PORT`, `HOST` | No | No | `3001`, `0.0.0.0` | Where the server listens (in `npm run dev`, the API port Vite proxies to) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | For "Sign in with Google" | The secret | – | A *Web application* OAuth client in the Google Cloud console (see [Accounts and sign-in](#accounts-and-sign-in)) |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | For "Sign in with Apple" | The private key | – | From the Apple Developer portal: the Services ID, team ID, key ID and the `.p8` key (PEM, with `\n` for line breaks, or base64) |
| `DEV_LOGIN` | Development only | No | – | `true` allows signing in with just a name and email. Ignored by the built server (`npm start`, Docker) and when `NODE_ENV=production`, unless `DEV_LOGIN_IN_PRODUCTION=true` (never on a real server) |
| `UPLOADS_STORAGE` | No | No | `s3` when `S3_BUCKET` is set, else `db` with Postgres, `fs` with PGlite | Where uploaded files (chat attachments, office tracks) go: `s3`, `db` or `fs`. Each file remembers where it went, so switching keeps old files readable |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | Recommended on Cloudflare (R2) | The access key and its secret | –, `auto` for the region | An S3-compatible bucket for uploads, with path-style URLs. Cloudflare R2: create a bucket and an API token with object read and write; the endpoint is `https://<account id>.r2.cloudflarestorage.com` |
| `UPLOAD_MAX_BYTES`, `UPLOADS_QUOTA_MB` | No | No | `10485760`, `1024` | Largest file, and the total each office may keep |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | For [GitHub notifications](#github) | The secret | – | An OAuth App on GitHub (*Developer settings > OAuth Apps*). GitHub also needs `TOKEN_ENCRYPTION_KEY`, `PUBLIC_URL` and a way to sign in |
| `TOKEN_ENCRYPTION_KEY` | For GitHub | Yes | – | Encrypts the saved GitHub tokens: 32 random bytes in base64, from `openssl rand -base64 32`. Without a valid key, GitHub stays off and the log says why. Keep it: with a new key, everyone has to connect GitHub again |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_KEY_API_TOKEN` | For people behind strict firewalls (or the TURN settings below) | The API token | – | Cloudflare's TURN service, from the dashboard (*Realtime > TURN*): short-lived credentials per visitor (replaces the static ICE servers below) |
| `CLOUDFLARE_TURN_TTL` | No | No | `86400` | How long those credentials last, in seconds (600 to 172800) |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | No | The credential | – | Your own TURN server, e.g. Compose's coturn (comma-separate several URLs) |
| `ICE_SERVERS` | No | Yes, if it holds credentials | Google STUN | JSON array of `RTCIceServer`s, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` (instead of the `TURN_*` shortcut) |
| `CLIENT_IP_HEADER` | Behind a proxy | No | – (Compose: `x-forwarded-for`; set on Containers and with the Tunnel) | Header with each visitor's IP: `x-forwarded-for` directly behind the bundled Caddy, `cf-connecting-ip` when every request comes through Cloudflare. Only use a header the visitor can't set: leave it unset when nothing sits in front, and don't use `cf-connecting-ip` if your server can also be reached without going through Cloudflare |
| `SPOTIFY_CLIENT_ID` | For Spotify listen-along | No (a public PKCE client) | – | An app at <https://developer.spotify.com/dashboard> (see [Music and Spotify](#music-and-spotify)) |
| `CHAT_RETENTION_DAYS` | No | No | – (keep) | Delete chat messages (with their threads) that have been quiet for this many days, with their files (see [Chat](#chat)) |
| `WEATHER` | No | No | on | `off` turns the [weather](#weather) off: no calls to Open-Meteo, and everyone sees the usual daytime office |
| `OPEN_METEO_API_KEY` | For commercial use of the weather | Yes | – | Key for a paid [Open-Meteo plan](https://open-meteo.com/en/pricing) (the free API is non-commercial only, see [Weather](#weather)). A value that can't be a key (spaces, more than 200 characters) is ignored with a warning |
| `GEO_HEADERS` | No | No | – (`workchop` on Containers) | Who sets the headers with each visitor's approximate location, for the weather: `workchop` (Workchop's Cloudflare Worker) or `cloudflare` (Cloudflare's *Add visitor location headers* Managed Transform, e.g. with the Tunnel). Like `CLIENT_IP_HEADER`, only set it when every request comes through that proxy, or visitors could fake their location |
| `COINS` | Development only | No | off | `on` brings back the old experimental coins (see [Coins](#coins-off-for-now)); don't set it on a real server |

Compose's own settings in `.env`: `DOMAIN` (required, your host name), `POSTGRES_PASSWORD` (required, secret: a long random password for the bundled database), and for the Tunnel `CLOUDFLARE_TUNNEL_TOKEN` (secret) and `COMPOSE_FILE`. Cloudflare Containers also has `LOCATION_HINT` and `EPHEMERAL_STORAGE` in `wrangler.jsonc` (see [Cloudflare Containers](#cloudflare-containers)).

STUN alone is enough on most home and office networks. People behind strict corporate NATs or firewalls need a **TURN server** (for example [coturn](https://github.com/coturn/coturn)) for calls to connect.

### Accounts and sign-in

Signing in is optional: anyone with an office link can still join as a guest. People who sign in keep their character, status, theme and weather settings across devices, and the home page lists the offices they visit under *Your spaces* (with who's in them right now), the ones they created (or opened with the owner key) as their own. Accounts are never merged by email address, so signing in with Google and with Apple gives two accounts. The sign-in buttons (on the home page, and in an office's lobby, which you come back to after signing in) appear for the methods that are set up:

- **Google:** in the Google Cloud console (Google Auth Platform), set up the branding, set the audience to *External* and publish it to *In production* (for just name, email and profile no review is needed). Create a *Web application* client with the redirect URI `https://<your host>/api/auth/google/callback` (and `http://localhost:5173/api/auth/google/callback` for development), copy the secret right away (it's shown once), and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Google deletes clients that go unused for six months.
- **Apple** (needs a paid Apple Developer membership): enable *Sign in with Apple* on an App ID, create a *Services ID* with your domain and the return URL `https://<your host>/api/auth/apple/callback` (HTTPS only, no localhost), and create a *Sign in with Apple* key. Set `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` (the `.p8` file). Apple sends a person's name only the first time they sign in.
- **Development:** `DEV_LOGIN=true npm run dev` adds a sign-in with just a name and email.

Sessions last 30 days from the last visit, in an HttpOnly cookie (`__Host-wc_session` over HTTPS).

### Chat

Chat works out of the box; it keeps its messages in the database and attached files with the other uploads (`UPLOAD_MAX_BYTES` per file, `UPLOADS_QUOTA_MB` per office). Who may do what:

- Everyone in an office, guests included, can read and write in its channels, create channels, set a channel's topic, and edit or delete their own messages. Guests are known by their connection, so after a reload they can no longer edit what they wrote before.
- The owner, and signed-in people who may edit the office (everyone, unless the owner locked building to themselves), can also rename and archive channels and delete anyone's channel messages. Guests can't, even where they may build. #general can't be renamed or archived. Archived channels keep their history and can be unarchived.
- Direct messages are only ever sent to, and readable by, the two people in them.

Deleting a message deletes its files too. Set `CHAT_RETENTION_DAYS` to have messages deleted automatically, with their threads and files, once nobody has written in them (or in their thread) for that many days; files sent in live messages go after that long too. The server checks at most hourly, when someone comes in.

A message's link (its "Copy link" action) opens the office at that message, for anyone who can see it.

### GitHub

People who sign in can connect their own GitHub account and follow their GitHub notifications without leaving the office. The GitHub panel (the GitHub button in the dock, or in its More menu on phones) shows what's unread in their GitHub inbox, in four tabs:

- **Mentions:** you, or a team you're on, were @mentioned, or you were assigned.
- **Reviews:** someone asked for your review. The tab also shows how many open pull requests are waiting for your review; that count stays until you've reviewed them, even once the notifications are read.
- **Actions:** workflow runs you started (green: succeeded, red: failed, grey: cancelled or skipped), and deployments waiting for your approval (amber).
- **Activity:** everything else, such as comments on issues and pull requests you opened or follow.

The dock badge counts unread mentions, review requests and failed runs. Clicking an item opens it on GitHub and marks it read; *Mark read*, *Done* and *Mark all read* change your inbox on GitHub too (*Mark all read* leaves unread what arrived after the panel last checked). Like GitHub's unread view, the panel lists unread notifications only: read ones leave it with the next update. A new failed run also pops up as a message with an *Open* button, and a small red badge pulses on the monitor of your own desk (the one you claimed, or else the one you sit at) until you open the panel or the run is read or done. Only your browser draws it: nothing about your GitHub reaches the office. People connect and disconnect in *Settings > Integrations*; guests see "Sign in to connect GitHub". On a server without the settings below, or where nobody can sign in, GitHub doesn't appear at all.

**Setting it up.** GitHub needs people to sign in, so set up [Google or Apple sign-in](#accounts-and-sign-in) (or `DEV_LOGIN` for development) and `PUBLIC_URL` first. Then:
1. Create an **OAuth App** (not a GitHub App: GitHub's notifications API doesn't accept GitHub App tokens). Create it under your company's GitHub organization (*Organization settings > Developer settings > OAuth Apps > New OAuth App*), because apps an organization owns get access to its data automatically. A personal one (<https://github.com/settings/applications/new>) works too, but then each organization that restricts OAuth Apps has to approve it first (see below).
2. Name it (people see the name when they connect) and use your Workchop address as the *Homepage URL*. Set the *Authorization callback URL* to `${PUBLIC_URL}/api/integrations/github/callback`, e.g. `https://office.example.com/api/integrations/github/callback`. It must match exactly. An app can have up to 10 callback URLs, so development (`http://localhost:5173/api/integrations/github/callback`) and production can share one app. Leave *Enable Device Flow* off.
3. Keep *Expire user access tokens* on (the default). Access tokens then last 8 hours, and Workchop renews them with the refresh token GitHub gives it, which lasts 6 months without use.
4. Generate a client secret and copy it right away (GitHub shows it only once).
5. Generate the encryption key with `openssl rand -base64 32`.
6. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` (in `.env` for Compose, or with `npx wrangler secret put NAME` on Cloudflare Containers) and restart. If only one of the client ID and secret is set, the key is missing or invalid, or `PUBLIC_URL` isn't set (in production), GitHub stays off and the server's log says why. When it's on, the log says so, with the callback URL to register. A `PUBLIC_URL` that isn't an http(s) address stops the server from starting. One that differs from the address people use, or from the callback URL above, makes connecting fail at GitHub.

Keep `TOKEN_ENCRYPTION_KEY` safe and don't change it. The saved tokens can only be read with it, so with a new key everyone has to connect GitHub again, and anyone who has both the key and the database can use the tokens.

**Scopes.** Connecting asks GitHub only for the `notifications` scope: reading your notifications and marking them read or done. It gives no access to code. Links then go to the pull request, issue, Actions or repository page, worked out from the notification. *Include private repos & Actions* in *Settings > Integrations* connects again with the `repo` scope as well. Workchop then asks GitHub for the exact page (such as the latest comment) of up to 10 new notifications per poll; the others keep the link worked out from the notification. With `repo`, the review and assignment counts include private repositories too. **`repo` gives full read and write access to all your repositories**, public and private, because GitHub has no read-only alternative for OAuth Apps. Workchop only reads with it, but turn it on only if you're comfortable with that. Connecting again replaces the previous token and revokes it at GitHub (renewing it first if it has expired, so there's a live token to revoke).

**What each person should turn on.** The panel shows what GitHub puts in your inbox at <https://github.com/notifications>, so:
- In GitHub's [notification settings](https://github.com/settings/notifications), choose *On GitHub* for *Participating* and *Watching*, and under *System > Actions* choose *On GitHub* (optionally only for failed workflows). Without it, Actions runs, and maybe everything else, are missing. GitHub only notifies you about workflow runs you started.
- **Organizations** restrict OAuth Apps by default: until an owner approves Workchop's app, nothing from that organization's private repositories comes through. Ask for approval at `https://github.com/settings/connections/applications/<client id>` (Workchop's settings link there). Apps the organization owns are approved automatically.
- **SAML single sign-on:** for organizations that use it, you need an active SSO session with each of them when you connect, or their notifications are missing. Sign in to the organization on GitHub, then connect again.

**Polling and rate limits.** The server asks GitHub for new notifications only for people who are in an office right now, and stops when they leave. It sends `If-Modified-Since`, so a "nothing new" answer doesn't count against GitHub's rate limit, and between polls it waits as long as GitHub's `X-Poll-Interval` asks, at least a minute. Each poll reads the newest 100 unread notifications at most (two pages of 50); when there are more, the panel says so and links to your inbox on GitHub. Every 5 minutes, two searches count the open pull requests waiting for your review and the open issues and pull requests assigned to you (in public repositories only, unless `repo` is on). These requests use the person's own GitHub rate limit: 5,000 requests an hour, shared with every other app and token acting for them, and 30 searches a minute. Workchop uses a small part of it. When GitHub says to slow down (403 or 429), the server waits as long as GitHub asks (at most an hour), or a minute when it doesn't say; after other errors, and when it keeps saying so, it waits longer each time, up to 15 minutes. Each person can start connecting at most 5 times in 10 minutes (then Workchop asks them to wait a few minutes), because every connection makes a new token: GitHub asks people to authorize again after 10 new tokens in an hour, and keeps only 10 per app and scope, revoking the oldest.

**What's stored.** The GitHub account's id and login, the access and refresh tokens, their scopes and expiry times, in the database. The tokens are encrypted with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`, never sent to browsers and never logged; browsers only get the notifications. The notifications themselves are kept in memory only, while you're in an office and for 10 minutes after you leave (so a reload doesn't fetch them all again). A connection being made is stored with who started it, its PKCE verifier, the page to go back to and a SHA-256 of its `state`; it can be used once, within 10 minutes, and a clean-up every hour deletes unfinished ones. Connecting only starts from Workchop's own pages: when another site sends someone to it, it's refused. A GitHub account can be connected to one Workchop account at a time: connecting it from another one moves it there.

**Disconnecting and expiry.** *Disconnect* deletes the saved connection, stops polling and revokes the token at GitHub. If the access token has expired, Workchop renews it first, so there's a live token to revoke. If GitHub can't be reached then, the connection is still deleted; revoke the app on GitHub to be sure. It revokes only this server's token, so other Workchop servers that share the OAuth App stay connected. To remove Workchop's access completely, revoke the app at <https://github.com/settings/applications>. Workchop renews access tokens itself, in the last 5 minutes before they expire. When GitHub stops accepting the saved tokens (revoked on GitHub, a refresh token unused for 6 months, or a changed `TOKEN_ENCRYPTION_KEY`), polling stops and Workchop asks you to reconnect.

**Trying it locally.** A mock GitHub stands in for github.com and its API, with sample notifications in every tab:

```bash
npx tsx tests/helpers/github.ts               # on port 3999 (or PORT); prints the settings to use
DEV_LOGIN=true <those settings> npm run dev   # in a second terminal
```

Sign in with the dev login, open an office and connect GitHub: the mock asks which test account to authorize. Add notifications at `http://localhost:3999/_mock`; they show up with the next poll, within about a minute. The mock keeps everything in memory, so connect again after restarting it. To try the real GitHub, add `http://localhost:5173/api/integrations/github/callback` to your OAuth App's callback URLs and start `DEV_LOGIN=true npm run dev` with its `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` and a `TOKEN_ENCRYPTION_KEY`.

### Music and Spotify

The built-in radio stations work out of the box. Two things to know before adding your own music:

- **Your own tracks and streams** must be music your organisation may play to its staff, e.g. royalty-free or licensed tracks, your own Icecast server, or a business music provider's stream URL. Most consumer radio stations and services (including YouTube, SoundCloud, and Spotify itself) don't allow being re-played inside another app. URLs must be `https://`. Audio files need range requests (any normal web server or bucket has them) so late joiners can start in the middle of a track.
- **Spotify listen-along** uses Spotify's Web Playback SDK, which has strict rules:
  1. Create an app at <https://developer.spotify.com/dashboard>, tick **Web Playback SDK** and **Web API**, and add the redirect URI `https://<your domain>/spotify-callback.html`. For local testing, open Workchop at `http://127.0.0.1:5173` (not `localhost`; Spotify only accepts loopback IPs over plain http) and register `http://127.0.0.1:5173/spotify-callback.html`.
  2. Set `SPOTIFY_CLIENT_ID` (in `.env` for Docker Compose) and restart. No client secret is needed (sign-in uses PKCE).
  3. Every listener needs **Spotify Premium** and a desktop browser. Apps in Spotify's *development mode* work only for accounts you add under *User Management* (currently up to 5). Spotify grants wider access only to established organisations, and its developer policy doesn't allow apps aimed at businesses. So treat listen-along as a feature for small teams and friends, and use the board's links and Jams for everyone else.

### Headphones and noise suppression

Nothing to set up: no environment variables, keys or third-party services. Enhanced noise suppression runs RNNoise ([@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor), MIT) in an AudioWorklet in each browser; its worklet and WebAssembly files (about 130 KB gzipped) are part of the build and are only downloaded by people who turn it on. It needs a browser with AudioWorklet (Chrome, Edge, Firefox 76+, Safari 14.1+) and 48 kHz audio; elsewhere it says so and keeps Standard. If you put a Content-Security-Policy in front of Workchop (in Caddy or the Worker), allow `'wasm-unsafe-eval'` and scripts from `'self'`.

### Current app and the desktop helper

Browsers can't see which app you're using, so Workchop has two ways to show it:

- **By hand**, for everyone (guests too): the status button next to you in the dock, or *Settings > Privacy & status*. What you pick wins over the helper. Nothing shows while you're *Away*.
- **The desktop helper** (signed-in people): *Settings > Desktop helper > Pair a computer* creates a token for that computer, shown once, and a command to copy into a terminal, which asks for the token (so it stays out of your shell history). The command downloads one script (`helper/workchop-presence.cjs`, no packages, needs [Node.js](https://nodejs.org) 18+), pairs it and starts it. Later, start it with `node ~/workchop-presence.cjs run`; `status` shows what it would send, `unpair` forgets the token. Remove a computer in the same settings section and its token stops working at once.

**Privacy.** Every 5 seconds the helper reads only the identifier of the app in front (a macOS bundle id, a Windows process name or a Linux window class), never window titles, URLs or the screen. It turns that into an id from Workchop's list (`shared/apps.ts`) **on your computer** and sends only the id, or `other` for any app not on the list (shown as "Working", or hidden if you turn off *Show other apps as "Working"*). It sends on a change plus a heartbeat every 15 s. The server keeps it in memory only. It's hidden while you're on *Do not disturb* or wearing headphones, and turning off *Share what app I'm using* hides it everywhere at once. Its token is kept in `~/.config/workchop/helper.json` (`%APPDATA%\Workchop\helper.json` on Windows), readable only by you.

**Per system:**
- **macOS:** reads `NSWorkspace.frontmostApplication` through `osascript` (JavaScript for Automation). It sends no Apple Events, so macOS asks for no Automation, Accessibility or Screen Recording permission.
- **Windows:** one hidden PowerShell process reads the foreground window's process name (`GetForegroundWindow`). Where PowerShell is locked down (AppLocker/WDAC "ConstrainedLanguage"), the helper reports that it can't tell. Some company security tools flag PowerShell calling Windows APIs; ask your IT team first on a managed computer.
- **Linux:** on X11 it uses `xprop` (`WM_CLASS` only). On Wayland it works on Sway, Hyprland and niri, and on GNOME with the [Focused Window D-Bus](https://github.com/flexagoon/focused-window-dbus) extension (which shows the focused window's title to other programs on your session bus too; Workchop drops it). Other Wayland desktops, including KDE Plasma, can't tell yet: the helper says so in *Settings > Desktop helper*, and picking a status by hand still works.

**Starting it at login:** macOS, a LaunchAgent (`~/Library/LaunchAgents/com.workchop.presence.plist` running `node ~/workchop-presence.cjs run` with `RunAtLoad`); Windows, a shortcut in `shell:startup` to `node %USERPROFILE%\workchop-presence.cjs run` (or Task Scheduler); Linux, a systemd user service (`ExecStart=/usr/bin/node %h/workchop-presence.cjs run`, `systemctl --user enable --now workchop-presence`).

**Server side.** `PUT /api/me/app-presence` with `Authorization: Bearer wcp_…` and `{"app": "<id>" | "other" | null, "platform": "macos" | "windows" | "linux", "v": 1}` answers 204. The server takes about one report per 2 s per token. When none of your tabs is in an office, it answers with `Retry-After: 300` and the helper waits (so it can take up to 5 minutes after you open Workchop for your app to show). On Cloudflare Containers, the Worker answers helper reports itself (204) when the container isn't running (`Retry-After: 60`), and passes reports on only within 5 minutes of someone using Workchop (open tabs check in every 4 minutes). While the container is still running without visitors, it asks helpers to wait 16 minutes, longer than the 15-minute idle timeout, so a helper never starts the container and can't keep it running. Nothing to configure: the feature needs no settings of its own.

### Coins (off for now)

Coins are switched off. The owner wants actual coins rather than coins earned through activity, so the feature is disabled until it's redesigned: by default there's no wallet, no balance, no "Send coins", no celebrations, no coin tables, routes or timers. `COINS=on` turns the old experimental version (welcome and daily bonuses, coins for being present, tips; see `docs/specs/coins.md`) back on, **for development only**; don't set it on a real server. Its code and tests stay in the repository for the redesign.

### Weather

Everyone sees the weather and time of day where they are, in their own view of the office. The weather comes from [Open-Meteo](https://open-meteo.com/) through the Workchop server and works without any setup, but check the licence below. `WEATHER=off` turns it off.

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

**Licence.** Open-Meteo's free API is for **non-commercial use only** (see their [terms](https://open-meteo.com/en/terms)). For commercial use, for example if Workchop is sold, shows ads or is part of a company's product, take a [paid plan](https://open-meteo.com/en/pricing) and set `OPEN_METEO_API_KEY`, or set `WEATHER=off`. With a key, the server uses Open-Meteo's customer servers and sends the key in a header, never in a URL. The data is licensed CC BY 4.0, so the app shows "Weather data by Open-Meteo.com" next to the weather, and "Location data based on GeoNames" with the city search.

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
  src/ui/      Landing page, lobby, character editor, dock, people and build panels,
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
  auth/        Sign-in with Google, Apple or the dev login; cookie sessions
  accounts.ts  Users, sign-in identities, office memberships
  uploads.ts   File uploads and downloads (database, disk or S3/R2)
  features.ts  Hooks for features: routes, socket handlers, tables (list in features/index.ts)
  features/chat/  Channels, messages, threads, mentions, reactions, read markers (tables chat_*)
  features/audio.ts  Shoulder taps for people wearing headphones
  features/presence/  Current app from the status picker or the desktop helper (table api_tokens)
  features/coins/  Wallets, the coin ledger, daily and presence coins, tips (only with COINS=on)
  features/weather/  Open-Meteo proxy with a cache per ~11 km cell, location from proxy headers
  features/github/  Connecting GitHub (an OAuth App), encrypted tokens, the notifications poller
  features/world.ts  Lamps and light switches, desk claims and desk notes (table desk_notes)
shared/   Code used by both sides: types, furniture catalog, avatar options,
          office validation and edits, collision, pathfinding and proximity rules,
          world interactions (world.ts) and what each plant is (plants.ts)
cloudflare/  Worker that runs the Docker image on Cloudflare Containers and passes on visitors'
             approximate location (wrangler.jsonc, worker.ts, geo.ts)
helper/   The optional desktop helper for the current-app indicator (workchop-presence.cjs)
```

- **The server decides who talks to whom.** Clients stream their position to the server, which runs the proximity and private-area rules in `shared/geometry.ts`. When two people should be connected it sends `peer:connect` to both, with a link id and which side makes the WebRTC offer. When they drift apart it sends `peer:disconnect`. Signalling messages are relayed only between currently linked people, on their current link id, so nobody can open a call with someone they shouldn't hear.
- **Media is peer-to-peer** (a mesh). Every connection always has one audio and one video transceiver, so muting, turning the camera on or off, or starting a screen share is just `replaceTrack`, with no renegotiation. Remote audio volume is set from the distance between the two people.
- **Headphones mute, they don't disconnect.** Focus mode mutes the `<audio>` element of each call (`el.muted`, since iOS ignores `volume`) and turns the music down to zero, but keeps every call connected, so taking the headphones off is instant. Remote audio stays on media elements rather than Web Audio, so the browser's echo cancellation keeps working.
- **Enhanced noise suppression** sends the microphone through a 48 kHz AudioContext (mono mix → RNNoise → a MediaStreamDestination) and sends that track instead, with `replaceTrack` like a mute. Muting disables the processed track. The pipeline is built once per visit and closed when you leave; if the worklet fails, the context isn't running (no click yet, or a phone call on iOS), or the mic can't be connected, the plain microphone is sent instead so nobody hears silence. A replaced or unplugged mic is picked up again.
- **Office edits are operations** (`add`, `update`, `remove`, `zone:*`, `settings`). They are applied optimistically on the client and validated and normalised by the server with the same `applyOp` code. The server then echoes them to everyone in its own order, so all clients converge. Rejected edits trigger a full resync.
- **Music is synced by clock, not streamed.** Clients estimate the server's clock (`time` pings). The built-in stations are generated from it with a seeded pattern, so every browser plays the same bar. Track lists play from a shared start time. Listen-along sessions store the DJ's track, position and server time, and listeners seek to match (the DJ re-sends on track changes, pauses and seeks).
- **Chat is stored, except what's live.** Channel messages and direct messages between signed-in people are rows in `chat_messages`; the server checks every mention (a member of the office, a guest who is here, or `@here`) before saving and notifying anyone, keeps mentions for people who are away, and remembers how far each signed-in person has read. Nearby messages and direct messages with guests only pass through the server.
- **Weather is each viewer's own.** Each browser asks the server for the weather at its own rounded location and draws the sky, light and weather itself; none of it is part of the office. The server only fetches and caches Open-Meteo's answers.
- **Everything in the world is generated in code** (furniture, characters, floor textures), so there are no asset files to load.
- **GitHub tokens stay on the server.** It polls GitHub for each connected person who is in an office and sends the changes to that person's sockets only. Browsers get notifications, never tokens.

## Development

```bash
npm run typecheck
npm test          # unit tests for geometry/office rules + server integration tests
```

Tests use an in-memory PGlite. They run against real Postgres instead when `TEST_DATABASE_URL` points at a database they may write to (each test file gets its own schema), e.g. `TEST_DATABASE_URL=postgres://user:pass@localhost:5432/workchop_test npm test`. Run both before changing SQL: production may run Postgres 16 while PGlite is Postgres 18.

**Adding a server feature:** create `server/features/<name>.ts` exporting `feature: Feature` (`name`, optional `migrations`, `register(ctx)`) and add it to the list in `server/features/index.ts`. `register(ctx)` gets: `app`, an Express router mounted at `/api` (after `express.json`, before the API's 404; a guard already refuses cross-site `POST`/`PATCH`/`DELETE`); `io`; `db`, the database; `store`, the office store; `auth.userFromRequest(req)` and the `auth.requireUser` middleware (401 for guests, else the user in `res.locals.user`); `uploads` (e.g. `uploads.remove(ids)` deletes stored files); `publicOrigin` (`PUBLIC_URL`'s origin, or null); `clientIp(req)` (the visitor's IP address, from `CLIENT_IP_HEADER` behind a proxy, for per-visitor limits) and `socketIp(socket)` (the same for a connection, which stays put when a guest reconnects); `quiet` (true in tests: leave out messages that only say things are working); `onClose(fn)` (runs when the server closes, before the database does: stop timers there); and `realtime`: `onSocket`, `onJoin`, `onLeave`, `emitToOffice`, `emitToUser`, `playersOfUser`, `updatePlayer` (changes a player and tells the office), `contextOf(socketId)`, `onlineCount`, `linkedPeers`. Each connection's context (`s`) has `socket`, `user` (null for guests), `room()`, `me()`, `office()`, `isOwner()`, `mayEdit()` and `limiter(rate, burst)`. Socket ids are visible to everyone in the office, so an HTTP route shouldn't trust an `X-Workchop-Socket` header alone: also limit by `clientIp(req)`, or check a secret only that socket has (like the upload key). Declare the feature's socket events in `shared/<name>.ts` by augmenting `ClientToServerEvents`/`ServerToClientEvents` (and `PlayerState`) from `shared/types.ts`. Migration ids are global: core uses 1–99, features take the next free id from 100. `onSocket`/`onJoin`/`onLeave` callbacks may be async (failures are logged), but catch errors in your own `socket.on` handlers. Files are uploaded with `POST /api/offices/<id>/uploads` (the file as the body, its name URL-encoded in `X-Filename`, and `X-Workchop-Socket`/`X-Workchop-Upload-Key` from the join answer's `selfId`/`uploadKey`); a busy server answers 429 or 503 with `Retry-After`.

**Adding a client feature:** create `client/src/features/<name>/index.ts` (or `.tsx`); every such file is loaded at startup, so nothing else needs editing. From there:

- `registerPanel({ id, title, icon, Component, order, dock?, hideOnMobile?, inMore?, useBadge?, badgeTone?, shortcut? })` from `ui/panels.tsx` adds a side panel and its dock button (chat is 10, music 20, people 30, coins' wallet 35 when on, My desk 40, GitHub 45; `setPanel(id)` toggles it). `dock: false` gives it no button (build mode has its own), `hideOnMobile` none on phones, and with `inMore` the button goes in the dock's More menu on phone-sized screens, where the dock only has room for a few; an alert badge there shows on the More button too. `useBadge` is a hook giving the button's badge (a count or short text; red with `badgeTone: 'alert'`, the default, grey with `'neutral'`), and `shortcut` names a key in its tooltip (chat's `Enter`; the office's own keys are listed above, so pick one that isn't taken). Registering returns a function that removes the panel again, for features that show only on some servers (GitHub) or for some people (My desk).
- `registerSettingsSection({ id, title, icon, order, Component })` from `ui/settings.tsx` adds a section to Settings (Appearance is 10, Audio & video 20, Privacy & status 30, Desktop helper 35, Weather and Integrations 40).
- `registerTopBarItem({ id, order, Component })` from `ui/topbar.ts` adds something to the top bar, after the music that's playing (weather is 10). `Component` renders null when there's nothing to show.
- `registerPersonDetail({ id, order, Component })` from `ui/PeoplePanel.tsx` adds a line under other people's names in the People panel (weather is 10). `Component` gets `{ player }` and renders null when there's nothing to show for them.
- `registerPersonAction({ id, order, Component })` from `ui/personActions.ts` adds a button next to other people in the People panel, after "Go to" and "Message" (coins' "Send coins" is 10, when coins are on). `Component` gets `{ player }` and renders null when it doesn't apply to them.
- `registerSceneLayer({ id, order, Component })` from `world/layers.ts` adds a component to the 3D office, rendered inside the Canvas after the office (weather is 10; the world feature's monitors, darkened areas, lamp lights and item cards 20–50). Each layer has its own `Suspense` and error boundary, so it can be `lazy`, and one that fails doesn't take the office down. To change the sky, fog, light, wind (plants sway with it) or how the ground looks, write to `sceneLighting` (same file) from `useFrame` with priority `-1`, so before the office's own components read it each frame. Call `resetSceneLighting()` when your layer unmounts, or the office keeps your sky and light.
- `onSession(id, (session) => cleanup)` from `lib/session.ts` runs for every office visit, after the socket is created and before it connects: add handlers with `session.socket.on(…)` (typed, including your augmented events; they run after the app's own), act after joining with `session.onJoined((rejoin) => …)` (rejoins follow reconnects), and read `session.officeId` and `session.selfId()`; `session.onLeave(fn)` runs `fn` as the person leaves. The function you return runs when the person leaves, and also when the hook is registered again under the same `id` (a hot reload) or unregistered mid-visit, so undo there what the hook added (`socket.off`, the function `onJoined` returns). `session.upload(file, { name, onProgress, signal })` uploads a file into the office and resolves to `{ id, url, name, contentType, size }`, or throws an Error whose message can be shown ("File too large (max 10 MB)", the server's reason…).
- `toast(text, 'error' | { kind, icon, action: { label, run }, duration })` from `state/store.ts` shows a message, optionally with an icon and a button, and returns its id for `dismissToast(id)`. Toasts look the same with headphones on (they make no sound).
- For signed-in people, `getState().account` is their account, `saveCharacter(patch)` saves their look, and `saveAccountSettings({ key: value })` from `lib/account.ts` saves small preferences with it, merged key by key with the saved ones (at most 50 keys per account, so prefix yours, e.g. `weather.unit`; guests have none: show a "Sign in to …" hint instead).
- The 3D world has hooks too, in `world/extensions.ts`: `registerItemModel(type, Component)` for new item types, `registerItemDecor({ id, order, types, Component })` for extra 3D parts on items (the world feature's screens, GitHub badge, name plates and notes on desks are 10–30) (other scene content is a scene layer, above), `registerItemInteraction(types, { onClick, onHover })` for what clicking an item does, and `registerNearbyAction(id, find)` for what `E` does near something. Keep three.js out of your feature's `index.ts` (it loads with the landing page): put the 3D code in a module you register with `registerWorldModule(() => import('./scene'))`, which loads with the scene. `registerOverlay({ id, order, Component })` from `ui/overlays.tsx` shows something over the office, such as a card pinned next to an item.
- Item types can keep their own data: give the catalog entry (`shared/catalog.ts`) a `sanitizeData(raw)`, and change the data through your feature's own socket events. Build edits never change it: a moved item keeps its data, a new or copied one starts from `sanitizeData(undefined)`.

Icons come from the [Hugeicons](https://hugeicons.com) font in `scripts/hugeicons/`. The app ships only the glyphs it uses: to add one, put its name (from `icons.css`) in `client/src/ui/icon-names.json`, export a component for it in `client/src/ui/icons.tsx` and run `npm run icons`. That regenerates `client/src/ui/hugeicons.ts` and the cut-down font `client/src/assets/hgi-subset.woff2`, and needs fontTools (`pip install fonttools brotli`).

`GITHUB_OAUTH_BASE` and `GITHUB_API_BASE` (by default `https://github.com` and `https://api.github.com`) point the [GitHub](#github) integration at another server. They're only for the tests and the mock GitHub (`npx tsx tests/helpers/github.ts`); don't set them anywhere else.

Coins are off (see [Coins](#coins-off-for-now)): `COINS=on npm run dev` brings back the old version to work on it. Its tests (`tests/coins.test.ts`, `tests/client-coins.test.ts`) turn it on themselves and also check that it's off by default.

## Limits

- Calls are a mesh: each person sends their stream to every person they're near. That works well for conversations of up to about 8 people. Larger groups (stages, all-hands) would need an SFU such as LiveKit or mediasoup.
- Anyone with an office link can join it. The owner key, stored in the creator's browser, only controls who may edit.
- Chat: each person can send about one message a second (bursts of 6) and create a channel every 20 seconds (bursts of 3); an office has up to 200 open channels. Messages are up to 4,000 characters with up to 5 files, and history loads 50 messages at a time.
- Uploads: each office keeps up to `UPLOADS_QUOTA_MB` of files. Each visitor (IP address) can send 3 files at once and 60 per 10 minutes, and the server holds at most 4 files of the maximum size in memory at a time.
- Weather: each ~11 km place with someone online costs up to 4 Open-Meteo calls an hour, so the budget of 8,000 a day covers at least 80 places online around the clock (300 with an API key). Past it, the server serves each place's last weather for up to 3 hours, then none until midnight UTC (open tabs keep showing what they have). The count is per server run: a restart starts it over.
