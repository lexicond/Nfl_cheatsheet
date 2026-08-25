# NFL Draft Cheatsheet — working notes

A personal fantasy football draft board. Express + SQLite serving a React board, plus a
standalone HTML cheat sheet generated from the same data. Read `HANDOVER.md` for current
state and open work.

## The one rule

**Every source here is fetched from a URL that can change meaning without changing
shape.** A page 302s to a different board, a "superflex" feed turns out to be 1QB, a
"dynasty" column is really redraft — and all of them still return valid data with a 200.
Assume nothing renders correct just because it parsed.

Concretely, this has already happened:

- `fantasypros.com/nfl/rankings/best-ball-cheatsheets.php` redirects to the generic
  standard-scoring redraft board and returns valid `ecrData`. So do
  `dynasty-superflex-overall`, `ppr-dynasty-superflex`, `half-ppr-superflex-cheatsheets`
  and others. Every FantasyPros fetch therefore asserts the `type` and `scoring` it
  expects and rejects the response otherwise. **Never add a FantasyPros URL without an
  `expect` block.**
- `superflex-cheatsheets.php` is the STANDARD-scoring board. This app is half-PPR
  throughout; use `half-point-ppr-superflex-cheatsheets.php`.
- Sleeper's `/v1/projections/nfl/{year}/0` still answers 200 with every player object
  empty. The live one is the season endpoint used in `scrapers/sleeper.js`.
- Sleeper keeps historical ADP on unrostered players — Tom Brady still carries one. A
  null `team` is how it marks them, so ADP from a teamless player is discarded.
- **nflverse's `player_stats` release is the archive; `stats_player` is the live one.**
  Both answer 200, both parse, and both carry a file called `stats_player_week_2024.csv`
  — at 6.8MB and 8.5MB respectively, because the archived cut has 114 columns and the
  live one 150. The archive also simply stops: it has no 2025 at all. Pull the wrong tag
  and the model projects a season on data a year out of date, with nothing in the
  response to say so. `server/model/nflverse.js` pins `stats_player` and asserts the
  columns it needs are present.

After touching the draft sync, run `node server/scripts/validate-draft-sync.js` — it
proves the season guard still refuses a stale draft, that picks land on the player they
name, and that an undone pick frees him again.

After touching a scraper, `server/sources.js` or `server/consensus.js`, run
`node server/scripts/validate-sources.js`. It asserts on what the numbers *imply*: a
superflex board must open with quarterbacks, dynasty must skew younger than redraft, best
ball and redraft must differ, and no two inputs to one consensus may correlate above 0.97.

## Architecture

`server/sources.js` is the single description of every ADP/value column — its provider,
which format and league type it may inform, the scoring the publisher actually used, a
plain-English explanation, and its **family**. Consensus sets, the board's columns, the
validator and the cheat sheet all read from it. A column can never be shown under one
format while being averaged into another.

`server/consensus.js` does all averaging. ADP formats average pick numbers; dynasty ranks
each source first because the values are on incompatible scales (KeepTradeCut runs
0–10000, FantasyCalc is a trade value, ECR is a draft position). Both the stored columns
and the per-request board call it, so they cannot drift.

**Families, not columns.** A market's 1QB and Superflex boards share a family, so
switching a source off survives flipping Superflex. Exclusions are always family names.

`server/model/` is the expected-points model — the only column on this board that is
computed here rather than fetched from somebody. It follows the decomposition the
architecture doc asks for, one file per stage:

| File | Stage |
|---|---|
| `nflverse.js` | Layer 0: weekly stats, schedules, and the gsis↔sleeper crosswalk |
| `scoring.js` | The league's scoring, in one place |
| `usage.js` | The per-player, per-season table Modules A and B share |
| `stability.js` | Year-over-year reliability, **measured**, → shrinkage constants |
| `age.js` | The ageing curve, **measured**, split into a volume half and an efficiency half |
| `marketprior.js` | Module D — the betting market's opinion on **share**, never on level |
| `volume.js` | Module A — opportunity |
| `efficiency.js` | Module B — points per opportunity, regressed |
| `environment.js` | Module C — implied team totals from betting lines |
| `combine.js` | E[FP], availability, Monte Carlo, replacement levels |
| `index.js` | Orchestration, rookies, and the tuned hyperparameters |

It reaches the board through `scrapers/expectedpoints.js`, which is a source wrapper
rather than a scraper, and it joins on **Sleeper's player id via the crosswalk** — so
none of the name-matching traps below apply to it.

`server/scrapers/marketprops.js` is its counterweight: the betting market's own season-long
over/unders per player — seven markets, from `/v3/offers` rather than `/v3/props` — scored
under the same rules into one `MKT` column. It joins on `fantasypros_id → sleeper_id` through
the same crosswalk, so it too is free of name matching. It is displayed and sortable, and
deliberately outside every average and outside the model. Only rows whose position has every
scoring category priced (`mkt_complete`) are a season total; the rest are shown dimmed and
compared with nothing.

Three further market sources sit around it, each with one job and none of them a board column:

| File | Role |
|---|---|
| `model/wintotals.js` | VegasInsider season win totals — the market on whole teams |
| `scrapers/polymarket.js` | Threshold ladders → the distribution SHAPE nothing else publishes |
| `scrapers/rotowire.js` | A second vendor on the same books, to check the first |

After touching anything under `server/model/` **or any of the market sources above**, run
`node server/scripts/validate-projections.js`. It backtests the model against a season
it was never given and fails if it does not beat "repeat last season".

