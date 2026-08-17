# Handover — 17 August 2026

Branch: `claude/sleeper-draft-sync-owbbur`, one commit ahead of `main`. The previous
session's work (eight live sources, six views, the source panel) is **merged** — it came
in through PR #6 and is what `main` now holds. Read `CLAUDE.md` first; it holds the traps
that will otherwise cost you hours.

## Where this got to

This session added **live Sleeper draft sync**: point the board at the draft you are
sitting in and players leave it as they are taken.

Paste the draft's Sleeper link into the **Draft** button in the top bar. From then on the
app polls Sleeper every five seconds and each pick takes that player off the board, with
the pick number and the team that made it shown on his row. The panel carries who is on
the clock, how many picks until your turn, and the last twelve picks. Disconnecting puts
every one of them back.

Built on Sleeper's public draft API (`/v1/draft/<id>`, `/v1/draft/<id>/picks`,
`/v1/league/<id>/users`, `/v1/user/<name>/drafts/nfl/<season>`) — no auth, no key. There
is no push channel, so it polls; five seconds a client, floored at 2.5s on the server, is
twelve calls a minute against a documented ceiling of a thousand.

The parts worth knowing about:

| Piece | What it does |
|---|---|
| `server/scrapers/sleeperDraft.js` | The API client, the sport/season assertions, and the snake/linear pick maths |
| `server/routes/draft.js` | connect · state · sync · disconnect · lookup, and the pick store |
| `client/src/hooks/useDraftSync.js` | The poll, and the "only redraw when a pick actually landed" rule |
| `client/src/components/DraftSyncPanel.jsx` | Connect form and the live panel |

Three decisions that are load-bearing:

- **A draft id proves nothing.** `/v1/draft/<id>` answers 200 for every draft Sleeper has
  ever hosted, any sport, any season — a 2021 draft returns forty valid picks that would
  mark forty players taken and look entirely plausible. Connecting therefore asserts
  `sport === 'nfl'` and the season against `/v1/state/nfl`, and prints the league, scoring,
  type and size so a wrong room is obvious before the first pick.
- **Live picks and the manual tick are separate columns.** `player_overrides.drafted` is
  what you ticked; `draft_picks` is what the room did. The board shows the union, and
  disconnecting clears only the second. Merging them would mean a disconnect wiping
  players you had marked by hand.
- **Picks match on Sleeper's player id**, carried on both sides, so none of the
  name-matching traps apply. The name fallback is exact on first name and position with no
  surname step, because a wrong match here takes the wrong man off the board mid-draft.

## What remains

**1. It has never run against a *drafting* room.** It is verified against the owner's own
completed Squid Best Balls draft — 180 of 180 picks matched onto the board, and the
computed pick order agrees with every slot Sleeper recorded — plus a second real public
draft. What only a live room exercises is `status: 'drafting'` rather than `complete`, the
on-the-clock readout advancing, and the pick timer. Worth a mock draft on Sleeper before
draft day. `SLEEPER_DRAFT_ID=<id> node server/scripts/validate-draft-sync.js` checks a
draft of your own without going near the UI, and holds the computed pick order against
every pick actually recorded.

**2. Auctions show no "on the clock"** — there is no pick order to derive. Picks still
land on the board normally. Snake, linear and third-round reversal are all handled:
the owner's best-ball league runs 3RR, so the reversal maths is derived from and checked
against its full 180 picks.

**3. Only one draft at a time.** `draft_sync` is a single row by design. Following two
boards at once would need that relaxed and the picks scoped per draft on read.

**4. The standalone cheat sheet has no sync**, and cannot — it is a static file with no
server behind it. Use the app on draft day.

**5. Deployment is unverified from here.** `main` holds the merged source work but nobody
has confirmed Railway picked it up, and this branch has certainly never run there. Boot
adds the two new tables via `CREATE TABLE IF NOT EXISTS`, which is additive and safe on
the existing volume, but it is untested against the real database.

**6. Everything the last handover left open is still open**, except that the branch is now
merged: drag-to-reorder is still untested, DynastySuperflex's compressed tail still has no
ruling, the five validator warnings are unchanged, KeepTradeCut is still only checked
through Dynasty Daddy's mirror, and there is still no CI.

## Before you touch the data

The database in a fresh container is **empty and throwaway**; the real one lives on the
Railway volume. On first boot the app self-seeds from Sleeper and Underdog. To get a full
board:

```bash
npm install && npm --prefix client install
node server/scripts/refresh-all.js         # all eight sources, ~6 seconds
node server/scripts/validate-sources.js    # confirm each format is what it claims
node server/scripts/validate-draft-sync.js # confirm the draft sync still holds
node server/scripts/audit-matching.js      # confirm names matched cleanly
node server/scripts/build-cheatsheet.js    # regenerate cheatsheets/draft-room-2026.html
```

ADP moves daily through August, so refresh before trusting anything and regenerate the
cheat sheet after every refresh — it is a point-in-time snapshot, not a live view.

## Things the owner cares about

- **Sleeper is where he drafts.** That is why Δ SL exists, why it is measured against
  Sleeper's own board whether or not Sleeper feeds the consensus, and why the live sync
  is Sleeper-only.
- He runs **10-team leagues as well as 12**, hence the league-size control. A connected
  draft offers to set it for you.
- He rates **FantasyPros, Sleeper, Underdog and KeepTradeCut** above the rest.
- He asks for evidence, not assurances. Show the numbers behind a claim, and say plainly
  when something was not checked.
