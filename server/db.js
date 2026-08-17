const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { normalizeName } = require('./utils/normalize');

const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'draft.db')
  : path.join(__dirname, '..', 'draft.db');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position TEXT,
    nfl_team TEXT,
    bye_week INTEGER,
    adp_fantasypros REAL,
    adp_underdog REAL,
    adp_sleeper REAL,
    adp_consensus REAL,
    pos_rank_fantasypros INTEGER,
    pos_rank_underdog INTEGER,
    pos_rank_sleeper INTEGER,
    last_updated TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS player_overrides (
    player_id INTEGER PRIMARY KEY REFERENCES players(id),
    personal_rank INTEGER,
    tier INTEGER,
    starred INTEGER DEFAULT 0,
    flagged INTEGER DEFAULT 0,
    drafted INTEGER DEFAULT 0,
    note_upside TEXT,
    note_downside TEXT,
    note_sources TEXT,
    note_personal TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS source_metadata (
    source TEXT PRIMARY KEY,
    last_fetched TEXT,
    player_count INTEGER,
    status TEXT
  );

  -- The live Sleeper draft the board is following. One row, ever: you draft in one
  -- room at a time, and pinning the id means a reload rejoins the same draft.
  CREATE TABLE IF NOT EXISTS draft_sync (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    draft_id TEXT NOT NULL,
    status TEXT,
    type TEXT,
    season TEXT,
    scoring_type TEXT,
    league_id TEXT,
    league_name TEXT,
    teams INTEGER,
    rounds INTEGER,
    reversal_round INTEGER DEFAULT 0,
    my_user_id TEXT,
    my_display_name TEXT,
    my_slot INTEGER,
    team_names TEXT,
    draft_order TEXT,
    connected_at TEXT,
    last_synced TEXT,
    last_error TEXT
  );

  -- Picks as Sleeper reported them. The pick is the record; player_id is only our
  -- match onto it, so a pick we cannot match (a kicker, a defence, a player this
  -- board does not carry) is still stored and still shown in the feed.
  CREATE TABLE IF NOT EXISTS draft_picks (
    draft_id TEXT NOT NULL,
    pick_no INTEGER NOT NULL,
    round INTEGER,
    draft_slot INTEGER,
    roster_id INTEGER,
    picked_by TEXT,
    is_keeper INTEGER DEFAULT 0,
    sleeper_player_id TEXT,
    player_id INTEGER REFERENCES players(id),
    player_name TEXT,
    position TEXT,
    nfl_team TEXT,
    seen_at TEXT,
    PRIMARY KEY (draft_id, pick_no)
  );
`);

// Safe migration: add column only if it doesn't exist
function addColumnIfMissing(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
    console.log(`[db] Migration: added ${table}.${column}`);
  }
}

addColumnIfMissing('players', 'projected_pts', 'REAL');
addColumnIfMissing('players', 'adp_consensus_prev', 'REAL');
addColumnIfMissing('players', 'adp_ffc', 'REAL');
addColumnIfMissing('players', 'adp_espn', 'REAL');
addColumnIfMissing('players', 'ktc_value', 'INTEGER');
addColumnIfMissing('players', 'ktc_value_sf', 'INTEGER');
addColumnIfMissing('players', 'fc_value', 'REAL');
addColumnIfMissing('players', 'fc_value_sf', 'REAL');
addColumnIfMissing('players', 'sleeper_player_id', 'TEXT');
addColumnIfMissing('players', 'name_normalized', 'TEXT');
addColumnIfMissing('source_metadata', 'notes', 'TEXT');
addColumnIfMissing('players', 'adp_fp_rd', 'REAL');
addColumnIfMissing('players', 'adp_fp_sf', 'REAL');
addColumnIfMissing('players', 'adp_sl_bb', 'REAL');
addColumnIfMissing('players', 'adp_sl_rd', 'REAL');
addColumnIfMissing('players', 'adp_sl_sf', 'REAL');
addColumnIfMissing('players', 'adp_sl_dyn', 'REAL');
addColumnIfMissing('players', 'adp_sl_dyn_sf', 'REAL');
addColumnIfMissing('players', 'adp_fp_dyn', 'REAL');
addColumnIfMissing('players', 'adp_ffc_sf', 'REAL');
addColumnIfMissing('players', 'adp_yahoo', 'REAL');
addColumnIfMissing('players', 'dyn_rank_consensus', 'REAL');
addColumnIfMissing('players', 'dyn_rank_consensus_sf', 'REAL');
addColumnIfMissing('players', 'adp_fp_dyn_sf', 'REAL');
addColumnIfMissing('players', 'age', 'REAL');
addColumnIfMissing('players', 'dp_value', 'INTEGER');
addColumnIfMissing('players', 'dp_value_sf', 'INTEGER');
addColumnIfMissing('players', 'ds_value', 'INTEGER');
addColumnIfMissing('players', 'ds_value_sf', 'INTEGER');
addColumnIfMissing('players', 'fp_tier', 'INTEGER');

// Populate name_normalized for any rows missing it
(function populateNameNormalized() {
  const missing = db.prepare('SELECT id, name FROM players WHERE name_normalized IS NULL').all();
  if (missing.length === 0) return;
  const upd = db.prepare('UPDATE players SET name_normalized = ? WHERE id = ?');
  const run = db.transaction(() => {
    for (const p of missing) upd.run(normalizeName(p.name), p.id);
  });
  run();
  console.log(`[db] Populated name_normalized for ${missing.length} players`);
})();

// Ensure all sources exist in metadata
const initSource = db.prepare(`
  INSERT OR IGNORE INTO source_metadata (source, status) VALUES (?, 'never')
`);
['fantasypros', 'underdog', 'sleeper', 'ffc', 'market', 'dynastyprocess', 'dynastydaddy', 'fantasycalc'].forEach(s => initSource.run(s));

// Lookup indexes for the matcher and the projection-rank subquery.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_players_norm_pos ON players (name_normalized, position);
  CREATE INDEX IF NOT EXISTS idx_players_sleeper_id ON players (sleeper_player_id);
  CREATE INDEX IF NOT EXISTS idx_players_pos_proj ON players (position, projected_pts);
  CREATE INDEX IF NOT EXISTS idx_draft_picks_player ON draft_picks (player_id);
`);

const { consensusColumns } = require('./sources');

// Mean of the non-null source values for a row, rounded to one decimal.
// Dynasty is excluded here — its inputs are on different scales and are ranked
// before averaging, in routes/refresh.js.
function computeConsensus(row, format, leagueType) {
  if (format === 'DYN') return null;
  const vals = consensusColumns(format, leagueType)
    .map(c => row[c])
    .filter(v => v != null && Number.isFinite(Number(v)))
    .map(Number);
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

module.exports = { db, computeConsensus, DB_PATH };
