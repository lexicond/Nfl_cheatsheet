/**
 * How much of each metric carries from one season to the next — measured here, on this
 * repo's own data, rather than taken on faith from a published study.
 *
 * The shrinkage weights this produces are the single highest-leverage choice in the
 * model. A metric that barely repeats (touchdown rate) must be pulled hard toward its
 * positional baseline; one that repeats well (target share) should be left close to
 * what the player actually did. Getting this backwards produces a projection that
 * chases last season's touchdown luck, which is the most common way a fantasy model
 * is wrong.
 *
 * The published figures — Fantasy Footballers' sticky-stats work, Sharp on RB YPC at
 * about 0.30, FantasyLife on TE receiving TDs at about 0.28 — are used only as a sanity
 * check on what is measured here, never as the inputs themselves. Sample sizes, seasons
 * and positional splits all differ between studies, so borrowing their coefficients
 * directly would be importing someone else's dataset into this one's weights.
 */

/** Pearson correlation over paired values. */
function correlation(pairs) {
  const n = pairs.length;
  if (n < 8) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; }
  const mx = sx / n;
  const my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}

// Metric -> the opportunity count that gives it its sample size. A rate measured over
// nine targets is not evidence, so pairs below the floor are excluded from the estimate
// and the floor is also what the shrinkage formula counts against.
const OPPORTUNITY_FIELD = {
  target_share: 'games',
  air_yards_share: 'games',
  wopr: 'games',
  targets_pg: 'games',
  carries_pg: 'games',
  attempts_pg: 'games',
  yards_per_target: 'targets',
  catch_rate: 'targets',
  adot: 'targets',
  rec_td_rate: 'targets',
  yards_per_carry: 'carries',
  rush_td_rate: 'carries',
  yards_per_attempt: 'attempts',
  pass_td_rate: 'attempts',
  int_rate: 'attempts',
};

// Minimum opportunities for a season to enter the stability estimate at all.
const MIN_OPPORTUNITIES = {
  games: 6, targets: 30, carries: 40, attempts: 150,
};

/**
 * Year-over-year correlation for one metric at one position, over consecutive season
 * pairs for the same player.
 */
function measureMetric(history, position, metric) {
  const field = OPPORTUNITY_FIELD[metric];
  const floor = MIN_OPPORTUNITIES[field];
  const pairs = [];

  for (const seasons of history.values()) {
    // history is newest-first; walk so `prev` is the earlier season.
    for (let i = 0; i < seasons.length - 1; i++) {
      const next = seasons[i];
      const prev = seasons[i + 1];
      if (next.season !== prev.season + 1) continue;         // consecutive only
      if (next.position !== position || prev.position !== position) continue;
      if (prev[metric] == null || next[metric] == null) continue;
      if (prev[field] < floor || next[field] < floor) continue;
      pairs.push([prev[metric], next[metric]]);
    }
  }

  return { metric, position, r: correlation(pairs), n: pairs.length };
}

const METRICS = Object.keys(OPPORTUNITY_FIELD);
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/**
 * Measure every metric at every position, and turn each into an empirical-Bayes
 * shrinkage constant.
 *
 * For a rate observed over n opportunities, the shrunk estimate is
 *
 *     w · player_rate + (1 − w) · baseline,   w = n / (n + k)
 *
 * k is the number of opportunities at which the player's own rate deserves half the
 * weight. Deriving it from the measured reliability r at the typical sample size n0
 * gives k = n0 · (1 − r) / r: a metric that repeats well earns a small k and keeps most
 * of its own signal, one that barely repeats gets a large k and is pulled to baseline.
 *
 * Unmeasurable metrics (too few pairs) fall back to a deliberately pessimistic r, so a
 * metric we cannot vouch for is regressed hard rather than trusted by default.
 */
const FALLBACK_R = 0.25;

// Typical single-season opportunity counts, the n0 the reliability is measured at.
const TYPICAL_N = {
  games: 15, targets: 90, carries: 150, attempts: 480,
};

function buildStability(history) {
  const out = {};
  const measured = [];

  for (const position of POSITIONS) {
    out[position] = {};
    for (const metric of METRICS) {
      const m = measureMetric(history, position, metric);
      const field = OPPORTUNITY_FIELD[metric];
      const n0 = TYPICAL_N[field];

      // A negative or tiny correlation means the metric carries nothing; clamp so k
      // stays finite and the metric is simply replaced by its baseline.
      const r = (m.r != null && m.n >= 15) ? Math.max(0.02, Math.min(0.95, m.r)) : FALLBACK_R;
      const k = n0 * (1 - r) / r;

      out[position][metric] = {
        r: m.r,
        measured: m.r != null && m.n >= 15,
        pairs: m.n,
        k: Math.round(k * 10) / 10,
        opportunity_field: field,
      };
      if (m.r != null && m.n >= 15) measured.push({ position, metric, r: m.r, n: m.n });
    }
  }

  return { table: out, measured };
}

/**
 * Shrink one observed rate toward a baseline, given the opportunities behind it.
 * Returns the baseline unchanged when there is no observation to shrink.
 */
function shrink(observed, opportunities, baseline, k) {
  if (baseline == null) return observed;
  if (observed == null || !Number.isFinite(observed)) return baseline;
  const n = Math.max(0, Number(opportunities) || 0);
  const w = n / (n + k);
  return w * observed + (1 - w) * baseline;
}

module.exports = {
  correlation, measureMetric, buildStability, shrink,
  METRICS, POSITIONS, OPPORTUNITY_FIELD, MIN_OPPORTUNITIES, TYPICAL_N, FALLBACK_R,
};
