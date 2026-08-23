/**
 * The expected-points model, end to end.
 *
 * Ingest → Modules A/B/C → combination identity → simulation → per-player projections.
 * Everything is keyed on gsis_id and joined to the board on Sleeper's id through the
 * crosswalk, so no part of this touches the name matcher.
 *
 * What this is NOT: a market. It is the board's own opinion, computed from what players
 * actually did and what the betting market expects their offences to score. It is
 * deliberately kept out of every consensus average for that reason — see sources.js.
 */
const nflverse = require('./nflverse');
const { buildUsageHistory, positionalBaselines } = require('./usage');
const { buildStability } = require('./stability');
const { projectVolume, volumeBaselines } = require('./volume');
const { projectEfficiency, fpoeResidual } = require('./efficiency');
const { buildEnvironment } = require('./environment');
const {
  expectedPointsPerGame, expectedGames, weeklyVolatility, simulateSeason,
} = require('./combine');

// Seasons of history for the priors, and the deeper window used only to measure
// year-over-year stability, which needs consecutive pairs and benefits from more of them.
const PRIOR_SEASONS = 3;
const STABILITY_SEASONS = 6;

/**
 * Hyperparameters, selected OUT OF SAMPLE by scripts/tune-projections.js: every
 * candidate is scored on one test season and the winner is then checked against a
 * different, later one it was never fitted on. Picking these by eye on the season you
 * report is how a model comes to look good only on the season you reported.
 *
 *   recency          how much weight each of the last three seasons carries. The first
 *                    version of this model spread weight far too evenly and lost to
 *                    "repeat last season" outright — a role from two years ago is much
 *                    weaker evidence than the shape of the curve first suggested.
 *   volumeShrink     multiplier on Module A's shrinkage constants
 *   efficiencyShrink multiplier on Module B's
 */
const TUNING = {
  // Only the most recent season the player actually has carries weight. This was the
  // surprise of the tuning run and it is worth stating plainly: blending three seasons
  // of usage — which is what the architecture suggests and what the first version did —
  // ranked WORSE than using the latest one alone, at every setting tried. Roles turn
  // over fast enough that a season two years back is mostly noise about this one, and
  // the shrinkage step already handles a thin recent sample. Older seasons are still
  // used, for measuring stability and for the FPOE talent prior.
  recency: [1, 0, 0],
  volumeShrink: 1,
  // Half the shrinkage the measured reliabilities imply. Those are estimated over a
  // pooled sample of every player at a position, which understates how much a
  // high-volume starter's own rates are worth.
  efficiencyShrink: 0.5,
};

/**
 * Rookies, and anyone else with no NFL history.
 *
 * They cannot be projected from usage they do not have, and leaving them off the board
 * entirely would be worse than a rough number — a first-round rookie running back is a
 * top-30 pick and the board has to say something about him.
 *
 * So the model does what the research supports: draft capital is the single most
 * predictive input available before a snap is played, and the relationship between
 * draft slot and rookie-season production is estimated FROM THIS DATA rather than
 * assumed — see rookieCurve below. Confidence is reported as 'low' throughout, because
 * it deserves to be.
 */
