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
Click the **↻** button next to any source in the top-right refresh panel, or **Refresh All** to update all three simultaneously.

### Via the API
```bash
# Refresh one source
curl -X POST http://localhost:3000/api/refresh/sleeper
curl -X POST http://localhost:3000/api/refresh/fantasypros
curl -X POST http://localhost:3000/api/refresh/underdog

# Refresh all
curl -X POST http://localhost:3000/api/refresh/all

# Check source status
curl http://localhost:3000/api/source-status
```

### Source notes
- **Sleeper** — public JSON API, no auth required, most reliable. Uses `search_rank` as ADP proxy.
- **FantasyPros** — scrapes the best ball cheatsheet page. May occasionally be blocked (shows ⚠ Failed). Try refreshing.
- **Underdog** — tries their API endpoints first, then falls back to scraping. May return no data if their API changes.

If a source fails, existing data for that source is preserved — only a successful fetch updates the values.

---

## Features

| Feature | How to use |
|---|---|
| Filter by position | Click position pills (QB / RB / WR / TE) — multi-select |
| Filter by tier | Click tier pills (T1–T5) |
| Hide drafted players | "Hide Drafted" toggle (on by default) |
| Starred only | "Starred Only" toggle |
| Search | Type in the search box (debounced 300ms) |
| Sort | Dropdown: Consensus ADP / My Rank / UD / FP / Sleeper |
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
│   └── scrapers/
│       ├── sleeper.js     Sleeper public API
│       ├── fantasypros.js FantasyPros best ball scraper
│       ├── underdog.js    Underdog API + scraper fallback
│       └── seed.js        Hardcoded top-30 fallback
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
