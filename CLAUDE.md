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

## Conventions

- Comments explain *why*, especially where a line guards against one of the traps above.
  Do not add comments that restate the code.
- Prefer fixing the data model over special-casing a symptom.
- A clean build proves nothing — load the page. A component prop referenced from a
  standalone function type-checks fine and blanks the whole app.
- Do not commit `draft.db`; it is git-ignored. In this container it is throwaway, and the
  real one lives on the Railway volume.
