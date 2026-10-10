# Feature: customer support workspaces ("Intercom in 3D")

Owner's words: "A workspace type tailored to customer support — support staff have a seat where
clients sit on the opposite end and both parties can chat over text, audio or video calls. Each
conversation is a ticket. A list shows who's next; when staff click Next, the next person walks to
that support desk. A big lobby with more sightseeing keeps the waiting customers busy."

Decisions: customers use the public customer link (no account) and appear to others as
"Visitor #N" (staff see real names); one customer per agent at a time; the lobby is "look around"
only (no mini-games).

## Who is who
- A workspace of kind `support` (fixed at creation; template `support`). Its guest link is the
  public **customer link**, on from creation; `open` never applies to it.
- **Staff**: owner, admins and members. **Customers**: guests there (`isCustomer(role, kind)` in
  shared/workspace.ts). Customers join named "Visitor" (core join and `profile` ignore the name they
  send), and become `visitorName(number)` once they have a ticket. Profile renames don't change it.
  Their PlayerState has `customer: true` (set on join) and no `userId`, and they keep the character
  from the customer lobby (never their account's), so others can't tell who they are.
- Customers can't change the shared world (`SocketContext.mayChangeWorld()` false): music, Spotify
  listen-along, `world:light`, `desk:note`; they can't build (guests build only in `open` offices;
  `kinds` keeps support items out of team offices), edit info boards (`world:board`: owner and
  admins), use chat outside their ticket, send or get coins, show their current app, or tap anyone
  but the agent serving them.
- A customer made a member while inside (`onRoleChange`) is staff from then on: their ticket ends
  (waiting: abandoned, active: resolved), the others get `{customer: false, userId, name}`.

## Contract
shared/support.ts: types, limits, `AWAY_GRACE_MS` (10 min), `SUMMON_TIMEOUT_MS` (25 s, client),
`STAFF_SEAT`/`CUSTOMER_SEAT` (support-desk seat order), `deskLabels(items)` ("Desk 1"… west to east,
then north to south), `ticketConv(id)` = `t:<id>`, and the socket events:

| Event | Who | What |
|---|---|---|
| `support:state` | everyone, after every join | `{as: 'staff', queue, board}`, `{as: 'customer', ticket, board}` or `{as: 'none'}` |
| `support:enter` | customers, after every join | resumes the open ticket of `key` (SHA-256 stored); with an empty message and nothing open, the key's ticket closed in the last 24 h (resolved: thanks and rating; abandoned: their place ran out), else an error; otherwise opens one (name, optional email, message; the message starts the ticket chat). One open ticket per connection |
| `support:leave-queue` | customers | a waiting ticket becomes abandoned |
| `support:rate` | customers | 1–5, once, on their last resolved ticket |
| `support:desk` | staff | take a support desk (one each), or leave yours (`null`; not while serving) |
| `support:next` | staff at a desk, not serving | claims the first waiting ticket whose customer is here; summons them |
| `support:resolve` | the agent serving | closes the ticket as resolved |
| `support:history` | staff | resolved and abandoned tickets, newest first, by name/email/number, 30 a page |
| `support:remove` | staff | takes a customer out (`office:removed` 'removed'): their open ticket is abandoned, their key can't open tickets for 4 h, their address can't come in for 1 h (in memory) |
| `support:queue` → staff | | waiting tickets (in queue order, with `present`, and `playerId`: the customer's newest connection), desks in use, your ticket |
| `support:ticket` → customers | | your ticket (place in the queue, agent and desk, status, rating); only to connections that sent `support:enter` |
| `support:summon` → customers | | the customer seat of the desk to walk to |
| `support:board` → everyone | | Now serving (number and desk) and how many wait |

Events are sent only when they change; `support:state` gives the current picture after a join.

## Server (server/features/support/)
- `support_tickets` (migration 700): status `waiting | active | resolved | abandoned`; SHA-256s of
  the customer's key and address; unique partial indexes: one open ticket per (office, customer
  key), one active per (office, agent) and per (office, desk). Numbers come from `support_counters`
  (one row per office, so they never start over) under
  `pg_advisory_xact_lock(hashtext('support:' || office))`, which Next takes too.
- Queue order (queue.ts): tickets that came back from an agent first (they keep `assigned_at`),
  then oldest first. Customers away within the grace time keep their place (and count in "ahead");
  Next skips them.
- In memory per workspace: desks (who, their connection, their ticket, where the desk stood), the
  customer connections here (address, idle since) and those on a ticket (ticket, key hash, name).
  After a restart, active tickets' desks wait for their agents (a ticket whose desk is gone goes back
  to the queue). Closed tickets are re-checked against the database before each update, and the
  ticket chat checks the ticket row itself, so nothing is written into a closed ticket.
- Desks: one per agent; asking from a second tab moves it there. An agent who leaves while not
  serving keeps it 30 s; while serving, `AWAY_GRACE_MS`, then the ticket goes back to the front of
  the queue. Moving or removing a desk in build mode (`onOfficeChange`) frees it the same way.
- A sweep every minute: present customers' `last_seen_at` is refreshed; waiting tickets of customers
  away longer than `AWAY_GRACE_MS` are abandoned, and so are active tickets nobody is serving (after
  a restart, in a workspace nobody came back to); customers here `CUSTOMER_IDLE_MS` (15 min) without
  an open ticket get `office:removed` 'idle'; tickets closed longer than `CHAT_RETENTION_DAYS` ago
  are deleted with their chat (`deleteConversations`). It stops with the server (`onClose`).
- Calls (link.ts, `supportLink` as a link rule set up once per check): customers never with
  customers; a customer always with the agent serving them, wherever they are, and with nobody else;
  a serving agent not with other staff; otherwise the usual rules. Next, resolve, desks and people
  coming and going call `realtime.relink` for the people concerned; resuming the ticket a connection
  already has answers from memory (no lock, update, summon or relink).
- Ticket chat (`registerConversation(ctx, 't', …)`): staff read every ticket; only the agent serving
  it writes; the customer reads and writes while it's open, under the name on the ticket (matched by
  their ticket, so after a reload they still own what they wrote). Customers get no channels, people,
  direct, live or nearby messages, and never get channel messages or mentions.
- Limits (per workspace and address, `addressKey`): `MAX_CUSTOMERS_PER_ADDRESS` (3) customers at once
  (`addJoinCheck`), 30 new tickets an hour (counted before anything waits), 10 open tickets; one open
  ticket per connection; files only in an open ticket, 20 MB per ticket (`uploads.addCheck`); email
  addresses without `? & % # / \` or spaces; token buckets per connection; customers are guests (90 of
  100 places).

## Client (client/src/features/support/)
Plug-ins it uses: `registerLobby`, `registerConvView('t:', …)`, `session.setFullVolume`, a panel
(order 5) for staff and the `chat` panel for customers. Customer lobby (name, email, "How can we help?", device check), the queue overlay with "While you
wait" sights, the summon walk (teleport and sit after `SUMMON_TIMEOUT_MS`, or at once in a background tab; nothing when already seated there, as after a reconnect), the ticket chat, rating;
the staff panel (desks, Next, the active ticket, the queue, history); the queue screen's picture and
desk interactions. Catalog: `support-desk`, `queue-board`, `aquarium`, `info-board`.