One season cannot settle anything at these sample sizes — a Spearman difference below about
0.02 on n≈300 is noise, and several plausible-looking changes have moved it by less than that
in both directions. For a change that is meant to improve the ranking rather than fix a
defect, A/B it across 2023–25 and look for a gain in *every* season, not in the mean.

## Traps worth knowing

- **axios must be ≥ 1.16.1.** Older versions send non-CONNECT requests and the sandbox
  proxy answers 405 on every HTTPS call.
- **DynastyProcess is not KeepTradeCut.** Its values correlate 0.98 with FantasyPros
  dynasty ECR because they are derived from it. It is displayed but deliberately excluded
  from the dynasty average, which already includes FantasyPros. Real KeepTradeCut comes
  from Dynasty Daddy market 0.
- **Dynasty Daddy market codes** (from its own repo, `PlayerInfoRepository.js`):
  0 KeepTradeCut · 1 FantasyCalc · 2 DynastyProcess · 3 DynastySuperflex · 4 KTC redraft ·
  5 FantasyCalc redraft. Its headline `trade_value` is *KeepTradeCut*, so pulling that
  alongside the direct KTC fetch would double-count.
- **Name matching.** The surname fallback requires compatible first names — equal, an
  abbreviation, an initial, or a known nickname — and when a source gives a team the match
  must be on that team. Without this, `Omari Evans` resolved onto `Mike Evans` and
  overwrote his ranking. Scrapers also refuse to write a row twice in one pass.
  `node server/scripts/audit-matching.js` hunts for the damage.
- **FFC ignores its own `teams` parameter** — 10 and 12 return byte-identical data. League
  size is a display setting only.
- **Chrome will not stick a `<td>`**, and a wrapper with horizontal overflow is always a
  scroll container, so a page-level sticky header cannot live inside one. The cheat
  sheet's board scrolls in its own bounded pane for this reason.
- **The Fantasy Footballers publish projections, not a ranking.** Their rankings pages
  render in the browser from `window.udk.data` — the three hosts' stat projections — under
  whichever scoring the reader picked. `scrapers/footballers.js` therefore computes the
  rank itself, from those projections, on *this board's* scoring: half-PPR with four-point
  passing touchdowns. Their own default is **HALF (6pt QB)**, so lifting their on-screen
  order would import a quarterback ranking built for scoring this league does not use.
  One fetch of any position page carries every position. `tiers` in that payload is empty
  for anonymous readers — it belongs to the paid Ultimate Draft Kit, so it is not taken.
- **A positional rank is not an ADP and is never averaged into one.** `ff_pos_rank` is
  displayed and sortable but sits outside the consensus, because averaging "RB4" with a
  pick number would be meaningless. It is registered twice in `sources.js` — once per
  season-long format — aliased onto one column, since a column declares a single format.
- **A draft id proves nothing on its own.** `/v1/draft/<id>` answers 200 for every draft
  Sleeper has ever hosted — any sport, any season. A 2021 draft returns forty valid picks
  that would mark forty players taken on a 2026 board, and it all looks right. So
  `fetchDraft` asserts `sport === 'nfl'` and the season against `/v1/state/nfl`, and the
  panel prints what the draft says it is (league, scoring, type, teams, rounds) so a
  wrong room is obvious before the first pick.
- **Sleeper has no push channel for drafts**, so picks are polled — five seconds in the
  client, with a 2.5s floor on the server so extra tabs cost nothing. The documented
  ceiling is 1000 calls a minute; one draft at this cadence is twelve.
- **Live picks and the manual tick are separate columns.** `player_overrides.drafted` is
  what you ticked; `draft_picks` is what the room did. The board shows the union, and
  disconnecting a draft clears the second without touching the first. Merging them would
  mean a disconnect silently wiping players marked by hand.
- **Picks match on Sleeper's player id**, which both sides carry, so the name-matching
  traps above do not apply — and the name fallback is deliberately exact on first name
  and position, with no surname step. A wrong match here does not mis-rank a player, it
  takes the wrong man off the board mid-draft. Names legitimately differ across an id
  match (Kenneth vs Kenny Gainwell); `validate-draft-sync.js` polices the two paths
  separately for this reason.
- **A naive CSV split silently destroys the model.** nflverse's `headshot_url` is a
  quoted field containing a comma, so `line.split(',')` shifts every column after it by
  one and `targets` starts reading somebody's air yards. Nothing throws; the numbers just
  become confidently wrong. `parseCsv` in `model/nflverse.js` is quote-aware, and the
  required columns are asserted before any of it is believed.
- **`github.com/<org>/<repo>/raw/...` answers 403 through the egress proxy.**
  `raw.githubusercontent.com` works. That is how the DynastyProcess crosswalk is fetched.
- **Judge the model on VOR, never on one pooled ranking by raw points.** At four-point
  passing touchdowns quarterbacks out-score everyone, so ranking every position together
  by raw points mostly measures whether a model reproduces that offset — a question of
  scale, not of ordering. Measured that way this model *loses* to "repeat last season"
  (0.680 vs 0.706) while *beating* it at every single position. That is Simpson's paradox,
  not a result. On value over replacement, which removes the offset by construction and
  is what the board shows, it wins (0.703 vs 0.690). Both numbers are printed by the
  validator; only the meaningful ones are assertions.
- **Superflex LOWERS the replacement quarterback, and that is what makes quarterbacks
  worth more.** When nearly every team starts two, the last startable QB is a far worse
  player, so the bar each QB is measured against drops and value over it rises. Asserting
  it the other way round looks obviously right and is wrong; there is a check for it in
  `validate-projections.js` because the mistake was made.
