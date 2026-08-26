/**
 * Layer 0: nflverse ingest and the player-id crosswalk.
 *
 * Everything the expected-points model knows about what actually happened on a field
 * comes through here. Three feeds, all free, all CSV over HTTPS:
 *
 *   - weekly player stats  (nflverse-data, release tag `stats_player`)
 *   - game schedules with closing betting lines (release tag `schedules`)
 *   - the DynastyProcess id crosswalk, which is what lets a projection land on the
 *     right board row without going anywhere near the name matcher.
 *
 * The one rule applies here more than anywhere else in the repo, because these are
 * GitHub release assets: the URL keeps working after the file behind it has been
 * frozen, renamed or re-cut. Two ways that has already bitten:
 *
 *   - `player_stats` is the ARCHIVED release. `stats_player` is the maintained one.
 *     Both answer 200 for 2024 and both parse. The archived cut has 114 columns and
 *     stops at 2024; the live one has 150 and carries 2025. Pulling the archived tag
 *     would silently project a season on data a year out of date, and nothing about
 *     the response would say so. SOURCES.stats is pinned to `stats_player` and the
 *     column count is asserted.
 *   - `headshot_url` is a quoted field containing a comma. A split(',') parse shifts
 *     every column after it by one, so `targets` reads somebody's air yards and the
 *     whole model is confidently wrong. parseCsv below is quote-aware, and
 *     assertColumns proves the header is the shape we think it is before any of it
 *     is believed.
 */
const fs = require('fs');
const path = require('path');
const { get, BROWSER_HEADERS } = require('../utils/http');

const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download';

const SOURCES = {
  // The maintained release. Not `player_stats` — see the header comment.
  stats: season => `${RELEASE}/stats_player/stats_player_week_${season}.csv`,
  schedules: () => `${RELEASE}/schedules/games.csv`,
  depthCharts: season => `${RELEASE}/depth_charts/depth_charts_${season}.csv`,
  // The crosswalk lives in the DynastyProcess repo. github.com/.../raw/... answers 403
  // through the egress proxy; raw.githubusercontent.com is the path that works.
  ids: () => 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv',
};

// Columns each feed must actually carry. Not a full schema — just enough that a
// re-cut file which has lost or reordered what the model reads fails loudly.
const REQUIRED = {
  stats: ['player_id', 'season', 'week', 'season_type', 'position', 'team',
          'attempts', 'passing_yards', 'passing_tds', 'passing_interceptions',
          'carries', 'rushing_yards', 'rushing_tds',
          'targets', 'receptions', 'receiving_yards', 'receiving_tds',
          'target_share', 'air_yards_share', 'receiving_air_yards',
          'rushing_fumbles_lost', 'receiving_fumbles_lost', 'sack_fumbles_lost'],
  schedules: ['game_id', 'season', 'week', 'game_type', 'away_team', 'home_team',
              'spread_line', 'total_line', 'away_score', 'home_score'],
  ids: ['gsis_id', 'sleeper_id', 'position', 'team', 'name', 'draft_year', 'draft_ovr'],
  // Two schemas exist. Through 2024 the file is one row per player per week
  // (`club_code`, `week`, `depth_team`, `position`); from 2025 it is a timestamped
  // snapshot feed (`team`, `pos_rank`, `pos_abb`, `dt`) with no week column at all.
  // Only gsis_id is common to both, so that is all this asserts and the reader below
  // detects which shape it got.
  depth: ['gsis_id'],
};

/**
 * A quote-aware CSV parse. Deliberately not a split(',') one-liner: nflverse embeds
 * commas inside quoted URLs, and a naive parse produces a perfectly plausible table
 * with every column after the quote shifted by one.
 *
 * Returns plain objects keyed by header. Rows whose field count does not match the
 * header are dropped rather than zipped short, since a short row means a truncated
 * download and its values would land under the wrong keys.
 */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const header = rows.shift();
  if (!header) return { header: [], rows: [] };

  const out = [];
  let malformed = 0;
  for (const r of rows) {
    if (r.length !== header.length) { malformed++; continue; }
    const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = r[i];
    out.push(o);
  }
  return { header, rows: out, malformed };
}