function buildRookieCurve(history, crosswalk, seasonsAvailable) {
  // Every drafted player's rookie season, paired with where he was drafted.
  const samples = { QB: [], RB: [], WR: [], TE: [] };
  const window = new Set(seasonsAvailable);

  // Start from the DRAFT, not from the stats. Fitting only on rookies who recorded a
  // season is survivorship bias of the worst kind here: the busts are precisely the
  // players who never appear in a stats file, so excluding them fits the curve to the
  // hits alone and hands every rookie the projection of a rookie who worked out. A
  // drafted player with no rookie season scored nothing, and the fit has to know that.
  for (const [gsis, entry] of crosswalk.byGsis) {
    if (entry.draft_year == null || entry.draft_ovr == null || entry.draft_ovr <= 0) continue;
    // Only draft classes whose rookie season is inside the data window, or the zero is
    // an artefact of the window rather than of the player.
    if (!window.has(entry.draft_year)) continue;
    if (!samples[entry.position]) continue;

    const seasons = history.get(gsis);
    const rookie = seasons ? seasons.find(s => s.season === entry.draft_year) : null;
    samples[entry.position].push({
      ovr: entry.draft_ovr,
      ppg: rookie ? rookie.ppg : 0,
      games: rookie ? rookie.games : 0,
    });
  }

  // Fit points-per-game against draft slot with a simple log fit, which matches the
  // shape of the relationship far better than a straight line: the gap between pick 1
  // and pick 20 is enormous, the gap between 180 and 200 is nothing.
  const curve = {};
  for (const [pos, list] of Object.entries(samples)) {
    const usable = list.filter(s => s.ovr > 0);
    if (usable.length < 12) { curve[pos] = null; continue; }

    const xs = usable.map(s => Math.log(s.ovr));
    const ys = usable.map(s => s.ppg);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const slope = den > 0 ? num / den : 0;

    // A straight line in log-pick space extrapolates badly off the top of the draft:
    // there are only a handful of picks inside the top five in any sample, so the fit
    // happily projects a pick-three back above every established veteran at his
    // position. Two empirical bounds stop that, both taken from the data rather than
    // chosen: the pick is clamped to the range actually observed, and the result is
    // capped at the 95th percentile of what rookies at this position have really
    // scored. No rookie projects above what rookies actually do.
    const ppgPlayed = usable.filter(s => s.games > 0).map(s => s.ppg).sort((a, b) => a - b);
    const cap = ppgPlayed.length
      ? ppgPlayed[Math.min(ppgPlayed.length - 1, Math.floor(ppgPlayed.length * 0.95))]
      : null;

    curve[pos] = {
      slope,
      intercept: my - slope * mx,
      n,
      mean_ppg: my,
      played: ppgPlayed.length,
      min_ovr: Math.min(...usable.map(s => s.ovr)),
      max_ovr: Math.max(...usable.map(s => s.ovr)),
      ppg_cap: cap,
    };
  }
  return curve;
}

function projectRookie(entry, position, curve, env) {
  const c = curve[position];
  if (!c || entry.draft_ovr == null) return null;
  // Undrafted free agents carry no pick; treat them as late as the draft goes.
  const raw = entry.draft_ovr > 0 ? entry.draft_ovr : 260;
  // Never extrapolate outside the picks the curve was actually fitted on.
  const ovr = Math.max(c.min_ovr, Math.min(c.max_ovr, raw));
  let ppg = Math.max(0.5, c.intercept + c.slope * Math.log(ovr));
  if (c.ppg_cap != null) ppg = Math.min(ppg, c.ppg_cap);
  const scalar = Math.pow(env?.env_scalar ?? 1, 0.7);
  return ppg * scalar;
}

/**
 * Run the model.
 *
 * `targetSeason` is the season being projected. History is whatever nflverse actually
 * has below it — discovered, not assumed, because in August the previous season may not
 * be cut yet and quietly projecting on two-year-old usage is the failure this guards
 * against.
 */