- **A rookie curve fitted only on rookies who played is fitted on the hits.** The busts
  are exactly the players who never appear in a stats file. `buildRookieCurve` starts from
  the draft and scores a drafted player with no rookie season as zero, and the projection
  is then bounded by the picks the curve was actually fitted on and capped at the 95th
  percentile of what rookies at that position really score. Without both, a pick-three
  back projected above every veteran at his position.
- **Favourites run, underdogs throw.** `mean_spread` is positive for a favourite, so the
  pass lean derived from it is negated. Getting this backwards is invisible in the output
  — it just quietly moves value from the right backfields to the wrong ones.
- **Blending three seasons of usage ranked worse than using the latest one.** This was
  the surprise of the tuning run and it is why `TUNING.recency` is `[0.85, 0.15, 0]`. Roles turn
  over fast enough that a season two years back is mostly noise about this one, and the
  shrinkage step already handles a thin recent sample. Older seasons still feed the
  stability measurement and the FPOE talent prior. Re-run
  `node server/scripts/tune-projections.js` before changing it — it selects on one season
  and validates on a later one it never saw.
- **Shrinkage toward a positional baseline is shrinkage toward a STARTER.** Every rate in
  the model is per game, and the baselines are drawn from players who had a role — 30.4
  pass attempts a game at quarterback. Regress a quarterback who threw two passes toward
  that, multiply by an expected-games figure that pulls a one-game season up to 10.5, and
  he projects about 145 points. Nathan Peterman projected 143 on two career opportunities;
  Philip Rivers, retired since 2020, projected 146. Every quarterback who ever took a snap
  sat on the same floor. `ROLE_GATE` in `model/index.js` refuses the question instead:
  no recent role, no projection, and the board shows a dash.
- **A player must still be on a team.** The role gate alone does not catch a retired
  player — his usage history never expires, so Derek Carr cleared it on 2024 and projected
  207. The crosswalk's current team is required, which also stops the environment layer
  silently falling back to a league baseline for exactly the players it knows least about.
- **A projection must be withdrawn, not just written.** `expectedpoints.js` nulls every
  row it did not project this run. Without that a player the model has stopped believing
  in keeps his last number for ever, and it reads as current because every column beside
  it is. The board reported full coverage of the draftable range on 385 stale rows.
- **Reaching back for an older season needs a discount or it makes things worse.** Letting
  the role anchor use a season the player has not repeated keeps genuinely draftable
  players on the board — Jayden Reed, Tank Dell and Braelon Allen all lost most of last
  season — but at full strength it ranked *below* "repeat last season", because most
  players who lose a role never get it back. At `staleDiscount` 0.55 the trade turns
  positive. Both that and `maxAnchorBack` were selected on one season and validated on
  another.
- **An evaluation pool filtered to healthy players cannot see the model's worst failure.**
  The backtest originally required six games in the season before the test, which excludes
  the bounce-back — a starter two years ago who missed last season and is being drafted on
  the older one. That is exactly where the recency weights decide the answer, so they were
  being chosen without ever being tested on the players they matter most for. The pool now
  takes either of the two prior seasons.
- **Score the model and the benchmark on the same players.** Once the role gate started
  refusing players, the tuner was scoring the model on what it could project and the
  benchmark on the whole pool — crediting the benchmark with a set of easy cases the model
  never saw. That moved the naive number by more than any hyperparameter did.
- **Two rankings can only be subtracted if they rank the same people.** The arbitrage
  column ranked value over replacement across 860 players and the market across 400, so
  the difference was mostly the difference in denominators: median −19, range −672 to
  +324. It is now computed over the players who have both, and only inside the range that
  actually gets drafted — beyond that a deep ADP comes off a single ECR list that keeps
  ordering players long after anyone is picking them, and every "biggest buy" was a player
  both sides agreed to ignore.
- **The crosswalk and nflverse spell nine teams differently.** DynastyProcess says `SFO`,
  `GBP`, `NOS`, `LAR`, `KCC`, `TBB`, `NEP`, `LVR`, `JAC`; the schedule file says `SF`, `GB`,
  `NO`, `LA`, `KC`, `TB`, `NE`, `LV`, `JAX`. The environment lookup simply missed for all of
  them, so 138 of 475 projections — every player on nine teams — silently fell back to a
  league-average scalar while the run still reported all 32 teams priced by the market.
  `normaliseTeam` in `model/nflverse.js` maps them, and the validator now asserts that every
  projection resolved an environment. Fixing it moved agreement with the posted spread from
  rho 0.64 to 0.74.
- **Nothing conserves playing time unless you make it.** Players are projected one at a time,
  which is right for positions that share the field and wrong for quarterback, where one man
  takes every snap. Unconstrained, 66 quarterbacks got 13.2 expected games each across 31
  teams — 871 where 527 exist — and team pass attempts came out 49% high with passing
  touchdowns 40% high, while targets and carries reconciled to within 3%. Games are now
  shared out per team in proportion to each man's strongest recent claim on the job.
- **Allocate the job by his best recent season, not his last one.** Joe Burrow's 2025 was
  eight games, so on last season alone Joe Flacco outranked him and took the larger share of
  Cincinnati. `qbClaimBasis: 'peak'` fixes it, and it also beat `'anchor'` in the backtest.
