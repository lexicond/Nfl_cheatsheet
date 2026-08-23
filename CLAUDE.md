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

After touching anything under `server/model/`, run
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
- **The expected-points column is never averaged into anything.** It is this board's own
  model; folding it into a market consensus would let the board vote on itself, on top of
  the existing rule that a points projection is not a pick number. `consensus: false`, and
  it is absent from dynasty entirely because a one-season projection cannot speak to a
  keep-forever league.
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
