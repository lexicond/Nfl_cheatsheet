/**
 * The ageing curve — MEASURED, not assumed.
 *
 * Every other forward-looking input in this model is somebody else's statement about the
 * coming season: the depth chart says who is starting, the betting market says how much
 * each offence will score. Age is the one thing the model can know about next season from
 * its own data, and until this file existed it knew it and did not use it — the crosswalk
 * carries an age for all 456 projected players and nothing read it. That is most of why a
 * thirty-year-old running back coming off a good year projected as though he were
 * twenty-five: nothing in the model had any way to say otherwise.
 *
 * What is measured here is consecutive-season pairs — the same player, seasons n and n+1,
 * with a real role in both — and how his per-game production changed. Two curves come out
 * of it, because the decline is not one thing:
 *
 *   volume      how much his OPPORTUNITY changed. This is the larger half and it is not
 *               really ageing at all, it is losing the job. A 29-year-old back keeps 81%
 *               of his touches; at 32 a receiver keeps 63% of his targets.
 *   efficiency  what is left once opportunity is accounted for — what he did with the
 *               touches he kept. Smaller, and at some ages it is nothing.
 *
 * They are applied in the modules they belong to, so the decomposition stays honest and
 * so the conservation step sees it: when an ageing back's carries come down, they go back
 * into his team's budget and are shared out among the men who took them.
 *
 * THE LEVEL OF THIS CURVE IS NOT AGEING AND MUST NOT BE APPLIED.
 *
 * The median next-season ratio is below 1 at EVERY age, including 22 — a 21-24 running
 * back comes out at 0.93. That is regression to the mean, not decline: pairs are selected
 * on having held a role in both seasons, and a season good enough to notice tends to be
 * followed by a worse one. The shrinkage step already handles that, and applying it again
 * here would quietly shave every player on the board. So each curve is divided by its own
 * position's overall median before anything is applied, which leaves only the DIFFERENCE
 * between one age and another — the part that is actually about age.
 *
 * Two further regularisations, for the same reason stability.js has them. The age cells
 * are thin — seven or eight quarterbacks a year past 32 — so the raw medians are noisy and
 * not monotone: tight ends came out at 0.95 for a 22-year-old against 1.08 for a
 * 24-year-old on eight players, which read as a penalty for being young and put Harold
 * Fannin below men four years older. A sliding window pools neighbouring ages, and the
 * result is then fitted monotone non-increasing, because that is the one thing actually
 * known about ageing in advance: nobody gets better at thirty than he was at twenty-nine.
 * What survives is a shape anyone who watches football would recognise — backs fall off a
 * cliff at 29, receivers decline gently from 27 and sharply past 32, tight ends and
 * quarterbacks barely at all until the very end.
 */

// A pair only counts if he had a real role in both seasons — otherwise this measures
// injury and job loss, which is the availability question the model deliberately refuses.
const MIN_GAMES = 8;
// Ratios off a tiny base are all noise; 3 points a game is roughly a fourth receiver.
const MIN_PPG = 3;
// Ages either side of the target pooled into its estimate.
const WINDOW = 1;
// A cell needs this many pairs before it is believed at all.
const MIN_CELL = 12;
// A monotone fit weights each age by how many players it actually rests on, so a cell of
// eight cannot drag a cell of eighty.
// How far a single year of age is ever allowed to move a projection. The measured tails
// go further than this, but on eight players.
const CLAMP = [0.7, 1.08];
// Below the youngest and above the oldest age with enough data, the curve holds flat
// rather than extrapolating a trend off the end of the evidence.
const AGE_MIN = 21;
const AGE_MAX = 38;

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const opportunityOf = s => (s.targets_pg || 0) + (s.carries_pg || 0) + (s.attempts_pg || 0);

/**
 * Consecutive-season pairs with the player's age in the LATER season, which is the season
 * being predicted and therefore the age the curve is indexed by.
 *
 * `ageAt(gsis, season)` returns his age in that season, or null. Ages come from the
 * crosswalk, which carries a current age — so a season's age is that minus the years
 * since. Coarse, but it is coarse in the same direction for everybody.
 */
function buildPairs(history, ageAt) {
  const pairs = [];
  for (const [gsis, list] of history) {
    const bySeason = new Map(list.map(s => [s.season, s]));
    for (const s of list) {
      const next = bySeason.get(s.season + 1);
      if (!next) continue;
      if (s.games < MIN_GAMES || next.games < MIN_GAMES) continue;
      if (!(s.ppg >= MIN_PPG)) continue;
      const position = next.position || s.position;
      if (!position) continue;
      const age = ageAt(gsis, s.season + 1);
      if (age == null || !Number.isFinite(age)) continue;
      const opp = opportunityOf(s);
      if (!(opp > 0)) continue;
      pairs.push({
        position,
        age: Math.round(age),
        ppg_ratio: next.ppg / s.ppg,
        opp_ratio: opportunityOf(next) / opp,
      });
    }
  }
  return pairs;
}

/**
 * One curve, for one position and one measured ratio.
 *
 * Returns a map of age -> multiplier, already normalised so that the position's own
 * average player is 1.0, smoothed across neighbouring ages, and non-increasing past the
 * age at which it peaks.
 */
