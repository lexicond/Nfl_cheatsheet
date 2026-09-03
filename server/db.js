const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { normalizeName } = require('./utils/normalize');

// Railway sets RAILWAY_VOLUME_MOUNT_PATH only when a volume is actually attached. With
// no volume the database lands inside the container, which is destroyed on every deploy
// — and because the app self-seeds players from Sleeper on boot, the board comes back
// looking perfectly healthy while every ranking, star, tier and note is gone. That is
// the whole reason this is reported rather than left to be noticed.
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const DB_PATH = VOLUME
  ? path.join(VOLUME, 'draft.db')
  : path.join(__dirname, '..', 'draft.db');

// Ephemeral only matters where the container is thrown away. A laptop keeps its files.
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID
  || process.env.RAILWAY_SERVICE_ID);

function storageInfo() {
  let bytes = null;
  try {
    bytes = fs.statSync(DB_PATH).size;
  } catch { /* not written yet */ }
  const userData = db.prepare(`
    SELECT COUNT(*) AS c FROM player_overrides
    WHERE personal_rank IS NOT NULL OR tier IS NOT NULL OR starred = 1 OR flagged = 1
       OR drafted = 1 OR note_personal IS NOT NULL OR note_upside IS NOT NULL
       OR note_downside IS NOT NULL
  `).get().c;
  return {
    db_path: DB_PATH,
    volume_mount: VOLUME,
    on_railway: ON_RAILWAY,
    // The one that matters: will this survive the next deploy?
    persistent: !ON_RAILWAY || !!VOLUME,
    size_bytes: bytes,
    rows_with_your_data: userData,
  };
}

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
// FULL rather than NORMAL: with NORMAL, WAL only fsyncs at a checkpoint, so a container
// killed outright can lose the last few commits — the stars and notes you just tapped in.
// That was a free trade while the whole database was thrown away on every deploy; on a
// volume it is not. Writes here are occasional taps and bulk refreshes that run in one
// transaction each, so the extra fsync costs nothing measurable.
db.pragma('synchronous = FULL');

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

  -- What each expected-points run was actually built from. The projection is the only
  -- column on this board nobody else publishes, so there is no second opinion to catch
  -- it being wrong — the provenance has to be recorded instead: which seasons fed it,
  -- how much of the season the betting market had priced, and what the run warned about.
  CREATE TABLE IF NOT EXISTS model_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at TEXT,
    target_season INTEGER,
    history_seasons TEXT,
    newest_season INTEGER,
    players INTEGER,
    rookies INTEGER,
    matched INTEGER,
    env_coverage REAL,
    env_priced_games INTEGER,
    warnings TEXT,
    elapsed_ms INTEGER
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
// FantasyPros publishes a tier on every one of its overall boards, and they are not
// the same tiers: the superflex board reorders quarterbacks into the top rounds, which
// pushes every receiver down a tier or two, and dynasty tiers a different population
// again. One column per board, so a format switch never shows another format's tiers.
// `fp_tier` above is the best-ball board's, kept under its original name.
addColumnIfMissing('players', 'fp_tier_rd', 'INTEGER');
addColumnIfMissing('players', 'fp_tier_sf', 'INTEGER');
addColumnIfMissing('players', 'fp_tier_dyn', 'INTEGER');
addColumnIfMissing('players', 'fp_tier_dyn_sf', 'INTEGER');
addColumnIfMissing('players', 'ff_pos_rank', 'INTEGER');
addColumnIfMissing('players', 'ff_points', 'REAL');

// The expected-points model's own output. Stored rather than computed per request
// because a full run reads six seasons of nflverse and takes several seconds — far too
// slow to sit in the path of a board that redraws every time a draft pick lands.
// Value over replacement is NOT stored: it depends on league size and league type, so
// it is derived per request in routes/players.js alongside the consensus.
addColumnIfMissing('players', 'xfp_points', 'REAL');
addColumnIfMissing('players', 'xfp_ppg', 'REAL');
addColumnIfMissing('players', 'xfp_games', 'REAL');
addColumnIfMissing('players', 'xfp_floor', 'REAL');
addColumnIfMissing('players', 'xfp_ceiling', 'REAL');
addColumnIfMissing('players', 'xfp_best_ball', 'REAL');
addColumnIfMissing('players', 'xfp_confidence', 'TEXT');
addColumnIfMissing('players', 'xfp_components', 'TEXT');

