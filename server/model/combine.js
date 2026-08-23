/**
 * The combination engine and the distribution layer.
 *
 * Modules A, B and C each answer one question; this puts them together into the
 * identity the whole model exists to evaluate, per game:
 *
 *   E[receiving FP] = targets × [ catch rate × (yards/target ÷ catch rate) × pts_per_yard
 *                               + TD rate/target × pts_per_TD
 *                               + catch rate × pts_per_reception ]
 *
 * and the equivalent for rushing and passing — each term from a different module and
 * regressed independently — then scaled by the team-environment estimate and multiplied
 * by expected games played.
 *
 * The season total is not the end of it. Best ball starts each week's optimal lineup, so
 * it pays for spike weeks rather than for consistency, and a mean-only projection
 * systematically misprices boom/bust players. So the layer below simulates the season
 * week by week and reports a ceiling alongside the mean.
 */
const { RULES } = require('./scoring');

// How hard the team-environment scalar is allowed to bite. A team priced for 18 points
// a game is genuinely a worse place to score than one priced for 27, but a player's own
// role adjusts to his offence too — the raw ratio (0.80 to 1.18 in 2026) overstates it.
// The exponent damps the scalar without flattening it.
const ENV_EXPONENT = 0.7;

/**
 * Points per game from projected volume and efficiency.
 * Returns the total and the per-phase breakdown, which the player panel shows.
 */
function expectedPointsPerGame(volume, efficiency, envScalar) {
  const e = efficiency;
  const v = volume;

  // Receiving: yards per target already folds catch rate in, so it multiplies targets
  // directly. Receptions need the catch rate separately because PPR pays per catch.
  const recYards = v.targets_pg * (e.yards_per_target ?? 0);
  const receptions = v.targets_pg * (e.catch_rate ?? 0);
  const recTds = v.targets_pg * (e.rec_td_rate ?? 0);
  const receiving =
    recYards * RULES.receiving_yards +
    receptions * RULES.receptions +
    recTds * RULES.receiving_tds;

  // Rushing.
  const rushYards = v.carries_pg * (e.yards_per_carry ?? 0);
  const rushTds = v.carries_pg * (e.rush_td_rate ?? 0);
  const rushing = rushYards * RULES.rushing_yards + rushTds * RULES.rushing_tds;

  // Passing.
  const passYards = v.attempts_pg * (e.yards_per_attempt ?? 0);
  const passTds = v.attempts_pg * (e.pass_td_rate ?? 0);
  const ints = v.attempts_pg * (e.int_rate ?? 0);
  const passing =
    passYards * RULES.passing_yards +
    passTds * RULES.passing_tds +
    ints * RULES.passing_interceptions;

  // The environment scales scoring opportunity, not the player's role in it.
  const scalar = Math.pow(envScalar ?? 1, ENV_EXPONENT);
  const raw = receiving + rushing + passing;

  return {
    ppg: raw * scalar,
    env_scalar_applied: Math.round(scalar * 1000) / 1000,
    breakdown: {
      receiving: Math.round(receiving * scalar * 100) / 100,
      rushing: Math.round(rushing * scalar * 100) / 100,
      passing: Math.round(passing * scalar * 100) / 100,
      targets_pg: Math.round(v.targets_pg * 100) / 100,
      carries_pg: Math.round(v.carries_pg * 100) / 100,
      attempts_pg: Math.round(v.attempts_pg * 100) / 100,
      rec_yards_pg: Math.round(recYards * scalar * 10) / 10,
      rush_yards_pg: Math.round(rushYards * scalar * 10) / 10,
      pass_yards_pg: Math.round(passYards * scalar * 10) / 10,
      receptions_pg: Math.round(receptions * 100) / 100,
      total_tds_pg: Math.round((recTds + rushTds + passTds) * 1000) / 1000,
    },
  };
}

/**
 * Expected games played. Deliberately not 17 for everyone: the difference between a
 * player's mean and his season-long ceiling is mostly availability, and best ball pays
 * for the weeks you actually get.
 *
 * Estimated from the player's own recent availability, shrunk toward a positional norm
 * so that one freak season does not brand him fragile forever, with a small age penalty
 * for running backs, who fall off a cliff rather than a slope.
 */
const POSITION_GAMES = { QB: 15.2, RB: 14.3, WR: 14.8, TE: 14.6 };

function expectedGames(seasons, position, age) {
  const norm = POSITION_GAMES[position] ?? 14.6;
  const recent = seasons.slice(0, 3);
  if (recent.length === 0) return norm;

  // Weight recent availability by recency; a season with no games played at all does
  // not appear in the stats file, so absence is handled by the shrinkage below rather
  // than being silently read as a full season.
  const weights = [0.5, 0.3, 0.2];
  let num = 0;
  let den = 0;
  recent.forEach((s, i) => { num += Math.min(s.games, 17) * weights[i]; den += weights[i]; });
  const own = num / den;

  // Shrink toward the positional norm: three seasons is thin evidence of durability.
  const n = recent.length;
  const w = n / (n + 2);
  let games = own * w + norm * (1 - w);

  // Running backs age badly, and the drop is sharp rather than gradual.
  if (position === 'RB' && age != null && age >= 28) {
    games -= Math.min(2.0, (age - 27) * 0.5);
  }
  return Math.max(6, Math.min(17, games));
}

/**
 * Week-to-week volatility. Best ball is paid on the maximum, so the spread matters as
 * much as the mean, and it varies systematically by position — a tight end's weeks are
 * far more uneven than a quarterback's relative to what he averages.
 *
 * Expressed as a coefficient of variation so it scales with the projection: taken from
 * the player's own weekly spread where he has enough weeks, otherwise from his position.
 */
