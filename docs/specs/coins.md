# Feature: coins wallet

Owner's words: "Users can have coins (wallet)".

Virtual coins only — no real money, no purchases with real currency, no cash-out. Signed-in members
only (guests see "Sign in to get a wallet").

## Rules (server-authoritative)
- Every member has one wallet (global across offices). Starting bonus 100 coins on first sign-in.
- Earn: daily check-in +20 (first join of the UTC day; once per user per day, enforced by a unique key),
  presence +5 per 30 minutes actively present in an office (not away/idle; cap 40/day; server timer per
  live player, not client-reported), receiving tips.
- Spend: tip someone in your office (1–500 coins, optional message ≤140 chars; can't tip yourself;
  rate limit 10 tips/minute); "Shout-out": a celebratory confetti burst over the recipient visible to
  everyone (reuses reactions confetti if available, else a simple effect).
- Ledger: coin_ledger(id, user_id, delta int, balance_after int, kind 'welcome'|'daily'|'presence'|
  'tip_in'|'tip_out', counterparty_user_id null, office_id null, note, idempotency_key unique null,
  created_at) and wallets(user_id pk, balance int check (balance >= 0)). All changes in one transaction
  with SELECT … FOR UPDATE on both wallets in a fixed order (deadlock-free); idempotency keys for
  daily/presence/tips (client sends a uuid per tip). Migrations 600+.
- Owners can turn coins off for their office (office setting `coins: boolean`, default on) — when off,
  tipping is hidden there (wallet still exists).

## API / events
GET /api/me/wallet → {balance, recent: ledger[20]}; GET /api/me/wallet/history?before= (paginated);
socket coins:tip {toPlayerId|toUserId, amount, note, key} ack {ok, balance} | {error};
server push coins:balance {balance, delta, kind} to user:<id>; coins:tipped {from, to, amount, note}
to the office (for the celebration + toast to the recipient).

## Client
- Wallet chip in the top bar or dock avatar menu showing the balance with a coin glyph (Hugeicons
  "coins-01"/"wallet-01"); click → Wallet panel: balance (animated count-up on change), "Send coins"
  form (recipient picker = signed-in people in the office, amount stepper with quick amounts 5/10/25/
  50, note), history list (icons per kind, relative time, +/− colours), how to earn.
- From the people panel / clicking a person: "Send coins" action.
- Recipient sees a toast "Ada sent you 25 coins: thanks for the review!" with a coin animation; the
  office sees a small celebration over the recipient.
- Micro-interactions: +20 daily bonus toast on first join of the day; subtle "+5" float when presence
  coins arrive.

## Tests
Server: concurrency (parallel tips from the same wallet can't overdraw; both sides consistent), no
negative balances, idempotency (same key twice = one transfer), daily once per UTC day, presence cap,
self-tip rejected, guests rejected, office coins off, ledger balance_after consistency. Run the
concurrency tests on PGlite and real Postgres. Browser: two signed-in users (dev login), tip, both
balances update live, toast + celebration, history rows.
