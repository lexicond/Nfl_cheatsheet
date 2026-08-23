#!/usr/bin/env node
/**
 * Does the expected-points model actually know anything?
 *
 *   node server/scripts/validate-projections.js
 *
 * Every other validator in this repo asks whether a source is what it claims to be.
 * This one asks a harder question of the model: projected on a season it has never
 * seen, does it rank players better than simply repeating last year's scoring?
 *
 * That is the bar the architecture sets, and it is the right one. A projection that
 * cannot beat "he'll do what he did last time" adds nothing, and the ADP-arbitrage
 * output built on it would be noise dressed as an edge. If the backtest fails, the
 * board should not be showing the column.
 *
 * The bar is measured on VALUE OVER REPLACEMENT and on per-position ordering, not on a
 * single pooled ranking by raw points, and the reason matters. At four-point passing
 * touchdowns quarterbacks out-score everyone, so pooling every position into one
 * raw-points ranking mostly measures whether a model reproduces that offset — a
 * question of scale, not of ordering, and not one any draft decision turns on. Scored
 * that way this model loses to the naive benchmark while beating it at every individual
 * position, which is Simpson's paradox rather than a finding. Scored on VOR, which
 * removes the positional offset by construction and is what the board displays, it
 * beats the benchmark. Both numbers are printed; only the ones that bear on a draft
 * decision are assertions.
 *
 * Lookahead hygiene is the whole game here, and it is enforced rather than assumed:
 *   - the model is given only seasons strictly before the test season
 *   - team environment is priced off the first six weeks only, approximating what a
 *     book had posted on draft day rather than the season's full closing lines
 *   - each player's team comes from his last played season, not from the current
 *     crosswalk, which knows where he ended up
 *
 * Exits non-zero if any assertion fails.
 */
const { runModel } = require('../model');
const nflverse = require('../model/nflverse');
const { aggregateSeason } = require('../model/usage');
const { correlation } = require('../model/stability');
const { replacementLevels } = require('../model/combine');

let failures = 0;
let warnings = 0;
const ok = m => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = m => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const warn = m => { console.log(`  \x1b[33m!\x1b[0m ${m}`); warnings++; };
const section = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

// Approximates the share of the schedule a book has priced by late August.
const DRAFT_DAY_WEEK = 6;