function assertColumns(kind, header) {
  const missing = REQUIRED[kind].filter(c => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `${kind} feed is missing ${missing.length} required column(s): ${missing.join(', ')}. ` +
      'The release asset has changed shape — do not trust anything derived from it.'
    );
  }
}

// A number, or null. nflverse writes "NA" and "" for absent, and both must not
// become 0 — a missing target share is not a zero target share.
function num(v) {
  if (v == null || v === '' || v === 'NA' || v === 'NaN') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The same, but for accumulating totals where absent genuinely means none happened.
function num0(v) {
  return num(v) ?? 0;
}

/**
 * On-disk cache. These files are 2–9MB each and the model reads four or five of them,
 * so a rebuild during a draft must not depend on GitHub being up. Entries older than
 * maxAgeHours are refetched; a fetch failure falls back to whatever is cached and says
 * so, because a day-old usage prior is worth far more than no projection at all.
 */
const CACHE_DIR = process.env.NFLVERSE_CACHE
  || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', '..'), '.nflverse-cache');

function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.csv`);
}

function ageHours(file) {
  try {
    return (Date.now() - fs.statSync(file).mtimeMs) / 3600000;
  } catch {
    return Infinity;
  }
}

async function fetchCsv(key, url, { maxAgeHours = 24, kind = null } = {}) {
  const file = cachePath(key);
  const age = ageHours(file);
  let text = null;
  let fromCache = false;

  if (age <= maxAgeHours) {
    text = fs.readFileSync(file, 'utf8');
    fromCache = true;
  } else {
    try {
      const res = await get(url, { headers: BROWSER_HEADERS, timeout: 120000, responseType: 'text' });
      text = typeof res.data === 'string' ? res.data : String(res.data);
      // A release asset that 404s comes back as a short "Not Found" body with a 200 in
      // some proxy configurations, so length is checked rather than assumed.
      if (text.length < 1000) throw new Error(`response was only ${text.length} bytes — not a data file`);
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, text);
    } catch (err) {
      if (!Number.isFinite(age)) throw new Error(`${key}: ${err.message} (and nothing cached)`);
      text = fs.readFileSync(file, 'utf8');
      fromCache = true;
      console.warn(`[nflverse] ${key} fetch failed (${err.message}) — using cache ${age.toFixed(1)}h old`);
    }
  }

  const parsed = parseCsv(text);
  if (kind) assertColumns(kind, parsed.header);
  return { ...parsed, fromCache, ageHours: fromCache ? age : 0 };
}

/**
 * Which seasons of weekly stats actually exist, newest first.
 *
 * Discovered rather than assumed. In August the current season has no stats at all,
 * and the previous one appears only once nflverse cuts it — so "this year minus one"
 * is a guess that silently drops the most important season in the prior. The caller
 * gets the real list and decides whether it is recent enough.
 */
async function availableSeasons(targetSeason, lookback = 4) {
  const found = [];
  for (let s = targetSeason - 1; s >= targetSeason - lookback; s--) {
    const file = cachePath(`stats_${s}`);
    if (ageHours(file) < Infinity) { found.push(s); continue; }
    try {
      const res = await get(SOURCES.stats(s), { headers: BROWSER_HEADERS, timeout: 30000, responseType: 'text' });
      if (typeof res.data === 'string' && res.data.length > 1000) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(file, res.data);
        found.push(s);
      }
    } catch {
      // A 404 is the normal answer for a season not yet cut. Keep looking back: a gap
      // in the middle is possible and is not a reason to stop.
    }
  }
  return found;
}

/**
 * Regular-season weekly rows for one season, at the positions this board carries.
 *
 * Post-season is excluded deliberately: a player on a team that went deep gets three
 * extra games of counting stats, which would read as a durable usage edge rather than
 * as his team having been good.
 */
const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

async function loadSeasonStats(season) {
  const { rows, malformed } = await fetchCsv(`stats_${season}`, SOURCES.stats(season), {
    maxAgeHours: 24 * 7,   // a finished season does not change
    kind: 'stats',
  });

  const reg = rows.filter(r => r.season_type === 'REG' && POSITIONS.has(r.position));

  // The season column must actually say what was asked for. A release asset can be
  // re-cut to hold a different year behind the same filename, and every downstream
  // number would still look reasonable.
  const seasons = [...new Set(reg.map(r => r.season))];
  if (seasons.length !== 1 || Number(seasons[0]) !== season) {
    throw new Error(`stats_player_week_${season}.csv contains season(s) ${seasons.join('/')} — not ${season}`);
  }

  const weeks = new Set(reg.map(r => Number(r.week)));
  if (weeks.size < 17) {
    throw new Error(`${season} has only ${weeks.size} regular-season weeks — the file looks partial`);
  }

  return { season, rows: reg, weeks: weeks.size, malformed };
}

/**
 * Team abbreviations, normalised onto the ones nflverse's schedule file uses.
 *
 * The DynastyProcess crosswalk spells nine current teams differently — SFO for SF, GBP
 * for GB, NOS for NO, LAR for LA — and nothing about the mismatch announces itself: the
 * lookup into the environment table simply misses, the player falls back to a
 * league-average scalar, and the projection comes out looking entirely reasonable. It
 * cost 138 of 475 projections their team environment before anyone noticed, which is
 * every player on nine teams. The dead franchises are here too because the crosswalk
 * still carries players whose last team was one of them.
 */
const TEAM_ALIASES = {
  GBP: 'GB', JAC: 'JAX', KCC: 'KC', LAR: 'LA', LVR: 'LV',
  NEP: 'NE', NOS: 'NO', SFO: 'SF', TBB: 'TB',
  OAK: 'LV', SDC: 'LAC', STL: 'LA', RAM: 'LA', ARZ: 'ARI', BLT: 'BAL',
  CLV: 'CLE', HST: 'HOU', WSH: 'WAS',
};

// Codes that mean "no team" rather than a team. Sleeper uses both.
const NO_TEAM = new Set(['NA', 'FA', 'FA*', 'UNS', 'NONE', '']);

function normaliseTeam(team) {
  if (!team) return null;
  const t = String(team).toUpperCase();
  if (NO_TEAM.has(t)) return null;
  return TEAM_ALIASES[t] || t;
}

/**
 * The gsis_id ↔ sleeper_id crosswalk.
 *
 * This is the whole reason the model can be trusted to land on the right player. The
 * board already stores Sleeper's id on every row, and nflverse keys everything on
 * gsis_id, so the join is exact — none of the surname/nickname/team heuristics in
 * utils/match.js are involved, and none of their failure modes are either.
 */
async function loadCrosswalk() {
  const { rows } = await fetchCsv('ids', SOURCES.ids(), { maxAgeHours: 24, kind: 'ids' });

  const bySleeper = new Map();
  const byGsis = new Map();
  for (const r of rows) {
    const gsis = r.gsis_id && r.gsis_id !== 'NA' ? r.gsis_id : null;
    const sleeper = r.sleeper_id && r.sleeper_id !== 'NA' ? String(r.sleeper_id) : null;
    if (!gsis) continue;
    const entry = {
      gsis_id: gsis,
      sleeper_id: sleeper,
      name: r.name,
      position: r.position,
      team: normaliseTeam(r.team),
      draft_year: num(r.draft_year),
      draft_ovr: num(r.draft_ovr),
      draft_round: num(r.draft_round),
      age: num(r.age),
      // The birthdate, not just the age, because the age column is as of today and the
      // ageing curve needs to index a player by how old he was in a PAST season. Deriving
      // it from a fixed date of birth is exact; subtracting years from a current age drifts
      // by up to a year depending on when in the calendar it was last regenerated.
      birthdate: r.birthdate && r.birthdate !== 'NA' ? r.birthdate : null,
    };
    byGsis.set(gsis, entry);
    if (sleeper) bySleeper.set(sleeper, entry);
  }

  if (bySleeper.size < 3000) {
    throw new Error(`crosswalk mapped only ${bySleeper.size} Sleeper ids — expected thousands`);
  }
  return { bySleeper, byGsis, count: rows.length };
}

/**
 * Week-one depth charts for a season, as `gsis_id -> { order, team, position }`.
 *
 * This is the only statement in the whole model about who is actually starting.
 * Everything else is last season's usage, which cannot know that a quarterback changed
 * teams in March — it is why the model had Malik Willis nowhere near Miami's job.
 *
 * Week one rather than a later week: the question is who was expected to start, and a
 * mid-season chart has already absorbed the injuries and benchings the projection is
 * supposed to be uncertain about. It is a shade ahead of an August draft, and that is
 * the one respect in which a backtest using it flatters the model.
 */
async function loadDepthChart(season) {
  const { rows } = await fetchCsv(`depth_${season}`, SOURCES.depthCharts(season), {
    maxAgeHours: 24 * 7,
    kind: 'depth',
  });
  const out = new Map();
  const modern = rows.length > 0 && rows[0].pos_rank !== undefined;

  if (modern) {
    // Snapshot feed: many datetimes, no weeks. Take the earliest snapshot of the season,
    // which is the closest thing it has to a week-one chart.
    const stamps = [...new Set(rows.map(r => r.dt).filter(Boolean))].sort();
    const first = stamps[0];
    for (const r of rows) {
      if (r.dt !== first) continue;
      const pos = r.pos_abb;
      const gsis = r.gsis_id;
      const order = num(r.pos_rank);
      if (!gsis || order == null || order < 1 || !POSITIONS.has(pos)) continue;
      const prev = out.get(gsis);
      if (prev && prev.order <= order) continue;
      out.set(gsis, { order, team: normaliseTeam(r.team), position: pos });
    }
  } else {
    for (const r of rows) {
      if (Number(r.week) !== 1 || r.game_type !== 'REG') continue;
      if (!POSITIONS.has(r.position)) continue;
      const gsis = r.gsis_id;
      const order = num(r.depth_team);
      if (!gsis || order == null || order < 1) continue;
      // A player can appear at more than one slot; keep his best listed rank.
      const prev = out.get(gsis);
      if (prev && prev.order <= order) continue;
      out.set(gsis, { order, team: normaliseTeam(r.club_code), position: r.position });
    }
  }

  if (out.size < 200) {
    throw new Error(`depth chart for ${season} yielded only ${out.size} players — schema may have changed again`);
  }
  return out;
}

/** Game schedules, including the closing spread and total each game was priced at. */
async function loadSchedules() {
  const { rows } = await fetchCsv('schedules', SOURCES.schedules(), { maxAgeHours: 6, kind: 'schedules' });
  return rows.map(r => ({
    game_id: r.game_id,
    season: num(r.season),
    week: num(r.week),
    game_type: r.game_type,
    away_team: r.away_team,
    home_team: r.home_team,
    away_score: num(r.away_score),
    home_score: num(r.home_score),
    // spread_line is quoted from the home team's perspective: positive = home favoured.
    spread_line: num(r.spread_line),
    total_line: num(r.total_line),
  }));
}

module.exports = {
  SOURCES, REQUIRED, CACHE_DIR, POSITIONS, TEAM_ALIASES, normaliseTeam,
  parseCsv, assertColumns, num, num0,
  fetchCsv, availableSeasons, loadSeasonStats, loadCrosswalk, loadSchedules, loadDepthChart,
};
