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
- **Build mode** (hammer button or `B`): 31 pieces of furniture and structure in 6 categories. Place, drag, rotate (`R`), duplicate (`Ctrl/Cmd+D`), recolour and delete (`Del`) items, and draw private areas by dragging on the floor.
- Office settings: name, floor size, floor style and colour, wall colour, and spawn point. The owner can lock building to themselves.
- Every edit is synced live to everyone in the office and saved on the server.

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

Requires Node.js 22.12 or newer (Node 20.19+ can run the app, but the test runner needs 22.12+). Check with `node --version`.

```bash
npm install
npm run dev
```

Open http://localhost:5173, create an office, pick a name and join. Allow the camera and microphone when the browser asks.

`npm run dev` starts the API and realtime server on port 3001 (reloading on change) and Vite on port 5173, which proxies `/api` and `/socket.io` to the server. If port 3001 is taken, run it on another one, e.g. `PORT=4001 npm run dev` (the proxy follows `PORT`). Stop it with `Ctrl+C`.

### Testing a call

**On your own:** copy the invite link (link button in the top bar) and open it in a private/incognito window, which gets its own name and character. Walk the two characters toward each other: the video tiles appear at the top once you're within a few metres, and disappear when you walk apart. Use headphones or mute one window to avoid echo.

**With other people or your phone:** browsers only allow the camera and microphone on HTTPS (or `localhost`). The `Network:` address Vite prints works on your Wi-Fi, but people joining that way can only watch and listen. For full two-way calls, run the production build behind any HTTPS tunnel and share the `https://…` address it prints:

```bash
npm run build && npm start              # serves the app on http://localhost:3001
cloudflared tunnel --url http://localhost:3001   # or: ngrok http 3001
```

(Use the production build for this: Vite's dev server rejects unfamiliar host names such as tunnel addresses.)

### Production

```bash
npm run build      # client -> dist/client, server -> dist/server
npm start          # serves both on PORT (default 3001)
```

Or with Docker:

```bash
docker build -t workchop .
docker run -p 3001:3001 -v workchop-data:/app/data workchop
```

Browsers only allow camera and microphone access on **HTTPS** (or `localhost`), so put the server behind a TLS-terminating proxy (Caddy, nginx, a load balancer…) that forwards WebSockets.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port of the server (in `npm run dev`, the API port Vite proxies to) |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data/offices` | Where offices are saved (one JSON file each) |
| `ICE_SERVERS` | Google STUN | JSON array of `RTCIceServer`s, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | – | Shortcut for adding one TURN server (comma-separate several URLs) |

STUN alone is enough on most home and office networks. People behind strict corporate NATs or firewalls need a **TURN server** (for example [coturn](https://github.com/coturn/coturn)) for calls to connect.

## How it works

```
client/   React + react-three-fiber app (Vite)
  src/world/   3D scene: furniture models, avatar, movement, camera, build tools
  src/ui/      Landing page, lobby, character editor, dock, chat, people and build panels
  src/lib/     Socket session, WebRTC mesh (peers.ts), local media, speaking detection
server/   Express + Socket.IO
  realtime.ts  Presence, movement, chat, office edits, WebRTC signalling relay
  room.ts      Who is linked to whom
  officeStore.ts  JSON persistence with debounced atomic writes
shared/   Code used by both sides: types, furniture catalog, avatar options,
          office validation and edits, collision, pathfinding and proximity rules
```

- **The server decides who talks to whom.** Clients stream their position to the server, which runs the proximity and private-area rules in `shared/geometry.ts`. When two people should be connected it sends `peer:connect` to both, with a link id and which side makes the WebRTC offer. When they drift apart it sends `peer:disconnect`. Signalling messages are relayed only between currently linked people, on their current link id, so nobody can open a call with someone they shouldn't hear.
- **Media is peer-to-peer** (a mesh). Every connection always has one audio and one video transceiver, so muting, turning the camera on or off, or starting a screen share is just `replaceTrack`, with no renegotiation. Remote audio volume is set from the distance between the two people.
- **Office edits are operations** (`add`, `update`, `remove`, `zone:*`, `settings`). They are applied optimistically on the client and validated and normalised by the server with the same `applyOp` code. The server then echoes them to everyone in its own order, so all clients converge. Rejected edits trigger a full resync.
- **Everything in the world is generated in code** (furniture, characters, floor textures), so there are no asset files to load.

## Development

```bash
npm run typecheck
npm test          # unit tests for geometry/office rules + server integration tests
```

## Limits

- Calls are a mesh: each person sends their stream to every person they're near. That works well for conversations of up to about 8 people. Larger groups (stages, all-hands) would need an SFU such as LiveKit or mediasoup.
- Anyone with an office link can join it. The owner key, stored in the creator's browser, only controls who may edit.