- **Hedge the allocation; do not bet on a starter.** Giving the strongest claim everything he
  is projected for reconciles the team perfectly and ranked quarterbacks *worse* than doing
  nothing, because who wins a job is not something last season's snap count reliably predicts.
  Sharing games in proportion to claim (`qbClaimPower`) is worth more than being right more
  often about the starter.
- **Three identities must hold and nothing in the model enforces them**: a team's targets
  equal its pass attempts, its receiving yards equal its passing yards, and its receiving
  touchdowns equal its passing touchdowns. Each side is built from different players'
  histories, so they are the sharpest test that the parts fit together —
  `validate-projections.js` asserts all three.
- **Do not forecast injuries; the model projects a full season.** Weighting a player's own
  availability history was the worst thing in this model. Measured, it barely works: model
  games against games actually played came out at rho 0.25 overall and 0.17 for non-QBs,
  while handing out a spread wide enough to dominate the projection (the median receiver
  was on 9.5 games). And most of what looks like durability is role — games played
  correlates 0.58 season to season, but hold role fixed and it falls to 0.28, and among
  established starters missing most of a year costs 1.8 games the next. Everyone with a
  role now gets seventeen games; role lives in the per-game rates.
- **Judge the model on points per game, not season totals.** A season total is rate ×
  games, and games is mostly injury, which the model deliberately declines to predict. So
  a season-total metric grades it largely on a guess it refuses to make, and the naive
  benchmark wins by carrying last season's games for free (0.58 vs 0.67). On the per-game
  rate — the question the board is for — the model wins, +0.017 on the held-out season and
  +0.016 across three. Both are printed; only the rate is asserted.
- **Sleeper conserves team totals and so must this.** Summed over all 31 players a team
  carries, Sleeper's projections come to 543 pass attempts and 454 carries against a real
  team's 545 and 455. They are allocating within a budget, not projecting each player
  independently. Doing it independently gave one team 611 targets against 496 attempts.
- **Cap a backup on TOTAL opportunity, never metric by metric.** A per-metric cap erases
  the thing a committee backfield is made of. Washington runs Jacory Croskey-Merritt and
  gives Rachaad White the passing down; capping targets separately flattened White into a
  generic second-stringer. Capping the sum keeps the mix he has earned and limits only its
  size — the pass-game share now reads 0.12 / 0.27 / 0.38 down the depth chart.
- **A backup's per-game rate is a starter's rate.** It was earned in games he started with
  the man ahead of him hurt. Zach Charbonnet projected 170 points against Sleeper's 62
  until his usage was shrunk toward the baseline for the rank he actually holds.
- **`depth_chart_order` 0 means unranked, not first — but nor is it unknown.** Sleeper uses it
  for players carried on the roster but not placed on the chart. Read as a starter it made
  Chase Edmonds Washington's lead back; read as *no information* it let Raheem Mostert escape
  the backup cap entirely and project 84 points against Sleeper's 10. In practice unranked
  means deep, so it maps to `UNRANKED_DEPTH`. A player with no depth-chart entry at all is
  still genuinely unknown, and that distinction is the whole point of the mapping.
- **The depth allowance has to keep falling past third, not flatten.** `DEPTH_VOLUME` stops at
  three and the lookup used to clamp to it, so a WR7 was handed a WR3's workload — Dont'e
  Thornton and Noah Brown projected 43 and 34 points against Sleeper's 3.7 and 7.3. Those
  phantom targets go into the team's total, and the conservation step then scales every
  receiver on that team down to fit the budget, so the error made by the fringe players is
  paid for by the starter. Fixing both leaks moved agreement with Sleeper from rho 0.82 to
  0.88 and the held-out backtest edge from +0.017 to +0.021.
- **A current injury is a fact, not a forecast.** IR, PUP, Sus and DNR mean he is not
  playing and get no projection; Questionable and Doubtful are week-to-week noise and are
  ignored. Charbonnet sat high on the board while on PUP with a repaired ACL.
- **The backtest must be handed the depth chart or it tests a different model.** Role,
  availability and the quarterback split all hang off it, and without it the validator was
  quietly grading a code path the board does not run.
- **The Odds API has no season-long player props and no team win totals** — checked with a
  live key, not assumed. It exposes `americanfootball_nfl` (per-game) and
  `americanfootball_nfl_super_bowl_winner` only. What it does have is a line on all 272
  games where nflverse's schedule file carried 112, which took Module C from 41% coverage
  to 100%. The key is optional and the model falls back to nflverse without it.
- **The expected-points column is never averaged into anything.** It is this board's own
  model; folding it into a market consensus would let the board vote on itself, on top of
  the existing rule that a points projection is not a pick number. `consensus: false`, and
  it is absent from dynasty entirely because a one-season projection cannot speak to a
  keep-forever league.
- **BettingPros' `/v3/props` answers 200 with an EMPTY LIST for markets that are alive on
  `/v3/offers`.** `/props` is the obvious endpoint — one request, `limit=500` — and it is the
  wrong one. Receptions (market 330) returned 0 props and 87 offers. Read as "the books do not
  price receptions", that cost every receiver a third of his half-PPR season, and nothing in
  the response said so: valid JSON, 200, an empty array. `/offers` is what bettingpros.com's
  own pages are built on, it carries two more players on receiving yards as well, and it is
  what `scrapers/marketprops.js` uses for all seven markets. **Its `limit` maxes out at 10**
  and it must be paged — asking for more is a 400, which reads like the market being down.
  Interceptions (303) genuinely is empty on both, so quarterback totals carry no interception
  term and read about two dozen points high; that is stated on the column, not estimated away.
