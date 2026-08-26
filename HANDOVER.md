# Handover — 24 August 2026

Branch: `claude/fantasy-points-prediction-review-tw9vif`. Read `CLAUDE.md` first; it holds
the traps that will otherwise cost you hours. The previous handover, covering the
expected-points model as it was first built, is below this section and still describes the
architecture accurately.

## Why this branch exists

Two things looked wrong on the board and both turned out to be symptoms rather than
opinions: Christian McCaffrey was RB1 by 23 points at thirty years old, and Brock Bowers
was TE11 at twenty-three. The complaint behind them — that the projection reads like a
description of last season rather than a forecast of this one — was measurable, and true.
Against last season's points per game the model's projections correlated 0.925; Sleeper's,
on the same players, 0.868. It was more anchored on last season than the market-tracking
baseline it is supposed to add something to.

## What changed

**The model now knows how old players are.** It did not. The crosswalk carries an age for
all 456 projected players and no part of the model read it, which is most of the McCaffrey
answer. `server/model/age.js` measures the curve from consecutive-season pairs and splits it
in two, because the decline is not one thing: the larger half is losing the job — a
29-year-old back keeps 81% of his touches — and goes to Module A, and the smaller half is
what he does with what he keeps and goes to Module B. Putting it on volume rather than on
the finished number matters, because the conservation step then sees the touches an ageing
player gives up and hands them to the men actually taking them.

Two properties of that curve are load-bearing and both are documented in `CLAUDE.md`: its
LEVEL is regression to the mean and is divided out, and it is fitted monotone because the
raw cells are thin enough to invent a penalty for being young.

**Four holes in the team budget**, all the same family as the quarterback one already
documented, none of them fixed by it, and together they are the Bowers answer:

1. A draft-capital player contributed nothing to his team's budget unless he was a
   quarterback. Seattle's carry budget came to 160 against a real 455.
2. The scale was solved as `target / total` with those players in the divisor and out of
   the numerator, so it overshot and stayed pinned at the cap.
3. Targets were scaled to the attempts a team was *aimed at* rather than the ones it got.
   Las Vegas finished with 464 targets against 450 attempts.
4. The quarterback-games allocation capped but never filled, so Las Vegas played 14.2
   quarterback games in a seventeen-game season and its whole receiving corps was fed from
   a budget a hundred attempts short.

## What it is worth

Held out, per game, against "repeat last season":

| | before | after |
|---|---|---|
| validator's test season | +0.0414 | **+0.0579** |
| mean over 2023–25 | +0.014 | **+0.022** |
| RB / WR / TE | 0.758 / 0.712 / 0.705 | **0.778 / 0.736 / 0.729** |
| MAE (season totals) | 48.6 | **44.6** |
| agreement with the betting market | 0.85 | **0.887** |

The ageing curve is most of that, and unusually for anything tried on this model it gained
in all three seasons rather than on average.

## What did NOT work, and is recorded so it is not retried

Preserving the model's own team RUSHING spread and correcting only the level — the
obviously symmetric counterpart to what the passing side does — is **worse**. The model's
team carry sum is not a projection of how much a team runs, it is an artefact of how many
of its backs clear the role gate: sd 116–127 against a real 44–56, and less correlated with
reality (0.16–0.29) than the constant it would replace (0.21–0.33). `TUNING.carryBudget`
keeps both settings and the comment says which evidence settled it.

## What is still true and was not fixed

**The model is still just as anchored on last season.** After all of the above the
correlation with last season's points per game is 0.925, essentially unchanged. The ageing
curve made it more accurate without making it more forward-looking, because age is a smooth
function that mostly reorders within a cohort. The remaining anchoring is by design —
`TUNING.recency` is `[0.85, 0.15, 0]`, selected out of sample — plus the plain absence of
offseason information. The model has exactly two forward-looking inputs: Sleeper's depth
chart, and the betting market's implied team totals. It knows nothing about a team change,
a coaching change, a vacated target share, or a contract.

That is the open work, and it is a features problem rather than a modelling one. See
`server/scripts/experiments/README.md`, which tests whether gradient boosting would do
better and finds that its advantage is fitted weights on the same three or four inputs, not
new signal — and that blending it with the structured model beats either alone in all three
seasons.

---

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
touchdowns, and they come in at 20.8 a game against the market's 23.0.

**That yardstick now exists.** VegasInsider publishes season win totals across four books in
server-rendered HTML, so `model/wintotals.js` reads them and the validator checks the model
against them every run — see *The market on whole teams* below.

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