async function runModel({
  targetSeason = new Date().getFullYear(),
  iterations = 400,
  // Backtest controls. Both exist to keep a historical run honest, and both default to
  // the live behaviour so a normal run is unaffected.
  //
  //   environmentMaxWeek — only price the environment off games up to this week. A
  //     backtest that averages a whole season's closing lines is using prices that did
  //     not exist on draft day; capping the week reproduces what a book had posted in
  //     August, which for the live 2026 run is about the first six weeks.
  //   useHistoryTeam — take each player's team from his most recent played season
  //     rather than from the crosswalk. The crosswalk is always current, so a backtest
  //     that used it would place every player in the offence he joined afterwards.
  environmentMaxWeek = null,
  useHistoryTeam = false,
  // Model hyperparameters. Defaults are the values selected out of sample — see
  // TUNING below and scripts/tune-projections.js. Overridable so the tuner can sweep
  // them without editing the model.
  tuning = {},
} = {}) {
  const startedAt = Date.now();
  const warnings = [];

  // --- Layer 0: ingest -------------------------------------------------------
  const seasons = await nflverse.availableSeasons(targetSeason, STABILITY_SEASONS);
  if (seasons.length === 0) {
    throw new Error(`no nflverse weekly stats available below ${targetSeason} — cannot project`);
  }

  // The most important assertion in the model. If the newest season on hand is more
  // than one behind the target, the projection is being built without last year, and
  // that is a materially different claim — it must never pass silently.
  const newest = seasons[0];
  const staleBy = targetSeason - 1 - newest;
  if (staleBy > 0) {
    warnings.push(
      `history stops at ${newest}, ${staleBy} season(s) before ${targetSeason - 1} — ` +
      'the projection does not include last season'
    );
  }

  const statSeasons = [];
  for (const s of seasons) statSeasons.push(await nflverse.loadSeasonStats(s));

  const crosswalk = await nflverse.loadCrosswalk();
  const games = await nflverse.loadSchedules();

  // --- Priors ----------------------------------------------------------------
  const fullHistory = buildUsageHistory(statSeasons);
  const stability = buildStability(fullHistory);
  const rateBaselines = positionalBaselines(fullHistory);
  const volBaselines = volumeBaselines(fullHistory);
  const rookieCurve = buildRookieCurve(fullHistory, crosswalk, seasons);

  // --- Module C ---------------------------------------------------------------
  const envGames = environmentMaxWeek == null
    ? games
    : games.filter(g => g.season !== targetSeason || g.week <= environmentMaxWeek);
  const environment = buildEnvironment(envGames, targetSeason, seasons);
  if (environment.coverage < 0.15) {
    warnings.push(
      `only ${Math.round(environment.coverage * 100)}% of ${targetSeason} games are priced — ` +
      'team environment is mostly a regressed baseline, not a market signal'
    );
  }

  // --- Per player --------------------------------------------------------------
  const projections = [];

  for (const [gsis, allSeasons] of fullHistory) {
    // Priors use the recent window only; the deeper history exists for stability.
    const recent = allSeasons.filter(s => s.season > targetSeason - 1 - PRIOR_SEASONS);
    if (recent.length === 0) continue;

    const position = recent[0].position;
    if (!nflverse.POSITIONS.has(position)) continue;

    const idEntry = crosswalk.byGsis.get(gsis);
    // The team he is on NOW, from the crosswalk, not the one he finished last season
    // with. A player who changed teams in the offseason is projected into his new
    // offence, which is the whole point of having an environment layer. A backtest
    // must not do this — the crosswalk knows where he ended up.
    const team = useHistoryTeam
      ? recent[0].team
      : ((idEntry?.team && idEntry.team !== 'NA') ? idEntry.team : recent[0].team);
    const env = environment.table.get(team) || null;

    const fpoe = fpoeResidual(recent, position, rateBaselines);
    const tune = { ...TUNING, ...tuning };
    const volume = projectVolume(recent, position, volBaselines, stability.table, env, tune);
    const efficiency = projectEfficiency(recent, position, rateBaselines, stability.table, fpoe, tune);
    const { ppg, breakdown, env_scalar_applied } =
      expectedPointsPerGame(volume, efficiency, env?.env_scalar ?? 1);

    const age = idEntry?.age ?? null;
    const gamesPlayed = expectedGames(recent, position, age);
    const cv = weeklyVolatility(recent, position, ppg);
    const sim = simulateSeason(ppg, gamesPlayed, cv, { iterations, seed: gsis });

    // How much this projection should be trusted. Driven by the things that actually
    // undermine it: no recent season, thin opportunity, or a team the market has not
    // priced.
    const totalOpportunity = recent.reduce((a, s) => a + s.targets + s.carries + s.attempts, 0);
    const sawLastSeason = recent.some(s => s.season === newest);
    let confidence = 'high';
    if (!sawLastSeason || totalOpportunity < 80) confidence = 'low';
    else if (totalOpportunity < 250 || env?.source === 'baseline') confidence = 'medium';

    projections.push({
      gsis_id: gsis,
      sleeper_id: idEntry?.sleeper_id ?? null,
      name: recent[0].name,
      position,
      team,
      points: sim ? Math.round(sim.mean * 10) / 10 : Math.round(ppg * gamesPlayed * 10) / 10,
      ppg: Math.round(ppg * 100) / 100,
      games: Math.round(gamesPlayed * 10) / 10,
      floor: sim ? Math.round(sim.floor * 10) / 10 : null,
      ceiling: sim ? Math.round(sim.ceiling * 10) / 10 : null,
      best_ball: sim ? Math.round(sim.best_ball * 10) / 10 : null,
      volatility: Math.round(cv * 1000) / 1000,
      confidence,
      is_rookie: false,
      components: {
        ...breakdown,
        env_team: team,
        env_total: env?.implied_total ?? null,
        env_source: env?.source ?? null,
        env_scalar: env_scalar_applied,
        fpoe: Math.round(fpoe * 1000) / 1000,
        talent_multiplier: efficiency.talent_multiplier,
        seasons_used: recent.map(s => s.season),
        // Which season actually set the level of the projection, as opposed to which
        // ones contributed sample size and the talent prior. With the tuned recency
        // weights these are not the same, and the panel should not imply they are.
        level_season: recent[0].season,
        opportunities: totalOpportunity,
      },
    });
  }

  // --- Rookies -----------------------------------------------------------------
  // Anyone drafted into the target season, or the one before it who never recorded a
  // usable season, has no history to project from.
  const projected = new Set(projections.map(p => p.gsis_id));
  let rookieCount = 0;

  for (const [gsis, entry] of crosswalk.byGsis) {
    if (projected.has(gsis)) continue;
    if (entry.draft_year == null || entry.draft_year < targetSeason - 1) continue;
    if (!nflverse.POSITIONS.has(entry.position)) continue;

    const env = environment.table.get(entry.team) || null;
    const ppg = projectRookie(entry, entry.position, rookieCurve, env);
    if (ppg == null) continue;

    const gamesPlayed = entry.position === 'RB' ? 13.5 : 13.0;
    // Rookies are more volatile than veterans at the same projection — the role is not
    // yet established, so the week-to-week spread is wider.
    const cv = Math.min(1.4, (require('./combine').POSITION_CV[entry.position] ?? 0.65) * 1.15);
    const sim = simulateSeason(ppg, gamesPlayed, cv, { iterations, seed: gsis });

    projections.push({
      gsis_id: gsis,
      sleeper_id: entry.sleeper_id,
      name: entry.name,
      position: entry.position,
      team: entry.team,
      points: sim ? Math.round(sim.mean * 10) / 10 : Math.round(ppg * gamesPlayed * 10) / 10,
      ppg: Math.round(ppg * 100) / 100,
      games: gamesPlayed,
      floor: sim ? Math.round(sim.floor * 10) / 10 : null,
      ceiling: sim ? Math.round(sim.ceiling * 10) / 10 : null,
      best_ball: sim ? Math.round(sim.best_ball * 10) / 10 : null,
      volatility: Math.round(cv * 1000) / 1000,
      confidence: 'low',
      is_rookie: true,
      components: {
        env_team: entry.team,
        env_total: env?.implied_total ?? null,
        env_source: env?.source ?? null,
        draft_ovr: entry.draft_ovr,
        draft_round: entry.draft_round,
        basis: 'draft capital — no NFL usage yet',
      },
    });
    rookieCount++;
  }

  return {
    projections,
    meta: {
      target_season: targetSeason,
      history_seasons: seasons,
      newest_season: newest,
      prior_seasons: PRIOR_SEASONS,
      players: projections.length,
      rookies: rookieCount,
      environment: {
        coverage: environment.coverage,
        priced_games: environment.priced_games,
        scheduled_games: environment.scheduled_games,
        teams_by_source: environment.teams_by_source,
        league_mean_scoring: environment.league_mean_scoring,
      },
      stability_measured: stability.measured.length,
      environment_max_week: environmentMaxWeek,
      history_team: useHistoryTeam,
      crosswalk_rows: crosswalk.count,
      warnings,
      elapsed_ms: Date.now() - startedAt,
    },
    // Kept on the result so the validator can assert on them without re-running ingest.
    internals: { stability, rateBaselines, volBaselines, rookieCurve, environment, fullHistory },
  };
}

module.exports = { runModel, buildRookieCurve, projectRookie, PRIOR_SEASONS, STABILITY_SEASONS, TUNING };
