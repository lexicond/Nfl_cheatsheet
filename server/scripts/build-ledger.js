#!/usr/bin/env node
/**
 * Build the Projection Ledger — the artifact that shows whether the model's numbers add up.
 *
 * The page was originally written by hand around a pasted data blob, which meant it went stale
 * the moment the model changed and there was no way to tell that it had. It is now generated:
 * `server/ledger/template.html` is the page, `window.__DATA__` is the only thing that varies,
 * and this rebuilds it from a live model run.
 *
 *   node server/scripts/build-ledger.js [out.html]
 *
 * Everything here is read-only against the model and the board. It is deliberately not part of
 * a refresh: it runs the model a second time and fetches a scraped page, and nothing on the
 * board depends on its output.
 */
const fs = require('fs');
const path = require('path');

const { runModel } = require('../model');
const nflverse = require('../model/nflverse');
const { aggregateSeason } = require('../model/usage');
const { correlation } = require('../model/stability');
const { fetchWinTotals } = require('../model/wintotals');
const { loadOddsGames } = require('../model/odds');

/**
 * Sleeper's depth chart, in the shape runModel wants: sleeper_id -> { order, team, injury }.
 * Mirrors `scrapers/expectedpoints.js`, which is the path the board actually runs.
 */
function buildDepthChart() {
  let db;
  try { ({ db } = require('../db')); } catch { return null; }
  const map = new Map();
  for (const row of db.prepare(`
    SELECT sleeper_player_id, nfl_team, depth_chart_order, injury_status FROM players
    WHERE sleeper_player_id IS NOT NULL AND depth_chart_order IS NOT NULL AND nfl_team IS NOT NULL
  `).all()) {
    map.set(String(row.sleeper_player_id), {
      // Sleeper uses 0 for a player carried on the roster but not placed on the chart.
      order: row.depth_chart_order > 0 ? row.depth_chart_order : null,
      team: nflverse.normaliseTeam(row.nfl_team),
      injury: row.injury_status || null,
    });
  }
  return map.size ? map : null;
}

const OUT = process.argv[2] || path.join(__dirname, '..', '..', 'cheatsheets', 'projection-ledger.html');
const TEMPLATE = path.join(__dirname, '..', 'ledger', 'template.html');
const SEASON = new Date().getFullYear();

// Points a team concedes per game, regressed toward the league mean. The model does not project
// defence at all, so this is a proxy and the fixture numbers should be read as a test of the
// offence and little else.
const DEFENCE_SHRINK = 0.5;
// Spread per point of scoring margin, and the logistic scale that turns a spread into a win
// probability. Both are the standard NFL rules of thumb rather than anything fitted here.
const WIN_PROB_SCALE = 5.5;

const round = (v, d = 0) => (v == null || !Number.isFinite(v) ? null : Number(Number(v).toFixed(d)));

function median(values) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** Per-team totals, summed from the players the model actually projected. */
function aggregateTeams(players) {
  const teams = new Map();
  for (const p of players) {
    // `components.basis` marks a player projected from draft capital because he has no NFL
    // usage yet. That is NOT the same as `is_rookie`: Quinn Ewers and Cam Miller are in their
    // second year and still have no usage, so they take the draft-capital path too. Filtering
    // on is_rookie let them through and put Miami on 43 quarterback games in a 17-game season.
    if (!p.team || p.components?.basis) continue;
    if (!teams.has(p.team)) {
      teams.set(p.team, { team: p.team, att: 0, tgt: 0, car: 0, passYd: 0, recYd: 0,
        rushYd: 0, passTd: 0, rushTd: 0, recTd: 0, n: 0, fpts: 0, envTotal: null });
    }
    const t = teams.get(p.team);
    const c = p.components || {};
    const g = p.games || 0;
    t.att += (c.attempts_pg || 0) * g;
    t.tgt += (c.targets_pg || 0) * g;
    t.car += (c.carries_pg || 0) * g;
    t.passYd += (c.pass_yards_pg || 0) * g;
    t.recYd += (c.rec_yards_pg || 0) * g;
    t.rushYd += (c.rush_yards_pg || 0) * g;
    t.passTd += (c.pass_tds_pg || 0) * g;
    t.rushTd += (c.rush_tds_pg || 0) * g;
    t.recTd += (c.rec_tds_pg || 0) * g;
    t.fpts += p.points || 0;
    t.n += 1;
    if (t.envTotal == null && c.env_total != null) t.envTotal = c.env_total;
  }
  return teams;
}

