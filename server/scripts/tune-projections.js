#!/usr/bin/env node
/**
 * Choose the model's hyperparameters honestly.
 *
 *   node server/scripts/tune-projections.js
 *
 * Sweeps recency weights and shrinkage strength, scores every candidate on a TUNING
 * season, then re-scores only the winner on a later VALIDATION season it was never
 * fitted against. The gap between the two is the honest estimate of what the choice is
 * worth; picking a setting by looking at the season you then quote is how a model comes
 * to beat a benchmark exactly once.
 *
 * Candidates are scored on VALUE OVER REPLACEMENT, not on raw projected points, because
 * that is what the board shows and what a draft decision turns on. The distinction is
 * not cosmetic: ranking every player together by raw points is dominated by the fact
 * that quarterbacks out-score everyone at four-point passing touchdowns, so a pooled
 * raw-points score mostly measures whether a model reproduces that positional offset —
 * a scale question, not a ranking one. Measured that way the model loses to "repeat
 * last season" while beating it at every individual position, which is Simpson's
 * paradox and not a real result. Measured on VOR, which removes the positional offset
 * by construction, it wins on both seasons tested.
 *
 * This is a development tool, not part of a refresh. It prints the numbers and the line
 * to paste into TUNING in server/model/index.js; it does not write to the model.
 */
const { runModel } = require('../model');
const nflverse = require('../model/nflverse');
const { aggregateSeason } = require('../model/usage');
const { correlation } = require('../model/stability');
const { replacementLevels } = require('../model/combine');

const DRAFT_DAY_WEEK = 6;

