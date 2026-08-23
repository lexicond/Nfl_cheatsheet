/**
 * Module A — volume, or opportunity.
 *
 * The most stable and most valuable of the three modules. Targets, carries and pass
 * attempts per game repeat year to year far better than anything a player does with
 * them (see stability.js, which measures it: WR target share carries at about 0.77,
 * yards per target at about 0.31). So this module leans on what a player's role
 * actually was, and shrinks it only lightly.
 *
 * Three seasons, recency-weighted. A role from three years ago is weak evidence about
 * this one, but throwing it away entirely makes a single injury-shortened season the
 * whole prior.
 */
const { shrink } = require('./stability');

// Recency weights, newest first. A season is only counted if the player has one.
const RECENCY = [0.6, 0.28, 0.12];

// Volume metrics projected per game.
const VOLUME_METRICS = ['targets_pg', 'carries_pg', 'attempts_pg', 'target_share', 'air_yards_share'];

/**
 * Weighted mean of a metric across a player's seasons, weighting by recency and by how
 * many games each season carries. A three-game season should not count as much as a
 * seventeen-game one at the same distance in the past.
 */
function weightedMean(seasons, metric, { maxSeasons = 3, recency = RECENCY } = {}) {
  let num = 0;
  let den = 0;
  let opportunities = 0;
  let games = 0;

  seasons.slice(0, maxSeasons).forEach((s, i) => {
    const v = s[metric];
    if (v == null || !Number.isFinite(v)) return;
    const weight = recency[i] ?? 0;
    // A season carrying no recency weight contributes nothing to the value, so it must
    // not contribute to the confidence either. Counting its games would tell the
    // shrinkage step that a single-season estimate rests on three seasons of evidence,
    // and leave a thin sample barely regressed.
    if (weight <= 0) return;
    // Games are the confidence in a per-game rate; cap so a 17-game season does not
    // completely drown a 12-game one.
    const w = weight * Math.min(s.games, 17);
    num += v * w;
    den += w;
    opportunities += s.games;
    games += s.games;
  });

  return { value: den > 0 ? num / den : null, weight: den, games, opportunities };
}

/**
 * Positional per-game volume baselines, over players with a real role. These are what a
 * thin sample gets shrunk toward — deliberately a "replacement starter" level rather
 * than a league-wide mean including everyone who took one snap.
 */
function volumeBaselines(history) {
  const buckets = {};
  for (const seasons of history.values()) {
    for (const s of seasons) {
      if (!s.position || s.games < 6) continue;
      (buckets[s.position] = buckets[s.position] || []).push(s);
    }
  }
  const out = {};
  for (const [pos, list] of Object.entries(buckets)) {
    out[pos] = {};
    for (const metric of VOLUME_METRICS) {
      const vals = list.map(s => s[metric]).filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
      out[pos][metric] = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
    }
  }
  return out;
}

/**
 * Project one player's per-game opportunity for the coming season.
 *
 * The environment's pass lean tilts the split between throwing and running: a team
 * expected to trail throws more, which lifts its pass-catchers' targets and trims its
 * backs' carries. It is applied to volume, not to efficiency, because that is where
 * game script actually acts.
 */
function projectVolume(seasons, position, baselines, stability, env, tuning = {}) {
  const base = baselines[position] || {};
  const stab = stability[position] || {};
  const out = {};

  for (const metric of VOLUME_METRICS) {
    const { value, games } = weightedMean(seasons, metric, { recency: tuning.recency || RECENCY });
    const k = (stab[metric]?.k ?? 8) * (tuning.volumeShrink ?? 1);
    // Games are the sample size for a per-game rate.
    out[metric] = shrink(value, games, base[metric] ?? 0, k);
  }

  const lean = env?.pass_lean ?? 0;
  // Pass lean moves targets and attempts up and carries down, or the reverse.
  out.targets_pg = Math.max(0, out.targets_pg * (1 + lean));
  out.attempts_pg = Math.max(0, out.attempts_pg * (1 + lean));
  out.carries_pg = Math.max(0, out.carries_pg * (1 - lean));

  out.opportunities_pg = out.targets_pg + out.carries_pg;
  return out;
}

module.exports = { projectVolume, volumeBaselines, weightedMean, RECENCY, VOLUME_METRICS };
