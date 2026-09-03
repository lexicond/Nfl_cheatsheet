# NFL Draft Cheatsheet

A personal best ball fantasy football draft board with multi-source ADP, drag-and-drop ranking, notes, and tier management.

**Stack:** Node.js + Express · React + Tailwind · SQLite (better-sqlite3) · Vite · Railway

> Picking this up mid-stream? Read **[HANDOVER.md](HANDOVER.md)** for current state and open
> work, and **[CLAUDE.md](CLAUDE.md)** for the traps in the data sources.

---

## Local Development

### Prerequisites
- Node.js 18+

### Setup

```bash
# Install all dependencies (root + client)
npm install
npm run install:all

# Start dev server (Express on :3000, Vite on :5173 with proxy)
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) for the frontend with hot reload.

On first run, the server automatically fetches player data from Sleeper. If that fails, it seeds 30 hardcoded players so the UI is never blank.

---

## Railway Deployment

### 1. Connect repo to Railway
- Create a new project → **Deploy from GitHub repo**
- Railway auto-detects `railway.json` and runs `npm run build` then `npm start`

### 2. Add a Volume (critical — persists your SQLite DB)

Volumes are created on the **project canvas**, not in the service's Settings tab — which
is the first place everyone looks, and they are not there.

- Close the service panel to get back to the canvas
- Press **⌘K** and search *Volume*, or **right-click the canvas**
- Choose the service to attach it to
- Set the mount path to **`/data`**

Or from a terminal: `railway volume add`, then `railway volume list` to confirm.

The mount path is not fixed — `db.js` reads `RAILWAY_VOLUME_MOUNT_PATH`, which Railway
sets automatically, so any path works. `/data` keeps it clear of `/app`, where Railway
puts the code. Volumes mount when the container starts rather than at build, so the
service redeploys when you attach one.

This keeps your rankings, notes, tiers and overrides across deploys and sleep cycles.

**Without a volume the database lives inside the container and is destroyed on every
deploy**, and the failure is silent: the app re-seeds players from Sleeper on boot, so the
board comes back looking perfectly healthy with every ranking, star, tier and note gone.

Check which you have:

```bash
curl -s https://<your-app>.up.railway.app/api/health | python3 -m json.tool | head -12
```

```jsonc
"storage": {
  "db_path": "/data/draft.db",
  "volume_mount": "/data",
  "persistent": true,        // false means the next deploy wipes it
  "rows_with_your_data": 42
}
```

The app says the same thing itself: an amber **⚠ Not saved** chip appears in the header
whenever it is running on storage that will not survive, and the boot log carries the same
warning. Both disappear once a volume is attached.

### 3. Environment variables (optional)
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `RAILWAY_VOLUME_MOUNT_PATH` | auto-set | Set to `/data` in production |

Railway sets `RAILWAY_VOLUME_MOUNT_PATH` automatically when you attach a volume.

---

## Refreshing Data Sources

### Via the UI
Click the **↻** button next to any source in the top-right refresh panel, or **Refresh All** to update every source in turn.

### Via the API
```bash
# Refresh one source: sleeper | fantasypros | underdog | ffc | market | ktc | fantasycalc
curl -X POST http://localhost:3000/api/refresh/underdog

# Refresh all (runs sequentially — Sleeper first, since it owns the roster rows)
curl -X POST http://localhost:3000/api/refresh/all