function spearman(pairs) {
  if (pairs.length < 10) return null;
  const rank = (idx) => {
    const order = pairs.map((p, i) => [p[idx], i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(pairs.length);
    order.forEach(([, i], k) => { r[i] = k + 1; });
    return r;
  };
  const a = rank(0);
  const b = rank(1);
  return correlation(a.map((v, i) => [v, b[i]]));
}

// The evaluation pool, and the naive benchmark, exactly as validate-projections builds
// them — so a number here means the same thing as a number there.
async function buildPool(testSeason) {
  const actual = aggregateSeason((await nflverse.loadSeasonStats(testSeason)).rows, testSeason);
  const prior = aggregateSeason((await nflverse.loadSeasonStats(testSeason - 1)).rows, testSeason - 1);
  const before = aggregateSeason((await nflverse.loadSeasonStats(testSeason - 2)).rows, testSeason - 2);

  // A player belongs in the pool if he had a real season in EITHER of the two years
  // before the test. Requiring it of the immediately prior season only — which is what
  // this did at first — quietly excludes the bounce-back: a player who was a starter two
  // years ago, lost most of last season to injury, and is being drafted this year on the
  // strength of the earlier season. That is precisely the case where how far back the
  // model looks decides the answer, so leaving it out of the pool meant the recency
  // weights were chosen without ever being tested on the players they matter most for.
  const pool = [];
  const seen = new Set();
  for (const source of [prior, before]) {
    for (const [gsis, p] of source) {
      if (seen.has(gsis) || p.games < 6 || !nflverse.POSITIONS.has(p.position)) continue;
      seen.add(gsis);
      const priorRec = prior.get(gsis);
      const act = actual.get(gsis);
      pool.push({
        gsis_id: gsis,
        position: p.position,
        // The naive benchmark is always last season's points, whether or not last season
        // is the one that qualified him — a player who missed it really did score little.
        prior_points: priorRec ? priorRec.points : 0,
        actual_points: act ? act.points : 0,
      });
    }
  }
  return pool;
}

async function score(testSeason, pool, tuning) {
  const proj = await runModel({
    targetSeason: testSeason,
    environmentMaxWeek: DRAFT_DAY_WEEK,
    useHistoryTeam: true,
    iterations: 120,
    tuning,
  });
  const byG = new Map(proj.projections.map(p => [p.gsis_id, p]));
  const pairs = [];
  const byPos = {};
  const scored = [];
  for (const r of pool) {
    const pr = byG.get(r.gsis_id);
    if (!pr) continue;
    pairs.push([pr.points, r.actual_points]);
    scored.push({ ...r, projected: pr.points });
    (byPos[r.position] = byPos[r.position] || []).push([pr.points, r.actual_points]);
  }
  // The benchmark is computed over exactly the players the model could score, never over
  // the whole pool. Scoring the two on different populations is not a comparison: once
  // the role gate began refusing players, the benchmark was being credited for a set of
  // easy cases — men who did nothing last season and nothing this one — that the model
  // was never shown. That alone moved the naive number by more than any hyperparameter.
  const out = {
    raw: spearman(pairs),
    vor: vorSpearman(scored, r => r.projected),
    naive_raw: spearman(scored.map(r => [r.prior_points, r.actual_points])),
    naive_vor: vorSpearman(scored, r => r.prior_points),
    n: pairs.length,
    positions: {},
    naive_positions: {},
  };
  for (const [pos, list] of Object.entries(byPos)) out.positions[pos] = spearman(list);
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const sub = scored.filter(r => r.position === pos);
    if (sub.length >= 10) out.naive_positions[pos] = spearman(sub.map(r => [r.prior_points, r.actual_points]));
  }
  return out;
}

/**
 * Rank on value over replacement rather than on raw points, for both the prediction and
 * the outcome. Replacement is recomputed from each series on its own scale, so a model
 * that is systematically high at one position is not rewarded or punished for it — only
 * for whether it ordered players correctly once that offset is gone.
 */
function vorSpearman(rows, predict) {
  const predLevels = replacementLevels(
    rows.map(r => ({ position: r.position, points: predict(r) })), { teams: 12, leagueType: '1QB' });
  const actLevels = replacementLevels(
    rows.map(r => ({ position: r.position, points: r.actual_points })), { teams: 12, leagueType: '1QB' });
  return spearman(rows.map(r => [
    predict(r) - (predLevels[r.position] ?? 0),
    r.actual_points - (actLevels[r.position] ?? 0),
  ]));
}

function naiveScore(pool) {
  const pairs = pool.map(r => [r.prior_points, r.actual_points]);
  const byPos = {};
  for (const r of pool) (byPos[r.position] = byPos[r.position] || []).push([r.prior_points, r.actual_points]);
  const out = {
    raw: spearman(pairs),
    vor: vorSpearman(pool, r => r.prior_points),
    positions: {},
  };
  for (const [pos, list] of Object.entries(byPos)) out.positions[pos] = spearman(list);
  return out;
}

// Candidate recency weightings, from "last season only" to the original flat spread.
// Weights are multiplied by games played, so these are "how much is a season worth per
// game of it", not "how much is a season worth". A tail of zero discards an older season
// entirely however many games it holds — which is what broke the bounce-back case.
const RECENCY_GRID = [
  [1.0, 0, 0],
  [1.0, 0.25, 0],
  [1.0, 0.35, 0.12],
  [1.0, 0.5, 0.2],
  [0.85, 0.15, 0],
  [0.8, 0.35, 0.15],
  [0.75, 0.2, 0.05],
  [0.6, 0.28, 0.12],
];
const SHRINK_GRID = [0.5, 0.75, 1.0, 1.5];

(async () => {
  const available = await nflverse.availableSeasons(new Date().getFullYear(), 6);
  if (available.length < 4) {
    console.error(`need at least 4 seasons to tune and validate; have ${available.join(', ')}`);
    process.exit(1);
  }

  const validationSeason = available[0];   // newest — held out entirely
  const tuningSeason = available[1];       // the one candidates are chosen on

  console.log(`tuning on ${tuningSeason}, validating on ${validationSeason} (never fitted)\n`);

  const tunePool = await buildPool(tuningSeason);
  const validPool = await buildPool(validationSeason);
  console.log(`pool sizes — tuning ${tunePool.length}, validation ${validPool.length}`);
  console.log('(the benchmark is recomputed inside each run, over exactly the players that run could score)\n');

  const results = [];
  for (const recency of RECENCY_GRID) {
    for (const efficiencyShrink of SHRINK_GRID) {
      const tuning = { recency, efficiencyShrink, volumeShrink: 1 };
      const s = await score(tuningSeason, tunePool, tuning);
      results.push({ tuning, score: s.vor, raw: s.raw, positions: s.positions });
      console.log(
        `  recency [${recency.join(', ')}]  effShrink ${efficiencyShrink}` +
        `  ->  VOR ${s.vor.toFixed(4)} vs naive ${s.naive_vor.toFixed(4)}` +
        `  (${s.vor > s.naive_vor ? 'beats' : 'loses to'} naive, n=${s.n})`
      );
    }
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  console.log(`\nbest on ${tuningSeason}: VOR ${best.score.toFixed(4)} with ` +
    `recency [${best.tuning.recency.join(', ')}], efficiencyShrink ${best.tuning.efficiencyShrink}`);

  const held = await score(validationSeason, validPool, best.tuning);
  console.log(`\nheld-out ${validationSeason} (n=${held.n}):`);
  console.log(`  VOR : model ${held.vor.toFixed(4)} vs naive ${held.naive_vor.toFixed(4)}` +
    `  (${held.vor > held.naive_vor ? '\x1b[32mbeats\x1b[0m' : '\x1b[31mloses to\x1b[0m'} naive)`);
  console.log(`  raw : model ${held.raw.toFixed(4)} vs naive ${held.naive_raw.toFixed(4)}` +
    `  (context only — see the header comment)`);
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    if (held.positions[pos] == null || held.naive_positions[pos] == null) continue;
    console.log(`    ${pos}: ${held.positions[pos].toFixed(4)} vs naive ${held.naive_positions[pos].toFixed(4)}`);
  }

  console.log('\nPaste into TUNING in server/model/index.js:');
  console.log(`  recency: [${best.tuning.recency.join(', ')}],`);
  console.log(`  volumeShrink: ${best.tuning.volumeShrink},`);
  console.log(`  efficiencyShrink: ${best.tuning.efficiencyShrink},`);
})().catch(err => { console.error(err.stack); process.exit(1); });
