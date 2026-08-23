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
 * The role gate: how much a player must actually have done last season before the model
 * will say anything about him at all.
 *
 * This exists because of a failure that shrinkage alone cannot fix. Every rate in the
 * model is per game, and every thin sample is regressed toward a positional baseline —
 * but that baseline is drawn from players who had a role, so it is a STARTER's workload
 * (30.4 pass attempts a game at quarterback). Regress a quarterback who threw two passes
 * toward it, multiply by an expected-games figure that a one-game season still pulls up
 * to 10.5, and he projects for about 145 points. Nathan Peterman, two career
 * opportunities in the window, projected 143. Philip Rivers, retired since 2020,
 * projected 146. Every quarterback who ever took a snap collapsed onto the same floor.
 *
 * Shrinking toward a lower baseline is not the fix: it would drag genuine starters down
 * with it, because the same constants apply to everyone. The honest fix is to refuse the
 * question. A player with no recent role gives the model nothing to work from, so it
 * returns nothing and the board shows a dash — the same as any player no source ranks.
 *
 * Thresholds are opportunities (pass attempts + carries + targets) in his most recent
 * season, and they are deliberately low: they are there to exclude players with no role,
 * not to express an opinion about depth. Against the live board this drops 43 players
 * who carry an ADP, none inside the top 50 and one inside the top 150.
 *
 * The proper fix is nflverse's depth charts, which would say who is starting rather than
 * inferring it from last season's volume. That is the right next step and is not built.
 */
