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

After touching anything under `server/model/` **or `scrapers/marketprops.js`**, run
`node server/scripts/validate-projections.js`. It backtests the model against a season
it was never given and fails if it does not beat "repeat last season".

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
  the surprise of the tuning run and it is why `TUNING.recency` is `[1, 0, 0]`. Roles turn
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
- **`depth_chart_order` 0 means unranked, not first.** Sleeper uses it for players carried
  on the roster but not placed on the chart. Read as a starter it made Chase Edmonds
  Washington's lead back.
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
- **A line is only a median if it is priced like one.** Book 68 alone posted De'Zhaun
  Stribling — a rookie receiver — at 74.5 receptions, over at +245 against under at −376. That
  is the market giving him about a 27% chance of getting there, not expecting him to; read as
  a median it made him a top-20 receiver. Measured across all seven markets only 3–8% of
  offers are lopsided like that (the median offer sits within 0.03 of even money), so
  `PRICE_BAND` rejects them rather than correcting them: recovering a median from a one-sided
  quote needs an assumed distribution the market has not published, and a guessed number that
  looks like a market line is worse than no number.
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

## Conventions

- Comments explain *why*, especially where a line guards against one of the traps above.
  Do not add comments that restate the code.
- Prefer fixing the data model over special-casing a symptom.
- A clean build proves nothing — load the page. A component prop referenced from a
  standalone function type-checks fine and blanks the whole app.
- Do not commit `draft.db`; it is git-ignored. In this container it is throwaway, and the
  real one lives on the Railway volume.