const POSITION_CV = { QB: 0.42, RB: 0.62, WR: 0.68, TE: 0.72 };

function weeklyVolatility(seasons, position, ppg) {
  const norm = POSITION_CV[position] ?? 0.65;
  const withSd = seasons.slice(0, 3).filter(s => s.week_sd != null && s.ppg > 1);
  if (withSd.length === 0 || ppg <= 0) return norm;

  const cvs = withSd.map(s => s.week_sd / Math.max(s.ppg, 1));
  const own = cvs.reduce((a, b) => a + b, 0) / cvs.length;
  // Shrink toward the positional norm; a single season's weekly spread is itself noisy.
  const w = withSd.length / (withSd.length + 2);
  return Math.max(0.25, Math.min(1.4, own * w + norm * (1 - w)));
}

/**
 * Simulate a season week by week and report the distribution.
 *
 * Weekly scores are drawn from a gamma-shaped distribution rather than a normal one:
 * fantasy weeks are bounded below at roughly zero and have a long right tail, and a
 * normal draw produces negative weeks and no spike weeks, which is exactly backwards
 * for valuing best ball.
 *
 * `bestBallWeeks` is the count of weeks the best-ball format actually scores; summing
 * the top N weeks approximates what an auto-started optimal lineup captures from one
 * player, which is what makes a boom/bust player worth more here than his mean says.
 */
/**
 * A small deterministic generator, seeded per player.
 *
 * The simulation must not use Math.random. Two refreshes over identical data would then
 * return slightly different projections, and a column that moves when nothing moved
 * reads as a model that cannot make its mind up — the one thing a number with no second
 * source behind it cannot afford. Seeding from the player's own id also keeps each
 * player independent of the order they happen to be processed in.
 */
function seededRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string, so a player's seed never changes between runs. */
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function simulateSeason(ppg, games, cv, { iterations = 400, bestBallWeeks = 14, rng = null, seed = 1 } = {}) {
  rng = rng || seededRng(hashSeed(seed));
  if (!(ppg > 0)) return null;

  // Gamma via the shape/scale of a sum of exponentials is slow; a Gaussian-to-gamma
  // moment match through a lognormal is adequate here and far cheaper. sigma is derived
  // so the lognormal's coefficient of variation matches cv.
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  const mu = Math.log(Math.max(ppg, 0.01)) - (sigma * sigma) / 2;

  const totals = [];
  const bestBall = [];

  // Box–Muller, two normals per call.
  let spare = null;
  const normal = () => {
    if (spare != null) { const s = spare; spare = null; return s; }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * f;
    return u * f;
  };

  for (let i = 0; i < iterations; i++) {
    // Games played varies too — availability is a large part of season-long spread.
    const played = Math.max(1, Math.round(games + normal() * 1.8));
    const capped = Math.min(17, played);
    const weeks = [];
    for (let w = 0; w < capped; w++) weeks.push(Math.exp(mu + sigma * normal()));

    totals.push(weeks.reduce((a, b) => a + b, 0));
    // Best ball scores a player only in the weeks his score is good enough to start,
    // approximated by his own best weeks up to the scoring-week count.
    weeks.sort((a, b) => b - a);
    bestBall.push(weeks.slice(0, bestBallWeeks).reduce((a, b) => a + b, 0));
  }

  totals.sort((a, b) => a - b);
  bestBall.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

  return {
    mean: totals.reduce((a, b) => a + b, 0) / totals.length,
    floor: q(totals, 0.15),
    ceiling: q(totals, 0.85),
    p50: q(totals, 0.5),
    best_ball: bestBall.reduce((a, b) => a + b, 0) / bestBall.length,
    best_ball_ceiling: q(bestBall, 0.85),
  };
}

/**
 * Replacement level, and value over it.
 *
 * This is what makes a quarterback's 320 points comparable with a running back's 210.
 * Replacement level is the projection of the last starter who would realistically be
 * drafted at that position given league size and starting requirements — so it moves
 * with the league, and a superflex league's replacement quarterback is a far better
 * player than a 1QB league's.
 *
 * Flex is distributed across RB/WR/TE by how the position actually flows into it rather
 * than evenly, because a flex spot is overwhelmingly a running back or a receiver.
 */
const FLEX_SHARE = { RB: 0.4, WR: 0.45, TE: 0.15 };

function replacementLevels(players, { teams = 12, leagueType = '1QB', starters = null } = {}) {
  const slots = starters || {
    QB: leagueType === '2QB' ? 1.7 : 1,   // superflex is not quite two: not every team starts a second
    RB: 2,
    WR: 3,
    TE: 1,
    FLEX: 1,
  };

  const levels = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const flex = pos === 'QB' ? 0 : (slots.FLEX || 0) * (FLEX_SHARE[pos] || 0);
    // The index of the last startable player at this position across the league.
    const depth = Math.max(1, Math.round(teams * ((slots[pos] || 0) + flex)));

    const ranked = players
      .filter(p => p.position === pos && p.points != null)
      .sort((a, b) => b.points - a.points);

    if (ranked.length === 0) { levels[pos] = 0; continue; }
    // Average the few players around the boundary rather than taking one, so a single
    // odd projection cannot move an entire position's value.
    const lo = Math.max(0, depth - 2);
    const hi = Math.min(ranked.length, depth + 3);
    const band = ranked.slice(lo, hi);
    levels[pos] = band.length
      ? band.reduce((a, p) => a + p.points, 0) / band.length
      : ranked[ranked.length - 1].points;
  }
  return levels;
}

module.exports = {
  expectedPointsPerGame, expectedGames, weeklyVolatility, simulateSeason,
  replacementLevels, seededRng, hashSeed,
  ENV_EXPONENT, POSITION_GAMES, POSITION_CV, FLEX_SHARE,
};