- **On `/offers` the consensus is book id 0, not a `consensus_line` field.** That field does
  not exist there. Each selection carries a list of books and book 0 is BettingPros' own
  consensus pseudo-book, with the real books beside it. Reading a real book instead picks one
  operator's shading at random.
- **BettingPros' best-price `over` and `under` are usually DIFFERENT LINES.** They are best
  prices across ~23 books, not two sides of one market: 74 of 107 receiving-yards offers had
  them at different numbers, and George Pickens came back with an over at 599.5 (−809) against
  an under at 1050.5 (−110). De-vigging that pair produces a confident number that is simply
  wrong. The consensus book is two-sided at one number (98 of those same 107 agree), so it is
  the only line read and no de-vigging happens at all.
- **A line is only a median if it is priced like one, so the price is used and not just the
  line.** Kyler Murray came back at 5.5 rushing touchdowns with the over near 28%; De'Zhaun
  Stribling, a rookie receiver, at 74.5 receptions on +245 against −376. Read as medians those
  are nonsense. Every line is converted to the median it implies —
  `median = line × exp(−sigma × Φ⁻¹(1−p))` — which is a no-op at even money by construction,
  so there is no threshold to tune and no cliff between a "fair" line and a "lopsided" one.
  Checked against the model's independent estimate of the same statistic, it changes almost
  nothing on the 430 already-fair offers (28.7% → 27.9% mean error) and moves the lopsided
  ones a long way closer (278% → 197%). Only quotes past `PRICE_BAND` from even money are
  still refused, where the fit would be extrapolating into a tail.
- **The spread that conversion needs is the one thing no sportsbook publishes, and Polymarket
  does.** Its threshold ladders are a survival function per player-stat — price *is*
  probability there, since it charges on resolution rather than taking vig — so a lognormal
  fitted through the rungs gives sigma straight from a market. The measured spreads order
  themselves the way anyone who watches football would expect, which is the main reason to
  believe them: passing yards 0.19, passing TDs 0.32, rushing yards 0.55, rushing TDs 0.60,
  receiving yards 0.62, receiving TDs 0.76. Liquidity is thin ($300–$10k an event, rungs under
  $50), so it is used for shape only and its own fitted median is recorded but never read.
  Ladders are non-monotonic often enough that monotonicity has to be imposed before fitting.
- **A lognormal fits a touchdown count badly, and left uncapped the correction ran away with
  it.** TD lines are quoted in half-numbers on a base of about five, so most of the distance
  between a posted `x.5` and the true median is the book rounding, not displacement. Uncapped,
  Calvin Ridley's receiving touchdowns went from 4.5 to 3.1 while every book RotoWire could
  see still said 4.5. The shift on a count is capped at half a step; yardage and receptions
  are effectively continuous and are not capped.
- **The consensus pseudo-book can contradict every book behind it.** Ashton Jeanty's rushing
  yards showed a consensus of 574.5 while eleven of his twelve real books sat at 974.5–1000.5,
  all flagged `is_off`, with one lone live outlier at 574.5 that the consensus was echoing.
  Nothing about the offer looks broken — it parses, it is two-sided, and it is priced close
  enough to even money to clear the band. So the consensus is also checked against the books it
  claims to summarise (`MIN_BOOK_SUPPORT`), and where essentially none of them agree the books'
  median is used instead. RotoWire, fetched independently in the validator, names the same
  players from outside, which is the reason to believe the rule rather than the threshold.
- **The books do not price every category for every player, so the totals are not all the same
  quantity.** Receiving markets exist for the pass-catching backs and not the rest — 22 of 36
  running backs had a rushing line and no receiving line at all — and adding up what is priced
  gave them a season total missing a third of their scoring. Jonathan Taylor came out at 203
  against the model's 310 almost entirely for that reason. Silence from the books means they
  saw no liquidity, not that the player scores zero, so missing terms are neither estimated
  nor treated as zero: `mkt_complete` marks the row, the board dims it and appends `*`, the
  cheat sheet shows a dash because a printed page has nowhere to put the caveat, and the
  validator compares only complete totals. Filtering to them moved model-vs-market agreement
  from rho 0.775 to 0.846 and Sleeper's from 0.914 to 0.975 — most of the apparent
  disagreement was the mismatched denominators, exactly as the arbitrage-column trap predicted.
- **The backup cap was designed on running backs and must not be aimed at receivers.** "You
  cannot take a starter's touches while another man is listed ahead of you" is true of a
  backfield and false of a receiving corps — a base offence plays two receivers and a slot at
  once. Applied from rank two it pinned George Pickens, Tee Higgins, Jameson Williams and
  Davante Adams at 3.2 targets a game, a fourth receiver's workload, and cost draftable
  receivers 17% against Sleeper. `SIMULTANEOUS_STARTERS` now says how many a position plays at
  once and the cap starts beyond that. Raising WR to 3 was tried and is worse than 2 — the
  third receiver really is capped in practice — so the number is empirical, not anatomical.
- **Shrinking a second receiver toward the FIRST receiver's baseline makes things worse, not
  better.** It looks like the natural companion to the cap fix and it is not: inflating every
  WR2 and WR3 pushes the team over its target budget, the conservation step scales everyone
  back to fit, and the alpha pays for it — Justin Jefferson fell from 173 to 143. The rank's
  own baseline stays the shrink target; only the hard cap moved.
