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
- In the Railway dashboard: **Service → Volumes → Add Volume**
- Mount path: `/data`
- This keeps your personal rankings, notes, and overrides across deploys and sleep cycles

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
- **Tiers** — positional tiers cut where the market leaves a real gap rather than at
  round numbers.

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

If a source fails, existing data for that source is preserved — only a successful fetch updates the values.

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
| Filter by tier | Click tier pills (T1–T5) |
| Hide drafted players | "Hide Drafted" toggle (on by default) |
| Starred only | "Starred Only" toggle |
| Search | Type in the search box (debounced 300ms) |
| Sort | Dropdown — options follow the format on screen (Consensus, each source, Proj Pts, My Rank) |
| Switch format | Best Ball / Redraft / Dynasty, and 1QB / SF-2QB — columns, consensus and sort all follow |
| Set personal rank | Click the "My #" cell and type a number |
| Drag to reorder | Grab the ⠿ handle on the left side of any row |
| Cycle tier | Click the tier badge in the row |
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
│   │   └── seed.js        Hardcoded fallback, last resort only
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
