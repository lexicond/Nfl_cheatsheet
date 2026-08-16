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
['fantasypros', 'underdog', 'sleeper', 'ffc', 'ktc', 'fantasycalc', 'market'].forEach(s => initSource.run(s));

// Lookup indexes for the matcher and the projection-rank subquery.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_players_norm_pos ON players (name_normalized, position);
  CREATE INDEX IF NOT EXISTS idx_players_sleeper_id ON players (sleeper_player_id);
  CREATE INDEX IF NOT EXISTS idx_players_pos_proj ON players (position, projected_pts);
`);

// Source columns that feed the consensus for each format + league type.
// Sleeper's own per-format ADP is used directly; nothing here mixes scales.
const CONSENSUS_SOURCES = {
  // Best ball: only genuinely best-ball markets. Redraft ADP drafts QBs and TEs
  // later than best ball does, so folding it in here would skew those positions.
  'BB:1QB':  ['adp_underdog', 'adp_fantasypros'],
  // Underdog's contests are 1QB, so its ADP is deliberately absent from the SF set.
  'BB:2QB':  ['adp_fp_sf', 'adp_sl_sf'],
  'RD:1QB':  ['adp_ffc', 'adp_fp_rd', 'adp_sl_rd', 'adp_espn', 'adp_yahoo'],
  'RD:2QB':  ['adp_ffc_sf', 'adp_fp_sf', 'adp_sl_sf'],
};

function consensusColumns(format, leagueType) {
  return CONSENSUS_SOURCES[`${format}:${leagueType === '2QB' ? '2QB' : '1QB'}`] || [];
}

// Mean of the non-null source ADPs for a row, rounded to one decimal.
function computeConsensus(row, format, leagueType) {
  const vals = consensusColumns(format, leagueType)
    .map(c => row[c])
    .filter(v => v != null && Number.isFinite(Number(v)))
    .map(Number);
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

module.exports = { db, computeConsensus, consensusColumns, CONSENSUS_SOURCES, DB_PATH };
