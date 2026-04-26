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
['fantasypros', 'underdog', 'sleeper', 'ffc', 'ktc', 'fantasycalc'].forEach(s => initSource.run(s));

// Average non-null ADP values from best-ball sources (FP, UD, FFC)
// Sleeper ADP is excluded because search_rank is Superflex-weighted
function computeConsensus(fp, ud, ffc = null) {
  const vals = [fp, ud, ffc].filter(v => v != null && !isNaN(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

module.exports = { db, computeConsensus, DB_PATH };
