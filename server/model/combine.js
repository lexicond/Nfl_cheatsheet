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
      // Touchdowns split by phase, not just totalled. A passing touchdown and the
      // receiving touchdown that scores it are the same event, so anything reconciling
      // a team's projected scoring has to be able to tell them apart — summing the
      // total would count every passing score twice.
      pass_tds_pg: Math.round(passTds * 1000) / 1000,
      rush_tds_pg: Math.round(rushTds * 1000) / 1000,
      rec_tds_pg: Math.round(recTds * 1000) / 1000,
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

// A season is seventeen games and a team plays its best players. Anyone with a role is
// projected for all of them.
const FULL_SEASON = 17;

/**
 * Expected games played — deliberately not a forecast.
 *
 * This used to weight each player's own recent availability and shrink it toward a
 * positional norm. It was the worst part of the model and it had to go. Two reasons,
 * one measured and one about what is knowable:
 *
 *   It does not work. Model games against games actually played came out at rho 0.25
 *   overall and 0.17 for non-quarterbacks — next to nothing. Meanwhile it was handing
 *   out a spread wide enough to dominate the projection: the median receiver was being
 *   projected for 9.5 games and the tenth percentile for 4.7, so two players with the
 *   same per-game rate could differ twofold on a component carrying no signal.
 *
 *   It is not knowable. An injury is close to random. What looks like durability is
 *   mostly role: across 2021–25 games played correlates 0.58 season to season, but hold
 *   role roughly fixed and it falls to 0.28, and among established starters having
 *   missed most of a season costs 1.8 games the next. Weighting a man's own injury
 *   history is fitting noise and quietly punishing players who got hurt once.
 *
 * So role decides who plays, and role is already in the per-game rates — a fourth
 * receiver's low target count is his role. Games is a constant, which means it drops out
 * of the ranking entirely and the ordering rests on the per-game rate, the part that
 * does carry signal (rho 0.755 against 0.733 for last season's rate).
 *
 * Quarterback is the one exception, handled in index.js: a backup takes no snaps at all
 * in a game he does not start, so a team's seventeen are shared out by depth chart. That
 * is role again, not injury.
 */
function expectedGames() {
  return FULL_SEASON;
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

/**
 * How wide the season distribution has to be to be honest.
 *
 * Simulating only week-to-week scoring noise around a known mean produces a band far too
 * narrow, because seventeen weeks average most of that noise away. Measured against five
 * seasons of outcomes, a band advertised as the 15th-to-85th percentile actually covered
 * 27% of them rather than 70%.
 *
 * What was missing is the uncertainty in the mean itself — whether the role holds, the
 * offence is what the market thinks, the player is the player he was. That is the larger
 * share of season-long spread and it does not shrink with more weeks. `seasonSigma` is a
 * lognormal draw on the whole rate, once per simulated season, and `gamesSd` carries the
 * availability that is deliberately not forecast per player but certainly happens. Both
 * are set by calibration, not taste.
 *
 * What they are calibrated TO matters, and the honest statement is narrow. Against
 * players who went on to play at least twelve games the band covers 72% of outcomes,
 * against the 70% it advertises. Against everybody it covers 35%, because the projection
 * is a full-season number and roughly half the pool does not get a full season. That gap
 * is not a fault in the band, it is the deliberate choice not to forecast injuries: the
 * projection says what a player scores if he holds his role and stays fit, and so does
 * the band around it. Mean projected points run about 1.45x mean actual for that reason,
 * which is the same property Sleeper's projections have.
 */
const SPREAD = { seasonSigma: 0.5, gamesSd: 3.0 };

function simulateSeason(ppg, games, cv, {
  iterations = 400, bestBallWeeks = 14, rng = null, seed = 1,
  seasonSigma = SPREAD.seasonSigma, gamesSd = SPREAD.gamesSd,
} = {}) {
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
    // Availability. Not a per-player forecast — the model refuses to make one — but a
    // season does get shortened and the distribution has to say so.
    const played = Math.max(1, Math.round(games + normal() * gamesSd));
    const capped = Math.min(17, played);
    // Uncertainty in the projection itself, drawn once for the whole season: the role
    // may not hold, the offence may not be what the market thinks. This is what makes
    // the band honest, and it is much the larger part of it.
    const seasonScale = Math.exp(seasonSigma * normal() - (seasonSigma * seasonSigma) / 2);
    const weeks = [];
    for (let w = 0; w < capped; w++) weeks.push(seasonScale * Math.exp(mu + sigma * normal()));

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
  replacementLevels, seededRng, hashSeed, FULL_SEASON, SPREAD,
  ENV_EXPONENT, POSITION_GAMES, POSITION_CV, FLEX_SHARE,
};
