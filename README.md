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
- **Build mode** (hammer button or `B`): 32 pieces of furniture and structure in 6 categories. Place, drag, rotate (`R`), duplicate (`Ctrl/Cmd+D`), recolour and delete (`Del`) items, and draw private areas by dragging on the floor.
- Office settings: name, floor size, floor style and colour, wall colour, and spawn point. The owner can lock building to themselves.
- Every edit is synced live to everyone in the office and saved on the server.

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
| `E` | Sit / stand |
| `1`–`6` | Reactions |
| `M` / `V` | Toggle microphone / camera |
| `B` | Build mode |
| `Enter` | Open chat |
| `R`, `Del`, `Ctrl+D`, `Esc` | Rotate, delete, duplicate, cancel (build mode) |

## Getting started

Requires Node.js 22.12+ or 24+ (the current LTS releases). Node 20.19+ also runs the app, though npm warns that the test runner wants 22.12+. Check with `node --version`.

```bash
npm install
npm run dev
```

Open the `Local:` address it prints (normally http://localhost:5173), create an office, pick a name and join. Allow the camera and microphone when the browser asks.

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

- **Where the data lives:** in the `db-data` Docker volume, and it survives restarts and `docker compose down`. Only `docker compose down -v` deletes it. Back it up with `docker compose exec db pg_dump -U workchop workchop > backup.sql`.
- **TURN (optional):** people behind strict corporate firewalls may need a relay for calls to connect. Set `TURN_URL=turn:<DOMAIN>:3478`, `TURN_USERNAME` and `TURN_CREDENTIAL` in `.env`, open TCP/UDP 3478 and UDP 49160–49200, and start with `docker compose --profile turn up -d --build`.

### What is stored

| Data | Where |
| --- | --- |
| Offices: layout, furniture, private areas, settings, owner key | Postgres (when `DATABASE_URL` is set), otherwise one JSON file per office in `DATA_DIR` |
| Names and characters | Each person's browser (local storage) |
| Jukebox settings: station, own tracks/stream, shared Spotify links | With the office (part of the jukebox item) |
| Spotify sign-in | Each listener's browser (local storage); never sent to the Workchop server |
| Chat | In memory only: the last 100 "everyone" messages per office, cleared on restart |
| Who's online, positions, calls | In memory only (live state) |

**Postgres or files?** Use Postgres for anything hosted. Each office is a single document, so it's stored as a `jsonb` row in one `offices` table, created automatically on start-up. Managed Postgres (Neon, Supabase, RDS, Render, Railway, Fly…) works too: set `DATABASE_URL`, plus `DATABASE_SSL=no-verify` if the provider uses a certificate Node doesn't trust. The JSON files are fine for a single server with a persistent disk, and need no setup. Switching storage doesn't move existing offices over.

Run **one app instance**. Live rooms (who's where, call links) are kept in memory, so several instances behind a load balancer would split an office in two. One instance comfortably serves many offices.

### Without Compose

```bash
npm run build      # client -> dist/client, server -> dist/server
npm start          # serves both on PORT (default 3001)
```

or `docker build -t workchop . && docker run -p 3001:3001 -e DATABASE_URL=postgres://… workchop` (leave out `DATABASE_URL` to store files in the `/app/data` volume). Put it behind any HTTPS reverse proxy that forwards WebSockets (Caddy, nginx, a cloud load balancer).

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port of the server (in `npm run dev`, the API port Vite proxies to) |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | – | Postgres connection string. When set, offices are stored in Postgres |
| `DATABASE_SSL` | – | `require` (verified TLS) or `no-verify` (TLS without certificate checks, for some managed providers) |
| `DATA_DIR` | `./data/offices` | Where offices are saved when there's no `DATABASE_URL` (one JSON file each) |
| `ICE_SERVERS` | Google STUN | JSON array of `RTCIceServer`s, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | – | Shortcut for adding one TURN server (comma-separate several URLs) |
| `SPOTIFY_CLIENT_ID` | – | Turns on Spotify listen-along (see below) |

STUN alone is enough on most home and office networks. People behind strict corporate NATs or firewalls need a **TURN server** (for example [coturn](https://github.com/coturn/coturn)) for calls to connect.

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
  src/ui/      Landing page, lobby, character editor, dock, chat, people and build panels
  src/lib/     Socket session, WebRTC mesh (peers.ts), local media, speaking detection,
               lounge radio (radio.ts, genmusic.ts), Spotify listen-along (spotify.ts)
server/   Express + Socket.IO
  realtime.ts  Presence, movement, chat, office edits, WebRTC signalling relay, jukebox and listen-along sessions
  room.ts      Who is linked to whom
  music.ts     Jukebox changes and who may make them, Spotify link previews
  officeStore.ts  Cache of open offices, debounced saves, flush on shutdown
  repos.ts     Storage backends: JSON files or Postgres (jsonb)
shared/   Code used by both sides: types, furniture catalog, avatar options,
          office validation and edits, collision, pathfinding and proximity rules
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

The storage tests also run against Postgres when `TEST_DATABASE_URL` points at a database they may write to, e.g. `TEST_DATABASE_URL=postgres://user:pass@localhost:5432/workchop_test npm test`.

## Limits

- Calls are a mesh: each person sends their stream to every person they're near. That works well for conversations of up to about 8 people. Larger groups (stages, all-hands) would need an SFU such as LiveKit or mediasoup.
- Anyone with an office link can join it. The owner key, stored in the creator's browser, only controls who may edit.