const ROLE_GATE = { QB: 100, RB: 60, WR: 35, TE: 25 };

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
  // How far back the role anchor may reach, and what a projection built on an older
  // season is discounted by. Both selected on one season and validated on a later one.
  //
  // The discount is the load-bearing half and it is not a fudge. Letting the anchor reach
  // back at all is what keeps genuinely draftable players on the board — Jayden Reed,
  // Tank Dell, Braelon Allen all lost most of last season — but at full strength it made
  // the model WORSE than doing nothing, because most players who lose a role never get it
  // back and "he'll score what he scored last season, which was nothing" is right about
  // them. Discounted, the trade turns positive: the players who do return are worth more
  // than the ones who do not cost. A flat multiplier is crude — it treats one season away
  // the same as two — and scaling it with distance is the obvious next thing to try.
  maxAnchorBack: 2,
  staleDiscount: 0.55,
  // Only the most recent season the player actually has carries weight. This was the
  // surprise of the tuning run and it is worth stating plainly: blending three seasons
  // of usage — which is what the architecture suggests and what the first version did —
  // ranked WORSE than using the latest one alone, at every setting tried. Roles turn
  // over fast enough that a season two years back is mostly noise about this one, and
  // the shrinkage step already handles a thin recent sample. Older seasons are still
  // used, for measuring stability and for the FPOE talent prior.
  recency: [0.85, 0.15, 0],
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
  const gated = { noLastSeason: 0, thinRole: 0, noTeam: 0 };

  for (const [gsis, allSeasons] of fullHistory) {
    // Priors use the recent window only; the deeper history exists for stability.
    const recent = allSeasons.filter(s => s.season > targetSeason - 1 - PRIOR_SEASONS);
    if (recent.length === 0) continue;

    const position = recent[0].position;
    if (!nflverse.POSITIONS.has(position)) continue;

    // The role gate: is there ANY season here with enough of a role to project from?
    //
    // Not "was it last season". Requiring the newest season to qualify left a hole in the
    // draftable range — Jayden Reed at ADP 96, Tank Dell at 188, Braelon Allen at 184 all
    // lost most of last season and would have shown a dash, which is a worse board than a
    // conservative number. So the window is walked newest-first for the most recent season
    // that clears the bar, and the projection is anchored there. If nothing clears it, the
    // model genuinely has nothing to say and returns nothing.
    const threshold = ROLE_GATE[position] ?? 30;
    const opportunityOf = s => s.attempts + s.carries + s.targets;
    const tune0 = { ...TUNING, ...tuning };
    const anchorIndex = recent.findIndex(s =>
      opportunityOf(s) >= threshold && (newest - s.season) <= tune0.maxAnchorBack);
    if (anchorIndex === -1) {
      if (recent[0].season !== newest) gated.noLastSeason++;
      else gated.thinRole++;
      continue;
    }
    // Anchor the level on that season and everything older; the thin seasons in front of
    // it are dropped rather than allowed to drag a healthy role down to an injured one.
    const usable = recent.slice(anchorIndex);
    const anchor = usable[0];
    const roleOpportunity = opportunityOf(anchor);
    // Projecting off a season that is not the most recent one is a materially weaker
    // claim — he has not held that role for a year — and the confidence says so below.
    const anchoredBack = newest - anchor.season;

    const idEntry = crosswalk.byGsis.get(gsis);

    // He has to be on a team. A retired player keeps his usage history for ever, so the
    // role gate alone will happily project him: Derek Carr, retired, cleared it on his
    // 2024 season and projected 207 points. There is also no team environment to place a
    // free agent in, so the environment layer silently falls back to a league baseline
    // for exactly the players it can say least about.
    const currentTeam = idEntry?.team;
    if (!currentTeam || currentTeam === 'NA' || currentTeam === 'FA') { gated.noTeam++; continue; }
    // The team he is on NOW, from the crosswalk, not the one he finished last season
    // with. A player who changed teams in the offseason is projected into his new
    // offence, which is the whole point of having an environment layer. A backtest
    // must not do this — the crosswalk knows where he ended up.
    const team = useHistoryTeam ? recent[0].team : currentTeam;
    const env = environment.table.get(team) || null;

    const fpoe = fpoeResidual(usable, position, rateBaselines);
    const tune = tune0;
    const volume = projectVolume(usable, position, volBaselines, stability.table, env, tune);
    const efficiency = projectEfficiency(usable, position, rateBaselines, stability.table, fpoe, tune);
    let { ppg, breakdown, env_scalar_applied } =
      expectedPointsPerGame(volume, efficiency, env?.env_scalar ?? 1);
    // A projection anchored on a season he has not repeated since is a weaker claim than
    // one anchored on last season, and the backtest is blunt about it: most players who
    // lose a role do not get it back, so projecting the old role at full strength is
    // worse than not projecting at all.
    if (anchoredBack > 0) ppg *= tune0.staleDiscount;

    const age = idEntry?.age ?? null;
    const gamesPlayed = expectedGames(usable, position, age);
    const cv = weeklyVolatility(usable, position, ppg);
    const sim = simulateSeason(ppg, gamesPlayed, cv, { iterations, seed: gsis });

    // How much this projection should be trusted. Driven by the things that actually
    // undermine it: no recent season, thin opportunity, or a team the market has not
    // priced.
    const totalOpportunity = usable.reduce((a, s) => a + s.targets + s.carries + s.attempts, 0);
    let confidence = 'high';
    // Anchored on an older season means he has not held this role for a year.
    if (anchoredBack > 0 || totalOpportunity < 80) confidence = 'low';
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
        role_opportunity: roleOpportunity,
        anchored_back: anchoredBack,
        seasons_used: usable.map(s => s.season),
        // Which season actually set the level of the projection, as opposed to which
        // ones contributed sample size and the talent prior. With the tuned recency
        // weights these are not the same, and the panel should not imply they are.
        level_season: anchor.season,
        opportunities: totalOpportunity,
      },
    });
  }

  // --- Draft-capital projections -------------------------------------------------
  // True rookies have no history at all. Second-year players who failed the role gate
  // are in the same position for practical purposes: what little they did is too thin to
  // extrapolate, and draft capital is the best remaining predictor. Both are projected
  // from the curve, but they are labelled differently — telling a reader a player has
  // "no NFL usage yet" when he played eight games last season is simply untrue.
  const projected = new Set(projections.map(p => p.gsis_id));
  let rookieCount = 0;

  for (const [gsis, entry] of crosswalk.byGsis) {
    if (projected.has(gsis)) continue;
    if (entry.draft_year == null || entry.draft_year < targetSeason - 1) continue;
    if (!nflverse.POSITIONS.has(entry.position)) continue;

    const env = environment.table.get(entry.team) || null;
    const ppg = projectRookie(entry, entry.position, rookieCurve, env);
    if (ppg == null) continue;

    // Did he appear at all? Anything in the usage history means he is a second-year
    // player the gate turned away, not a player who has never taken a snap.
    const played = fullHistory.get(gsis);
    const trueRookie = entry.draft_year >= targetSeason;

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
      is_rookie: trueRookie,
      from_draft_capital: true,
      components: {
        env_team: entry.team,
        env_total: env?.implied_total ?? null,
        env_source: env?.source ?? null,
        draft_ovr: entry.draft_ovr,
        draft_round: entry.draft_round,
        basis: trueRookie
          ? 'draft capital — no NFL usage yet'
          : 'draft capital — too little NFL usage to project from',
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
      // Players the role gate refused. Reported rather than silently dropped: a
      // projection that is absent is a claim too, and it should be a visible one.
      gated,
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
