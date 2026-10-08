# Workchop

A 3D virtual office in the browser, in the spirit of [Gather](https://www.gather.town/): walk around with your own character, and when you get close to someone you can hear and see them. Teams can rebuild the office together in build mode.

## Features

**Proximity audio and video**
- Walk within about 4 m of someone to start a WebRTC call. You keep hearing them until about 5 m, and their volume fades with distance.
- **Private areas** (meeting rooms, booths): everyone inside hears only the others inside, however far apart they are. Someone standing just outside the glass hears nothing.
- Screen sharing, mute and camera toggles, device selection (mic, camera, speakers), and a talking indicator on video tiles and characters.
- Click a video tile to enlarge it, e.g. to follow a screen share.
- A "Do not disturb" status keeps you out of conversations except inside private areas.

**Your character**
- A procedurally built 3D character: skin tone, 7 hairstyles (or bald) and hair colour, T-shirt / hoodie / suit / dress, colours for top, bottoms and shoes, hats (cap, beanie, top hat, crown, headphones), glasses, and facial hair. You can also pick custom colours.
- Walking animation, sitting on chairs, sofas and stools, and reactions (👋 waves, ✋ raises a hand).
- Your look and name are saved in the browser and can be changed at any time, even inside an office.

**The office**
- Two starting templates: a furnished startup office with desk pods, a glass meeting room, a lounge, a kitchen and ping pong, or a blank floor.
- **Build mode** (hammer button or `B`): 45 pieces of furniture, structure and plants in 7 categories. Place, drag, rotate (`R`), duplicate (`Ctrl/Cmd+D`), recolour and delete (`Del`) items, and draw private areas by dragging on the floor.
- Office settings: name, floor size, floor style and colour, wall colour, and spawn point. The owner can lock building to themselves.
- Every edit is synced live to everyone in the office and saved on the server.

**Little things in the world**
- **Desk monitors** are off until someone sits at the desk: then the screen wakes up (a glow and a logo) and shows the app they're working in, when they share it, or a calm wallpaper with their name and the time. Everyone sees it, and it goes dark a second after they get up.
- **Lights:** click a floor lamp or desk lamp to switch it on or off for everyone. A **light switch** (Build → Structure; put it against a wall) works the ceiling lights of the private area in front of it, or of the open office: switched off, that area goes dark for everyone, while its lamps and lit monitors keep glowing. Walk up to one and press `E`, or click it.
- **Plants:** 13 species (Build → Plants), from a monstera and a bird of paradise to a bonsai and a barrel cactus. Small ones stand on desks, tables and shelves. Click one to see what it is: where it comes from, how much light and water it needs, whether it's safe for pets (per the ASPCA where it lists the plant), and a fun fact.
- **Your desk:** signed-in people click a free desk and choose *Make this my desk* (one per office; claiming another moves you). Your name goes on a name plate. Anyone, guests included, can click your desk and leave you a sticky note (up to 500 characters, in four colours). The notes stack up on the desk for everyone to see, but only you read them: you get a toast when one arrives, or a reminder when you come in, and *My desk* in the dock lists them to mark as read or throw away. Whoever wrote a note can take it back. Owners and people who can edit the office can free a desk.

**Lounge music**
- A **jukebox** (in the startup lounge, or add one from Build → Fun) plays music for everyone in the private area it stands in, or within about 7 m if it's out in the open. Click it, the 🎵 dock button, or the "now playing" chip to open it. Everyone has their own volume and mute.
- **Radio:** two built-in stations, *Workchop Lo-fi* and *Workchop Ambient*, are composed live in each browser from the server clock, so everyone hears the same notes at the same moment, with nothing to license or stream. Editors can also add **the office's own tracks** (audio files, looped in sync for everyone) or **a live stream** (an https Icecast/Shoutcast URL). Anyone can switch stations.
- **Spotify board:** share Spotify playlists, albums, tracks, podcasts, or a **Jam** invite. Everyone opens them in their own Spotify app.
- **Spotify listen-along** (optional, needs `SPOTIFY_CLIENT_ID`, see below): people connect their own Spotify Premium account, someone presses ▶ "Play for everyone", and everyone connected at that jukebox hears the same track at the same position on their own account. Workchop only syncs what's playing; it never streams audio from one person to another.

**Getting around**
- `WASD` or the arrow keys move you relative to the camera, and `Shift` runs. Click the floor to walk there (with pathfinding); click a chair to walk over and sit.
- Drag to orbit the camera and scroll to zoom. Walls and shelves between you and the camera fade out.
- Text chat to everyone, to people nearby, or as a direct message. The people list shows who's in a conversation, with "go to" and "message" buttons.
- Works on phones: tap to walk, drag to look around.

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | Move (`Shift` to run) |
| `E` | Sit / stand, or switch the lights or lamp you're next to |
| `1`–`6` | Reactions |
| `M` / `V` | Toggle microphone / camera |
| `B` | Build mode |
| `Enter` | Open chat |
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

Caddy isn't started, so you can close ports 80 and 443: nothing needs to be reachable from the internet. Calls still go directly between people, so use [Cloudflare TURN](#cloudflare-turn-for-calls) for people behind strict firewalls.

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

The first deploy takes a few minutes while Cloudflare prepares the container. Workchop is then at `https://workchop.<your-subdomain>.workers.dev`. Add your own hostname under the Worker's *Settings > Domains & Routes*. Optional settings are wrangler secrets as well: `SPOTIFY_CLIENT_ID` (register `https://<your host>/spotify-callback.html` as its redirect URI), `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN`, the [sign-in](#accounts-and-sign-in) keys, and an R2 bucket for uploaded files (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; without one, files go into Postgres, which fills a free database quickly). Set `PUBLIC_URL` (in `wrangler.jsonc`) to the address people use; sign-in needs it.

How it behaves:
- **Starts on demand.** The first visit starts the container, which takes a few seconds. It stops about 15 minutes after the last person closes Workchop. Open tabs check in every few minutes, which keeps it running.
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
| Uploaded files | An S3/R2 bucket when `S3_*` is set, otherwise the database with Postgres, or `DATA_DIR/uploads` with PGlite (`UPLOADS_STORAGE` picks one) |
| Names and characters of guests | Each person's browser (local storage) |
| Jukebox settings: station, own tracks/stream, shared Spotify links | With the office (part of the jukebox item) |
| Lamps and light switches (on or off), who has claimed which desk | With the office (part of each item) |
| Notes left on desks: text, colour, author, when, read or not | The database (`desk_notes`), until the desk's owner or the author throws them away. Each owner keeps at most 50 per office; the oldest read ones make room |
| Spotify sign-in | Each listener's browser (local storage); never sent to the Workchop server |
| Chat | In memory only: the last 100 "everyone" messages per office, cleared on restart |
| Who's online, positions, calls | In memory only (live state) |

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

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port of the server (in `npm run dev`, the API port Vite proxies to) |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | – | Postgres connection string. Without it, data is kept in PGlite in `DATA_DIR/db` |
| `DATABASE_SSL` | – | `require` (verified TLS) or `no-verify` (TLS without certificate checks, for some managed providers) |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Data folder: the PGlite database (`db/`), uploaded files with `UPLOADS_STORAGE=fs` (`uploads/`), and old office JSON files to import |
| `PUBLIC_URL` | `http://localhost:5173` in development | The address people open Workchop at, e.g. `https://office.example.com`. Sign-in redirects are built from it, and Socket.IO refuses connections whose `Origin` differs. Compose sets it from `DOMAIN` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | – | Turns on "Sign in with Google" (see [Accounts and sign-in](#accounts-and-sign-in)) |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | – | Turns on "Sign in with Apple": the Services ID, team ID, key ID and the `.p8` key (PEM, with `\n` for line breaks, or base64) |
| `DEV_LOGIN` | – | `true` allows signing in with just a name and email, for development. Ignored by the built server (`npm start`, Docker) and when `NODE_ENV=production`, unless `DEV_LOGIN_IN_PRODUCTION=true` |
| `UPLOADS_STORAGE` | see above | Where uploaded files go: `s3`, `db` or `fs`. Each file remembers where it went, so switching keeps old files readable |
| `UPLOAD_MAX_BYTES`, `UPLOADS_QUOTA_MB` | `10485760`, `1024` | Largest file, and the total each office may keep |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | –, `auto` | An S3-compatible bucket for uploads (Cloudflare R2: `https://<account id>.r2.cloudflarestorage.com`); path-style URLs |
| `ICE_SERVERS` | Google STUN | JSON array of `RTCIceServer`s, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | – | Shortcut for adding one TURN server (comma-separate several URLs) |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_KEY_API_TOKEN` | – | Use Cloudflare's TURN service, with short-lived credentials per visitor (replaces the static ICE servers above) |
| `CLOUDFLARE_TURN_TTL` | `86400` | How long those credentials last, in seconds (600 to 172800) |
| `CLIENT_IP_HEADER` | – | Header with each visitor's IP when behind a proxy: `x-forwarded-for` directly behind the bundled Caddy (set in Compose), `cf-connecting-ip` when every request comes through Cloudflare (set automatically on Containers and with the Tunnel). Only use a header the visitor can't set: leave it unset when nothing sits in front, and don't use `cf-connecting-ip` if your server can also be reached without going through Cloudflare |
| `SPOTIFY_CLIENT_ID` | – | Turns on Spotify listen-along (see below) |

STUN alone is enough on most home and office networks. People behind strict corporate NATs or firewalls need a **TURN server** (for example [coturn](https://github.com/coturn/coturn)) for calls to connect.

### Accounts and sign-in

Signing in is optional: anyone with an office link can still join as a guest. People who sign in keep their character, status and theme across devices, and the home page lists the offices they visit under *Your spaces* (with who's in them right now), the ones they created (or opened with the owner key) as their own. Accounts are never merged by email address, so signing in with Google and with Apple gives two accounts. The sign-in buttons (on the home page, and in an office's lobby, which you come back to after signing in) appear for the methods that are set up:

- **Google:** in the Google Cloud console (Google Auth Platform), set up the branding, set the audience to *External* and publish it to *In production* (for just name, email and profile no review is needed). Create a *Web application* client with the redirect URI `https://<your host>/api/auth/google/callback` (and `http://localhost:5173/api/auth/google/callback` for development), copy the secret right away (it's shown once), and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Google deletes clients that go unused for six months.
- **Apple** (needs a paid Apple Developer membership): enable *Sign in with Apple* on an App ID, create a *Services ID* with your domain and the return URL `https://<your host>/api/auth/apple/callback` (HTTPS only, no localhost), and create a *Sign in with Apple* key. Set `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` (the `.p8` file). Apple sends a person's name only the first time they sign in.
- **Development:** `DEV_LOGIN=true npm run dev` adds a sign-in with just a name and email.

Sessions last 30 days from the last visit, in an HttpOnly cookie (`__Host-wc_session` over HTTPS).

### Music and Spotify

The built-in radio stations work out of the box. Two things to know before adding your own music:

- **Your own tracks and streams** must be music your organisation may play to its staff, e.g. royalty-free or licensed tracks, your own Icecast server, or a business music provider's stream URL. Most consumer radio stations and services (including YouTube, SoundCloud, and Spotify itself) don't allow being re-played inside another app. URLs must be `https://`. Audio files need range requests (any normal web server or bucket has them) so late joiners can start in the middle of a track.
- **Spotify listen-along** uses Spotify's Web Playback SDK, which has strict rules:
  1. Create an app at <https://developer.spotify.com/dashboard>, tick **Web Playback SDK** and **Web API**, and add the redirect URI `https://<your domain>/spotify-callback.html`. For local testing, open Workchop at `http://127.0.0.1:5173` (not `localhost`; Spotify only accepts loopback IPs over plain http) and register `http://127.0.0.1:5173/spotify-callback.html`.
  2. Set `SPOTIFY_CLIENT_ID` (in `.env` for Docker Compose) and restart. No client secret is needed (sign-in uses PKCE).
  3. Every listener needs **Spotify Premium** and a desktop browser. Apps in Spotify's *development mode* work only for accounts you add under *User Management* (currently up to 5). Spotify grants wider access only to established organisations, and its developer policy doesn't allow apps aimed at businesses. So treat listen-along as a feature for small teams and friends, and use the board's links and Jams for everyone else.

## How it works

```
client/   React + react-three-fiber app (Vite)
  src/world/   3D scene: furniture models, avatar, movement, camera, build tools
  src/ui/      Landing page, lobby, character editor, dock, chat, people and build panels,
               the side panel (panels.tsx) and settings (settings.tsx) registries
  src/lib/     Socket session and its hooks (session.ts), sign-in and account (account.ts),
               WebRTC mesh (peers.ts), local media, speaking detection, file uploads (upload.ts),
               lounge radio (radio.ts, genmusic.ts), Spotify listen-along (spotify.ts)
  src/features/  Client features, loaded automatically (see Development); world/ has the desk
               monitors, lights, plant cards, desk claims and notes
server/   Express + Socket.IO
  realtime.ts  Presence, movement, chat, office edits, WebRTC signalling relay, jukebox and listen-along sessions
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
  features/world.ts  Lamps and light switches, desk claims and desk notes
shared/   Code used by both sides: types, furniture catalog, avatar options,
          office validation and edits, collision, pathfinding and proximity rules,
          world interactions (world.ts) and what each plant is (plants.ts)
cloudflare/  Worker that runs the Docker image on Cloudflare Containers (wrangler.jsonc, worker.ts)
```

- **The server decides who talks to whom.** Clients stream their position to the server, which runs the proximity and private-area rules in `shared/geometry.ts`. When two people should be connected it sends `peer:connect` to both, with a link id and which side makes the WebRTC offer. When they drift apart it sends `peer:disconnect`. Signalling messages are relayed only between currently linked people, on their current link id, so nobody can open a call with someone they shouldn't hear.
- **Media is peer-to-peer** (a mesh). Every connection always has one audio and one video transceiver, so muting, turning the camera on or off, or starting a screen share is just `replaceTrack`, with no renegotiation. Remote audio volume is set from the distance between the two people.
- **Office edits are operations** (`add`, `update`, `remove`, `zone:*`, `settings`). They are applied optimistically on the client and validated and normalised by the server with the same `applyOp` code. The server then echoes them to everyone in its own order, so all clients converge. Rejected edits trigger a full resync.
- **Music is synced by clock, not streamed.** Clients estimate the server's clock (`time` pings). The built-in stations are generated from it with a seeded pattern, so every browser plays the same bar. Track lists play from a shared start time. Listen-along sessions store the DJ's track, position and server time, and listeners seek to match (the DJ re-sends on track changes, pauses and seeks).
- **Everything in the world is generated in code** (furniture, characters, floor textures), so there are no asset files to load.

## Development

```bash
npm run typecheck
npm test          # unit tests for geometry/office rules + server integration tests
```

Tests use an in-memory PGlite. They run against real Postgres instead when `TEST_DATABASE_URL` points at a database they may write to (each test file gets its own schema), e.g. `TEST_DATABASE_URL=postgres://user:pass@localhost:5432/workchop_test npm test`. Run both before changing SQL: production may run Postgres 16 while PGlite is Postgres 18.

**Adding a server feature:** create `server/features/<name>.ts` exporting `feature: Feature` (`name`, optional `migrations`, `register(ctx)`) and add it to the list in `server/features/index.ts`. `register` gets an Express router mounted at `/api`, the database, the office store, `auth.userFromRequest`/`requireUser`, and the realtime hooks (`onSocket`, `onJoin`, `onLeave`, `emitToOffice`, `emitToUser`, `updatePlayer`…). Declare the feature's socket events in `shared/<name>.ts` by augmenting `ClientToServerEvents`/`ServerToClientEvents` (and `PlayerState`) from `shared/types.ts`. Migration ids are global: core uses 1–99, features take the next free id from 100. `onSocket`/`onJoin`/`onLeave` callbacks may be async (failures are logged), but catch errors in your own `socket.on` handlers. Files are uploaded with `POST /api/offices/<id>/uploads` (the file as the body, its name URL-encoded in `X-Filename`, and `X-Workchop-Socket`/`X-Workchop-Upload-Key` from the join answer's `selfId`/`uploadKey`); a busy server answers 429 or 503 with `Retry-After`.

**Adding a client feature:** create `client/src/features/<name>/index.ts` (or `.tsx`); every such file is loaded at startup, so nothing else needs editing. From there:

- `registerPanel({ id, title, icon, Component, order, dock?, hideOnMobile?, useBadge?, badgeTone?, shortcut? })` from `ui/panels.tsx` adds a side panel and its dock button (chat is 10, music 20, people 30; `setPanel(id)` toggles it).
- `registerSettingsSection({ id, title, icon, order, Component })` from `ui/settings.tsx` adds a section to Settings (Appearance is 10, Audio & video 20).
- `onSession(id, (session) => cleanup)` from `lib/session.ts` runs for every office visit, after the socket is created and before it connects: add handlers with `session.socket.on(…)` (typed, including your augmented events; they run after the app's own), act after joining with `session.onJoined((rejoin) => …)` (rejoins follow reconnects), and read `session.officeId` and `session.selfId()`. The function you return runs when the person leaves, and also when the hook is registered again under the same `id` (a hot reload) or unregistered mid-visit, so undo there what the hook added (`socket.off`, the function `onJoined` returns). `session.upload(file, { name, onProgress, signal })` uploads a file into the office and resolves to `{ id, url, name, contentType, size }`, or throws an Error whose message can be shown ("File too large (max 10 MB)", the server's reason…).
- `toast(text, { kind, icon, action: { label, run } })` from `state/store.ts` shows a message, optionally with an icon and a button.
- For signed-in people, `getState().account` is their account and `saveAccountSettings({ key: value })` from `lib/account.ts` saves small preferences with it, merged key by key with the saved ones (at most 50 keys per account, so prefix yours, e.g. `weather.unit`; guests have none: show a "Sign in to …" hint instead).
- The 3D world has hooks too, in `world/extensions.ts`: `registerItemModel(type, Component)` for new item types, `registerItemDecor({ id, types, Component })` for extra 3D parts on items, `registerWorldLayer({ id, order, Component })` for scene content, `registerItemInteraction(types, { onClick, onHover })` for what clicking an item does, and `registerNearbyAction(id, find)` for what `E` does near something. Keep three.js out of your feature's `index.ts` (it loads with the landing page): put the 3D code in a module you register with `registerWorldModule(() => import('./scene'))`, which loads with the scene. `registerOverlay({ id, order, Component })` from `ui/overlays.tsx` shows something over the office, such as a card pinned next to an item.
- Item types can keep their own data: give the catalog entry (`shared/catalog.ts`) a `sanitizeData(raw)`, and change the data through your feature's own socket events. Build edits never change it: a moved item keeps its data, a new or copied one starts from `sanitizeData(undefined)`.

Icons come from the [Hugeicons](https://hugeicons.com) font in `scripts/hugeicons/`. The app ships only the glyphs it uses: to add one, put its name (from `icons.css`) in `client/src/ui/icon-names.json`, export a component for it in `client/src/ui/icons.tsx` and run `npm run icons`. That regenerates `client/src/ui/hugeicons.ts` and the cut-down font `client/src/assets/hgi-subset.woff2`, and needs fontTools (`pip install fonttools brotli`).

## Limits

- Calls are a mesh: each person sends their stream to every person they're near. That works well for conversations of up to about 8 people. Larger groups (stages, all-hands) would need an SFU such as LiveKit or mediasoup.
- Anyone with an office link can join it. The owner key, stored in the creator's browser, only controls who may edit.
- Uploads: each office keeps up to `UPLOADS_QUOTA_MB` of files. Each visitor (IP address) can send 3 files at once and 60 per 10 minutes, and the server holds at most 4 files of the maximum size in memory at a time.