## What the betting market told us

Season-long over/unders are now fetched per player from BettingPros — passing, rushing and
receiving yards, passing, rushing and receiving touchdowns, **and receptions** — scored under
this board's rules into a single `MKT` column beside the model's own. **158 players carry a
line**, joined exactly on `fantasypros_id → sleeper_id` through the crosswalk, with no name
matching anywhere in the path. `server/scrapers/marketprops.js`.

**The first version fetched from the wrong endpoint and lost a whole category.** `/v3/props`
takes `limit=500` and answers in one request, which makes it the obvious choice; it also
answers 200 with an empty list for markets that are perfectly alive on `/v3/offers`.
Receptions returned **0 props and 87 offers**. Reading that empty list as "the books do not
price receptions" took a third of every receiver's half-PPR season out of the column, with
nothing in the response to say so. Everything now comes from `/offers`, which is what
bettingpros.com's own pages use — and whose `limit` maxes out at **10**, so it has to be
paged; asking for more is a 400 that reads like the market being down.

Interceptions (market 303) really is empty on both endpoints. So quarterback totals carry no
interception term and read roughly two dozen points high. That is said on the column rather
than estimated away.

**The documented parsing trap is real and worse than advertised.** The brief warned that the
best `over` and `under` prices are drawn from ~23 books and frequently differ: **74 of 107**
receiving-yards offers had them at different numbers, and George Pickens came back with an
over at 599.5 (−809) against an under at 1050.5 (−110). The consensus is not a field on
`/offers` at all — it is **book id 0**, a pseudo-book alongside the real ones — and it is
two-sided at a single number on 98 of those same 107. That is the only line read, and no
de-vigging is attempted.

**A line is only a median if it is priced like one.** Book 68 alone posted De'Zhaun Stribling
— a rookie receiver — at 74.5 receptions, over at +245 against under at −376: about a 27%
chance of getting there, not an expectation of it. Read as a median it made him a top-20
receiver. Only 3–8% of offers are lopsided like that, so they are rejected rather than
corrected; recovering a median from a one-sided quote needs a distribution the market has not
published, and a guessed number that looks like a market line is worse than none.

**Not every total is the same quantity, and 60 of them say so.** The books price receiving
markets for the pass-catching backs and skip the rest — 22 of 36 running backs had a rushing
line and no receiving line at all — so adding up what is priced gave them a season total
missing a third of their scoring. Jonathan Taylor came out at 203 against the model's 310
almost entirely for that reason. Silence from a book means it saw no liquidity, not that the
player scores zero, so nothing is estimated and nothing is zeroed: `mkt_complete` marks the
row, the board dims it and appends `*`, the cheat sheet shows a dash because a printed page
has nowhere to put the caveat, and the validator compares only complete totals.

**The humbling number.** Across the 98 players carrying a complete market total:

| | rho against the market |
|---|---|
| Sleeper's projections | **0.975** |
| This model | 0.846 |

Both numbers rose sharply when the partial totals were filtered out — from 0.914 and 0.775 —
which is the arbitrage-column lesson again: two rankings can only be compared if they cover
the same categories, and most of the apparent disagreement was the mismatched denominators.

Sleeper still tracks the betting market considerably more closely than this model does. That
is not automatically a fault — the model is meant to be an independent view and an edge
requires disagreeing somewhere — but it is not a result to be pleased about either, and it is
printed by the validator every run rather than buried. The validator fails only below rho 0.6:
a model that has come loose from the market entirely is broken rather than contrarian.

Levels agree to 0.96×, which is the more reassuring half: the model and the market are pricing
the same amount of football, they disagree about who gets it.

## Reading the price, not just the line

The first version of the market column threw away every line that was not priced near even
money — sixteen of them — on the grounds that recovering a median from a one-sided quote needs
a distribution nobody publishes. That was the wrong call twice over: it lost players entirely,
and the distribution *is* published, just not by a sportsbook.

Kyler Murray was posted at 5.5 rushing touchdowns with the over near 28%. That is the market
saying he probably will not get there, not that it expects him to. Every line is now converted
to the median its price implies:

```
median = line × exp(−sigma × Φ⁻¹(1 − p))
```

which is a no-op at even money by construction — no threshold to tune, no cliff between a
"fair" line and a "lopsided" one. Murray's 5.5 becomes 5.0, Stribling's 74.5 receptions falls
out of the top twenty, and ten more players keep a total they were previously refused.

