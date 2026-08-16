# NFL Draft Cheatsheet

A personal best ball fantasy football draft board with multi-source ADP, drag-and-drop ranking, notes, and tier management.

**Stack:** Node.js + Express · React + Tailwind · SQLite (better-sqlite3) · Vite · Railway

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
| **FantasyPros** | Expert consensus rankings: best ball, ½PPR redraft, superflex, dynasty. Also bye weeks and expert tiers | `ecrData` payload embedded in each rankings page |
| **FFC** | Real mock-draft ADP, ½PPR and 2QB | Fantasy Football Calculator public JSON API |
| **Sleeper** | Player roster, season projections, and Sleeper's own ADP for ½PPR / 2QB / dynasty / dynasty-SF | `api.sleeper.app` projections endpoint |
| **ESPN + Yahoo** (`market`) | Home-league platform ADP | DraftSharks' ESPN and Yahoo boards |
| **KTC** | Dynasty values, 1QB and superflex | DynastyProcess daily CSV of KeepTradeCut values |
| **FantasyCalc** | Dynasty trade values, 1QB and superflex | FantasyCalc public API |

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
| Add notes | Click 📝 to open the slide-over panel |
| Close slide-over | Click ✕, click the backdrop, or press **Esc** |

---

## Project Structure

```
/
├── server/
│   ├── index.js           Express entry point + auto-seed
│   ├── db.js              SQLite setup, schema, migrations
│   ├── routes/
│   │   ├── players.js     GET /api/players, PATCH override, POST reorder
│   │   └── refresh.js     POST /api/refresh/:source, GET /api/source-status
│   ├── scrapers/
│   │   ├── sleeper.js     Roster, projections, Sleeper ADP by format
│   │   ├── fantasypros.js ECR for best ball / redraft / superflex / dynasty
│   │   ├── underdog.js    Underdog best-ball ADP (FFC fallback)
│   │   ├── ffc.js         Fantasy Football Calculator mock-draft ADP
│   │   ├── market.js      ESPN + Yahoo platform ADP
│   │   ├── ktc.js         KeepTradeCut dynasty values
│   │   ├── fantasycalc.js FantasyCalc dynasty values
│   │   └── seed.js        Hardcoded fallback, last resort only
│   ├── utils/
│   │   ├── http.js        Shared HTTP client + embedded-JSON extraction
│   │   ├── match.js       Player name matching across sources
│   │   ├── normalize.js   Name normalisation
│   │   └── draftsharks.js DraftSharks ADP board parser
│   └── scripts/
│       ├── refresh-all.js Refresh every source from the CLI
│       └── health-check.js Data health report
├── client/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── index.css      Tailwind + custom classes
│   │   ├── main.jsx
│   │   ├── hooks/
│   │   │   └── usePlayers.js
│   │   └── components/
│   │       ├── DraftBoard.jsx
│   │       ├── PlayerRow.jsx
│   │       ├── FilterBar.jsx
│   │       ├── PlayerModal.jsx
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
