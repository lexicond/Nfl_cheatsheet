/**
 * The expected-points model, wired in as a source.
 *
 * It sits alongside the scrapers and refreshes through the same route because that is
 * how everything else on this board is kept current — but it is not a scraper, and the
 * difference matters when reading the board. Every other column is somebody else's
 * opinion or somebody else's draft data. This one is computed here, from what players
 * did (nflverse) and what the betting market expects their offences to score.
 *
 * That makes it the only column with no second opinion behind it. So the run records
 * its own provenance in `model_runs` — which seasons fed it, how much of the schedule
 * the market had priced, what it warned about — and refuses to overwrite good numbers
 * with a bad run.
 *
 * The join is on Sleeper's player id via the DynastyProcess crosswalk, so none of the
 * name-matching traps in utils/match.js apply here: a projection cannot land on the
 * wrong player because two men share a surname.
 */
const { db } = require('../db');
const { runModel } = require('../model');

const SEASON_YEAR = new Date().getFullYear();

// Below this, something is wrong with the crosswalk or the ingest and the previous
// run's numbers are worth more than this one's.
const MIN_MATCHES = 150;

async function fetchExpectedPoints({ targetSeason = SEASON_YEAR } = {}) {
  const now = new Date().toISOString();
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ?
    WHERE source = 'expectedpoints'
  `);

  let result;
  try {
    result = await runModel({ targetSeason });
  } catch (err) {
    updateMeta.run(now, 0, 'error', err.message);
    console.error('[ExpectedPoints] Model run failed:', err.message);
    return { success: false, error: err.message, source: 'expectedpoints', timestamp: now };
  }

  const { projections, meta } = result;

  // Match on Sleeper's id. Players the board does not carry are simply skipped —
  // nflverse knows about every man who took a snap, the board only about draftable ones.
  const bySleeperId = db.prepare('SELECT id, name, position FROM players WHERE sleeper_player_id = ?');
  const update = db.prepare(`
    UPDATE players SET
      xfp_points = @points,
      xfp_ppg = @ppg,
      xfp_games = @games,
      xfp_floor = @floor,
      xfp_ceiling = @ceiling,
      xfp_best_ball = @best_ball,
      xfp_confidence = @confidence,
      xfp_components = @components,
      last_updated = @ts
    WHERE id = @id
  `);

  const claimed = new Map();
  let matched = 0;
  let positionMismatch = 0;
  const unmatched = [];

  const rows = db.transaction(() => {
    let count = 0;
    for (const p of projections) {
      if (!p.sleeper_id) { unmatched.push(p.name); continue; }
      const target = bySleeperId.get(String(p.sleeper_id));
      if (!target) { unmatched.push(p.name); continue; }

      // The id join is exact, so a position disagreement means the crosswalk has the
      // wrong Sleeper id for this gsis_id — not a naming quirk. Skip rather than write:
      // a projection on the wrong row is worse than no projection.
      if (target.position && p.position && target.position !== p.position) {
        positionMismatch++;
        continue;
      }

      // One projection per row, even if the crosswalk ever maps two gsis ids onto one
      // Sleeper id. Same rule as every scraper here: keep the first, warn about the rest.
      if (claimed.has(target.id)) {
        console.warn(`[ExpectedPoints] "${p.name}" also matched the row already taken by "${claimed.get(target.id)}" — keeping the first`);
        continue;
      }
      claimed.set(target.id, p.name);

      update.run({
        id: target.id,
        points: p.points,
        ppg: p.ppg,
        games: p.games,
        floor: p.floor,
        ceiling: p.ceiling,
        best_ball: p.best_ball,
        confidence: p.confidence,
        components: JSON.stringify(p.components),
        ts: now,
      });
      matched++;
      count++;
    }
    return count;
  })();

  if (matched < MIN_MATCHES) {
    const msg = `only ${matched} players matched the board (expected at least ${MIN_MATCHES}) — ` +
      'the crosswalk or the ingest is broken; previous projections left in place';
    updateMeta.run(now, matched, 'error', msg);
    console.error(`[ExpectedPoints] ${msg}`);
    return { success: false, error: msg, source: 'expectedpoints', timestamp: now, meta };
  }

  db.prepare(`
    INSERT INTO model_runs
      (ran_at, target_season, history_seasons, newest_season, players, rookies, matched,
       env_coverage, env_priced_games, warnings, elapsed_ms)
    VALUES (@ran_at, @target_season, @history_seasons, @newest_season, @players, @rookies,
            @matched, @env_coverage, @env_priced_games, @warnings, @elapsed_ms)
  `).run({
    ran_at: now,
    target_season: meta.target_season,
    history_seasons: meta.history_seasons.join(','),
    newest_season: meta.newest_season,
    players: meta.players,
    rookies: meta.rookies,
    matched,
    env_coverage: meta.environment.coverage,
    env_priced_games: meta.environment.priced_games,
    warnings: meta.warnings.join(' · ') || null,
    elapsed_ms: meta.elapsed_ms,
  });

  const note =
    `${matched} matched · ${meta.target_season} from ${meta.history_seasons.slice(0, 3).join('/')} · ` +
    `market priced ${Math.round(meta.environment.coverage * 100)}% of games` +
    (meta.warnings.length ? ` · ${meta.warnings.join(' · ')}` : '');

  updateMeta.run(now, matched, meta.warnings.length ? 'warn' : 'ok', note);
  console.log(`[ExpectedPoints] ${matched}/${projections.length} projections onto the board — ${note}`);
  if (positionMismatch > 0) {
    console.warn(`[ExpectedPoints] ${positionMismatch} skipped on a position disagreement with the crosswalk`);
  }

  return {
    success: true,
    players_updated: matched,
    projections: projections.length,
    rookies: meta.rookies,
    position_mismatch: positionMismatch,
    unmatched: unmatched.length,
    meta,
    source: 'expectedpoints',
    timestamp: now,
  };
}

module.exports = { fetchExpectedPoints, MIN_MATCHES };
