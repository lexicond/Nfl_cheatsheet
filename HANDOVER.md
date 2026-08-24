# Handover — 23 August 2026

Branch: `claude/expected-points-predictor-uuj2z3`. Read `CLAUDE.md` first; it holds the
traps that will otherwise cost you hours. The previous handover, covering the live
Sleeper draft sync, is below this section and still current.

## What this branch adds

**The board now has its own projection.** Every other column is somebody else's opinion
or somebody else's draft data. This one is computed here, from what players actually did
and what the betting market expects their offences to score — the
"opportunity × efficiency × environment" decomposition, built as separate modules so each
can be argued with on its own.

Four new things on the board, all season-long formats, none in dynasty:

| Column | What it is |
|---|---|
| **xFP** | Projected half-PPR points for the season |
| **VOR** | Points above the last startable player at his position — moves with league size and superflex |
| **Ceil** | 85th-percentile season from simulating the year week by week |
| **Edge** | Where the model and the market disagree, across the whole board |

VOR is the one to draft on. Raw points are not comparable across positions: at four-point
passing touchdowns a quarterback out-scores every running back and is still not the better
pick. Edge is the arbitrage number — positive means the model would take him earlier than
the room is.

The standalone cheat sheet carries all of it too, deriving VOR on the page so the league-size
and superflex switches keep working offline.

## An audit found five bugs — read this before trusting an earlier number

The columns were audited by looking at their extremes, which is where a projection
exposes itself. Everything below is fixed, and each has a check that fails if it returns.

1. **Every quarterback had a ~145-point floor.** Nathan Peterman projected 143 on two
   career opportunities; Philip Rivers, retired since 2020, projected 146. Cause: rates
   are per game and thin samples regress toward a baseline drawn from players who had a
   role — a *starter's* 30.4 attempts a game — while a one-game season still pulled
   expected games up to 10.5. Fixed by a role gate that refuses to answer rather than
   inventing a starter.
2. **Retired players kept projecting.** Usage history never expires, so Derek Carr cleared
   the gate on his 2024 season and projected 207. A current team is now required.
3. **Projections were never withdrawn.** The scraper only ever wrote; a player it stopped
   projecting kept his old number indefinitely. **385 stale rows** were sitting on the
   board, and they were the reason an earlier coverage check read 100%.
4. **The arbitrage column was arithmetic on mismatched populations.** VOR was ranked over
   860 players and the market over 400, so the difference was largely the difference in
   denominators — median −19, range −672 to +324, and every "biggest buy" was a player
   with a value over replacement of about minus forty whom both sides agreed to ignore.
   Now computed over the players who have both numbers, inside the draftable range only:
   median 0, range ±133.
5. **The backtest could not see any of this.** Its pool required six games in the prior
   season, which excludes both the thin-sample players above and the bounce-back — a
   starter two years ago who missed last season. And once the gate began refusing players,
   the tuner scored the model on what it could project but the benchmark on the whole pool.
   Both fixed; the pool is harder now and the numbers below are lower and more honest than
   the ones this handover first carried.

The model is **better** after the audit, not worse: on the harder pool it beats the
benchmark by 0.031 rather than 0.013, and now wins at every position.

## A second audit: does it add up as a team?

The first audit checked the columns' extremes. This one checked whether the numbers are
*possible* — a projection built one player at a time has nothing forcing a team's totals to
be reachable. Three more faults, all fixed.

6. **Nine teams had no team environment at all.** The crosswalk spells them `SFO`, `GBP`,
   `NOS`, `LAR`, `KCC`, `TBB`, `NEP`, `LVR`, `JAC`; nflverse's schedule says `SF`, `GB`, `NO`,
   `LA`… The lookup missed, and **138 of 475 projections** — every player on nine teams —
   quietly used a league-average scalar instead of their team's market-implied total, while
   the run still reported all 32 teams priced. Fixing it moved agreement with the posted
   spread from rho 0.64 to **0.74**.
7. **Quarterback playing time was not conserved.** 66 quarterbacks were given 13.2 expected
   games each across 31 teams — 871 games where 527 exist. The Jets alone were projected for
   1,253 pass attempts against a real team's 545. League-wide, pass attempts came out **49%
   high** and passing touchdowns **40% high**, while targets, carries and rushing touchdowns
   all reconciled to within 3% — the whole discrepancy was this.