# Check source status and data health
curl http://localhost:3000/api/source-status
curl http://localhost:3000/api/health
```

### From the command line
```bash
node server/scripts/refresh-all.js      # every source, then rebuild derived columns
node server/scripts/health-check.js     # freshness, coverage, ranking consistency
node server/scripts/health-check.js --repair
```

### Importing an expert round-up

`server/data/expert-board-2026.json` is a hand-compiled round-up of what analysts are
saying — a `targets` list, a `fades` list, and a `contested` list for the players they
genuinely disagree about. Applying it stars the targets, flags the fades, and writes the
verdict, the cost, who is saying it and the reasoning into each player's Upside and
Downside notes:

```bash
node server/scripts/apply-expert-board.js --dry-run   # what it would touch
node server/scripts/apply-expert-board.js
```

It is idempotent and deliberately narrow: it never clears a star or flag you set, never
touches your rank, tier, drafted mark or Personal Notes, and refuses to overwrite a note
it did not itself write (`--overwrite` says otherwise). It matches on name and position —
the board is the authority on which team a player is on, so a round-up naming last week's
team is reported rather than believed.

Run it wherever the database lives. On Railway that means `railway run node
server/scripts/apply-expert-board.js`, because the board's data is on the volume there,
not in the repo.

---

## The printable cheat sheet

```bash
node server/scripts/refresh-all.js
node server/scripts/build-cheatsheet.js   # → cheatsheets/draft-room-<year>.html
```

One self-contained HTML file — no server, no network — so it opens on a phone in a
draft room with no signal. It carries every format and league type, and three views:

- **Scarcity map** — every ranked player on a shared pick axis, so you can see where
  each position's supply thins out, with the two widest drop-offs marked.
- **Board** — grouped by the round the pick actually falls in, with each contributing
  source shown next to the consensus.
- **Tiers** — FantasyPros' own tiers off the overall board for the format on screen,
  split by position, so a Tier 4 back and a Tier 4 receiver are the same rung. Numbering
  is overall, so a column starts wherever its best player lands and can skip numbers;
  anyone FantasyPros has not tiered is listed last.

Plus the players whose projected positional rank disagrees most with what they cost.

### Sources

| Source | What it provides | Where it comes from |
|---|---|---|
| **Underdog** | Best ball ADP (½PPR, 12-team) | DraftSharks' Underdog board — Underdog publishes no public API |
| **FantasyPros** | Expert consensus rankings: best ball, ½PPR redraft, ½PPR superflex, dynasty, dynasty superflex. Also bye weeks and expert tiers | `ecrData` payload embedded in each rankings page |
| **FFC** | Real mock-draft ADP, ½PPR and 2QB | Fantasy Football Calculator public JSON API |
| **Sleeper** | Player roster, season projections, and Sleeper's own ADP for ½PPR / 2QB / dynasty / dynasty-SF | `api.sleeper.app` projections endpoint |
| **ESPN + Yahoo** (`market`) | Home-league platform ADP | DraftSharks' ESPN and Yahoo boards |
| **Dynasty Daddy** | KeepTradeCut and DynastySuperflex values, 1QB and superflex; player ages and cross-platform ids | `dynasty-daddy.com/api/v1/player` — markets 0 and 3 |
| **FantasyCalc** | Dynasty trade values, 1QB and superflex | FantasyCalc public API |
| **DynastyProcess** | Dynasty values and player ages. Displayed but **not** averaged — see below | DynastyProcess daily CSV |
| **The Fantasy Footballers** | Andy, Jason and Mike's statistical projections, averaged and ranked within each position. Displayed but **not** averaged — a positional rank is not a pick number | `window.udk.data` embedded in their free positional rankings pages |
| **Expected Points** (`expectedpoints`) | This board's own projection — expected points, value over replacement, and a simulated ceiling. Displayed but **not** averaged | Computed here from nflverse usage and betting-market team totals — see below |
| **Market line** (`marketprops`) | The betting market's own season-long over/unders per player — passing, rushing and receiving yards and touchdowns — added up under this board's scoring. Displayed but **not** averaged, and not fed into the model either | BettingPros season props, consensus line across ~23 books |

If a source fails, existing data for that source is preserved — only a successful fetch updates the values.

### The expected-points model

Every other column above is somebody else's number. This one is worked out here, and it
is the only column with no publisher behind it to check it against — so it is built to be
argued with rather than believed.

It projects each player's half-PPR season from three things kept deliberately separate:

- **Opportunity** — targets, carries and pass attempts per game, from the last three
  seasons of nflverse play-by-play, lightly regressed because roles repeat well.
- **Efficiency** — yards per target, per carry, touchdown rates, regressed *hard* toward
  positional baselines because they mostly do not repeat. How hard is not guessed: the
  year-over-year reliability of every metric is measured from the data itself and turned
  into an empirical-Bayes shrinkage weight.
- **Team environment** — each team's implied points per game, from betting lines on the
  coming season (`total / 2 ± spread / 2`). A team priced for 27 points a game is a better
  place to score than one priced for 18.

The season is then simulated week by week, including the games a player is likely to miss,
which gives the floor, the ceiling, and a best-ball score that counts only his best weeks.

**Four columns come out of it**, on best-ball and redraft boards only — a one-season
projection has nothing to say about a keep-forever league:

| Column | Meaning |
|---|---|
| **xFP** | Projected half-PPR points |
| **VOR** | Points above the last startable player at his position. **This is the one to draft on** — raw points are not comparable across positions |
| **Ceil** | 85th-percentile season |
| **Edge** | How far the model and the market disagree, in draft places; positive means it would draft him earlier than the room is. Computed only inside the range that actually gets drafted |

VOR and Edge are recomputed on every request because they move with league size and with
superflex — a superflex league starts far more quarterbacks, so the bar each is measured
against drops and every quarterback gains value.

It is **never averaged into the consensus.** A points projection is not a pick number, and
folding the board's own model into a market consensus would let the board vote on itself.

Projections join the board on Sleeper's player id through the DynastyProcess crosswalk, so
the name-matching heuristics used elsewhere are not involved.

**It declines to answer where it has nothing to say.** A player with no recent role, or no
current team, gets a dash rather than a number — without that guard a quarterback who threw
two passes regressed onto a starter's workload and projected 145 points. Coverage inside the
draftable range (ADP top 200) stays above 98%; beyond it, the gaps are the guard working.

**Backtested before being trusted.** Projected onto 2025 having been given only 2024 and
earlier, it beats "repeat last season" on value over replacement (Spearman 0.725 vs 0.694)
and at every individual position. Run it yourself:

```bash
node server/scripts/validate-projections.js
```

The validator fails the build if the model stops beating that benchmark. See `HANDOVER.md`
for the full numbers, including the one metric on which it loses and why that metric is the
wrong question.

### How the consensus is built

Each format averages **only sources that publish that format**, so a redraft ADP never
skews a best-ball board and a 1QB ranking never skews a superflex one:

| Format | Sources averaged |
|---|---|
| Best ball, 1QB | Underdog ADP + FantasyPros best-ball ECR |
| Best ball, superflex | FantasyPros SF + Sleeper 2QB |
| Redraft, 1QB | FFC + FantasyPros ½PPR + Sleeper ½PPR + ESPN + Yahoo |
| Redraft, superflex | FFC 2QB + FantasyPros SF + Sleeper 2QB |
| Dynasty | Mean **rank** across KTC, FantasyCalc, FantasyPros dynasty and Sleeper dynasty ADP (the values are on different scales, so they are ranked before averaging) |

---

## Features

| Feature | How to use |
|---|---|
| Filter by position | Click position pills (QB / RB / WR / TE) — multi-select |
| Filter by tier | Click tier pills — FantasyPros' tiers for the format on screen, plus T– for everyone past the end of their board |
| Hide drafted players | "Hide Drafted" toggle (on by default) |
| Starred only | "Starred Only" toggle |
| Search | Type in the search box (debounced 300ms) |
| Sort | Dropdown — options follow the format on screen (Consensus, each source, Tier, Proj Pts, My Rank). Sorting by Tier orders within a tier by consensus and sinks the untiered to the bottom |
| Switch format | Best Ball / Redraft / Dynasty, and 1QB / SF-2QB — columns, consensus and sort all follow |
| Set personal rank | Click the "My #" cell and type a number |
| Drag to reorder | Grab the ⠿ handle on the left side of any row |
| Cycle tier | Click the tier badge in the row — a solid badge is your own tier, a dashed one is FantasyPros' |
| Star / flag | Click ★ / ⚑ icons in the Flags column |
| Mark as drafted | Click the "Available" / "✓ Drafted" button |
| Follow a live Sleeper draft | **Draft** button in the top bar — see below |
| Add notes | Click 📝 to open the slide-over panel |
| Close slide-over | Click ✕, click the backdrop, or press **Esc** |

---

## Live Sleeper draft sync

Point the board at the draft you are sitting in and players disappear from it as they are
taken, without touching anything.

Open the **Draft** button in the top bar and paste the draft's Sleeper link (or its id).
Entering your Sleeper username is optional and does two extra things: it shows which picks
are yours, and it counts down to your next one. **Find drafts** lists this season's drafts
for a username, so a link is not strictly needed.

While connected:

- A player taken in the room drops off the board within about five seconds, exactly as if
  you had ticked him. His row shows the pick that took him and the team that made it.
- The panel shows who is on the clock, how many picks until your turn, and the last twelve
  picks made.
- Picks the board does not carry — kickers, defences, deep bench — are counted and shown in
  the feed rather than silently dropped.
- **Disconnect** puts every one of those players back. Players you ticked by hand are a
  separate flag and are never touched.

Reloading the page rejoins the same draft. Only one draft is followed at a time.

Two things worth knowing. Sleeper offers no push channel for drafts, so this polls its
public API every five seconds — well inside Sleeper's documented ceiling, and the server
throttles further so extra tabs cost nothing. And a draft id alone proves nothing: the
same endpoint answers for every draft Sleeper has ever hosted, in any sport or season, so
connecting asserts the sport and season and prints the league, scoring, type and size for
you to check against the room you are actually in.

Snake, linear and third-round-reversal drafts all get a working "on the clock" and next-pick
countdown. Auctions are followed normally — picks land on the board as usual — but have no
pick order to derive, so that part is left blank rather than guessed.

### API

| Endpoint | Purpose |
|---|---|
| `POST /api/draft/connect` | `{ ref, username? }` — `ref` is a draft URL or id. Validates and starts following |
| `GET /api/draft/state` | Current state; polls Sleeper first unless `?sync=0` |
| `POST /api/draft/sync` | Force a poll, ignoring the throttle |
| `POST /api/draft/disconnect` | Stop following and clear every live pick |
| `GET /api/draft/lookup?username=` | This season's NFL drafts for a Sleeper username |

The standalone cheat sheet in `cheatsheets/` is a point-in-time snapshot with no server
behind it, so it has no live sync — use the app on draft day.

---

## Project Structure

```
/
├── server/
│   ├── index.js           Express entry point + auto-seed
│   ├── db.js              SQLite setup, schema, migrations
│   ├── sources.js         Every column: provider, format, scoring, plain-English explanation
│   ├── consensus.js       Averaging and dynasty rank-averaging, with source exclusions
│   ├── routes/
│   │   ├── players.js     GET /api/players, PATCH override, POST reorder
│   │   ├── draft.js       Live Sleeper draft: connect, poll, disconnect
│   │   └── refresh.js     POST /api/refresh/:source, GET /api/source-status
│   ├── scrapers/
│   │   ├── sleeper.js     Roster, projections, Sleeper ADP by format
│   │   ├── sleeperDraft.js Sleeper draft API, with the sport/season assertions
│   │   ├── fantasypros.js ECR for best ball / redraft / superflex / dynasty
│   │   ├── underdog.js    Underdog best-ball ADP (FFC fallback)
│   │   ├── ffc.js         Fantasy Football Calculator mock-draft ADP
│   │   ├── market.js      ESPN + Yahoo platform ADP
│   │   ├── dynastydaddy.js KeepTradeCut + DynastySuperflex values, ages
│   │   ├── dynastyprocess.js DynastyProcess values and ages
│   │   ├── fantasycalc.js FantasyCalc dynasty values
│   │   ├── expectedpoints.js Runs the model and writes its columns onto the board
│   │   ├── marketprops.js Season-long betting over/unders, scored under this league
│   │   └── seed.js        Hardcoded fallback, last resort only
│   ├── model/             The expected-points model — the board's own projection
│   │   ├── nflverse.js    Weekly stats, schedules, and the gsis↔sleeper crosswalk
│   │   ├── scoring.js     The league's scoring rules, in one place
│   │   ├── usage.js       Per-player, per-season usage table
│   │   ├── stability.js   Measured year-over-year reliability → shrinkage weights
│   │   ├── volume.js      Module A — opportunity
│   │   ├── efficiency.js  Module B — points per opportunity, regressed
│   │   ├── environment.js Module C — implied team totals from betting lines
│   │   ├── combine.js     E[FP], availability, simulation, replacement levels
│   │   └── index.js       Orchestration, rookies, tuned hyperparameters
│   ├── utils/
│   │   ├── http.js        Shared HTTP client + embedded-JSON extraction
│   │   ├── match.js       Player name matching across sources
│   │   ├── normalize.js   Name normalisation
│   │   └── draftsharks.js DraftSharks ADP board parser
│   └── scripts/
│       ├── refresh-all.js  Refresh every source from the CLI
│       ├── validate-sources.js Assert each format contains what it claims
│       ├── validate-draft-sync.js Assert the live draft sync matches picks correctly
│       ├── audit-matching.js  Find name-matching damage across sources
│       ├── test-source-toggle.js Assert switching a source off changes the board
│       ├── validate-projections.js Backtest the model on a season it never saw
│       ├── tune-projections.js Select model hyperparameters out of sample
│       ├── build-cheatsheet.js Render the standalone cheat sheet
│       └── health-check.js Data health report
├── client/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── index.css      Tailwind + custom classes
│   │   ├── main.jsx
│   │   ├── hooks/
│   │   │   ├── usePlayers.js
│   │   │   └── useDraftSync.js  Poll a live Sleeper draft
│   │   └── components/
│   │       ├── DraftBoard.jsx
│   │       ├── PlayerRow.jsx
│   │       ├── FilterBar.jsx
│   │       ├── PlayerModal.jsx
│   │       ├── DraftSyncPanel.jsx  Connect to and follow a live draft
│   │       └── SourceRefreshPanel.jsx
│   └── index.html
├── package.json
└── railway.json
```

---

## Database Location

- **Local dev:** `./draft.db` (project root, git-ignored)
- **Railway (with volume):** `/data/draft.db`

To back up your rankings: download `draft.db` from the Railway volume, or use the Railway CLI:
```bash
railway connect  # SSH into the container
cp /data/draft.db /tmp/backup.db
```