- **Every touchdown a quarterback throws is caught by somebody, and nothing made that true.**
  The model produced 811 passing touchdowns against 742 receiving ones, so 69 of its own
  thrown touchdowns landed on nobody. Passing touchdowns are the side to trust — 811 against
  a real 811, and 4.66% per attempt against a real 4.65% — so the receiving side is now
  reconciled to them per team. It is applied on top of the receiving scale rather than folded
  into it, because yards and receptions are constrained by targets while touchdowns are
  constrained by the throw: two budgets that happen to sit on the same players.
- **A draft-capital quarterback needs ALL his budget rates, not just attempts.** Giving him
  attempts alone left Las Vegas throwing 442 times for ONE touchdown — 0.22% per attempt
  against a league 4.65% — and the receiving-touchdown reconciliation above then cut every
  Raiders receiver by 30% to match a passing game that scored nothing. Brock Bowers paid for
  it twice over. Attempts, passing yards and passing touchdowns all come from the rank
  allowance and league rates; his own projection still comes from the rookie curve.
- **Sleeper is not ground truth and reads high.** Its league totals come to 11,640 receptions,
  129,683 receiving yards and 833 receiving touchdowns; the last two real seasons produced
  11,130-11,563, 121,678-126,476 and about 801. On yardage this model's total is the closest
  of the three.A gap against Sleeper is therefore not evidence of a fault on its own — check the
  number against nflverse before chasing it.
- **Correct the attempt LEVEL, never the spread — teams do not all throw the same.** Attempts
  summed from whichever quarterbacks have usage history came to 496 a team against a real 545,
  because backups take their share of the games at a backup's rate. Every target is derived
  from that total, so every pass-catcher read about 9% light. But that shortfall is an
  artefact of the games split and says nothing about any particular team, so only the level is
  corrected — one scalar shared by all 32, which by construction cannot reorder them.
  Replacing each team's attempts with `LEAGUE_PASS_ATTEMPTS × (1 + lean)` was tried and is
  wrong: real teams ranged 397–800 last season (sd 73) and the constant collapsed the model's
  spread to sd 24. A team with a poor quarterback throws less and his receivers catch fewer —
  that is signal the model had and the constant deleted. It also tests worse on held-out data
  (+0.0397 against +0.0411). The level-only correction lands the league at 545 with sd 46.
- **Both sides of the attempt correction must move together.** Correcting only the targets put
  512 targets against 496 attempts, which is not a projection but an impossibility: every
  attempt is at most one target. Scaling the passing side too restores the identity at 0.94.
- **`components.basis` marks a player projected from draft capital, and it is NOT the same as
  `is_rookie`.** Quinn Ewers and Cam Miller are in their second year with no NFL usage, so they
  take the draft-capital path while `is_rookie` is false. The ledger filtered on `is_rookie`,
  let them into the team totals, and put Miami on 43 quarterback games in a seventeen-game
  season. Everything that aggregates by team must filter on `basis`, as `validate-projections`
  does. Note also what that means for the model: quarterback-games conservation covers
  quarterbacks with usage behind them, and a draft-capital quarterback sits outside the budget.
- **`runModel`'s `depthChart` is Sleeper's map, keyed by sleeper id** — `sleeper_id -> {order,
  team, injury}`, exactly as `scrapers/expectedpoints.js` builds it. Handing it nflverse's depth
  chart instead is not a near-enough substitute: it is the wrong shape, every lookup misses
  silently, and the model quietly runs as though no depth chart existed at all.
- **`node server/scripts/build-ledger.js` regenerates the Projection Ledger artifact.** The page
  is `server/ledger/template.html`; only `window.__DATA__` varies. It was originally written
  around a pasted blob, which meant it went stale the moment the model changed with no way to
  tell. It is not part of a refresh — it runs the model a second time and scrapes a page, and
  nothing on the board depends on its output.
- **VegasInsider's four books post DIFFERENT win-total lines, so the page cannot be
  averaged.** Baltimore came back at o11.5 (+120) from one book and o10.5 (−150) from another.
  Each quote is converted to the total it implies before anything is combined, and the two
  Baltimore numbers then land within 0.01 of each other from lines a full win apart. Summing
  all 32 gives 273.3 against the 272 a season hands out — but note honestly that averaging the
  raw lines sums correctly too, because the price corrections cancel across the league; what
  the identity really catches is taking the MEDIAN line, which sums to 278. The price
  adjustment earns its place per team, not in aggregate: it moves the Rams by 0.64 wins.
- **Only the over is published on win totals**, so there is no second side to de-vig against
  and a standard two-way overround is assumed instead. It is worth about a tenth of a win and
  is applied identically to every team, so it cannot reorder them.
- **RotoWire's team, position and player id are not to be trusted** — the brief's Lamar Jackson
  row came back a cornerback with a null team, and rows here really do disagree with the board.
  Nothing is read from them: the join is an exact normalised name against players the board
  already has, and a name matching more than one player is skipped rather than guessed.
- **Circa is documented as the sharp reference and is currently absent**, along with BetMGM,
  BetRivers, Hard Rock and theScore — all five return null on every RotoWire row. Only
  DraftKings, Caesars and FanDuel carry lines today. Worth knowing before building anything on
  "prefer Circa when present".
- **RotoWire is deliberately not a board column.** It carries the same six markets from broadly
  the same books, so publishing it beside `MKT` would put two renderings of one market on the
  board and invite them to be read as two opinions. It runs in the validator instead, where it
  independently catches the consensus coming adrift from the market — which is what settled
  that Jeanty's 574.5 was wrong rather than early.