/**
 * Run every fixture and count expected wins.
 *
 * The model gives offence only, so each team's scoring is its own projected points per game
 * against its opponent's defensive strength, and the margin becomes a win probability through
 * the usual logistic. Read the output as an ordering of teams, not as a forecast: the offence
 * has already been scaled by the market's implied team totals.
 */
function projectWins(teamPPG, defenceAdj, schedule) {
  const wins = new Map();
  for (const team of teamPPG.keys()) wins.set(team, 0);
  let counted = 0;
  for (const g of schedule) {
    const home = nflverse.normaliseTeam(g.home_team);
    const away = nflverse.normaliseTeam(g.away_team);
    if (!teamPPG.has(home) || !teamPPG.has(away)) continue;
    const homeScore = teamPPG.get(home) + (defenceAdj.get(away) || 0);
    const awayScore = teamPPG.get(away) + (defenceAdj.get(home) || 0);
    // Home advantage, the league's own long-run figure.
    const margin = homeScore - awayScore + 1.3;
    const pHome = 1 / (1 + Math.exp(-margin / WIN_PROB_SCALE));
    wins.set(home, wins.get(home) + pHome);
    wins.set(away, wins.get(away) + (1 - pHome));
    counted++;
  }
  return { wins, counted };
}

(async () => {
  console.log('[Ledger] running the model…');
  // The SAME depth map the board's own run uses — Sleeper's, keyed by sleeper id. Handing the
  // model nflverse's chart instead is not a near-enough substitute: it is the wrong shape, the
  // lookup silently misses on every player, and the quarterback-games conservation stops firing.
  // Miami came out with 43 quarterback games in a seventeen-game season before this was fixed.
  const depthChart = buildDepthChart();
  const run = await runModel({ targetSeason: SEASON, iterations: 400, depthChart });
  const players = run.projections;

  const teams = aggregateTeams(players);
  const previous = SEASON - 1;

  console.log('[Ledger] loading last season for the yardstick…');
  let actualByTeam = new Map();
  let defenceAdj = new Map();
  try {
    const stats = await nflverse.loadSeasonStats(previous);
    // aggregateSeason keys by player id, so take the values.
    const usage = [...aggregateSeason(stats.rows, previous).values()];
    for (const row of usage) {
      const team = nflverse.normaliseTeam(row.team);
      if (!team) continue;
      if (!actualByTeam.has(team)) {
        actualByTeam.set(team, { att: 0, tgt: 0, car: 0, passTd: 0, rushTd: 0, recTd: 0,
          passYd: 0, recYd: 0, rushYd: 0 });
      }
      const t = actualByTeam.get(team);
      t.att += row.attempts || 0; t.tgt += row.targets || 0; t.car += row.carries || 0;
      t.passYd += row.passing_yards || 0; t.recYd += row.receiving_yards || 0;
      t.rushYd += row.rushing_yards || 0; t.passTd += row.passing_tds || 0;
      t.rushTd += row.rushing_tds || 0; t.recTd += row.receiving_tds || 0;
    }
  } catch (err) {
    console.warn(`[Ledger] last season unavailable (${err.message}) — the comparison column will be empty`);
  }

  // Defence, proxied from last season's points allowed and regressed halfway to the mean.
  // loadSchedules returns every season it has, so both cuts come from one fetch.
  let allSchedules = [];
  try {
    allSchedules = await nflverse.loadSchedules();
  } catch (err) {
    console.warn(`[Ledger] schedule unavailable (${err.message})`);
  }
  const schedule = allSchedules.filter(g => g.season === SEASON && g.game_type === 'REG');
  try {
    const past = allSchedules.filter(g => g.season === previous && g.game_type === 'REG');
    const allowed = new Map();
    for (const g of past) {
      const home = nflverse.normaliseTeam(g.home_team);
      const away = nflverse.normaliseTeam(g.away_team);
      const hs = Number(g.home_score), as = Number(g.away_score);
      if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
      for (const [team, conceded] of [[home, as], [away, hs]]) {
        if (!team) continue;
        if (!allowed.has(team)) allowed.set(team, []);
        allowed.get(team).push(conceded);
      }
    }
    const means = [...allowed.entries()].map(([t, v]) => [t, v.reduce((a, b) => a + b, 0) / v.length]);
    const league = means.reduce((a, [, m]) => a + m, 0) / (means.length || 1);
    for (const [team, mean] of means) defenceAdj.set(team, (mean - league) * DEFENCE_SHRINK);
  } catch { /* no defence proxy: every team gets zero, which is neutral */ }

  // The market's own view of each offence, for the per-team gap column.
  const marketPPG = new Map();
  try {
    const odds = await loadOddsGames(SEASON);
    const games = odds.games || [];
    const per = new Map();
    for (const g of games) {
      const total = Number(g.total_line), spread = Number(g.spread_line);
      if (!Number.isFinite(total) || !Number.isFinite(spread)) continue;
      const home = nflverse.normaliseTeam(g.home_team);
      const away = nflverse.normaliseTeam(g.away_team);
      // spread_line is positive for a home favourite.
      for (const [team, implied] of [[home, total / 2 + spread / 2], [away, total / 2 - spread / 2]]) {
        if (!team) continue;
        if (!per.has(team)) per.set(team, []);
        per.get(team).push(implied);
      }
    }
    for (const [team, values] of per) marketPPG.set(team, values.reduce((a, b) => a + b, 0) / values.length);
  } catch (err) {
    console.warn(`[Ledger] market team totals unavailable (${err.message})`);
  }

  // Offensive points per game: projected touchdowns at six, plus the extra point that
  // follows 94% of them, plus a flat allowance for field goals.
  //
  // Kicking is not modelled and neither is defensive or special-teams scoring, so the field
  // goal term is the league's own average rather than anything this team-specific. It is the
  // same for every team by construction and therefore cannot change their order — it exists
  // so the LEVEL is comparable with a real scoreboard, which is the only thing it is read for.
  const EXTRA_POINT_RATE = 0.94;
  const FIELD_GOAL_POINTS_PER_GAME = 5.4;
  const teamPPG = new Map();
  for (const [team, t] of teams) {
    const tds = t.passTd + t.rushTd;
    teamPPG.set(team, (tds * (6 + EXTRA_POINT_RATE)) / 17 + FIELD_GOAL_POINTS_PER_GAME);
  }
  const { wins, counted } = projectWins(teamPPG, defenceAdj, schedule);

  // How the model's own view of each offence lines up with the market's, team by team.
  const scoringPairs = [...teamPPG.entries()]
    .filter(([team]) => marketPPG.has(team))
    .map(([team, ppg]) => [ppg, marketPPG.get(team)]);
  const teamScoringRho = scoringPairs.length >= 24 ? correlation(scoringPairs) : null;
  const meanAbsGap = scoringPairs.length
    ? scoringPairs.reduce((a, [m, k]) => a + Math.abs(m - k), 0) / scoringPairs.length : null;

  console.log('[Ledger] fetching the market on whole teams…');
  let marketWins = {};
  try {
    marketWins = await fetchWinTotals();
  } catch (err) {
    console.warn(`[Ledger] win totals unavailable (${err.message})`);
  }

  // Spreads, against the ones the books have posted.
  const spreadPairs = [];
  for (const g of schedule) {
    const home = nflverse.normaliseTeam(g.home_team);
    const away = nflverse.normaliseTeam(g.away_team);
    const posted = Number(g.spread_line);
    if (!Number.isFinite(posted) || !teamPPG.has(home) || !teamPPG.has(away)) continue;
    const ours = (teamPPG.get(home) + (defenceAdj.get(away) || 0))
      - (teamPPG.get(away) + (defenceAdj.get(home) || 0)) + 1.3;
    spreadPairs.push([ours, posted]);
  }
  const spreadRho = spreadPairs.length > 8 ? correlation(spreadPairs) : null;
  const spreadMAE = spreadPairs.length
    ? spreadPairs.reduce((a, [o, p]) => a + Math.abs(o - p), 0) / spreadPairs.length : null;
  const spreadBias = spreadPairs.length
    ? spreadPairs.reduce((a, [o, p]) => a + (o - p), 0) / spreadPairs.length : null;
  const sameFavourite = spreadPairs.filter(([o, p]) => (o > 0) === (p > 0)).length;

  // The board's own market column, for the sources section.
  let market = null;
  try {
    const { db } = require('../db');
    const rows = db.prepare(`
      SELECT position, xfp_points m, mkt_points k, projected_pts s, mkt_complete c, mkt_adjusted a
      FROM players WHERE mkt_points IS NOT NULL
    `).all();
    const complete = rows.filter(r => r.c === 1 && r.m != null);
    const rank = (arr, f) => {
      const o = arr.map((x, i) => [f(x), i]).sort((a, b) => a[0] - b[0]);
      const r = new Array(arr.length);
      o.forEach(([, i], k) => { r[i] = k + 1; });
      return r;
    };
    const rho = (arr, f, g) => {
      const a = rank(arr, f), b = rank(arr, g);
      return correlation(a.map((v, i) => [v, b[i]]));
    };
    const withSleeper = complete.filter(r => r.s != null);
    market = {
      priced: rows.length,
      complete: complete.length,
      adjusted: rows.filter(r => r.a > 0).length,
      modelRho: complete.length >= 40 ? round(rho(complete, x => x.m, x => x.k), 3) : null,
      sleeperRho: withSleeper.length >= 40 ? round(rho(withSleeper, x => x.s, x => x.k), 3) : null,
    };
  } catch (err) {
    console.warn(`[Ledger] board database unavailable (${err.message})`);
  }

  const teamRows = [...teams.values()].map(t => ({
    team: t.team,
    att: round(t.att), tgt: round(t.tgt), car: round(t.car),
    passYd: round(t.passYd), recYd: round(t.recYd), rushYd: round(t.rushYd),
    passTd: round(t.passTd, 1), rushTd: round(t.rushTd, 1), recTd: round(t.recTd, 1),
    n: t.n, fpts: round(t.fpts), envTotal: round(t.envTotal, 2),
    actual: actualByTeam.get(t.team) || null,
  })).sort((a, b) => a.team.localeCompare(b.team));

  const playerRows = players.filter(p => p.team).map(p => {
    const c = p.components || {};
    const g = p.games || 0;
    return {
      name: p.name, pos: p.position, team: p.team,
      games: round(g, 1), points: round(p.points, 1), ceiling: round(p.ceiling, 1),
      conf: p.confidence, fromDraft: !!c.basis,
      att: round((c.attempts_pg || 0) * g), tgt: round((c.targets_pg || 0) * g),
      car: round((c.carries_pg || 0) * g),
      passYd: round((c.pass_yards_pg || 0) * g), recYd: round((c.rec_yards_pg || 0) * g),
      rushYd: round((c.rush_yards_pg || 0) * g),
      passTd: round((c.pass_tds_pg || 0) * g, 1), rushTd: round((c.rush_tds_pg || 0) * g, 1),
      recTd: round((c.rec_tds_pg || 0) * g, 1), rec: round((c.receptions_pg || 0) * g),
      envTotal: round(c.env_total, 2), envSource: c.env_source || null,
      anchor: c.level_season ?? null,
    };
  }).sort((a, b) => b.points - a.points);

  const leagueMeasures = [
    ['Pass attempts', 'att'], ['Targets', 'tgt'], ['Carries', 'car'],
    ['Passing yards', 'passYd'], ['Receiving yards', 'recYd'], ['Rushing yards', 'rushYd'],
    ['Passing TDs', 'passTd'], ['Rushing TDs', 'rushTd'], ['Receiving TDs', 'recTd'],
  ].map(([label, key]) => {
    const model = teamRows.reduce((a, t) => a + (t[key] || 0), 0) / (teamRows.length || 1);
    const withActual = teamRows.filter(t => t.actual);
    const actual = withActual.length
      ? withActual.reduce((a, t) => a + (t.actual[key] || 0), 0) / withActual.length : null;
    return { label, model: round(model), actual: round(actual) };
  });

  const winRows = [...wins.entries()].map(([team, w]) => ({
    team,
    wins: round(w, 1),
    modelPPG: round(teamPPG.get(team), 1),
    marketPPG: round(marketPPG.get(team), 1),
    marketWins: marketWins[team] ? round(marketWins[team].wins, 1) : null,
    books: marketWins[team]?.books ?? null,
  })).sort((a, b) => b.wins - a.wins);

  const winPairs = winRows.filter(r => r.marketWins != null).map(r => [r.wins, r.marketWins]);
  const offencePairs = winRows.filter(r => r.marketWins != null && r.modelPPG != null)
    .map(r => [r.modelPPG, r.marketWins]);

  const data = {
    summary: {
      generated: new Date().toISOString(),
      targetSeason: SEASON,
      historySeasons: run.meta?.history_seasons || [],
      envCoverage: run.meta?.environment?.coverage ?? null,
      pricedGames: run.meta?.environment?.priced_games ?? null,
      scheduledGames: run.meta?.environment?.scheduled_games ?? schedule.length,
      qbGamesReclaimed: run.meta?.qb_conservation?.games_reclaimed ?? null,
      projected: players.length,
      rookies: players.filter(p => p.components?.basis).length,
      gated: run.meta?.gated ?? null,
      league: leagueMeasures,
      fixtures: {
        modelMeanPPG: round([...teamPPG.values()].reduce((a, b) => a + b, 0) / teamPPG.size, 1),
        marketMeanPPG: round([...marketPPG.values()].reduce((a, b) => a + b, 0) / (marketPPG.size || 1), 1),
        teamScoringRho: round(teamScoringRho, 3),
        meanAbsGap: round(meanAbsGap, 2),
        spreadN: spreadPairs.length,
        spreadMAE: round(spreadMAE, 2),
        spreadBias: round(spreadBias, 2),
        spreadRho: round(spreadRho, 3),
        sameFavourite,
        gamesRun: counted,
      },
      wins: winRows,
      winMarket: {
        teams: Object.keys(marketWins).length,
        books: marketWins[Object.keys(marketWins)[0]]?.books ?? null,
        impliedTotal: round(Object.values(marketWins).reduce((a, t) => a + t.wins, 0), 1),
        worstCrossBook: round(Math.max(0, ...Object.values(marketWins).map(t => t.crossBookSpread)), 2),
        winsRho: winPairs.length >= 24 ? round(correlation(winPairs), 3) : null,
        offenceRho: offencePairs.length >= 24 ? round(correlation(offencePairs), 3) : null,
      },
      market,
    },
    teams: teamRows,
    players: playerRows,
  };

  const template = fs.readFileSync(TEMPLATE, 'utf8');
  if (!template.includes('__LEDGER_DATA__')) {
    throw new Error('template has lost its __LEDGER_DATA__ placeholder — nothing would be injected');
  }
  // `</script` inside a JSON string would close the tag early and blank the page.
  const json = JSON.stringify(data).replace(/<\//g, '<\\/');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, template.replace('__LEDGER_DATA__', json));

  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`[Ledger] wrote ${OUT} — ${playerRows.length} players, ${teamRows.length} teams, ${kb} KB`);
  if (data.summary.winMarket.winsRho != null) {
    console.log(`[Ledger] projected wins vs the market's win totals: rho ${data.summary.winMarket.winsRho}`);
  }
})().catch(err => {
  console.error('[Ledger] failed:', err.message);
  process.exit(1);
});