// Sleeper's depth chart. This is the only live statement anywhere in the app about who
// is actually starting — every other signal is last season's usage, which cannot know
// that a quarterback changed teams in March. Order 1 is the starter at that slot.
addColumnIfMissing('players', 'depth_chart_order', 'INTEGER');
addColumnIfMissing('players', 'depth_chart_position', 'TEXT');
// Sleeper's current injury designation. Knowing a player is on PUP with a repaired ACL
// is not forecasting an injury — it is reading one that has already happened.
addColumnIfMissing('players', 'injury_status', 'TEXT');

// Season-long betting lines per player, and those lines scored under this league's rules.
// Carried alongside the model's own projection, never blended into it — a market line is
// an expected value that already prices in missed games, and the model's number
// deliberately assumes a full season.
addColumnIfMissing('players', 'mkt_pass_yards', 'REAL');
addColumnIfMissing('players', 'mkt_rush_yards', 'REAL');
addColumnIfMissing('players', 'mkt_rec_yards', 'REAL');
addColumnIfMissing('players', 'mkt_pass_tds', 'REAL');
addColumnIfMissing('players', 'mkt_rush_tds', 'REAL');
addColumnIfMissing('players', 'mkt_rec_tds', 'REAL');
addColumnIfMissing('players', 'mkt_receptions', 'REAL');
addColumnIfMissing('players', 'mkt_points', 'REAL');
// How many real books priced his THINNEST line. A total backed by one operator on any of
// its terms is not the same claim as one eight books agree on, and receptions are thin
// where yardage is deep, so the weakest term is the one worth reporting.
addColumnIfMissing('players', 'mkt_books', 'INTEGER');
// Whether the total covers every category the position scores in. The books price
// receiving for the pass-catching backs and skip the rest, so a partial total is not a
// season projection and must not be compared with one.
addColumnIfMissing('players', 'mkt_complete', 'INTEGER');
// How many of his lines were moved from the posted number to the median that number's price
// implies. The one place a distribution assumption enters an otherwise pure market column,
// so it is counted rather than hidden.
addColumnIfMissing('players', 'mkt_adjusted', 'INTEGER');
// Book support per SCORING COMPONENT, not just the one minimum across all seven markets.
// mkt_books is the thinnest line a player carries anywhere, which is the right thing to
// report beside a season total but the wrong thing to weight a single component by: a
// receiver whose receiving lines eight books agree on but whose rushing-touchdown line
// comes from one was recorded at 1, and model/marketprior.js then barely moved the part
// of him that was well supported.
addColumnIfMissing('players', 'mkt_books_rec', 'INTEGER');
addColumnIfMissing('players', 'mkt_books_rush', 'INTEGER');
addColumnIfMissing('players', 'mkt_books_pass', 'INTEGER');

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
['fantasypros', 'underdog', 'sleeper', 'ffc', 'market', 'dynastyprocess', 'dynastydaddy', 'fantasycalc', 'footballers', 'expectedpoints', 'marketprops'].forEach(s => initSource.run(s));

// Lookup indexes for the matcher and the projection-rank subquery.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_players_norm_pos ON players (name_normalized, position);
  CREATE INDEX IF NOT EXISTS idx_players_sleeper_id ON players (sleeper_player_id);
  CREATE INDEX IF NOT EXISTS idx_players_pos_proj ON players (position, projected_pts);
  CREATE INDEX IF NOT EXISTS idx_players_pos_xfp ON players (position, xfp_points);
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

module.exports = { db, computeConsensus, DB_PATH, storageInfo };