- **The vendor cross-check compares RAW consensus lines, not what the board stores.** The
  stored number is the median a line's price implies, which is deliberately a different
  quantity from a posted line; checking it against RotoWire's posted lines reported every price
  correction as a vendor disagreement and put the failure rate at 9.9% of nonsense instead of
  8.5% of signal.
- **`mkt_books` is the THINNEST of a player's lines, not the widest.** A total whose receiving
  yards eight books agree on but whose receptions come from one is only as good as that one.
  Taking the max read as broad agreement on players who had none.
- **The BettingPros key is borrowed from their public frontend bundle, not issued to us**, and
  may rotate without notice. Every failure path in `marketprops.js` is soft and the board
  keeps what it had; `BETTINGPROS_KEY` overrides it without a deploy. Nothing downstream may
  depend on it existing.
- **A market line and a projection are not the same quantity.** The line already discounts the
  games the books expect a player to miss; the model's number is a full seventeen on purpose,
  because it refuses to forecast injuries. So `mkt_points` reads low on anyone thought
  fragile, and the gap is information. It is shown beside the projection and never blended
  into it — blending would need the availability gap reconciled first, and doing it carelessly
  turns the projection back into an injury forecast.
- **Sleeper tracks the betting market at rho 0.98; this model at 0.85** (on complete totals;
  0.91 and 0.77 before that filter). Both are printed by
  `validate-projections.js` every run rather than buried. The model is meant to be independent
  and an edge requires disagreeing somewhere, so this is not asserted as a failure — but the
  validator does fail below rho 0.6, because a model that has come loose from the market
  entirely is broken rather than contrarian.
- **A new column `kind` has to be added to the descending-sort set in two places** —
  `sortSpec` in `routes/players.js` and `sortRows` in `cheatsheet/board.js`. ADP and ranks
  count up from the best pick; trade values, projections and betting lines count down from it.
  Reading it the wrong way round does not error, it silently puts the worst player at the top
  of the board. `xfp_points` sorted ascending on the cheat sheet for exactly this reason.
- **The stored picks are made to equal Sleeper's, not merely appended to.** A
  commissioner can undo a pick, and a player left marked taken never returns to the board
  on his own.
- **A draft-capital player must contribute to his team's budget at EVERY position, not just
  quarterback.** The rule "a draft-capital quarterback needs all his budget rates" was fixed
  for quarterbacks and left unfixed everywhere else, and the hole is the same shape: a
  drafted running back listed first contributed no carries, so his team's remaining backs
  were scaled up to fill a gap that was not there. Seattle's carry budget came to 160
  against a real 455 because Jadarian Price is its listed starter and simply was not in it;
  the rush scale pinned at the 1.40 cap and Emanuel Wilson, a third-string back, projected
  99 points on carries that belong to Price. Arizona, Tennessee and the Jets had the same
  hole. Every draft-capital player now carries the depth allowance for his listed rank, with
  receiving yards and receiving touchdowns derived from it at league rates for the same
  reason the passing ones are.
- **A conservation scale must be solved on the part it can actually move.** Draft-capital
  players are counted into the team totals but never scaled — their points come from the
  rookie curve, not from those rates. So the scale is `(target − fixed) / (total − fixed)`,
  not `target / total`; with a rookie starter in the divisor but out of the numerator the
  latter overshoots, and Seattle stayed pinned at the cap even after Price began
  contributing.
- **Targets are scaled to the attempts a team ACTUALLY gets, never to the ones it was aimed
  at.** The two are identical only while the pass scale is unclamped. Las Vegas, whose
  attempts are almost entirely one rookie quarterback's and therefore unmovable, sat at the
  1.40 cap and finished with 464 targets against 450 attempts — a ratio of 1.03 where every
  attempt is at most one target. The validator checks the MEDIAN team ratio, so it read a
  clean 0.94 while a real team on the board was broken.
- **The quarterback-games allocation caps but must also FILL.** It only ever took games
  away, so a team whose starter begins below his entitled share never got them back: the
  rookie block hands a draft-capital starter a flat 13.0 games, Las Vegas came to 14.2
  quarterback games in a seventeen-game season and threw 450 times against a real 545, and
  because every target is derived from those attempts its whole receiving corps was fed from
  a budget a hundred attempts short. Brock Bowers read about 9% light for that alone. Filling
  is applied only to a draft-capital starter — never to a veteran who simply projects for
  fewer games than his share, since nothing there knows better than he does.
- **Preserving the model's own team RUSHING spread is worse than replacing it with a
  constant, and this is the opposite of the passing lesson.** It looks like the obviously
  symmetric fix and it is not, because the premise does not hold: the model's team carry sum
  is not a projection of how much a team runs, it is an artefact of how many of its backs
  clear the role gate. Measured against what teams actually did, the team's own spread comes
  out at sd 116–127 against a real 44–56 and correlates 0.16–0.29 with reality, where the
  constant gives sd 35–62 at 0.21–0.33. It is wider AND less correlated — preserving it
  preserves noise. The backtest cannot separate the two at all (+0.0130 against +0.0128), so
  this one is settled on calibration, not on the backtest. `TUNING.carryBudget` keeps both.
- **Nothing knew how old anybody was.** The crosswalk carries an age for all 456 projected
  players and no part of the model read it, which is most of why a thirty-year-old back
  coming off a good season projected like a twenty-five-year-old. `model/age.js` measures the
  curve from consecutive-season pairs and splits it in two, because the decline is not one
  thing: the larger half is losing the job (a 29-year-old back keeps 81% of his touches) and
  goes to Module A, the smaller half is what he does with what he keeps and goes to Module B.
  Putting it on volume rather than on the finished number matters — the conservation step then
  SEES the touches an ageing player gives up and hands them to the men actually taking them.
  Worth +0.007 Spearman on the held-out season and, unusually for anything tried here, it
  gained in all three seasons rather than on average.