**The check that it works.** Compared against the model's own independent estimate of the same
statistic, the correction changes almost nothing on the 430 offers already priced fairly (mean
error 28.7% → 27.9%) and moves the lopsided ones a long way closer (278% → 197%). Agreement
with the model rose from rho 0.846 to 0.857 and Sleeper's from 0.975 to 0.978 — two independent
yardsticks moving the same way.

**Where sigma comes from: Polymarket.** Its threshold ladders are a survival function per
player-stat, and because it charges on resolution rather than taking vig, price *is*
probability. Fit a lognormal through the rungs and the spread falls out. The measured spreads
order themselves the way anyone who watches football would expect, which is the main reason to
trust them:

| stat | sigma |
|---|---|
| Passing yards | 0.19 |
| Passing TDs | 0.32 |
| Rushing yards | 0.55 |
| Rushing TDs | 0.60 |
| Receiving yards | 0.62 |
| Receiving TDs | 0.76 |

Liquidity is thin — $300 to $10k an event, individual rungs under $50 — so it supplies shape
and nothing else. Its own fitted medians are recorded and never read.

**Where it had to be reined in.** A lognormal fits a touchdown count badly. TD lines are quoted
in half-numbers on a base of about five, so most of the gap between a posted `x.5` and the true
median is the book rounding rather than real displacement. Uncapped, the correction took Calvin
Ridley's receiving touchdowns from 4.5 to 3.1 while every book RotoWire could see still said
4.5. Counts are now capped at half a step; yardage and receptions are not capped.

Adjusted lines are counted in `mkt_adjusted` and named in the tooltip. This is the one place a
distribution assumption enters an otherwise pure market column, so it says so.

## The consensus that contradicted its own books

Ashton Jeanty's rushing-yards consensus came back at 574.5. Eleven of his twelve real books sat
at 974.5–1000.5 — all flagged `is_off` — with one live outlier at 574.5 that the consensus was
echoing. Nothing about the offer looks broken: it parses, it is two-sided, and it is priced
close enough to even money to clear the price band.

RotoWire settled it. Its independent pull had DraftKings **live** at 999.5 priced at evens, so
the consensus was wrong rather than early. The consensus is now checked against the books it
claims to summarise, and where essentially none of them agree the books' median is used in its
place — Jeanty comes back at 975.5 instead of being dropped. Five offers need that.

The validator runs the same check from outside against RotoWire and names the same players,
which is the reason to believe the rule rather than the threshold. It compares **raw consensus
lines**, not what the board stores: the stored number is a price-implied median, and checking
that against posted lines reported every correction as a vendor disagreement.

**RotoWire is deliberately not a board column.** It carries the same six markets from broadly
the same books, so showing it beside `MKT` would put two renderings of one market on the board
and invite them to be read as two opinions.

**Two things the brief promised that are not there.** Circa — "the sharp reference" — publishes
nothing today, and neither do BetMGM, BetRivers, Hard Rock or theScore. Only DraftKings,
Caesars and FanDuel carry lines. And there is no receptions table at all, which is the one
market BettingPros does have.

## The market on whole teams

VegasInsider's win totals close the gap the fixture work left open. All 32 teams, four books
each, server-rendered.

**The books post different lines, so the page cannot be averaged.** Baltimore came back at
o11.5 (+120) from one book and o10.5 (−150) from another. Each quote is converted to the total
it implies before anything is combined — and the two Baltimore numbers then land within 0.01 of
each other, from lines a full win apart. Across all 32 teams the books reconcile to within 0.43
wins.

Summing every team gives **273.3 implied wins against the 272 a season actually hands out**.
Stated honestly: averaging the raw lines sums correctly too, because the price corrections
cancel across the league. What the identity catches is taking the *median* line, which sums to
278. The price adjustment earns its place per team — it moves the Rams by 0.64 wins and eight
teams by more than a third of one.

The model's projected team offence tracks the win market at **rho 0.860**. Read that as a check
on ordering rather than level: the environment layer already scales every projection by the
market's implied points per game. What it has not seen is the win total, which prices defence
and schedule too.

**The two columns are not the same quantity, and that is the point of showing both.** A market
line already discounts the games the books expect a player to miss. The model's number is a
full seventeen on purpose. So the market reads low on anyone the books think is fragile, and
the gap is information rather than an error in either number — the tooltip on `MKT` spells
this out wherever the two differ by more than 15 points.