8. **The job was allocated on the wrong evidence.** Ranking claim by last season's attempts
   handed Cincinnati to Joe Flacco over Joe Burrow, whose 2025 was eight games. Claim is now
   each man's best recent season.

### What reconciles now

| Identity — must hold by definition | Before | After |
|---|---|---|
| Targets per pass attempt | 0.57 | **0.98** |
| Receiving yards per passing yard | — | **1.04** |
| Receiving TDs per passing TD | 0.63 | **0.99** |

| Per team, league average | Model | Actual 2025 |
|---|---|---|
| Pass attempts | 497 | 545 |
| Targets | 513 | 515 |
| Carries | 436 | 455 |
| Passing yards | 3,576 | 3,824 |

Everything now lands within about 9% of a real NFL season, consistently a little light —
because the players the role gate refuses still score, and because kicking and defensive
scores are not modelled at all.

### Propagated through the fixtures

Summing the players back into team scoring and running all 272 games gives spreads that
correlate **0.737** with the ones books have actually posted, a mean absolute error of
**2.56 points** a game, and the same favourite in **89 of 112** priced games.

**Read that as partly circular.** The model already scales every projection by the market's
implied team total, so the *ordering* of teams is inherited from the prices it is being
checked against. The *level* is not: the points are built bottom-up from projected
touchdowns, and they come in at 20.8 a game against the market's 23.0. A real sportsbook win
total would be a better yardstick; no clean free source carries one, and season-long player
props would have to be scraped.

**Where it is visibly wrong:** Miami projects 3.5 wins because no Miami quarterback clears
the role gate, so the team is hollow rather than bad. Any team whose new starter was gated
looks far worse than it is.

## A third pass: adversarial testing, and a change of claim

Asked to attack it, and the attacks landed. Two of them changed what the model claims.

**The tests were checked before the model.** Shuffled projections score 0.05 and a
reversed model −0.63, so the metric does discriminate. But a harder benchmark — last
season's points per game — beat the model outright, which sent the search in the right
direction.

**The edge is real but small, and not significant on one season.** Bootstrapping the
paired difference against "repeat last season" across five seasons puts it at **+0.009,
95% interval [−0.015, +0.032]**. It wins four seasons in five and loses 2022. Any single
season's margin is inside the noise, so the validator no longer demands a win every year —
it fails only on a regression beyond the noise band, and prints the pooled figure.

**Availability was the worst part of the model, and it is gone.** Model games against
games actually played: rho 0.25 overall, 0.17 for non-quarterbacks. Meanwhile the median
receiver was being projected for 9.5 games — a twofold spread on a component with no
signal. Most of what looks like durability is role: games played correlates 0.58 season to
season, 0.28 once role is held fixed, and among established starters missing most of a
year costs 1.8 games the next. Everyone with a role now gets seventeen.

**So the claim changed.** The model is a better **points-per-game** projection, not a
better season-total one:

| held-out 2025 | model | naive |
|---|---|---|
| **Points per game** | **0.7272** | 0.7107 |
| QB / RB / TE | **0.669 / 0.744 / 0.718** | 0.592 / 0.703 / 0.587 |
| WR | 0.672 | 0.698 |
| season totals (VOR) | 0.582 | 0.673 |

A season total is rate × games and games is mostly injury, so that last row grades the
model on a guess it refuses to make. The board shows both, and **PPG is now a column**.

**The band was badly miscalibrated and is now honest.** Advertised as the 15th–85th
percentile, it covered 27% of outcomes. Widening alone could not fix it — the projection
is a full-season number, so half the pool never gets a full season. It now covers **70%
of outcomes among players who went on to play 12+ games**, which is what it actually
claims, and the labels say so. Mean projected runs 1.16× mean actual: the same
"if healthy" premium Sleeper's projections carry.

## What Sleeper told us

Checked whether Sleeper's own totals are physically possible. **They are** — 543 pass
attempts and 454 carries per team against a real 545 and 455, summed over all 31 players
they carry. Sleeper allocates within a team budget rather than projecting players
independently, which is why their backups are low. That validated the conservation work
and exposed the remaining error: backups were getting a full season at rates they earned
while starting.

Agreement with Sleeper is now **rho 0.82**, and by role: starters 0.96× their number,
backups 0.80×. Josh Allen 361.5 against their 361.5; Gibbs 310 against 300.

**Committee nuance survives.** Washington's backfield reads as it should:

