# Handover — 18 August 2026

Branch: `claude/sleeper-draft-sync-owbbur`, ten commits ahead of `origin/main`, deployed to
Railway from the branch and used through a live mock draft. The previous session's work
(eight live sources, six views, the source panel) is merged and is what `main` holds.
Read `CLAUDE.md` first; it holds the traps that will otherwise cost you hours.

## What this branch adds

**The board follows a live Sleeper draft.** Paste a draft link into the **Draft** button
and each pick takes that player off the board within about five seconds, with the pick
number and the team that made it on his row. The panel carries the league, who is on the
clock, how many picks until your turn, and the last twelve picks. Disconnecting puts
everyone back.

**The standalone cheat sheet does the same, with no server.** It talks to Sleeper straight
from the page — `api.sleeper.app` sends `access-control-allow-origin: *` — so one HTML
file on a phone still empties itself as the room drafts:

```bash
node server/scripts/build-cheatsheet.js out.html \
  --draft https://sleeper.app/draft/nfl/<id> --user lexicond [--format BB] [--no-poll]
```

`--no-poll` bakes the picks in and says "snapshot · not updating" rather than pretending
to be live — for viewers that cannot reach Sleeper at all.

**A one-tap route to the pick.** Sleeper's API is read-only, so the pick itself has to be
made in their app. Each available row carries a ↗ that copies the player's name and opens
the draft room; in Sleeper it is a paste and a confirm.

**The app works on a phone**, which is where it is read on draft day. That took more than
a media query — see the layout notes below.

| Piece | What it does |
|---|---|
| `server/scrapers/sleeperDraft.js` | Sleeper's draft API, the sport/season assertions, snake/linear/reversal pick maths |
| `server/routes/draft.js` | connect · state · sync · disconnect · lookup, and the pick store |
| `server/cheatsheet/live.js` | The same sync, in the standalone sheet, talking to Sleeper directly |
| `client/src/hooks/useDraftSync.js` | The poll, and the "only redraw when a pick actually landed" rule |
| `client/src/components/DraftSyncPanel.jsx` | Connect form and the live panel |

## Decisions that are load-bearing

- **A draft id proves nothing.** `/v1/draft/<id>` answers 200 for every draft Sleeper has
  ever hosted, any sport, any season — a 2021 draft returns forty valid picks that would
  mark forty players taken and look entirely plausible. Connecting asserts `sport` and the
  season against `/v1/state/nfl`, and prints the league, scoring, type and size.
- **Live picks and the manual tick are separate columns.** `player_overrides.drafted` is
  what you ticked; `draft_picks` is what the room did. The board shows the union, and
  disconnecting clears only the second.
- **Picks match on Sleeper's player id**, carried on both sides, so the name-matching traps
  do not apply. The name fallback is exact on first name and position, no surname step.
- **Third-round reversal is handled**, because the owner's best-ball league uses it. Under
  a reversal the snake does not turn at the reversal round — that round repeats the
  previous one's order, and every round after alternates. Derived from and checked against
  all 180 picks of his Squid Best Balls draft. Auctions report no pick order at all.
- **Ranks are counted over the whole pool, then the drafted are filtered out.** Both the
  app and the sheet. Filtering earlier makes projection rank, the value score and the
  Sleeper gap drift as the room drafts. The sheet had exactly this bug and it is fixed;
  keep the filter last.

## What is verified, and how

Against the owner's own drafts, not fixtures:

- **180 of 180 picks** in Squid Best Balls landed on the right row, every one matched on
  Sleeper's player id rather than by name.
- **180 of 180 computed slots** agree with what Sleeper recorded — the proof of the
  reversal maths.
- A **2021 draft is refused** by the season guard.
- **Twelve players left the board unassisted** in a browser test driven by a real Sleeper
  poll — the live path end to end, no mock.
- Recovery from connecting **before the draft order exists**: slot comes back on the next
  sync.
- Eight browser suites and five command-line validators pass.

```bash
node server/scripts/validate-draft-sync.js          # season guard, both match paths, undo
SLEEPER_DRAFT_ID=<id> node server/scripts/validate-draft-sync.js   # and a draft of yours
bash tests/browser/run-all.sh                       # needs a server and a built client
```

`validate-draft-sync.js` rewrites the pick tables, so it refuses to run while a draft is
connected — pass `--force` if you mean it.

## Storage on Railway — check this first

At the time of writing the deployed app **had no volume attached**, so its database lived
inside the container and was destroyed on every deploy. Diagnosed from outside: only
`sleeper` and `underdog` had ever been fetched, both stamped within half a second of each
other, which is the boot self-seed — and it only runs when the players table is empty.
Nothing personal had been lost because none had been entered yet, but any prep would have
gone on the next push.

This is the worst shape a failure can take here: the app re-seeds players from Sleeper on
boot, so a wiped database comes back looking healthy with only the irreplaceable part —
your rankings, stars, tiers and notes — missing.