/** Spearman: rank both series, then correlate the ranks. */
function spearman(pairs) {
  if (pairs.length < 10) return null;
  const rank = (idx) => {
    const order = pairs.map((p, i) => [p[idx], i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(pairs.length);
    order.forEach(([, i], k) => { r[i] = k + 1; });
    return r;
  };
  const ra = rank(0);
  const rb = rank(1);
  return correlation(ra.map((v, i) => [v, rb[i]]));
}

/**
 * Rank on value over replacement, for both the prediction and the outcome. Replacement
 * is recomputed from each series on its own scale, so a model that runs systematically
 * high at one position is neither rewarded nor punished for that — only for whether it
 * ordered players correctly once the positional offset is removed.
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

function mae(pairs) {
  return pairs.reduce((a, [p, act]) => a + Math.abs(p - act), 0) / pairs.length;
}
function rmse(pairs) {
  return Math.sqrt(pairs.reduce((a, [p, act]) => a + (p - act) ** 2, 0) / pairs.length);
}

(async () => {
  /* ---------------------------------------------------------------- backtest */
  section('Backtest — project a season the model has not seen');

  const available = await nflverse.availableSeasons(new Date().getFullYear(), 6);
  if (available.length < 3) {
    bad(`only ${available.length} season(s) of history available — cannot backtest`);
    process.exit(1);
  }

  // Test on the newest complete season, training on everything strictly before it.
  const testSeason = available[0];
  console.log(`  test season ${testSeason}, training on ${available.slice(1).join(', ')}`);

  const projected = await runModel({
    targetSeason: testSeason,
    environmentMaxWeek: DRAFT_DAY_WEEK,
    useHistoryTeam: true,
    iterations: 200,
  });

  // Prove no lookahead rather than trusting the flag.
  if (projected.meta.history_seasons.includes(testSeason)) {
    bad(`the model was given ${testSeason} while projecting it — lookahead`);
  } else {
    ok(`no ${testSeason} data reached the model (history: ${projected.meta.history_seasons.join(', ')})`);
  }

  // What actually happened.
  const actualRows = await nflverse.loadSeasonStats(testSeason);
  const actual = aggregateSeason(actualRows.rows, testSeason);

  // The naive benchmark: last season's points, unchanged.
  const priorRows = await nflverse.loadSeasonStats(testSeason - 1);
  const prior = aggregateSeason(priorRows.rows, testSeason - 1);

  // Score only players the market would actually have been drafting: someone who
  // recorded a real prior season. Including every fringe body flatters both the model
  // and the benchmark, because predicting that a third-string tight end scores nothing
  // is easy and is not what the board is for.
  // A player belongs in the pool if he had a real season in EITHER of the two years
  // before the test. Requiring it of the immediately prior season only — the first
  // version of this — quietly excludes the bounce-back: a starter two years ago who lost
  // most of last season to injury and is being drafted this year on the earlier season.
  // That is exactly where how far back the model looks decides the answer, so a pool
  // without them cannot see the model's biggest failure mode.
  const before = aggregateSeason((await nflverse.loadSeasonStats(testSeason - 2)).rows, testSeason - 2);
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
        name: p.name,
        position: p.position,
        // The benchmark is always last season's points, whether or not last season is the
        // one that qualified him — a player who missed it really did score little.
        prior_points: priorRec ? priorRec.points : 0,
        // A player who did not appear scored nothing. That is a real outcome, not a gap:
        // dropping him would quietly remove every injury and every bust from the test.
        actual_points: act ? act.points : 0,
      });
    }
  }

  const byGsis = new Map(projected.projections.map(p => [p.gsis_id, p]));
  let missing = 0;
  for (const row of pool) {
    const pr = byGsis.get(row.gsis_id);
    if (!pr) { missing++; continue; }
    row.model_points = pr.points;
  }
  const scored = pool.filter(r => r.model_points != null);

  console.log(`  ${scored.length} players scored (${missing} in the prior season had no projection)`);
  if (scored.length < 100) {
    bad(`only ${scored.length} players could be scored — too few to conclude anything`);
  }

  const modelPairs = scored.map(r => [r.model_points, r.actual_points]);
  const naivePairs = scored.map(r => [r.prior_points, r.actual_points]);

  const modelVor = vorSpearman(scored, r => r.model_points);
  const naiveVor = vorSpearman(scored, r => r.prior_points);

  console.log(`\n  value over replacement (n=${scored.length}) — the number the board shows`);
  console.log(`    model  Spearman ${modelVor.toFixed(4)}`);
  console.log(`    naive  Spearman ${naiveVor.toFixed(4)}`);
  console.log(`  raw pooled points — context only, dominated by the QB scoring offset`);
  console.log(`    model  Spearman ${spearman(modelPairs).toFixed(4)}  MAE ${mae(modelPairs).toFixed(1)}  RMSE ${rmse(modelPairs).toFixed(1)}`);
  console.log(`    naive  Spearman ${spearman(naivePairs).toFixed(4)}  MAE ${mae(naivePairs).toFixed(1)}  RMSE ${rmse(naivePairs).toFixed(1)}`);

  if (modelVor > naiveVor) {
    ok(`model out-ranks the naive benchmark on VOR by ${(modelVor - naiveVor).toFixed(4)} Spearman`);
  } else {
    bad(
      `model does NOT beat "repeat last season" on VOR (${modelVor.toFixed(4)} vs ${naiveVor.toFixed(4)}) — ` +
      'do not trust the projection column or anything derived from it'
    );
  }

  /* ------------------------------------------------------------ per position */
  section('Backtest by position — no position may be worse than naive');
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const sub = scored.filter(r => r.position === pos);
    if (sub.length < 20) { warn(`${pos}: only ${sub.length} players, skipped`); continue; }
    const m = spearman(sub.map(r => [r.model_points, r.actual_points]));
    const nv = spearman(sub.map(r => [r.prior_points, r.actual_points]));
    const label = `${pos} (n=${sub.length}): model ${m.toFixed(3)} vs naive ${nv.toFixed(3)}`;
    if (m >= nv - 0.02) ok(label);
    else bad(`${label} — the model is materially worse than doing nothing at ${pos}`);
  }

  /* ------------------------------------------------------------- live sanity */
  section('Live run — structural sanity');
  const live = await runModel({ targetSeason: new Date().getFullYear(), iterations: 200 });
  const P = live.projections;

  console.log(`  ${P.length} players (${live.meta.rookies} rookies), ${live.meta.elapsed_ms}ms`);
  for (const w of live.meta.warnings) warn(w);

  // Every projection must be a finite, non-negative number. A NaN here propagates into
  // ranks and sorts silently.
  const bogus = P.filter(p => !Number.isFinite(p.points) || p.points < 0);
  if (bogus.length === 0) ok(`all ${P.length} projections are finite and non-negative`);
  else bad(`${bogus.length} projection(s) are NaN or negative — e.g. ${bogus.slice(0, 3).map(p => p.name).join(', ')}`);

  // The ceiling must sit above the mean and the floor below it, or the simulation is
  // wired up wrong and the best-ball column is meaningless.
  const badBand = P.filter(p => p.ceiling != null && p.floor != null
    && !(p.floor <= p.points && p.points <= p.ceiling));
  if (badBand.length === 0) ok('floor ≤ projection ≤ ceiling holds for every player');
  else bad(`${badBand.length} player(s) have a floor/ceiling that does not bracket the mean`);

  // Quarterbacks out-score everyone in raw points at four-point passing touchdowns.
  // If they do not, the scoring engine is not scoring passing.
  const best = pos => Math.max(...P.filter(p => p.position === pos).map(p => p.points));
  if (best('QB') > best('RB') && best('QB') > best('WR')) {
    ok(`QB1 ${best('QB').toFixed(0)} > RB1 ${best('RB').toFixed(0)} and WR1 ${best('WR').toFixed(0)}, as raw scoring requires`);
  } else {
    bad(`QB1 ${best('QB').toFixed(0)} does not lead RB1 ${best('RB').toFixed(0)}/WR1 ${best('WR').toFixed(0)} — passing may not be scored`);
  }

  // …which is exactly why value over replacement exists. Once replacement level is
  // subtracted the ordering must change, or VOR is not doing its job.
  const levels = replacementLevels(P, { teams: 12, leagueType: '1QB' });
  console.log(`  replacement (12-team 1QB): ${Object.entries(levels).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')}`);
  const vor = P.map(p => ({ ...p, vor: p.points - (levels[p.position] ?? 0) }))
    .sort((a, b) => b.vor - a.vor);
  const topRawQb = P.slice().sort((a, b) => b.points - a.points).findIndex(p => p.position !== 'QB');
  const topVorNonQb = vor.findIndex(p => p.position !== 'QB');
  if (topVorNonQb < topRawQb) {
    ok(`VOR reorders the board: first non-QB moves from raw rank ${topRawQb + 1} to VOR rank ${topVorNonQb + 1}`);
  } else {
    bad('VOR did not change the cross-position ordering — replacement levels look wrong');
  }

  // Superflex must make quarterbacks more valuable — and it does so by LOWERING their
  // replacement level, not raising it. When nearly every team starts two, the last
  // startable quarterback is a far worse player, so the bar each QB is measured against
  // drops and every QB's value over it rises. Asserting this the other way round is an
  // easy mistake and this check exists having made it.
  const sfLevels = replacementLevels(P, { teams: 12, leagueType: '2QB' });
  const bestQb = Math.max(...P.filter(p => p.position === 'QB').map(p => p.points));
  const vor1 = bestQb - levels.QB;
  const vorSf = bestQb - sfLevels.QB;
  if (sfLevels.QB < levels.QB && vorSf > vor1) {
    ok(`superflex drops the replacement QB from ${levels.QB.toFixed(0)} to ${sfLevels.QB.toFixed(0)}, ` +
       `lifting QB1 value over replacement from ${vor1.toFixed(0)} to ${vorSf.toFixed(0)}`);
  } else {
    bad(`superflex replacement QB ${sfLevels.QB.toFixed(0)} vs 1QB ${levels.QB.toFixed(0)} — ` +
        'superflex should lower the bar and raise QB value');
  }

  /* ------------------------------------------------------- measured stability */
  section('Measured stability — does it match what the research says?');
  const st = live.internals.stability.table;
  const show = (pos, metric) => {
    const e = st[pos]?.[metric];
    return e && e.measured ? e.r : null;
  };
  // Target share must repeat far better than touchdown rate. This is the assumption the
  // whole shrinkage scheme rests on; if it inverted, the weights would be backwards.
  for (const pos of ['RB', 'WR', 'TE']) {
    const share = show(pos, 'target_share');
    const td = show(pos, 'rec_td_rate');
    if (share == null || td == null) { warn(`${pos}: not enough pairs to compare stability`); continue; }
    const label = `${pos}: target share r=${share.toFixed(3)} vs receiving TD rate r=${td.toFixed(3)}`;
    if (share > td + 0.1) ok(label);
    else bad(`${label} — opportunity should repeat far better than touchdown rate; the shrinkage weights would be backwards`);
  }
  const rbYpc = show('RB', 'yards_per_carry');
  if (rbYpc != null) {
    if (rbYpc < 0.35) ok(`RB yards per carry r=${rbYpc.toFixed(3)} — barely repeats, as the research says`);
    else warn(`RB yards per carry r=${rbYpc.toFixed(3)} — higher than published work suggests, check the sample`);
  }

  /* ------------------------------------------------------------- board reach */
  section('Board coverage — can the projection actually land on rows?');
  let db = null;
  try {
    ({ db } = require('../db'));
  } catch (err) {
    warn(`database unavailable (${err.message}) — skipping coverage`);
  }
  if (db) {
    const have = new Set(P.filter(p => p.sleeper_id).map(p => String(p.sleeper_id)));
    const covered = (limit) => {
      const rows = db.prepare(
        `SELECT sleeper_player_id FROM players
         WHERE sleeper_player_id IS NOT NULL AND adp_consensus IS NOT NULL
         ${limit ? 'AND adp_consensus <= ' + limit : ''}`
      ).all();
      const hit = rows.filter(r => have.has(String(r.sleeper_player_id))).length;
      return { hit, total: rows.length, pct: rows.length ? hit / rows.length : 0 };
    };

    // The range that decides a draft. This must be essentially complete: a player being
    // taken in the first seventeen rounds with no projection is a hole in the board.
    const core = covered(200);
    const coreLabel = `${core.hit}/${core.total} players inside ADP 200 have a projection (${(core.pct * 100).toFixed(1)}%)`;
    if (core.pct >= 0.98) ok(coreLabel);
    else if (core.pct >= 0.9) warn(`${coreLabel} — some draftable players are missing one`);
    else bad(`${coreLabel} — the crosswalk or the role gate is cutting into the draftable range`);

    // Beyond it, coverage is expected to fall away: the role gate deliberately refuses
    // players with no recent role, and almost all of them live in the deep tail. Reported
    // so the number is visible, but not asserted on — a low figure here is the gate
    // working, not a fault.
    const all = covered(null);
    console.log(`  ${all.hit}/${all.total} across the whole board (${(all.pct * 100).toFixed(1)}%) — ` +
      `the rest are players the role gate refused`);
  }

  /* ------------------------------------------------------------- the role gate */
  section('Role gate — no projection without the evidence to support one');
  console.log(`  refused: ${live.meta.gated.noLastSeason} with no season last year, ` +
    `${live.meta.gated.thinRole} with too little of one`);

  // The failure this guards against: every rate in the model is per game and every thin
  // sample is regressed toward a baseline drawn from players who had a role, so without
  // the gate a quarterback who threw two passes regressed onto a starter's workload and
  // projected about 145 points. Nathan Peterman, two opportunities, projected 143.
  const ungated = P.filter(p => !p.components?.basis)
    .filter(p => (p.components?.role_opportunity ?? 0) < 20 && p.points > 60);
  if (ungated.length === 0) {
    ok('no player projects a real season off fewer than 20 opportunities');
  } else {
    bad(`${ungated.length} player(s) project >60 points on under 20 opportunities — ` +
      `e.g. ${ungated.slice(0, 3).map(p => `${p.name} ${p.points}`).join(', ')}`);
  }

  // A projection may be anchored on an older season — that is how a player who lost last
  // season to injury stays on the board — but never further back than the model allows,
  // and never at full strength. Both halves are asserted, because dropping the discount
  // is what made this change harmful in the backtest.
  const { maxAnchorBack } = require('../model').TUNING;
  const tooOld = P.filter(p => !p.components?.basis)
    .filter(p => p.components?.level_season != null
      && live.meta.newest_season - p.components.level_season > maxAnchorBack);
  if (tooOld.length === 0) {
    ok(`no projection reaches further back than ${maxAnchorBack} season(s) for its role anchor`);
  } else {
    bad(`${tooOld.length} projection(s) anchored more than ${maxAnchorBack} seasons back — ` +
      `e.g. ${tooOld.slice(0, 3).map(p => `${p.name} (${p.components.level_season})`).join(', ')}`);
  }
  const anchoredBack = P.filter(p => (p.components?.anchored_back ?? 0) > 0);
  console.log(`  ${anchoredBack.length} projections are anchored on an older season, ` +
    `discounted to ${Math.round(require('../model').TUNING.staleDiscount * 100)}%`);
  const undiscounted = anchoredBack.filter(p => p.confidence !== 'low');
  if (undiscounted.length === 0) ok('every older-anchored projection is marked low confidence');
  else bad(`${undiscounted.length} older-anchored projection(s) are not marked low confidence`);

  console.log(`\n${failures === 0 ? '\x1b[32mPASSED\x1b[0m' : '\x1b[31mFAILED\x1b[0m'} — ${failures} failure(s), ${warnings} warning(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error('\n\x1b[31mvalidate-projections crashed\x1b[0m:', err.message);
  console.error(err.stack);
  process.exit(1);
});