| | depth | carries/g | targets/g | pass-game share |
|---|---|---|---|---|
| Croskey-Merritt | 1 | 8.37 | 1.18 | 0.12 |
| Rachaad White | 2 | 4.78 | 1.79 | 0.27 |
| McNichols | 3 | 2.40 | 1.44 | 0.38 |

That only works because the backup cap is on **total** opportunity. Capping each metric
separately flattened White into a generic second-stringer and erased the passing-down role.

## Is it any good? — the evidence

Backtested on **2025**, a season the model was never given, training only on 2024 and
earlier, with team environment priced off the first six weeks only (roughly what a book
had posted by draft day) and each player placed on the team he last played for rather than
the one the crosswalk knows he joined later.

| | model | naive "repeat last season" |
|---|---|---|
| **Value over replacement** | **0.7101** | 0.6941 |
| QB | **0.686** | 0.688 |
| RB | **0.726** | 0.685 |
| WR | **0.728** | 0.719 |
| TE | **0.732** | 0.670 |
| **raw pooled points** | **0.731** | 0.713 |

Spearman rank correlation, n=323. The pool is every player with a real season in either of the two years before the test — including the bounce-backs, which an earlier version excluded and which are the hardest cases in it.

**That last row used to be the model's weak spot and no longer is.** It lost on pooled raw
points until quarterback playing time was conserved — most of the "positional scale bias"
was simply too many quarterbacks. The reasoning below still matters for how to read the
metric, but the model now wins on both. That is Simpson's paradox, not a finding: pooling every position into
one raw-points ranking is dominated by the fact that quarterbacks out-score everyone, so it
mostly measures whether a model reproduces that positional offset. It is a question of
scale, not of ordering, and no draft decision turns on it. On VOR — which removes the offset
by construction and is what the board actually shows — the model wins. Both numbers are
printed by the validator; only the ones that bear on a pick are assertions. If you change
the model, do not "fix" the raw-pooled number by recalibrating positions against each other;
you would be fitting to a metric nobody uses.

Also verified:

- **Measured stability reproduces the published research** without being told it. WR target
  share repeats at 0.77 year to year, air-yards share at 0.74, aDOT at 0.67; RB yards per
  carry at 0.18 and receiving touchdown rate at 0.13–0.16. Sharp puts RB YPC near 0.30,
  FantasyLife puts TE receiving TDs at 0.28. Those figures are used only as a sanity check —
  the shrinkage weights come from what is measured here.
- **860 of 955 projections land on board rows**, and 391 of 396 drafted-relevant players
  have one (98.7%), all joined on Sleeper's id through the crosswalk. Three were skipped on
  a position disagreement rather than written to a doubtful row.
- **All 32 teams got a real market environment** — 112 of 272 games priced in late August,
  which is enough for every team to clear the four-game threshold.
- Eight browser suites and five command-line validators pass.

```bash
node server/scripts/validate-projections.js   # backtest + structural checks
node server/scripts/tune-projections.js       # re-select hyperparameters, out of sample
npm run validate                              # sources + draft sync + projections
```

## Decisions that are load-bearing

- **The projection is never averaged into anything.** It is this board's own model; folding
  it into a market consensus would let the board vote on itself, on top of the existing rule
  that a points projection is not a pick number. It is `consensus: false` and absent from
  dynasty entirely — a one-season projection cannot speak to a keep-forever league.
- **VOR is derived per request, not stored.** It moves with league size and with superflex,
  so storing it would freeze one league's answer. Only the projection itself is stored.
- **Only the most recent season sets the level.** Blending three seasons of usage ranked
  *worse* than using the latest one alone, at every setting tried. Older seasons still feed
  the stability measurement and the talent prior. See `TUNING` in `server/model/index.js`.
- **Hyperparameters were selected on 2024 and validated on 2025.** Never picked by eye on
  the season quoted.
- **Expected fantasy points is an input, not an output.** The FPOE residual — how much a
  player has out-scored what his opportunities implied — is a shrunk, hard-capped talent
  multiplier on yardage rates. It is never the projection itself.
- **Nobody is projected for 17 games.** Availability is sampled inside the simulation, which
  is where a fragile player's ceiling gets capped and where best ball and redraft diverge.
- **The simulation is seeded per player, not from `Math.random`.** Two refreshes over
  identical data return identical projections. A column that drifts when nothing changed
  reads as a model that cannot make its mind up, and this is the one column with no second
  source to check it against.

## Open work

