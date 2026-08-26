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

/**
 * Per-game opportunity by depth-chart rank, measured over the 2022–24 charts against
 * what those players actually did. Medians, over players who appeared at all.
 *
 *            targets/g   carries/g   attempts/g
 *   QB 1        —           3.36        32.06
 *   QB 2        —           1.83        14.00
 *   RB 1       2.58        11.86          —
 *   RB 2       1.50         5.00          —
 *   RB 3       1.00         3.88          —
 *   WR 1       5.13          —            —
 *   WR 2       2.54          —            —
 *   TE 1       4.19          —            —
 *   TE 2       2.00          —            —
 *
 * A backup gets roughly half a starter's per-game work. This matters because a player's
 * own history is not a clean read on his current role: Zach Charbonnet's per-game rate
 * comes from games he started with Kenneth Walker hurt, so projecting him a full season
 * at that rate made him a 170-point back when Sleeper had him at 62. Shrinking toward
 * the baseline for the rank he actually holds now is the fix, and it is the same
 * empirical-Bayes step the model already applies — just aimed at the right target.
 */
// How many men a position actually plays at once.
//
// The backup cap below exists because you cannot take a starter's touches while another man
// is listed ahead of you. That is true of a backfield and it is not true of a receiving
// corps: a base offence puts three receivers on the field together, so a WR2 is a starter
// with a different route tree, not a backup. Applying the cap from rank two pinned George
// Pickens, Tee Higgins, Jameson Williams and Davante Adams — every one of them a genuine
// first-choice receiver listed second — at 3.2 targets a game, which is a fourth receiver's
// workload. It cost draftable receivers about 17% against Sleeper across the board.
//
// The cap and the rank baseline both still apply beyond these counts, which is where the
// original cases live: Isiah Pacheco and Zach Charbonnet are second running backs behind one
// starter, and that is exactly the situation the cap was measured on.
const SIMULTANEOUS_STARTERS = { QB: 1, RB: 1, WR: 2, TE: 1 };

// How fast the allowance keeps falling past third on the chart.
//
// The table below stops at three, and clamping everyone deeper to that row handed a WR7 a
// WR3's workload. Las Vegas is what that costs: Dont'e Thornton (seventh) and Noah Brown
// (seventh) projected 43 and 34 points against Sleeper's 3.7 and 7.3, and their targets went
// into the team's total. The conservation step then scaled every Raiders receiver down by
// 40% to fit the budget, which is how Brock Bowers — a genuine TE1 on 9.0 targets a game in
// 2024 — came out at 100 points against Sleeper's 202. The error was made by the fringe
// players and paid for by the starter.
const DEEP_DECAY = 0.7;

// A player Sleeper carries on the roster but does not place on the chart at all. Read as
// "no rank known" he escaped the backup cap entirely and projected like a starter: Raheem
// Mostert came out at 84 points against Sleeper's 10. Unranked is not first — that mistake
// is documented and guarded elsewhere — but nor is it unknown. In practice it means deep.
const UNRANKED_DEPTH = 5;

const DEPTH_VOLUME = {
  QB: [{ attempts_pg: 32.06, carries_pg: 3.36 }, { attempts_pg: 14.0, carries_pg: 1.83 }, { attempts_pg: 8.0, carries_pg: 1.5 }],
  RB: [{ targets_pg: 2.58, carries_pg: 11.86 }, { targets_pg: 1.5, carries_pg: 5.0 }, { targets_pg: 1.0, carries_pg: 3.88 }],
  WR: [{ targets_pg: 5.13 }, { targets_pg: 2.54 }, { targets_pg: 2.14 }],
  TE: [{ targets_pg: 4.19 }, { targets_pg: 2.0 }, { targets_pg: 1.5 }],
};

/**
 * The typical workload for a rank, continuing to fall past the end of the table.
 *
 * Ranks one to three come from measured usage. Beyond that the table has nothing to say, so
 * the third row decays geometrically rather than flattening — a seventh receiver is not a
 * third receiver, and treating him as one puts phantom targets into his team's budget.
 */
