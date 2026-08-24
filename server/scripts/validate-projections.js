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

  // The depth chart has to be supplied here or the backtest exercises a different model
  // from the one the board runs: role, availability and the quarterback split all hang
  // off it. nflverse publishes historical charts, so the backtest uses that season's own
  // week-one chart rather than today's.
  const backtestDepth = await nflverse.loadDepthChart(testSeason);

  const projected = await runModel({
    targetSeason: testSeason,
    environmentMaxWeek: DRAFT_DAY_WEEK,
    // Teams come from the depth chart, which is that season's, so the crosswalk's
    // present-day team is not consulted.
    useHistoryTeam: false,
    useOdds: false,           // today's prices say nothing about a past season
    depthChart: backtestDepth,
    iterations: 200,
  });
  console.log(`  depth chart supplied: ${backtestDepth.size} players`);

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

  // The headline claim is the PER-GAME rate, not the season total, and the reason is a
  // design decision rather than a convenience.
  //
  // A season total is rate x games, and games is mostly injury. The model refuses to
  // forecast injuries — everyone with a role is projected a full season, which is what
  // Sleeper does too — because the evidence says it is barely forecastable: hold role
  // fixed and games played correlates 0.28 season to season, and among established
  // starters missing most of a year costs 1.8 games the next. So a metric built on
  // season totals is graded largely on a guess the model declines to make, and the naive
  // benchmark wins it by carrying last season's games played for free.
  //
  // On the question the board is actually for — who is good — the model wins. Both are
  // printed; the rate is the one asserted.
  const played = scored.filter(r => (actual.get(r.gsis_id)?.games ?? 0) >= 4);
  const modelPpg = spearman(played.map(r => [byGsis.get(r.gsis_id).ppg, actual.get(r.gsis_id).ppg]));
  const naivePpg = spearman(played.map(r => {
    const pr = prior.get(r.gsis_id);
    return [pr ? pr.ppg : 0, actual.get(r.gsis_id).ppg];
  }));

  console.log(`\n  points per game (n=${played.length}) — the model's actual claim`);
  console.log(`    model  Spearman ${modelPpg.toFixed(4)}`);
  console.log(`    naive  Spearman ${naivePpg.toFixed(4)}`);
  console.log(`  season totals (n=${scored.length}) — context; dominated by availability, which is not forecast`);
  console.log(`    model  VOR ${modelVor.toFixed(4)}   raw ${spearman(modelPairs).toFixed(4)}   MAE ${mae(modelPairs).toFixed(1)}`);
  console.log(`    naive  VOR ${naiveVor.toFixed(4)}   raw ${spearman(naivePairs).toFixed(4)}   MAE ${mae(naivePairs).toFixed(1)}`);

  // Tolerant of one season's noise, by necessity. Bootstrapping the paired difference
  // puts a single season's margin well inside +/-0.05, and over 2023-25 the model's
  // per-game edge averages +0.016 while individual seasons swing either side of zero. A
  // gate demanding a win every year would fail at random; this one catches a real
  // regression.
  const ppgMargin = modelPpg - naivePpg;
  if (ppgMargin > 0) {
    ok(`model out-ranks the benchmark on points per game by ${ppgMargin.toFixed(4)} Spearman ` +
       '(three-season mean +0.016)');
  } else if (ppgMargin > -0.05) {
    warn(`model is ${Math.abs(ppgMargin).toFixed(4)} behind on points per game this season — ` +
         'inside the noise band (three-season mean is +0.016), but watch it');
  } else {
    bad(`model is materially worse than "repeat last season" on points per game ` +
        `(${modelPpg.toFixed(4)} vs ${naivePpg.toFixed(4)}) — the projection is not adding anything`);
  }

  /* ------------------------------------------------------------ per position */
  section('Backtest by position — points per game, no position may be worse than naive');
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const sub = played.filter(r => r.position === pos);
    if (sub.length < 20) { warn(`${pos}: only ${sub.length} players, skipped`); continue; }
    // Per game, for the same reason as above.
    const m = spearman(sub.map(r => [byGsis.get(r.gsis_id).ppg, actual.get(r.gsis_id).ppg]));
    const nv = spearman(sub.map(r => {
      const pr = prior.get(r.gsis_id);
      return [pr ? pr.ppg : 0, actual.get(r.gsis_id).ppg];
    }));
    const label = `${pos} (n=${sub.length}): model ${m.toFixed(3)} vs naive ${nv.toFixed(3)}`;
    // A position holds maybe 50-140 players, so the noise band here is wider still.
    if (m >= nv - 0.08) ok(label);
    else bad(`${label} — the model is materially worse than doing nothing at ${pos}`);
  }

  // The board's database, needed by several sections below. Absent in a bare checkout.
  let db = null;
  try {
    ({ db } = require('../db'));
  } catch (err) {
    warn(`database unavailable (${err.message}) — skipping the checks that need it`);
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

  /* --------------------------------------------------------------- calibration */
  section('Is the floor-to-ceiling band honest?');
  {
    const withBand = scored.filter(r => {
      const p = byGsis.get(r.gsis_id);
      return p && p.floor != null && p.ceiling != null;
    }).map(r => ({ ...r, p: byGsis.get(r.gsis_id) }));

    const cover = list => {
      const below = list.filter(r => r.actual_points < r.p.floor).length;
      const above = list.filter(r => r.actual_points > r.p.ceiling).length;
      return { below: 100 * below / list.length, inside: 100 * (list.length - below - above) / list.length,
               above: 100 * above / list.length, n: list.length };
    };

    // Conditional on the player getting a season. This is what the band actually claims:
    // the range if he holds his role, because the model deliberately does not forecast
    // who gets hurt.
    const healthy = withBand.filter(r => (actual.get(r.gsis_id)?.games ?? 0) >= 12);
    const c = cover(healthy);
    console.log(`  among players who went on to play 12+ games (n=${c.n}): ` +
      `${c.below.toFixed(0)}% below / ${c.inside.toFixed(0)}% inside / ${c.above.toFixed(0)}% above`);
    if (c.inside >= 60 && c.inside <= 82) {
      ok(`band covers ${c.inside.toFixed(0)}% of outcomes for players who got a season, against the 70% it claims`);
    } else {
      bad(`band covers ${c.inside.toFixed(0)}% where it claims 70% — the quoted percentiles are wrong`);
    }

    // And the unconditional figure, reported so the "if healthy" premium is never hidden.
    const all = cover(withBand);
    const projMean = withBand.reduce((a, r) => a + r.p.points, 0) / withBand.length;
    const actMean = withBand.reduce((a, r) => a + r.actual_points, 0) / withBand.length;
    console.log(`  across everybody (n=${all.n}): ${all.below.toFixed(0)}% below / ` +
      `${all.inside.toFixed(0)}% inside / ${all.above.toFixed(0)}% above`);
    console.log(`  mean projected ${projMean.toFixed(0)} vs mean actual ${actMean.toFixed(0)} ` +
      `(${(projMean / actMean).toFixed(2)}x) — the full-season premium, the same property ` +
      `Sleeper's projections have. Not a fault; it is what "if he holds the role" means.`);
  }

  /* ------------------------------------------------- team-level reconciliation */
  section('Adds up as a team — conservation identities');

  const teamAgg = new Map();
  for (const p of P) {
    const c = p.components || {};
    if (!p.team || c.basis) continue;
    if (!teamAgg.has(p.team)) {
      teamAgg.set(p.team, { att: 0, tgt: 0, car: 0, passTd: 0, recTd: 0, passYd: 0, recYd: 0 });
    }
    const g = p.games || 0;
    const t = teamAgg.get(p.team);
    t.att += (c.attempts_pg || 0) * g;   t.tgt += (c.targets_pg || 0) * g;
    t.car += (c.carries_pg || 0) * g;
    t.passTd += (c.pass_tds_pg || 0) * g; t.recTd += (c.rec_tds_pg || 0) * g;
    t.passYd += (c.pass_yards_pg || 0) * g; t.recYd += (c.rec_yards_pg || 0) * g;
  }
  const teams = [...teamAgg.values()];
  const avg = k => teams.reduce((a, t) => a + t[k], 0) / teams.length;
  // The floor is per-identity: a denominator of 200 is right for attempts and yards and
  // silently excluded every team from the touchdown test, where the denominator is ~23.
  const medianRatio = (a, b, floor) => {
    const r = teams.filter(t => t[b] > floor).map(t => t[a] / t[b]).sort((x, y) => x - y);
    return r.length ? r[Math.floor(r.length / 2)] : null;
  };

  console.log(`  per team: ${avg('att').toFixed(0)} pass attempts, ${avg('tgt').toFixed(0)} targets, ` +
    `${avg('car').toFixed(0)} carries, ${avg('passYd').toFixed(0)} passing yards`);

  // These are identities, not estimates. Every pass attempt is a target, every passing
  // yard is a receiving yard, every passing touchdown is a receiving touchdown. Nothing
  // in the model enforces them — the two sides are projected from different players'
  // histories — so they are the sharpest available test that the parts fit together.
  const identities = [
    ['targets per pass attempt', 'tgt', 'att', 0.94, 0.18, 200],
    ['receiving yards per passing yard', 'recYd', 'passYd', 1.0, 0.18, 1500],
    ['receiving TDs per passing TD', 'recTd', 'passTd', 1.0, 0.20, 8],
  ];
  for (const [label, a, b, target, tol, floor] of identities) {
    const m = medianRatio(a, b, floor);
    if (m == null) { warn(`${label}: not enough teams to test`); continue; }
    const text = `${label}: median ${m.toFixed(2)} (should be about ${target})`;
    if (Math.abs(m - target) <= tol) ok(text);
    else bad(`${text} — the two sides of the identity disagree; team totals do not add up`);
  }

  // And the totals have to be a plausible NFL season, not merely self-consistent.
  const plausible = [
    ['pass attempts', 'att', 440, 660],
    ['carries', 'car', 340, 520],
    ['passing yards', 'passYd', 2900, 4600],
  ];
  for (const [label, k, lo, hi] of plausible) {
    const v = avg(k);
    if (v >= lo && v <= hi) ok(`mean team ${label} ${v.toFixed(0)} is inside the plausible range ${lo}–${hi}`);
    else bad(`mean team ${label} ${v.toFixed(0)} is outside ${lo}–${hi} for a real NFL team`);
  }

  // Module C has to actually reach the players. It is keyed on nflverse's team codes and
  // the crosswalk spells nine current teams differently — SFO for SF, GBP for GB, NOS for
  // NO — so before those were normalised, every player on nine teams silently fell back
  // to a league-average scalar. Nothing in the output said so: the environment table
  // itself still reported 32 teams priced by the market.
  const noEnv = P.filter(p => !p.components?.basis && p.components?.env_total == null);
  const teamsSeen = new Set(P.filter(p => !p.components?.basis).map(p => p.team));
  if (noEnv.length === 0 && teamsSeen.size >= 32) {
    ok(`every projection resolved a team environment, across all ${teamsSeen.size} teams`);
  } else {
    bad(`${noEnv.length} projection(s) across ${teamsSeen.size} teams have no team environment — ` +
      `the crosswalk's team codes are not reaching the schedule's`);
  }
  const offMarket = P.filter(p => !p.components?.basis && p.components?.env_source !== 'market');
  if (offMarket.length === 0) ok('every team environment came from priced games, not a fallback baseline');
  else warn(`${offMarket.length} projection(s) are on a fallback team environment, not market prices`);

  // Availability is not forecast per player: everyone with a role gets a full season and
  // role differences live in the per-game rates. The only exception is quarterback, where
  // a team's seventeen are split by depth chart. So every non-QB should be on 17.
  const nonQbGames = P.filter(p => p.position !== 'QB' && !p.components?.basis);
  const oddGames = nonQbGames.filter(p => Math.abs((p.games ?? 0) - 17) > 0.01);
  if (oddGames.length === 0) {
    ok(`all ${nonQbGames.length} non-quarterbacks are projected a full season`);
  } else {
    bad(`${oddGames.length} non-quarterback(s) are not on 17 games — ` +
      `e.g. ${oddGames.slice(0, 3).map(p => `${p.name} ${p.games}`).join(', ')}`);
  }
  const startersShort = P.filter(p => p.position === 'QB' && p.components?.depth_order === 1
    && (p.games ?? 0) < 13);
  if (startersShort.length === 0) {
    ok('every listed starting quarterback is projected at least 13 games');
  } else {
    bad(`${startersShort.length} listed starting QB(s) projected under 13 games — ` +
      `e.g. ${startersShort.slice(0, 3).map(p => `${p.name} ${p.games}`).join(', ')}`);
  }

  // Quarterback playing time is the one thing that must be conserved outright: a team
  // has 17 games of it and one man takes nearly every snap. Unconstrained the model gave
  // 66 quarterbacks 13.2 expected games each across 31 teams.
  const qbGames = new Map();
  for (const p of P) {
    if (p.position !== 'QB' || !p.team || p.components?.basis) continue;
    qbGames.set(p.team, (qbGames.get(p.team) || 0) + (p.games || 0));
  }
  const worst = [...qbGames.entries()].sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] <= 19) {
    ok(`no team is projected more than ${worst[1].toFixed(1)} quarterback games (${worst[0]}); a season has 17`);
  } else if (worst) {
    bad(`${worst[0]} is projected ${worst[1].toFixed(1)} quarterback games from a 17-game season — ` +
      'playing time is not being conserved');
  }
  console.log(`  reclaimed ${live.meta.qb_conservation.games_reclaimed} QB games, ` +
    `dropped ${live.meta.qb_conservation.dropped} with no share of the job left`);

  /* ------------------------------------------------ the market on whole teams */
  section('Against the market on whole teams — season win totals');
  try {
    const { fetchWinTotals } = require('../model/wintotals');
    const wt = await fetchWinTotals();
    const names = Object.keys(wt);

    if (names.length < 32) {
      warn(`only ${names.length} of 32 teams carry a win total — VegasInsider's markup may have moved`);
    } else {
      ok(`all 32 teams priced, ${wt[names[0]].books} books each`);

      // A season hands out exactly 272 wins. Nothing in the scrape enforces that, and the
      // books are not trying to make it true, so it is the sharpest available check that the
      // page was read correctly and that the price adjustment is sane. Averaging the posted
      // LINES happens to sum correctly too; taking the median line does not, and comes out
      // near 278. Per team the two methods differ by up to 0.6 wins, which is what actually
      // matters for ordering.
      const total = names.reduce((a, t) => a + wt[t].wins, 0);
      if (Math.abs(total - 272) <= 8) ok(`implied wins sum to ${total.toFixed(1)}, against the 272 a season has`);
      else bad(`implied wins sum to ${total.toFixed(1)} — a season has 272, so the scrape or the price adjustment is wrong`);

      // Books post different lines for the same team; once each quote is converted to the
      // total it implies they should agree. If they do not, the conversion is broken.
      const spreads = names.map(t => wt[t].crossBookSpread).sort((a, b) => a - b);
      const worst = spreads[spreads.length - 1];
      const multi = names.filter(t => wt[t].lines.length > 1);
      if (worst <= 1.0) {
        ok(`books reconcile to within ${worst.toFixed(2)} wins (median ${spreads[Math.floor(spreads.length / 2)].toFixed(2)}), ` +
          `including ${multi.length} teams where they post different lines`);
      } else {
        bad(`books disagree by up to ${worst.toFixed(2)} wins after conversion — the price adjustment is not working`);
      }

      // The model's own view of each team, built bottom-up from the players it projects.
      // Read this as a check on ORDERING, not on level: the environment layer already scales
      // every projection by the market's implied points per game, so the model has seen the
      // market's opinion of these offences. What it has not seen is the win total, which
      // prices defence and schedule too — so a weak correlation here would still be a
      // finding, and a team far off the line is worth looking at.
      const offence = new Map();
      for (const p of P) {
        if (!p.team || p.components?.basis) continue;
        offence.set(p.team, (offence.get(p.team) || 0) + (p.points || 0));
      }
      const pairs = names.filter(t => offence.has(t)).map(t => [offence.get(t), wt[t].wins]);
      if (pairs.length >= 24) {
        const r = correlation(pairs);
        console.log(`  model's projected team offence vs the market's win total: rho ${r.toFixed(3)} over ${pairs.length} teams`);
        // Not asserted upward: offence alone cannot explain wins, and the model does not
        // project defence at all. Asserted downward, because no relationship would mean the
        // bottom-up sums have come loose from the teams they belong to.
        if (r >= 0.35) ok(`team-level offence tracks the win market at rho ${r.toFixed(3)}`);
        else bad(`team offence and the win market are unrelated (rho ${r.toFixed(3)}) — the per-team sums are suspect`);

        const fitted = pairs.slice().sort((a, b) => a[0] - b[0]);
        const lo = fitted.slice(0, 4).map(x => x[1]).reduce((a, b) => a + b, 0) / 4;
        const hi = fitted.slice(-4).map(x => x[1]).reduce((a, b) => a + b, 0) / 4;
        console.log(`  the four offences it likes least are priced for ${lo.toFixed(1)} wins; the four it likes most, ${hi.toFixed(1)}`);

        // Teams the role gate has hollowed out show up here rather than anywhere else: a
        // team with no projectable quarterback has almost no projected offence, whatever
        // the market thinks of it.
        const byGap = pairs.map(([o, w], i) => ({ team: names.filter(t => offence.has(t))[i], o, w }))
          .sort((a, b) => (a.o / a.w) - (b.o / b.w));
        console.log(`  thinnest offence per priced win: ${byGap.slice(0, 3).map(x => `${x.team} (${x.o.toFixed(0)}pts / ${x.w.toFixed(1)}w)`).join(', ')}`);
      } else {
        warn(`only ${pairs.length} teams have both a projection and a win total`);
      }
    }
  } catch (err) {
    // The board must not fail its validation because a scraped page moved.
    warn(`win totals unavailable (${err.message}) — skipping the team-level market check`);
  }

  /* ------------------------------------------------- the per-player market */
  section('Against the betting market — the only per-player second opinion');
  if (db) {
    // Only complete totals. A market total missing its receiving terms is not a season
    // projection, and correlating one against a model that projects the whole player
    // measures the gap in the denominators rather than any disagreement about the player.
    const mk = db.prepare(`
      SELECT position, xfp_points m, mkt_points k, projected_pts s FROM players
      WHERE mkt_points IS NOT NULL AND xfp_points IS NOT NULL AND mkt_complete = 1
    `).all();
    if (mk.length < 60) {
      warn(`only ${mk.length} players carry a season betting line — is marketprops refreshing?`);
    } else {
      // Every scoring category the books price must actually be landing on rows. This is
      // here because a market that answers with an empty list reads exactly like a market
      // nobody bets: receptions looked unpriced for as long as it was fetched from the
      // wrong endpoint, and a third of every receiver's half-PPR season went missing from
      // this column without a single error being raised.
      const term = c => db.prepare(`SELECT COUNT(*) n FROM players WHERE ${c} IS NOT NULL`).get().n;
      const terms = {
        'passing yards': ['mkt_pass_yards', 20], 'passing TDs': ['mkt_pass_tds', 20],
        'rushing yards': ['mkt_rush_yards', 35], 'rushing TDs': ['mkt_rush_tds', 35],
        'receiving yards': ['mkt_rec_yards', 60], 'receiving TDs': ['mkt_rec_tds', 60],
        'receptions': ['mkt_receptions', 50],
      };
      const thin = Object.entries(terms).filter(([, [c, min]]) => term(c) < min);
      if (thin.length === 0) {
        ok(`all seven market terms are populated (${Object.entries(terms).map(([l, [c]]) => `${l} ${term(c)}`).join(', ')})`);
      } else {
        bad('market terms missing or thin: ' + thin.map(([l, [c, min]]) => `${l} ${term(c)} < ${min}`).join('; ')
          + ' — check the /offers endpoint and its 10-row page cap before believing the books stopped pricing it');
      }

      const rank = (arr, f) => {
        const o = arr.map((x, i) => [f(x), i]).sort((a, b) => a[0] - b[0]);
        const r = new Array(arr.length);
        o.forEach(([, i], k2) => { r[i] = k2 + 1; });
        return r;
      };
      const rho = (arr, f, g) => {
        const a = rank(arr, f); const b = rank(arr, g);
        return correlation(a.map((v, i) => [v, b[i]]));
      };
      const modelRho = rho(mk, x => x.m, x => x.k);
      const avg = f => mk.reduce((a, b) => a + f(b), 0) / mk.length;
      console.log(`  ${mk.length} players with a complete market total. model vs market rho ${modelRho.toFixed(3)}, ` +
        `levels ${(avg(x => x.m) / avg(x => x.k)).toFixed(2)}x`);

      const withSleeper = mk.filter(x => x.s != null);
      if (withSleeper.length >= 40) {
        const sleeperRho = rho(withSleeper, x => x.s, x => x.k);
        console.log(`  Sleeper vs the same market: rho ${sleeperRho.toFixed(3)} — ` +
          (sleeperRho > modelRho
            ? 'Sleeper tracks the market more closely than this model does, which is worth knowing'
            : 'this model tracks the market at least as closely as Sleeper'));
      }

      // Not a demand that the model agree with the market — it is meant to be an
      // independent view, and an edge requires disagreeing somewhere. But a model that
      // has come loose from the market entirely is broken rather than contrarian.
      if (modelRho >= 0.6) ok(`model tracks the market at rho ${modelRho.toFixed(3)}`);
      else bad(`model agrees with the market at only rho ${modelRho.toFixed(3)} — ` +
        'that is not independence, it is a fault');
    }
  }

  /* -------------------------------------------- a second vendor on the market */
  section('Cross-checked against RotoWire — is the consensus the market?');
  if (db) {
    try {
      const { fetchPlayerFutures } = require('../scrapers/rotowire');
      const { rows, failures } = await fetchPlayerFutures();
      if (failures.length) warn(`RotoWire tables missing: ${failures.join('; ')}`);

      // Compared against BettingPros' RAW consensus line, not against what this board stores.
      // The stored number is the median that line's price implies, which is deliberately a
      // different quantity from a posted line; checking it against RotoWire's posted lines
      // would report every price correction as a vendor disagreement. The question here is
      // only whether BettingPros' consensus is reporting the same market everyone else sees.
      const { fetchOffers, consensusLine, MARKETS } = require('../scrapers/marketprops');
      const posted = new Map();
      for (const m of MARKETS) {
        for (const offer of await fetchOffers(m.id, new Date().getFullYear())) {
          const line = consensusLine(offer, 'over');
          if (line == null) continue;
          const who = (offer.participants || [])[0]?.name;
          if (!who) continue;
          const key = String(who).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
          posted.set(`${key}|${m.column}`, { line, name: who });
        }
      }

      const bookCoverage = {};
      const gaps = [];
      let compared = 0;
      for (const r of rows) {
        for (const [book, quote] of Object.entries(r.books)) {
          bookCoverage[book] = (bookCoverage[book] || 0) + (quote.line != null ? 1 : 0);
        }
        const match = posted.get(`${r.key}|${r.column}`);
        if (!match) continue;
        const ours = match.line;
        if (ours == null || !(ours > 0)) continue;
        // Only books quoting at something like even money: a milestone rung priced at +650
        // is not this market's central estimate any more than a lopsided consensus is.
        const fair = Object.values(r.books).filter(q => {
          if (q.price == null) return true;
          const p = q.price < 0 ? -q.price / (-q.price + 100) : 100 / (q.price + 100);
          return Math.abs(p - 0.5) <= 0.2;
        }).map(q => q.line);
        if (!fair.length) continue;
        fair.sort((a, b) => a - b);
        const theirs = fair[Math.floor(fair.length / 2)];
        compared++;
        const relative = Math.abs(theirs - ours) / ours;
        if (relative > 0.15) gaps.push({ name: match.name, label: r.label, ours, theirs, relative });
      }

      const live = Object.entries(bookCoverage).filter(([, n]) => n > 0).map(([b]) => b);
      const dead = ['circasports', 'mgm', 'betrivers', 'hardrock', 'thescore'].filter(b => !live.includes(b));
      console.log(`  ${rows.length} RotoWire futures across 6 markets; books carrying lines: ${live.join(', ') || 'none'}`);
      if (dead.length) {
        console.log(`  absent today: ${dead.join(', ')} — the brief calls Circa the sharp reference, and it is not publishing`);
      }

      if (compared < 40) {
        warn(`only ${compared} lines could be compared — the name join or their tables may have moved`);
      } else {
        const rate = gaps.length / compared;
        console.log(`  ${compared} of BettingPros' posted consensus lines comparable; ` +
          `${gaps.length} differ from RotoWire's books by more than 15% (${(100 * rate).toFixed(1)}%)`);
        gaps.sort((a, b) => b.relative - a.relative).slice(0, 5).forEach(g =>
          console.log(`    ${g.name} ${g.label}: ours ${g.ours}, RotoWire's books ${g.theirs} (${(100 * g.relative).toFixed(0)}%)`));
        // Two vendors reading the same books should mostly agree. A high disagreement rate
        // means one of them is not reporting the market, which is exactly the failure that
        // put Ashton Jeanty on the board 400 rushing yards light.
        if (rate <= 0.15) ok(`an independent vendor agrees with our lines on ${(100 * (1 - rate)).toFixed(0)}% of them`);
        else bad(`an independent vendor disagrees with ${(100 * rate).toFixed(0)}% of our lines — the consensus may not be the market`);
      }
    } catch (err) {
      warn(`RotoWire unavailable (${err.message}) — skipping the second-vendor cross-check`);
    }
  }

  /* ------------------------------------------------------------- board reach */
  section('Board coverage — can the projection actually land on rows?');
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
