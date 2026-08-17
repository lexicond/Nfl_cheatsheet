# Handover — 17 August 2026

Branch: `claude/nfl-charger-refresh-bugs-2n2v7s`, seven commits ahead of `main`.
**Nothing has been merged and no pull request is open.** Read `CLAUDE.md` first — it holds
the traps that will otherwise cost you hours.

## Where this got to

The app started the session pointed at endpoints that had all moved. Every data source is
now live against 2026 data, each format averages only sources that publish that format,
and both the app and the standalone cheat sheet let you see and change which sources feed
the board.

Eight sources, all green:

| Source | Provides |
|---|---|
| Underdog (via DraftSharks) | Best-ball ADP, ½PPR 12-team |
| FantasyPros | ECR for best ball, ½PPR redraft, ½PPR superflex, dynasty, dynasty superflex; also bye weeks |
| Fantasy Football Calculator | Mock-draft ADP, ½PPR and 2QB |
| Sleeper | Roster, season projections, and its own ADP for ½PPR / 2QB / dynasty / dynasty-SF |
| ESPN + Yahoo (via DraftSharks) | Home-league platform ADP |
| Dynasty Daddy | KeepTradeCut and DynastySuperflex values, plus player ages and cross-platform ids |
| FantasyCalc | Dynasty trade values, 1QB and superflex |
| DynastyProcess | Dynasty values and ages — displayed, never averaged (see `CLAUDE.md`) |

Six views (Best Ball / Redraft / Dynasty × 1QB / Superflex), each with its own consensus,
a Sources panel with per-source explanations and toggles, sorting by any live source,
league size 8–14, and three derived columns: **Rd**, **Δ SL** (cheaper or dearer on
Sleeper than the consensus) and **Split** (how far apart the chosen sources are).

Default sources on: **FantasyPros, Sleeper, Underdog, KeepTradeCut** — the owner's call.
Everything else ships off, one tick away.

## What remains

**1. Nothing is deployed or merged.** This is the biggest gap. The branch has never run on
Railway. Boot adds roughly a dozen columns via `addColumnIfMissing` in `server/db.js`;
that migration has only been exercised locally, though it is idempotent and additive. The
owner has not asked for a PR — ask before opening one.

**2. Drag-to-reorder is untested.** Typing a rank into the "My #" cell is covered by
`tests/browser/workflows.js`; dragging the ⠿ handle is not, because it is awkward to drive
headlessly. The reorder endpoint itself is tested. Worth a manual pass.

**3. DynastySuperflex's tail is compressed and the owner has not ruled on it.** Its values
collapse — median 149 against KeepTradeCut's 2,193 for the same players, and single digits
by the 75th percentile, so 204 players sit under 100 while KTC has them above 500. Ranking
before averaging means the scale does no harm, but its *ordering* outside roughly the top
150 is close to noise. It is currently off by default, so this only matters if it gets
switched on. Three options were put to the owner and not chosen between: leave it, cap its
influence to where it has resolution, or drop it from the average and keep it as a column.

**4. Five validator warnings, all judgement calls, none defects.**
- FFC's 2QB board is standard-scoring; no half-PPR 2QB is published anywhere.
- Best ball 1QB rests on two sources correlating at 0.98 — Underdog and FantasyPros are
  the only public best-ball markets, so there is no third to add.
- Two dynasty pairs correlate ~0.98 (FantasyCalc against Sleeper dynasty ADP). Expected
  for dynasty; not evidence of double-counting.
- Josh Allen at 30 sits inside the dynasty superflex top 10. Correct, not a fault.

**5. Δ SL in best ball is a corrected proxy.** Sleeper publishes no best-ball board, so the
baseline is its ½PPR redraft ADP. That carried a standing positional offset — quarterbacks
at a median +13, tight ends at −9 — so each position's median is now subtracted and the
tooltip names the offset removed. Redraft and dynasty compare against a true Sleeper board
and need no correction. If a genuine best-ball Sleeper ADP ever appears, remove the
correction rather than layering on it.

**6. KeepTradeCut was never validated directly.** Its own site is client-rendered; the
values come through Dynasty Daddy's mirror and were sanity-checked against it, not against
keeptradecut.com.

**7. No CI.** Tests are the four Node scripts and seven browser suites in `tests/`, all run
by hand. See `tests/README.md`. Browser suites need Playwright installed separately and do
not reset state — clear overrides first or they fail on leftovers.

## Before you touch the data

The database in a fresh container is **empty and throwaway**; the real one lives on the
Railway volume. On first boot the app self-seeds from Sleeper and Underdog. To get a full
board:

```bash
npm install && npm --prefix client install
node server/scripts/refresh-all.js        # all eight sources, ~6 seconds
node server/scripts/validate-sources.js   # confirm each format is what it claims
node server/scripts/audit-matching.js     # confirm names matched cleanly
node server/scripts/build-cheatsheet.js   # regenerate cheatsheets/draft-room-2026.html
```

ADP moves daily through August, so refresh before trusting anything and regenerate the
cheat sheet after every refresh — it is a point-in-time snapshot, not a live view.

## Things the owner cares about

- **Sleeper is where he drafts.** That is why Δ SL exists and why it is measured against
  Sleeper's own board whether or not Sleeper feeds the consensus.
- He runs **10-team leagues as well as 12**, hence the league-size control.
- He rates **FantasyPros, Sleeper, Underdog and KeepTradeCut** above the rest.
- He asks for evidence, not assurances. Show the numbers behind a claim, and say plainly
  when something was not checked.