function depthAllowance(position, depthOrder) {
  const table = DEPTH_VOLUME[position];
  if (!table) return null;
  const rank = Math.max(1, depthOrder);
  const row = table[Math.min(rank, table.length) - 1];
  if (!row) return null;
  if (rank <= table.length) return row;
  const decay = DEEP_DECAY ** (rank - table.length);
  const out = {};
  for (const [metric, value] of Object.entries(row)) out[metric] = value * decay;
  return out;
}

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
function projectVolume(seasons, position, baselines, stability, env, tuning = {}, depthOrder = null, ageMultiplier = 1) {
  const base = baselines[position] || {};
  const stab = stability[position] || {};
  const out = {};

  // Where the depth chart names his rank, shrink toward what that rank typically does
  // rather than toward the position at large. His own history may be a different job.
  const rankBase = (depthOrder != null && (tuning.useDepthVolume ?? true))
    ? depthAllowance(position, depthOrder)
    : null;


  // How far above his rank's typical workload a backup is allowed to project. Some
  // headroom for a good player in a committee, but not a starter's share: you cannot
  // take a starter's touches while another man is listed ahead of you.
  const BACKUP_HEADROOM = tuning.backupHeadroom ?? 1.25;

  for (const metric of VOLUME_METRICS) {
    const { value, games } = weightedMean(seasons, metric, { recency: tuning.recency || RECENCY });
    const k = (stab[metric]?.k ?? 8) * (tuning.volumeShrink ?? 1);
    const target = (rankBase && rankBase[metric] != null) ? rankBase[metric] : (base[metric] ?? 0);
    // Games are the sample size for a per-game rate.
    out[metric] = shrink(value, games, target, k);
  }

  // Cap a backup on TOTAL opportunity, not metric by metric.
  //
  // Shrinking toward the rank baseline is not enough on its own: a backup with a long
  // history of starting keeps most of his own rate, because the sample is large — and
  // large about a different job. Isiah Pacheco, listed second, projected 119 points
  // against Sleeper's 49 until this went in.
  //
  // But capping each metric separately destroys the thing a committee backfield is made
  // of. Washington runs Jacory Croskey-Merritt and gives Rachaad White the passing down;
  // a per-metric cap holds White's targets to a second-string average and erases the
  // specialist role entirely. What a backup cannot do is out-touch the starter overall.
  // What he certainly can do is out-target him. So the ceiling is on the sum, and when
  // it binds everything scales together — the mix he has earned survives, only its size
  // is limited.
  const startersHere = SIMULTANEOUS_STARTERS[position] ?? 1;
  if (depthOrder != null && depthOrder > startersHere && rankBase) {
    const metrics = VOLUME_METRICS.filter(m => rankBase[m] != null);
    const projected = metrics.reduce((a, m) => a + (out[m] || 0), 0);
    const allowed = metrics.reduce((a, m) => a + rankBase[m], 0) * BACKUP_HEADROOM;
    if (projected > allowed && projected > 0) {
      const scale = allowed / projected;
      for (const m of metrics) out[m] *= scale;
    }
  }

  // Ageing, applied to opportunity — see model/age.js. This is the larger half of what
  // happens to an older player and it is not really decline at all: it is losing the job.
  // A 29-year-old back keeps about 81% of his touches and a 32-year-old receiver 63% of
  // his targets, measured over consecutive seasons in which he held a role in both.
  //
  // It goes here, ahead of the game-script lean and before anything downstream sums a
  // team, so that the touches an ageing player gives up are visible to the conservation
  // step and land on the players who actually take them.
  if (ageMultiplier !== 1 && Number.isFinite(ageMultiplier)) {
    for (const metric of ['targets_pg', 'carries_pg', 'attempts_pg']) {
      if (out[metric] != null) out[metric] *= ageMultiplier;
    }
  }

  const lean = env?.pass_lean ?? 0;
  // Pass lean moves targets and attempts up and carries down, or the reverse.
  out.targets_pg = Math.max(0, out.targets_pg * (1 + lean));
  out.attempts_pg = Math.max(0, out.attempts_pg * (1 + lean));
  out.carries_pg = Math.max(0, out.carries_pg * (1 - lean));

  out.opportunities_pg = out.targets_pg + out.carries_pg;
  return out;
}

module.exports = {
  projectVolume, volumeBaselines, weightedMean, depthAllowance,
  RECENCY, VOLUME_METRICS, DEPTH_VOLUME, UNRANKED_DEPTH, SIMULTANEOUS_STARTERS,
};