**The fix is one dashboard action**, but not where you would look for it: volumes are
created on the **project canvas** (⌘K → *Volume*, or right-click the canvas), then
attached to the service, and only then does the mount path appear in its settings. The
service's own Settings tab has no volume option, which is where everyone looks first.
`railway volume add` does the same from a terminal. Any mount path works — `db.js` reads
`RAILWAY_VOLUME_MOUNT_PATH`, which Railway sets automatically.

It is no longer silent either way:

- `GET /api/health` reports a `storage` block — `db_path`, `volume_mount`, `persistent`,
  and how many rows carry your own data.
- The header shows an amber **⚠ Not saved** chip whenever storage will not survive.
- The boot log says the same.

`persistent` is true off Railway too, since a laptop keeps its files; it is only the
throwaway container that needs the warning.

## Open work

**1. It has never run a full draft end to end.** It has been connected to a live mock and
watched picks land, and every path is verified against completed drafts, but nobody has
taken a whole draft on it. The pick timer is the one thing entirely unexercised.

**2. Three faults live in code this branch did not write.** Worth fixing before they bite:

- `server/scrapers/fantasycalc.js:73` cross-fills the league types — `v1qb ?? vsf` and the
  reverse. If the `numQbs=2` endpoint fails, every player's 1QB trade value is written into
  `fc_value_sf` and feeds the superflex dynasty consensus, while the source still records
  `ok`. A silent wrong answer, which is the worst kind here.
- `server/scrapers/sleeper.js:105` is the only scraper without a claim guard. Two players
  colliding on normalized name plus position collapse onto one row, and the second
  overwrites the first's `sleeper_player_id`. That now matters more than it did: a wrong
  Sleeper id takes the wrong man off the board mid-draft.
- `client/src/components/PlayerModal.jsx:48` reads `adp_fp_dyn` for its "FantasyPros
  (dynasty)" row, which the server aliases to the superflex column under 2QB — so a
  superflex rank is labelled as the 1QB one. `adp_sl_dyn` is missing from the breakdown
  entirely.

**3. Auctions show no "on the clock"** — there is no pick order to derive. Picks still land
on the board normally.

**4. Only one draft at a time.** `draft_sync` is a single row by design.

**5. The pick still has to be made in Sleeper.** Their API is read-only and says so:
*"you cannot modify contents via this API"*. A `POST` to the picks endpoint returns 404.
Driving their UI with a headless browser would need the owner's credentials, break on any
markup change, and fail at the worst possible moment. The ↗ affordance is the honest
answer. A **draft queue** — a shortlist in your own order, with anyone taken dropping out,
so your pick is decided before your turn arrives — was offered and not taken up; it is the
next thing worth building if the paste step still grates.

**6. Everything the last handover left open is still open**: drag-to-reorder untested,
DynastySuperflex's compressed tail unruled-on, the five validator warnings unchanged,
KeepTradeCut still only checked through Dynasty Daddy's mirror, and no CI.

## The phone layout, and why it is the way it is

The board is read on a handset on draft day, and almost nothing about the desktop layout
survived contact with one.

- The panels are **bottom sheets** below 640px and popovers above it. Anchored right of a
  button near the left edge, a 320px popover opened off the side of the screen entirely.
- **`backdrop-blur` only applies at `sm:` and up.** It establishes a containing block,
  which traps the panels' `fixed` positioning inside the filter bar and let a tall panel
  run off the top of the screen. The bar does not stick on a phone anyway.
- **The filter bar does not stick on a phone** — it held a third of the screen for the
  whole draft. The column header takes over as the sticky one.
- **Consensus sits directly after the name** at that width, and the drag handle and My #
  are dropped. In source order the headline number started around 460px into a 390px
  screen. Nothing is removed from the desktop layout.
- The `.livebar` in the cheat sheet needs its **`[hidden]` guard**: `display:flex` on a
  class outranks the user agent's `[hidden]` rule, and without it the bar shows as an
  empty box wherever the script does not run — which is exactly how a viewer that strips
  JavaScript makes a working page look broken.

`tests/browser/draftsync.js` checks the phone width directly — no sideways scroll, the
headline number on screen, the panel inside the viewport — because that is the width it is
used at and nothing else tests it.

## Before you touch the data

The database in a fresh container is **empty and throwaway**; the real one lives on the
Railway volume. On first boot the app self-seeds from Sleeper and Underdog. For a full
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
cheat sheet after every refresh — it is a point-in-time snapshot, not a live view. Do not
commit a regenerated sheet as part of an unrelated change; it is noise in the diff.

**Restart the server after touching anything under `server/`.** Node caches modules, and
this cost two rounds of "the fix did not work" in this session when it had simply never
been loaded.

## Things the owner cares about

- **Sleeper is where he drafts.** That is why Δ SL exists, why it is measured against
  Sleeper's own board whether or not Sleeper feeds the consensus, and why the live sync is
  Sleeper-only.
- He runs **10-team leagues as well as 12**, and his best ball league is **third-round
  reversal**. A connected draft offers to set the league size for you.
- He rates **FantasyPros, Sleeper, Underdog and KeepTradeCut** above the rest.
- He reads the board **on a phone**. Check anything you build at 390px before calling it
  done.
- He asks for evidence, not assurances. Show the numbers behind a claim, and say plainly
  when something was not checked.
