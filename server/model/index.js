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
const { projectVolume, volumeBaselines, depthAllowance, UNRANKED_DEPTH } = require('./volume');
const { RULES } = require('./scoring');
const { projectEfficiency, fpoeResidual } = require('./efficiency');
const { buildEnvironment } = require('./environment');
const { loadOddsGames } = require('./odds');
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
// League-typical passing production per attempt, used only to give a quarterback projected
// from draft capital a coherent contribution to his team's budget. Measured on 2025: 811
// passing touchdowns and about 3,900 yards a team across 545 attempts.
const LEAGUE_YARDS_PER_ATTEMPT = 7.2;
const LEAGUE_TD_PER_ATTEMPT = 0.0465;

const ROLE_GATE = { QB: 100, RB: 60, WR: 35, TE: 25 };

// Designations that mean he is not available for the season's start, as opposed to the
// week-to-week churn of a Questionable tag.
const OUT_INDEFINITELY = new Set(['IR', 'PUP', 'Sus', 'DNR', 'NA', 'Out']);

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
  // How sharply a team's quarterback games are assumed to belong to one man. 1 shares
  // them in proportion to each man's claim; higher powers bet harder on the incumbent.
  // Selected across two seasons rather than one: on a single season a hard bet looked
  // best and then failed to generalise, because who actually wins a quarterback job is
  // not something last season's snap count reliably predicts. Hedging is worth more than
  // being right about the starter more often. Without conservation at all the QB margin
  // against the benchmark averaged -0.063 across the selection seasons; at power 1 it is
  // +0.059.
  qbClaimPower: 2,
  // Whose job is it? 'peak' takes the most a quarterback ever carried in the window,
  // 'anchor' only his latest season. Peak is better and the reason is Joe Burrow: his
  // 2025 was eight games, so on the latest season alone Joe Flacco outranked him and the
  // allocation handed Flacco the larger share of Cincinnati's year. A starter who missed
  // half a season still has the stronger claim on the job.
  qbClaimBasis: 'peak',
  // How a team's seventeen quarterback games are split once the depth chart has named a
  // starter. [100, 8, 2] gives the starter about 91% of them — roughly fifteen and a half
  // games, which is a starter playing nearly every week rather than a forecast that he
  // will be hurt. Sharper than this and the backup falls below a game and drops out of
  // the projection set altogether, which backtested worse; softer and confirmed starters
  // like Joe Burrow were being handed 13.9 games with the rest given to a backup nobody
  // is drafting. Selected across 2022–24 with the depth chart supplied.
  qbDepthWeights: [100, 8, 2],
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
  // Live-only inputs. Both are absent in a backtest: the betting API prices the coming
  // season and nothing else, and Sleeper's depth chart is today's, not 2023's.
  //   useOdds     — price the environment off every game a book has posted rather than
  //                 the fraction nflverse's schedule file happens to carry
  //   depthChart  — sleeper_id -> { order, team }, the only live read on who is starting
  useOdds = true,
  depthChart = null,
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

  // Prefer the live market for the season being projected. nflverse's file carries a
  // line only for the games a book had priced when it was cut — 112 of 272 for 2026 —
  // and a team environment averaged over six games is a much weaker number than one
  // averaged over seventeen. Never used in a backtest: these are today's prices.
  let oddsMeta = null;
  let pricedGames = games;
  if (useOdds && environmentMaxWeek == null) {
    const odds = await loadOddsGames(targetSeason);
    if (odds.available) {
      pricedGames = games.filter(g => g.season !== targetSeason).concat(odds.games);
      oddsMeta = { source: 'the-odds-api', priced: odds.priced, mean_total: odds.meanTotal };
    } else {
      oddsMeta = { source: 'nflverse-schedules', reason: odds.reason };
    }
  }

  // --- Priors ----------------------------------------------------------------
  const fullHistory = buildUsageHistory(statSeasons);
  const stability = buildStability(fullHistory);
  const rateBaselines = positionalBaselines(fullHistory);
  const volBaselines = volumeBaselines(fullHistory);
  const rookieCurve = buildRookieCurve(fullHistory, crosswalk, seasons);

  // --- Module C ---------------------------------------------------------------
  const envGames = environmentMaxWeek == null
    ? pricedGames
    : pricedGames.filter(g => g.season !== targetSeason || g.week <= environmentMaxWeek);
  const environment = buildEnvironment(envGames, targetSeason, seasons);
  if (environment.coverage < 0.15) {
    warnings.push(
      `only ${Math.round(environment.coverage * 100)}% of ${targetSeason} games are priced — ` +
      'team environment is mostly a regressed baseline, not a market signal'
    );
  }

  // --- Per player --------------------------------------------------------------
  const projections = [];
  const gated = { noLastSeason: 0, thinRole: 0, noTeam: 0, noEnvironment: 0, injured: 0 };
  let startersRescued = 0;

  for (const [gsis, allSeasons] of fullHistory) {
    // Priors use the recent window only; the deeper history exists for stability.
    const recent = allSeasons.filter(s => s.season > targetSeason - 1 - PRIOR_SEASONS);
    if (recent.length === 0) continue;

    const position = recent[0].position;
    if (!nflverse.POSITIONS.has(position)) continue;

    const idEntry = crosswalk.byGsis.get(gsis);

    // The depth chart, if we have one. Keyed on Sleeper's id for a live run and on
    // gsis_id for a backtest, because that is what each source provides. Resolved here,
    // above the role gate, because the gate consults it.
    const depth = depthChart
      ? (depthChart.get(String(idEntry?.sleeper_id)) || depthChart.get(gsis) || null)
      : null;
    // A player on the chart without a rank is carried but unplaced, which in practice means
    // deep — not unknown. Left as null he escaped the backup cap and projected like a
    // starter. `depth` being absent entirely (no chart at all) still means no information.
    const depthOrder = depth ? (depth.order ?? UNRANKED_DEPTH) : null;

    // He has to be on a team. A retired player keeps his usage history for ever, so the
    // role gate alone will happily project him: Derek Carr, retired, cleared it on his
    // 2024 season and projected 207 points. There is also no team environment to place a
    // free agent in, so the environment layer silently falls back to a league baseline
    // for exactly the players it can say least about.
    //
    // Where the depth chart and the crosswalk disagree about the team the chart wins: it
    // is today's, and the crosswalk can be a transfer window behind. That is what put
    // Malik Willis in Miami.
    // A player already ruled out is not a forecast, it is a fact. Season-ending or
    // indefinite designations mean he is not playing, and a projection would be a
    // statement the model has no business making — Zach Charbonnet sat high on the board
    // while on PUP with a repaired ACL. Week-to-week noise (Questionable, Doubtful) is
    // left alone: that is ordinary and unknowable.
    if (depth?.injury && OUT_INDEFINITELY.has(depth.injury)) { gated.injured++; continue; }

    const currentTeam = depth?.team || idEntry?.team;
    if (!currentTeam) { gated.noTeam++; continue; }
    if (!environment.table.has(currentTeam)) { gated.noEnvironment++; continue; }


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
    let anchorIndex = recent.findIndex(s =>
      opportunityOf(s) >= threshold && (newest - s.season) <= tune0.maxAnchorBack);

    // A man the depth chart lists as his team's starter has a role whatever last season
    // says, and refusing to project him is simply wrong — it is how Miami ended up with
    // no quarterback at all and a projection of three and a half wins. The gate is there
    // to catch players with no role, and the depth chart is better evidence of one than
    // last season's snap count.
    if (anchorIndex === -1 && depthOrder === 1) {
      anchorIndex = 0;
      startersRescued++;
    }

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

    // The team he is on NOW, from the crosswalk, not the one he finished last season
    // with. A player who changed teams in the offseason is projected into his new
    // offence, which is the whole point of having an environment layer. A backtest
    // must not do this — the crosswalk knows where he ended up.
    const team = useHistoryTeam ? recent[0].team : currentTeam;
    const env = environment.table.get(team) || null;

    const fpoe = fpoeResidual(usable, position, rateBaselines);
    const tune = tune0;
    const volume = projectVolume(usable, position, volBaselines, stability.table, env, tune, depthOrder);
    const efficiency = projectEfficiency(usable, position, rateBaselines, stability.table, fpoe, tune);
    let { ppg, breakdown, env_scalar_applied } =
      expectedPointsPerGame(volume, efficiency, env?.env_scalar ?? 1);
    // A projection anchored on a season he has not repeated since is a weaker claim than
    // one anchored on last season, and the backtest is blunt about it: most players who
    // lose a role do not get it back, so projecting the old role at full strength is
    // worse than not projecting at all.
    if (anchoredBack > 0) ppg *= tune0.staleDiscount;

    const age = idEntry?.age ?? null;
    // A full season for everyone with a role. Quarterbacks are re-cut below, where a
    // team's seventeen games are shared out by depth chart.
    const gamesPlayed = expectedGames();
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
        depth_order: depthOrder,
        injury_status: depth?.injury ?? null,
        // The most he ever carried in the window, which is a better read on whose job it
        // is than the latest season alone: a starter who missed half of last year still
        // has the stronger claim on it.
        peak_opportunity: Math.max(...usable.map(opportunityOf)),
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
  //
  // This runs BEFORE both conservation steps, and it did not always. Appended afterwards,
  // these players sat outside every team budget: Las Vegas projected thirty quarterback
  // games in a seventeen-game season because its listed starter was a rookie and simply
  // was not in the allocation. They also carry the depth chart now — without it the
  // allocator could not see that a draft-capital quarterback was the man listed first, and
  // treated him as the weakest claim in the room.
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

    // The depth chart, resolved the same way it is for everyone else. A draft-capital
    // player is exactly the case where last season's usage says nothing and the chart says
    // everything, so leaving it off here was the worst place to leave it off.
    const rookieDepth = depthChart
      ? (depthChart.get(String(entry.sleeper_id)) || depthChart.get(gsis) || null)
      : null;
    const rookieDepthOrder = rookieDepth ? (rookieDepth.order ?? UNRANKED_DEPTH) : null;

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
        depth_order: rookieDepthOrder,
        injury_status: rookieDepth?.injury ?? null,
        // A quarterback who is going to start throws, and his team's receivers are fed from
        // those attempts. Without rates here he contributed nothing to the team's budget, so
        // Las Vegas was scaled to 305 attempts where a real team throws 545 and every Raiders
        // receiver was cut to fit.
        //
        // All three rates are needed, not just attempts. Giving him attempts alone left Las
        // Vegas throwing 442 times for ONE touchdown — 0.22% per attempt against a league
        // 4.65% — and the receiving-touchdown reconciliation then cut its receivers by 30% to
        // match a passing game that scored nothing. Brock Bowers paid for it.
        //
        // These are budget contributions only. His own projection still comes from the
        // rookie curve, and nothing scales these — the conservation pass skips him.
        ...(entry.position === 'QB' && rookieDepthOrder != null
          ? (() => {
            const attempts = depthAllowance('QB', rookieDepthOrder)?.attempts_pg ?? 0;
            return {
              attempts_pg: attempts,
              pass_yards_pg: attempts * LEAGUE_YARDS_PER_ATTEMPT,
              pass_tds_pg: attempts * LEAGUE_TD_PER_ATTEMPT,
            };
          })()
          : {}),
        basis: trueRookie
          ? 'draft capital — no NFL usage yet'
          : 'draft capital — too little NFL usage to project from',
      },
    });
    rookieCount++;
  }

  // --- Conservation: a team only has one quarterback job ---------------------------
  //
  // Every player is projected independently, which is right for positions that genuinely
  // share the field. It is wrong for quarterback, where one man takes essentially every
  // snap. Unconstrained, the model handed 66 quarterbacks an average of 13.2 expected
  // games across 31 teams — 871 games where 527 exist — and the Jets alone were projected
  // for 1,253 pass attempts against a real team's 545. Summed to the team, pass attempts
  // came out 49% high and passing touchdowns 40% high, while targets, carries and rushing
  // touchdowns all reconciled to within 3%. The whole discrepancy was this.
  //
  // So the quarterback games on a team are allocated rather than assumed: whoever has the
  // strongest claim to the job takes what he is projected for, and the next man gets only
  // what is left. This deliberately does not touch the other positions — two backs really
  // do play the same game, and their totals already reconcile.
  const QB_GAMES_PER_TEAM = 17;     // a season, shared out — not a durability forecast

  const qbsByTeam = new Map();
  for (const p of projections) {
    if (p.position !== 'QB') continue;
    if (!qbsByTeam.has(p.team)) qbsByTeam.set(p.team, []);
    qbsByTeam.get(p.team).push(p);
  }

  let qbGamesReclaimed = 0;
  for (const qbs of qbsByTeam.values()) {
    // Claim on the job is last season's own workload first — that is the evidence of who
    // actually held it — and the projection only breaks a tie.
    qbs.sort((a, b) =>
      (b.components.role_opportunity ?? 0) - (a.components.role_opportunity ?? 0)
      || b.ppg - a.ppg);

    // How sharply the job is assumed to belong to one man. Allocating greedily — the
    // strongest claim takes everything he is projected for and the next takes what is
    // left — reconciles the team perfectly but is a hard bet on who starts, and in a
    // backtest that bet is wrong often enough to cost more at quarterback than the
    // reconciliation gains. Sharing the games out in proportion to each man's claim,
    // raised to a power, hedges it: the power decides how sharp the bet is, and it was
    // chosen on one season and checked on another.
    // Whose job is it? If the depth chart says, believe it — that is a statement about
    // this season, where opportunity is a statement about last one. Where it does not
    // say, fall back to the most a man ever carried recently.
    //
    // The chart is not treated as certain even so. Two or three rooms a year are
    // genuinely unsettled and the chart still names somebody, so the starter's claim is
    // strong rather than absolute and the backup keeps a real share.
    const hasDepth = qbs.some(p => p.components.depth_order != null);
    const W = tuning.qbDepthWeights ?? TUNING.qbDepthWeights;
    const claimBasis = hasDepth
      ? (p => {
        const o = p.components.depth_order;
        return o == null ? W[2] : (o === 1 ? W[0] : o === 2 ? W[1] : W[2]);
      })
      : ((tuning.qbClaimBasis ?? TUNING.qbClaimBasis) === 'peak'
        ? (p => p.components.peak_opportunity ?? p.components.role_opportunity ?? 0)
        : (p => p.components.role_opportunity ?? 0));
    const power = hasDepth ? 1 : (tuning.qbClaimPower ?? TUNING.qbClaimPower);
    const claim = qbs.map(p => Math.pow(Math.max(claimBasis(p), 1), power));
    const claimTotal = claim.reduce((a, b) => a + b, 0) || 1;

    for (let i = 0; i < qbs.length; i++) {
      const p = qbs[i];
      const share = claim[i] / claimTotal;
      const allowed = Math.max(0, Math.min(p.games, QB_GAMES_PER_TEAM * share));
      if (allowed >= p.games - 0.01) continue;      // he already fitted

      qbGamesReclaimed += p.games - allowed;
      p.games = Math.round(allowed * 10) / 10;
      p.components.games_capped = true;

      if (p.games < 1) {
        // No share of the job left. Zeroing the projection would be a claim of its own,
        // so he is dropped instead and the board shows a dash.
        p.drop = true;
        continue;
      }
      const sim = simulateSeason(p.ppg, p.games, p.volatility, { iterations, seed: p.gsis_id });
      p.points = sim ? Math.round(sim.mean * 10) / 10 : Math.round(p.ppg * p.games * 10) / 10;
      p.floor = sim ? Math.round(sim.floor * 10) / 10 : null;
      p.ceiling = sim ? Math.round(sim.ceiling * 10) / 10 : null;
      p.best_ball = sim ? Math.round(sim.best_ball * 10) / 10 : null;
    }
  }
  const dropped = projections.filter(p => p.drop).length;
  for (let i = projections.length - 1; i >= 0; i--) if (projections[i].drop) projections.splice(i, 1);

  // --- Conservation: a team has only so many touches to give ------------------------
  //
  // The same problem as quarterback games, one step out. Every pass-catcher is now
  // projected for a full season, but their per-game target rates were each measured over
  // the games they actually played, and they were not all on the field together. Summed,
  // a team came to 611 projected targets against 496 pass attempts — a ratio of 1.17
  // where every pass attempt is one target and it should be about 0.94.
  //
  // So the receiving and rushing sides are scaled to what the team can actually produce.
  // Pass attempts are already conserved, because quarterback games are; targets are
  // scaled to them. Carries are scaled to a league-typical rushing load, tilted by the
  // same game-script lean the environment layer derives — a team expected to trail
  // throws more and runs less.
  //
  // Note what this costs: once the identities hold by construction they stop being an
  // independent check that the parts agree, and become a check that the scaling ran.
  // That is the right trade — better a board with numbers that add up than a test that
  // fails honestly while the board misleads — but the validator says which it is.
  const TARGETS_PER_ATTEMPT = 0.94;   // the rest are thrown away, spiked or sacked
  const LEAGUE_RUSH_ATTEMPTS = 455;
  const LEAGUE_PASS_ATTEMPTS = 545;

  const teamTotals = new Map();
  for (const p of projections) {
    // A draft-capital player has no per-metric projection to scale, so he is not scaled —
    // but a quarterback among them now carries an attempt rate, and those attempts are
    // real: they are what his receivers are fed from. Leaving them out built the budget as
    // though nobody threw the ball, which is how one rookie quarterback shrank an entire
    // receiving corps.
    const isDraftCapital = !!p.components.basis;
    if (isDraftCapital && !(p.components.attempts_pg > 0)) continue;
    if (!teamTotals.has(p.team)) teamTotals.set(p.team, { att: 0, tgt: 0, car: 0, passTd: 0, recTd: 0 });
    const t = teamTotals.get(p.team);
    const g = p.games || 0;
    t.att += (p.components.attempts_pg || 0) * g;
    t.passTd += (p.components.pass_tds_pg || 0) * g;
    if (isDraftCapital) continue;   // he consumes attempts, but has no targets or carries to count
    t.tgt += (p.components.targets_pg || 0) * g;
    t.car += (p.components.carries_pg || 0) * g;
    t.recTd += (p.components.rec_tds_pg || 0) * g;
  }

  // The league-wide attempt correction.
  //
  // Summing a team's attempts from the quarterbacks the model projects came to 496 against
  // a real 545, and every target is derived from that total, so every pass-catcher on the
  // board read about 9% light. But the shortfall is an ARTEFACT, not a finding: it comes
  // from the games split, where a backup takes his share at a backup's attempt rate. It
  // says nothing about any particular team.
  //
  // So only the level is corrected, with one scalar shared by all 32 teams, and the spread
  // is left exactly as the model projected it. Replacing each team's own attempts with a
  // league constant was tried and it is wrong: real teams ranged from 397 to 800 attempts
  // last season, a standard deviation of 73, and the constant collapsed the model's spread
  // to 24. A team with a poor quarterback really does throw less, and his receivers really
  // do catch fewer — that is signal the model had and the constant deleted.
  //
  // Because the correction is identical for every team it cannot reorder them; it moves
  // the whole league onto a realistic scale and nothing else.
  const projectedLeagueAtt = [...teamTotals.values()].reduce((a, t) => a + t.att, 0)
    / (teamTotals.size || 1);
  const attemptCorrection = projectedLeagueAtt > 0
    ? Math.max(0.85, Math.min(1.3, LEAGUE_PASS_ATTEMPTS / projectedLeagueAtt))
    : 1;

  const scales = new Map();
  for (const [team, t] of teamTotals) {
    const env = environment.table.get(team);
    const lean = env?.pass_lean ?? 0;
    // This team's own projected volume, on a realistic league scale.
    //
    // Both sides move together. Correcting only the targets was tried and it breaks the
    // thing that makes this checkable: it put 512 targets against 496 attempts, which is
    // not a projection but an impossibility, since every attempt is at most one target.
    const targetAtt = t.att * attemptCorrection;
    const targetTgt = targetAtt * TARGETS_PER_ATTEMPT;
    const targetCar = LEAGUE_RUSH_ATTEMPTS * (1 - lean * 2);
    // Bounded: a scale far from 1 means something else is wrong and silently
    // multiplying by it would hide that rather than fix it.
    const sc0 = {
      pass: t.att > 0 ? Math.max(0.6, Math.min(1.4, targetAtt / t.att)) : 1,
      rec: t.tgt > 0 ? Math.max(0.6, Math.min(1.4, targetTgt / t.tgt)) : 1,
    };
    scales.set(team, {
      pass: t.att > 0 ? Math.max(0.6, Math.min(1.4, targetAtt / t.att)) : 1,
      rec: t.tgt > 0 ? Math.max(0.6, Math.min(1.4, targetTgt / t.tgt)) : 1,
      rush: t.car > 0 ? Math.max(0.6, Math.min(1.4, targetCar / t.car)) : 1,
      // Every touchdown a quarterback throws is caught by somebody. Nothing in the model
      // made that true and it was not: league-wide it produced 811 passing touchdowns
      // against 742 receiving ones, so 69 of its own thrown touchdowns landed on nobody.
      // Passing touchdowns are the side to trust — the model puts them at 811 against a
      // real 811, and 4.66% per attempt against a real 4.65% — so the receiving side is
      // reconciled to them. Both sides carry the pass scale already, so this is computed
      // on the post-scale totals and only the ratio between them moves.
      recTd: t.recTd > 0 ? Math.max(0.7, Math.min(1.4, (t.passTd * sc0.pass) / (t.recTd * sc0.rec))) : 1,
    });
  }

  for (const p of projections) {
    const c = p.components;
    if (c.basis) continue;
    const sc = scales.get(p.team);
    if (!sc) continue;
    if (Math.abs(sc.rec - 1) < 0.001 && Math.abs(sc.rush - 1) < 0.001
      && Math.abs(sc.pass - 1) < 0.001) continue;

    const recPts = (c.receiving || 0) * sc.rec;
    const rushPts = (c.rushing || 0) * sc.rush;
    const passPts = (c.passing || 0) * sc.pass;
    if (!(recPts + rushPts + passPts > 0)) continue;

    for (const [k, f] of [['targets_pg', sc.rec], ['receptions_pg', sc.rec], ['rec_yards_pg', sc.rec],
                          ['rec_tds_pg', sc.rec], ['carries_pg', sc.rush], ['rush_yards_pg', sc.rush],
                          ['rush_tds_pg', sc.rush], ['attempts_pg', sc.pass],
                          ['pass_yards_pg', sc.pass], ['pass_tds_pg', sc.pass]]) {
      if (c[k] != null) c[k] = Math.round(c[k] * f * 1000) / 1000;
    }
    // Receiving touchdowns are then reconciled to the passing touchdowns actually thrown.
    // Applied on top of the receiving scale rather than folded into it, because yards and
    // receptions are constrained by targets and touchdowns are constrained by the throw —
    // two different budgets that happen to sit on the same players.
    let tdDelta = 0;
    if (sc.recTd != null && Math.abs(sc.recTd - 1) > 0.001 && c.rec_tds_pg != null) {
      const before = c.rec_tds_pg;
      c.rec_tds_pg = Math.round(before * sc.recTd * 1000) / 1000;
      tdDelta = (c.rec_tds_pg - before) * RULES.receiving_tds;
    }

    c.receiving = Math.round((recPts + tdDelta) * 100) / 100;
    c.rushing = Math.round(rushPts * 100) / 100;
    c.passing = Math.round(passPts * 100) / 100;
    c.total_tds_pg = Math.round(((c.rec_tds_pg || 0) + (c.rush_tds_pg || 0) + (c.pass_tds_pg || 0)) * 1000) / 1000;
    const newPpg = recPts + tdDelta + rushPts + passPts;
    if (!(newPpg > 0)) continue;
    c.team_scale = {
      passing: Math.round(sc.pass * 1000) / 1000,
      receiving: Math.round(sc.rec * 1000) / 1000,
      rushing: Math.round(sc.rush * 1000) / 1000,
      receiving_td: Math.round((sc.recTd ?? 1) * 1000) / 1000,
    };

    p.ppg = Math.round(newPpg * 100) / 100;
    const sim = simulateSeason(p.ppg, p.games, p.volatility, { iterations, seed: p.gsis_id });
    p.points = sim ? Math.round(sim.mean * 10) / 10 : Math.round(p.ppg * p.games * 10) / 10;
    p.floor = sim ? Math.round(sim.floor * 10) / 10 : null;
    p.ceiling = sim ? Math.round(sim.ceiling * 10) / 10 : null;
    p.best_ball = sim ? Math.round(sim.best_ball * 10) / 10 : null;
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
      odds: oddsMeta,
      environment: {
        coverage: environment.coverage,
        priced_games: environment.priced_games,
        scheduled_games: environment.scheduled_games,
        teams_by_source: environment.teams_by_source,
        league_mean_scoring: environment.league_mean_scoring,
      },
      stability_measured: stability.measured.length,
      depth_chart: depthChart ? { players: depthChart.size, starters_rescued: startersRescued } : null,
      qb_conservation: {
        games_reclaimed: Math.round(qbGamesReclaimed * 10) / 10,
        dropped: dropped,
      },
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
