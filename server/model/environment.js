/**
 * Module C — team environment, from the betting market.
 *
 * How many points a team is expected to score bounds how many fantasy points its
 * players can divide up, and the market forecasts that better than any public model.
 * The conversion is arithmetic, not opinion:
 *
 *     implied team total = total / 2 ± spread / 2
 *
 * A team favoured by 6 in a 47-point game is priced for 26.5. Averaging a team's
 * implied totals across its schedule gives a market-consensus offensive forecast for
 * the season, and the same two numbers give the game script — a big favourite runs
 * more, its opponent throws more — which is what tilts value between a backfield and
 * a receiving corps.
 *
 * The honest problem in August: books have priced only part of the season. nflverse's
 * schedule file carries every 2026 game but a line on roughly the first third of them.
 * So this layer computes what it can from real prices, falls back to a regressed
 * three-year scoring baseline for teams with too few priced games, and REPORTS which
 * of the two each team got. A projection built on a fallback is not the same claim as
 * one built on Vegas, and the model says which it is rather than presenting both as
 * "market-implied".
 */

const LEAGUE_MEAN_TOTAL = 44.5;   // long-run NFL game total, used only as a last resort
const REG = 'REG';

// A team needs this many priced games before its market average is trusted on its own.
// Below it, the market number is blended toward the team's own recent scoring.
const MIN_PRICED_GAMES = 4;

/**
 * Implied totals for both sides of one priced game.
 * spread_line is quoted from the home team's perspective: positive means home favoured.
 */
function impliedTotals(game) {
  if (game.total_line == null || game.spread_line == null) return null;
  const half = game.total_line / 2;
  const edge = game.spread_line / 2;
  return {
    [game.home_team]: half + edge,
    [game.away_team]: half - edge,
  };
}

/**
 * What each team actually scored per game in a completed season. This is the fallback
 * when the market has not priced enough of a team's schedule, and it is also what the
 * market number is blended toward when the sample is thin.
 */
function realisedScoring(games, season) {
  const acc = new Map();
  const add = (team, pts) => {
    if (!team || pts == null) return;
    if (!acc.has(team)) acc.set(team, { pts: 0, games: 0 });
    const a = acc.get(team);
    a.pts += pts;
    a.games++;
  };
  for (const g of games) {
    if (g.season !== season || g.game_type !== REG) continue;
    if (g.home_score == null || g.away_score == null) continue;
    add(g.home_team, g.home_score);
    add(g.away_team, g.away_score);
  }
  const out = new Map();
  for (const [team, a] of acc) out.set(team, a.pts / a.games);
  return out;
}

/**
 * Regress a team's realised scoring across the seasons available, weighting recent
 * years more and pulling everything toward the league mean. Team offences turn over;
 * last year's 30-point unit is not this year's without evidence.
 */
function baselineScoring(games, seasons) {
  const weights = [0.5, 0.3, 0.2];
  const perSeason = seasons.slice(0, 3).map(s => realisedScoring(games, s));
  const teams = new Set(perSeason.flatMap(m => [...m.keys()]));

  // League mean per game, over whatever seasons we have.
  const all = perSeason.flatMap(m => [...m.values()]);
  const leagueMean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : LEAGUE_MEAN_TOTAL / 2;

  const out = new Map();
  for (const team of teams) {
    let num = 0;
    let den = 0;
    perSeason.forEach((m, i) => {
      const v = m.get(team);
      if (v == null) return;
      num += v * weights[i];
      den += weights[i];
    });
    if (den === 0) continue;
    const weighted = num / den;
    // Shrink a third of the way to the league mean: team scoring is moderately sticky
    // year to year, nowhere near fully so.
    out.set(team, weighted * 0.67 + leagueMean * 0.33);
  }
  return out;
}

/**
 * Build the environment table for the target season.
 *
 * Returns, per team:
 *   implied_total   points per game the team is expected to score
 *   source          'market' | 'blended' | 'baseline' — how that number was arrived at
 *   priced_games    how many of its games the book has actually priced
 *   pass_lean       game-script tilt, positive = expected to throw more than average
 *   env_scalar      implied_total / league mean, the multiplier applied to a projection
 */
function buildEnvironment(games, targetSeason, historySeasons) {
  const baseline = baselineScoring(games, historySeasons);
  const baseVals = [...baseline.values()];
  const baseMean = baseVals.length
    ? baseVals.reduce((a, b) => a + b, 0) / baseVals.length
    : LEAGUE_MEAN_TOTAL / 2;

  // Collect every priced game of the target season, per team.
  const priced = new Map();          // team -> implied totals
  const spreads = new Map();         // team -> its own spread (negative = favoured)
  let pricedGames = 0;
  let scheduledGames = 0;

  for (const g of games) {
    if (g.season !== targetSeason || g.game_type !== REG) continue;
    scheduledGames++;
    const totals = impliedTotals(g);
    if (!totals) continue;
    pricedGames++;
    for (const [team, tot] of Object.entries(totals)) {
      if (!priced.has(team)) { priced.set(team, []); spreads.set(team, []); }
      priced.get(team).push(tot);
    }
    // A team's own spread: home takes spread_line, away takes its negation.
    spreads.get(g.home_team).push(g.spread_line);
    spreads.get(g.away_team).push(-g.spread_line);
  }

  const teams = new Set([...baseline.keys(), ...priced.keys()]);
  const table = new Map();

  for (const team of teams) {
    const list = priced.get(team) || [];
    const marketMean = list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
    const base = baseline.get(team) ?? baseMean;

    let implied;
    let source;
    if (marketMean != null && list.length >= MIN_PRICED_GAMES) {
      implied = marketMean;
      source = 'market';
    } else if (marketMean != null && list.length > 0) {
      // Thin sample: weight the market by how much of it there is.
      const w = list.length / MIN_PRICED_GAMES;
      implied = marketMean * w + base * (1 - w);
      source = 'blended';
    } else {
      implied = base;
      source = 'baseline';
    }

    // Game script. A team favoured on average runs more and throws less; the underdog
    // does the reverse, playing from behind. Hence the negation: mean_spread is positive
    // for a favourite, and a favourite's pass lean is negative. Expressed as a small
    // lean, not a hard multiplier — the effect on season-long volume is real but modest,
    // and it is capped so one lopsided schedule cannot dominate a projection.
    const sp = spreads.get(team) || [];
    const meanSpread = sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : 0;
    const passLean = Math.max(-0.06, Math.min(0.06, -meanSpread * 0.012));

    table.set(team, {
      team,
      implied_total: Math.round(implied * 100) / 100,
      source,
      priced_games: list.length,
      mean_spread: Math.round(meanSpread * 100) / 100,
      pass_lean: Math.round(passLean * 1000) / 1000,
      env_scalar: Math.round((implied / baseMean) * 1000) / 1000,
    });
  }

  const bySource = { market: 0, blended: 0, baseline: 0 };
  for (const t of table.values()) bySource[t.source]++;

  return {
    table,
    target_season: targetSeason,
    league_mean_scoring: Math.round(baseMean * 100) / 100,
    scheduled_games: scheduledGames,
    priced_games: pricedGames,
    coverage: scheduledGames ? Math.round((pricedGames / scheduledGames) * 1000) / 1000 : 0,
    teams_by_source: bySource,
  };
}

module.exports = {
  buildEnvironment, impliedTotals, realisedScoring, baselineScoring,
  LEAGUE_MEAN_TOTAL, MIN_PRICED_GAMES,
};
