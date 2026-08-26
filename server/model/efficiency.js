/**
 * Module B — efficiency, conditional on volume.
 *
 * What a player does per opportunity. This is the noisy half, and the whole job of this
 * module is to refuse to believe most of it. stability.js measures the damage: a running
 * back's yards per carry repeats at about 0.04 year to year and his rushing touchdown
 * rate at about 0.11, which means last season's figures are very nearly noise. Target
 * share, by contrast, repeats at about 0.77 — but that lives in Module A.
 *
 * So every rate here is an empirical-Bayes blend of what the player did and what his
 * position typically does, with the weight on his own number set by the reliability
 * measured for that exact metric at that exact position, and by how many opportunities
 * he had. Touchdown rates end up almost entirely at baseline. Air-yards-driven metrics
 * like aDOT, which genuinely belong to the receiver, keep most of their own signal.
 */
const { shrink } = require('./stability');
const { weightedMean } = require('./volume');

// Rate -> the opportunity count it is measured over.
const EFFICIENCY_METRICS = {
  yards_per_target: 'targets',
  catch_rate: 'targets',
  rec_td_rate: 'targets',
  adot: 'targets',
  yards_per_carry: 'carries',
  rush_td_rate: 'carries',
  yards_per_attempt: 'attempts',
  pass_td_rate: 'attempts',
  int_rate: 'attempts',
};

/**
 * Total opportunities a player accumulated in a metric's denominator across the seasons
 * in the window. This — not games — is the sample size that decides how much of his own
 * rate he keeps: a back with 700 carries behind him has earned more trust in his YPC
 * than one with 40.
 *
 * Note the deliberate asymmetry with Module A. The recency weights currently put all the
 * weight on the most recent season for the LEVEL of a rate, but the sample size counted
 * here still spans the whole window. That is intentional rather than an oversight: a
 * player's career volume is real evidence about his underlying efficiency even when the
 * best estimate of his current form is his latest season. It does mean the shrinkage is
 * lighter than a strictly single-season empirical-Bayes treatment would give, which is
 * part of why the tuned efficiency shrinkage multiplier came out at 0.5 rather than 1 —
 * the two were fitted together and should be changed together.
 */
function opportunityCount(seasons, field, maxSeasons = 3) {
  return seasons.slice(0, maxSeasons).reduce((a, s) => a + (Number(s[field]) || 0), 0);
}

/**
 * Project one player's per-opportunity rates.
 *
 * `fpoePrior` is the multi-year residual between what he actually scored and what his
 * opportunities implied — the expected-points-over-expected signal the PDF calls a
 * talent prior. It is applied as a small multiplier on yardage rates only, and it is
 * itself shrunk, because a single season of beating expectation is mostly luck.
 */
function projectEfficiency(seasons, position, baselines, stability, fpoePrior = 0, tuning = {}, ageMultiplier = 1) {
  const base = baselines[position] || {};
  const stab = stability[position] || {};
  const out = {};

  for (const [metric, field] of Object.entries(EFFICIENCY_METRICS)) {
    const { value } = weightedMean(seasons, metric, tuning.recency ? { recency: tuning.recency } : {});
    const opportunities = opportunityCount(seasons, field);
    const k = (stab[metric]?.k ?? 200) * (tuning.efficiencyShrink ?? 1);
    out[metric] = shrink(value, opportunities, base[metric] ?? null, k);
  }

  // The talent adjustment. Capped hard: this is the one place a model can talk itself
  // into a player being 30% better than his opportunities say, and it is the most common
  // way a projection becomes an opinion.
  const talent = 1 + Math.max(-0.08, Math.min(0.08, fpoePrior));
  for (const metric of ['yards_per_target', 'yards_per_carry', 'yards_per_attempt']) {
    if (out[metric] != null) out[metric] *= talent;
  }
  out.talent_multiplier = Math.round(talent * 1000) / 1000;

  // The residual half of ageing: what is left once the change in OPPORTUNITY is taken
  // out, which Module A has already applied. It is the smaller half — most of what looks
  // like an old player declining is an old player playing less — and at several ages it
  // is nothing at all. Applied to the yardage rates only, on the same grounds as the
  // talent prior: a touchdown rate is too noisy to carry a further multiplier, and
  // scoring rates are reconciled at the team level downstream anyway.
  if (ageMultiplier !== 1 && Number.isFinite(ageMultiplier)) {
    for (const metric of ['yards_per_target', 'yards_per_carry', 'yards_per_attempt']) {
      if (out[metric] != null) out[metric] *= ageMultiplier;
    }
  }
  out.age_multiplier = Math.round(ageMultiplier * 1000) / 1000;

  return out;
}

/**
 * The FPOE prior: how much a player has out-scored what a league-average player would
 * have scored on his opportunities, per opportunity, across the seasons available.
 *
 * This is the model's own retrodictive expected-points residual, computed from the same
 * baselines the projection uses, and it is used exactly as the architecture says xFP
 * should be used — as an INPUT talent prior, never as the output projection. It is
 * shrunk by sample size and clamped before it is ever applied.
 */
function fpoeResidual(seasons, position, baselines, maxSeasons = 3) {
  const base = baselines[position] || {};
  let actual = 0;
  let expected = 0;
  let opportunities = 0;

  for (const s of seasons.slice(0, maxSeasons)) {
    // Expected yards, if he had been exactly positional-average on his real volume.
    const expYards =
      (base.yards_per_target != null ? s.targets * base.yards_per_target : 0) +
      (base.yards_per_carry != null ? s.carries * base.yards_per_carry : 0) +
      (base.yards_per_attempt != null ? s.attempts * base.yards_per_attempt : 0);
    const actYards = s.receiving_yards + s.rushing_yards + s.passing_yards;
    if (expYards <= 0) continue;
    actual += actYards;
    expected += expYards;
    opportunities += s.targets + s.carries + s.attempts;
  }

  if (expected <= 0 || opportunities < 50) return 0;
  const raw = actual / expected - 1;
  // Shrink toward zero by sample size: 300 opportunities earns half weight.
  const w = opportunities / (opportunities + 300);
  return raw * w;
}

module.exports = { projectEfficiency, fpoeResidual, opportunityCount, EFFICIENCY_METRICS };