**The key is borrowed.** It is lifted from BettingPros' own public frontend bundle, is not
issued to us, and may rotate without notice. Every failure path is soft: no key, a 401, a thin
response, and the board simply keeps what it had. Nothing downstream depends on it existing.

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
- **Everyone with a role is projected for 17 games.** Availability turned out to be the
  worst-measured part of the model (rho 0.25 against games actually played), so it is no
  longer forecast: the projection is a full season, PPG is the honest comparison between
  two players, and a *current* injury is read off Sleeper rather than predicted. The
  quarterback allocation is the one exception, and it shares out a job rather than
  forecasting a wound.
- **The simulation is seeded per player, not from `Math.random`.** Two refreshes over
  identical data return identical projections. A column that drifts when nothing changed
  reads as a model that cannot make its mind up, and this is the one column with no second
  source to check it against.

## Open work

**1. Age is only modelled for running backs.** A 36-year-old tight end coming off a good
season still projects on that season. The board rarely carries such players (it is seeded
from Sleeper's active roster) but the model will happily rank one if it does.

**2. The market lines are shown, not used.** Season-long player props are now fetched and
displayed (see the section above), but nothing in the model reads them. Blending them into
the projection needs the availability gap reconciled first — a market line is an expected
value that already discounts missed games and the projection deliberately is not — and doing
that carelessly would turn the projection straight back into something that forecasts
injuries. Touchdown rate remains the noisiest input in the model and the market's TD lines
remain the best available replacement for it, so this is the highest-value thing still
undone.

**2b. All four sources in the brief are now read**, each in the role it is actually good for:
BettingPros for the lines, Polymarket for the distribution shape those lines need to be read
correctly, RotoWire as a second vendor checking the first, VegasInsider for the market on whole
teams. DraftKings' own endpoints are Akamai-blocked and OddsTrader renders client-side; the
brief says do not attempt either, and neither was attempted.

What Polymarket has *not* been used for yet is the best-ball ceiling, which is the other thing
it is good for. The model still invents its own spread there, and a market-implied distribution
per player is a better one — the work is fitting the per-stat ladders into a single fantasy
points distribution, which the stats being correlated makes non-trivial.

**2c. FIXED — a draft-capital starting quarterback collapsed his team's whole receiving corps.**
Found by asking why Brock Bowers — ADP 18, 9.0 targets a game in 2024 — projected 111 points
against Sleeper's 202.

Team targets are scaled to the team's projected pass attempts. Those attempts are summed from
quarterbacks the model actually projects, and a quarterback projected from draft capital is
excluded from every team total. Las Vegas lists Fernando Mendoza first, so he contributes
nothing: LV's budget is built from 305 attempts where a real team throws about 545. Every
Raiders pass-catcher is then scaled down to fit, and the scale clamps at its 0.6 floor. Bowers
is collateral damage from his quarterback being a rookie.

Fixed by doing both of the things that were on the table. Draft-capital projections now run
BEFORE the conservation steps rather than being appended after them, they carry the depth chart,
and a draft-capital quarterback carries an attempt rate for his rank — so he enters the games
allocation and the attempt budget instead of sitting outside both. Las Vegas had been projecting
thirty quarterback games in a seventeen-game season.

Separately, the attempt LEVEL is corrected — but deliberately not the spread. Summing a team's
attempts from the quarterbacks the model projects came to 496 against a real 545, because a
backup takes his share of the games at a backup's rate, and every target is derived from that
total, so every pass-catcher read 9% light.

The first attempt at this replaced each team's attempts with a league constant tilted by game
script. That was wrong and the owner caught it: real teams ranged from 397 to 800 attempts last
season, a standard deviation of 73, and the constant collapsed the model's spread to 24 — about
two thirds of the genuine between-team variation deleted. A team with a poor quarterback really
does throw less, and his receivers really do catch fewer.

What ships instead is a single correction scalar shared by all 32 teams, so it moves the league
onto a realistic scale and by construction cannot reorder anyone. The league lands at 545 with
a spread of 46, and it tests better on held-out data than the constant did (+0.0411 against
+0.0397). Both sides still move together: correcting only the targets put 512 targets against
496 attempts, which is an impossibility rather than a projection.

**What that means for the two players who prompted this.** Bowers projects 172.6 against the
betting market's 178.1 — the model and the books essentially agree, and Sleeper's 202.5 is the
outlier. Jefferson projects 174.4 against the market's 201.9. Both are still below Sleeper, and
that is now a position rather than a bug: the Raiders and Vikings quarterback rooms are priced
in rather than averaged away.

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