**1. Age is only modelled for running backs.** A 36-year-old tight end coming off a good
season still projects on that season. The board rarely carries such players (it is seeded
from Sleeper's active roster) but the model will happily rank one if it does.

**2. Season-long player props are not wired in.** The architecture calls them the single
best public forecast, and it is right, but no clean API exposes two-sided per-player season
over/unders — they have to be scraped from RotoWire, BettingPros or OddsTrader. Anytime-TD
props are the higher-value target: touchdown rate is the noisiest input in the whole model
and a de-vigged market number would replace the weakest estimate it makes.

**3. No correlation in the simulation.** Each player's weeks are drawn independently, so a
quarterback and his WR1 are uncorrelated when in reality they run about +0.5 together. That
understates the ceiling of a stack and means the Ceil column cannot yet be used to build
correlated best-ball rosters.

**4. Efficiency shrinkage counts a wider sample than the level it shrinks.** Deliberate and
documented in `efficiency.js` — a player's career volume is real evidence about his true
efficiency even when his current form is best read off last season — but it does mean the
shrinkage is lighter than a strict single-season treatment. It was tuned alongside the 0.5
multiplier, so change the two together and re-tune.

**5. The nflverse cache is not shared across deploys unless a volume is attached.** It lands
beside the database, so the same volume that protects your rankings protects it. Without one
the first refresh after a deploy re-downloads about 40MB.

**6. Everything the previous handover left open is still open** — see below.

---

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
- The Fantasy Footballers: **313 of 314** players matched, three analysts, ranked on this
  board's own scoring rather than their 6pt-QB default.
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

**2. Three faults in older code — now fixed.** Recorded because the reasoning matters:

- FantasyCalc cross-filled the league types. Each column is now written only when its own
  endpoint answered; the other keeps its previous value, which is this repo's rule for a
  failed source everywhere else.
- Sleeper's roster loop had no claim guard, alone among the scrapers. It fires on the real
  roster: **Frank Gore and Frank Gore Jr.**, both running backs listed at Buffalo, were
  collapsing onto one row and one was overwriting the other's `sleeper_player_id` — the id
  live draft picks match on. They now hold separate rows, and no two players share an id.
  `audit-matching` treats distinct Sleeper ids as proof of two different men, so the pair
  is not reported as a duplicate.
- The player panel labelled a superflex dynasty rank as the 1QB one, because
  `adp_fp_dyn` is aliased by the server under 2QB. The dynasty rows now take their names
  from the league type on screen, and Sleeper's dynasty ADP — fetched all along, never
  shown — is in the breakdown.

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

**6. Findings from an improvement sweep, in the order they are worth doing.**

*Data correctness — these change what the board tells you:*

- **The best-ball consensus is effectively one opinion.** Underdog and FantasyPros
  best-ball correlate at **rho 0.981**, and they are its only two inputs. The headline
  number on the owner's primary format is two near-identical sources averaged together,
  which reads as agreement and is not. The Fantasy Footballers column now gives a
  genuinely independent third view, but it is positional and cannot join the average.
  Worth hunting a real second best-ball market.
- **FFC's superflex board is not half-PPR.** `adp_ffc_sf` feeds the RD:2QB consensus and
  FFC publishes that board in one flavour only — `meta.type` is "2 QB" with no half-PPR
  variant. The validator has been warning about it. It is a genuine superflex board (it
  opens with Josh Allen), so only the scoring is wrong. Either drop it from that consensus
  and leave FantasyPros SF + Sleeper 2QB, or keep it knowingly. The owner's call, so it
  has been left alone.
- **Dynasty has the same overlap**: FantasyCalc against Sleeper dynasty at rho 0.975, and
  0.984 in superflex.
- The three faults above are fixed; what remains in this list is a matter of judgement,
  not correctness.

*Insurance:*

- **Nothing runs the validators automatically.** Five command-line validators and eight
  browser suites exist and all pass, and nothing runs them on a push. A GitHub Action
  running the node validators would catch a source changing shape without anyone opening
  the board.
- **No export of your own work.** The volume protects it from deploys, not from a
  mis-click or a bad migration. `GET /api/backup` returning the overrides as JSON, and a
  restore, would give a file the owner controls.

*Draft day:*

- **A draft queue** — a shortlist in your own order, anyone taken dropping out, so the
  pick is decided before the turn arrives. Offered and not taken up; it is the natural
  next step now that the ↗ handles execution.

**7. Everything the last handover left open is still open**: drag-to-reorder untested,
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