- **The LEVEL of a measured age curve is regression to the mean and must be divided out.**
  The median next-season ratio is below 1 at every age, including 22 — a 21-24 running back
  comes out at 0.93. That is not decline, it is that pairs are selected on holding a role in
  both seasons and a season good enough to notice tends to be followed by a worse one. The
  shrinkage step already handles it; applying it again would quietly shave every player on
  the board. Only the DIFFERENCE between ages is used, normalised so the average player is
  exactly 1.0.
- **The betting market is an INPUT to share and never to level, and the two must not be
  confused.** A line already discounts the games the books expect a man to miss; the model's
  number is a full seventeen on purpose. Blending them raw drags every covered player down
  by that difference — and the covered players are the high-volume ones, so the conservation
  step then scales the whole team back up and hands the difference to the fringe players
  nobody prices. `marketprior.js` de-biases the market to the model's own level per
  component first (measured at 1.04–1.11 on the live board), so what is left is a statement
  about share alone.
- **Module D runs BEFORE conservation, and the order is the design.** The market moves a
  player relative to his team-mates; conservation then puts his team back on its budget, so
  the net effect is a transfer of share. Run it afterwards and three priced players drag a
  whole team's volume around — which would be fatal, because per-team market aggregates do
  not survive inspection: Cleveland's priced receivers are quoted for 133% of its priced
  passing yards and Miami's for 27%, since only three to seven players a team carry lines
  and which three is arbitrary.
- **The market prior is the one thing here that NO backtest can vouch for.** BettingPros
  publishes the coming season only; there is no archive of what the books thought in August
  2023. The backtest is untouched (the market is absent from it by construction) and stays
  at +0.058 on the held-out season, so a green validator says nothing about this change.
  What is provable is that it is share-neutral: team totals do not move (562 attempts, 537
  targets, 458 carries before and after) and all three identities still hold.
  `TUNING.marketWeight` turns it off.
- **Importing the market did NOT collapse the model into Sleeper, which was the fear.**
  Sleeper tracks the market at 0.970, so pulling toward the market looks like pulling toward
  Sleeper. Measured across weights 0 → 0.7, agreement with Sleeper moves 0.906 → 0.909 while
  agreement with the market moves 0.884 → 0.913. The blend touches 132 players and only
  their share within a team, which is not where Sleeper and this model mostly differ.
- **`mkt_books` is a minimum across all SEVEN markets, and Module D blends ONE component at
  a time.** A receiver whose receiving lines eight books agree on but whose rushing-touchdown
  line comes from one is recorded at 1, so the part that is well supported is barely moved.
  `BOOKS_FOR_FULL_WEIGHT` is set to 3 rather than 5 to blunt this; the clean fix is for
  `marketprops.js` to store a book count per component.
- **A head-coaching change does NOT predictably shift the pass/run mix — this was measured,
  because it is widely believed.** Over 320 team-seasons a team's pass rate swings more year
  to year (sd 6pp) than teams differ from each other (5.2pp), so the instinct that it is a
  real, sizeable effect is right. Attributing it to the coach is not: teams keeping their
  coach moved 3.48pp and teams changing moved 3.54pp. An incoming coach's rate at his
  previous stop predicts his new team's at r=0.088 against r=0.368 for simply carrying the
  team forward — on n=12, so suggestive rather than settled, and note nflverse carries the
  HEAD COACH while the play caller is often the coordinator, whom it does not carry at all.
  It does not change what to build either way: perfect foreknowledge of team volume is worth
  +0.005 (see below).
- **The error is in WHO gets the touches, not in how much a team plays.** Hand the model
  perfect team volume and it gains +0.005 Spearman; hand it perfect within-team share and it
  gains +0.15. On opportunity the log-error standard deviations are 0.08 against 0.89. Team
  volume barely varies — real teams ran 366–547 times in 2025 around a mean of 455 — and the
  implied totals plus the conservation constants already land inside 8%. Any scheme, pace or
  personnel feature aims at the stage that is not broken.
- **Edge measures the model against BEHAVIOUR, which is why the market can be an input to
  the projection without eating the column.** A draft board is not a forecast: over the
  players carrying both, the market's own season totals correlate just 0.486 with consensus
  ADP. Edge now ranks against Sleeper's ADP for the active format — the room actually being
  drafted in — but be honest about what that switch is worth: Sleeper ADP and the consensus
  correlate 0.983, so it is the right object rather than a different answer.
- **An age curve has to be fitted monotone or the thin cells invent penalties for being
  young.** Raw, tight ends came out at 0.95 for a 22-year-old against 1.08 for a 24-year-old
  on eight players, which put Harold Fannin below men four years older. Monotone
  non-increasing is the one thing actually known about ageing in advance, so the measured
  cells are fitted with pool-adjacent-violators rather than believed one at a time. It also
  tested better (+0.0221 against +0.0207).

## Conventions

- Comments explain *why*, especially where a line guards against one of the traps above.
  Do not add comments that restate the code.
- Prefer fixing the data model over special-casing a symptom.
- A clean build proves nothing — load the page. A component prop referenced from a
  standalone function type-checks fine and blanks the whole app.
- Do not commit `draft.db`; it is git-ignored. In this container it is throwaway, and the
  real one lives on the Railway volume.