/**
 * Pool adjacent violators: the least-squares fit that is non-increasing, weighted.
 *
 * Wherever the measured curve goes back up — which at these sample sizes it does, in every
 * position — the offending ages are merged into one block at their weighted mean, and the
 * merge cascades left until the sequence is monotone again. It is the standard isotonic
 * fit and it is the right tool: it changes the curve only where the data contradicts
 * monotonicity, and leaves a genuine plateau alone.
 */
function poolAdjacentViolators(values, weights) {
  const blocks = values.map((v, i) => ({ sum: v * weights[i], w: weights[i], len: 1 }));
  const out = [];
  for (const b of blocks) {
    let cur = b;
    while (out.length && out[out.length - 1].sum / out[out.length - 1].w < cur.sum / cur.w) {
      const prev = out.pop();
      cur = { sum: prev.sum + cur.sum, w: prev.w + cur.w, len: prev.len + cur.len };
    }
    out.push(cur);
  }
  const fitted = [];
  for (const b of out) for (let i = 0; i < b.len; i++) fitted.push(b.sum / b.w);
  return fitted;
}

function fitCurve(pairs, key) {
  const all = pairs.filter(p => Number.isFinite(p[key]) && p[key] > 0);
  if (all.length < MIN_CELL * 3) return null;

  const ages = [];
  const raw = [];
  const weights = [];
  for (let age = AGE_MIN; age <= AGE_MAX; age++) {
    const cell = all.filter(p => Math.abs(p.age - age) <= WINDOW).map(p => p[key]);
    if (cell.length < MIN_CELL) continue;
    ages.push(age);
    raw.push(median(cell));
    // The players actually AT this age, not the windowed pool — otherwise every age
    // carries roughly the same weight and the thin tails count as much as the middle.
    weights.push(Math.max(1, all.filter(p => p.age === age).length));
  }
  if (ages.length < 3) return null;

  const fitted = poolAdjacentViolators(raw, weights);

  // Normalised so the AVERAGE player comes out at 1.0. This is the step that separates
  // ageing from regression to the mean — see the warning at the top of this file. Without
  // it the whole curve sits below 1 and every player on the board is quietly shaved.
  const totalW = weights.reduce((a, b) => a + b, 0);
  const centre = fitted.reduce((a, v, i) => a + v * weights[i], 0) / (totalW || 1);
  if (!(centre > 0)) return null;

  const curve = new Map();
  ages.forEach((age, i) => {
    curve.set(age, Math.max(CLAMP[0], Math.min(CLAMP[1], fitted[i] / centre)));
  });
  // The oldest age at which the curve is still at its maximum — i.e. where decline starts.
  const top = Math.max(...curve.values());
  const peak = Math.max(...[...curve.entries()].filter(([, v]) => v >= top - 1e-9).map(([a]) => a));
  return { curve, peak, n: all.length, centre };
}

/**
 * Build both curves for every position.
 *
 * Returns { table, sample } where table is position -> { volume: Map, efficiency: Map }.
 * A position with too little data gets no curve at all and is left alone, which is the
 * right failure: no adjustment is a defensible claim, a made-up one is not.
 */
function buildAgeCurves(history, ageAt) {
  const pairs = buildPairs(history, ageAt);
  const table = {};
  const sample = { pairs: pairs.length, positions: {} };

  for (const position of ['QB', 'RB', 'WR', 'TE']) {
    const sub = pairs.filter(p => p.position === position);
    const volume = fitCurve(sub, 'opp_ratio');
    if (!volume) continue;

    // Efficiency is the RESIDUAL: what changed once the change in opportunity is
    // accounted for. Measured directly as ppg-per-opportunity rather than fitted
    // separately, so that volume x efficiency reconstructs the whole measured decline
    // and neither half double-counts the other.
    const withRate = sub.map(p => ({ ...p, rate_ratio: p.opp_ratio > 0 ? p.ppg_ratio / p.opp_ratio : null }));
    const efficiency = fitCurve(withRate, 'rate_ratio');
    if (!efficiency) continue;

    table[position] = { volume: volume.curve, efficiency: efficiency.curve };
    sample.positions[position] = {
      n: volume.n,
      peak_volume: volume.peak,
      peak_efficiency: efficiency.peak,
    };
  }
  return { table, sample };
}

/**
 * Look one age up. Outside the measured range the curve holds flat at its nearest end —
 * extrapolating a decline off the end of the evidence is exactly how a model comes to
 * project a 39-year-old at zero on no data at all.
 */
function ageMultiplier(table, position, age, kind) {
  const entry = table?.[position]?.[kind];
  if (!entry || age == null || !Number.isFinite(age)) return 1;
  const a = Math.round(age);
  if (entry.has(a)) return entry.get(a);
  const ages = [...entry.keys()].sort((x, y) => x - y);
  if (!ages.length) return 1;
  if (a < ages[0]) return entry.get(ages[0]);
  return entry.get(ages[ages.length - 1]);
}

module.exports = {
  buildAgeCurves, ageMultiplier, buildPairs, fitCurve, poolAdjacentViolators,
  MIN_GAMES, MIN_PPG, WINDOW, MIN_CELL, CLAMP,
};
