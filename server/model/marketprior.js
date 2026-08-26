/**
 * Module D — the betting market's opinion on WHO gets a team's touches.
 *
 * The ceiling analysis in scripts/experiments/where-is-the-error.js settled where this
 * model's remaining error lives, and it is not where intuition puts it. Perfect
 * foreknowledge of every team's pass and run VOLUME — pace, scheme, personnel, play mix,
 * all of it — is worth +0.005 Spearman. Perfect knowledge of each player's SHARE of his
 * team is worth +0.15. Team volume is already solved; who gets the ball is not.
 *
 * Everything the model knows about share is backward-looking: last season's usage, and a
 * depth-chart rank. So it systematically under-rates a man who has just moved and
 * over-rates the incumbent he displaces. Against the market's own implied share of a
 * team's receiving yards, the gaps were a clean roster of exactly those cases — A.J. Brown
 * to New England at 50.7% against the model's 43.0%, DJ Moore to Buffalo 36.8% against
 * 28.2%, Jakobi Meyers to Jacksonville 24.8% against 10.4% — while Rome Odunze and
 * Wan'Dale Robinson, the incumbents being displaced, went the other way.
 *
 * The books price training camp, coordinator hires and depth-chart news continuously and
 * with money at stake. That is the forward-looking information the model was missing, and
 * it is already fetched: scrapers/marketprops.js writes it to the board.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not touch any team's total volume. Per-team market aggregates do not survive
 * inspection — Cleveland's priced receivers are quoted for 133% of its priced passing
 * yards, Miami's for 27% — because three to seven players a team carry lines and which
 * three is arbitrary. So the market moves a player only RELATIVE to his team-mates, and
 * the conservation step downstream puts the team back on its budget. The net effect is a
 * transfer of share, which is the one thing the market is being trusted for.
 *
 * It also does not touch the level. A market line and a projection are not the same
 * quantity: the line already discounts the games the books expect a man to miss, the
 * model's number is a full seventeen on purpose. Blending the two raw would drag every
 * covered player down by that difference — and since the covered players are the
 * high-volume ones, conservation would then scale the whole team back up and hand the
 * difference to the fringe players nobody prices. So the market side is de-biased to the
 * model's own level, per component, across the covered population, BEFORE anything is
 * blended. The blend is then a statement about share and nothing else.
 *
 * THIS CANNOT BE BACKTESTED, and that has to be said plainly because nothing else in this
 * model is in that position. BettingPros publishes lines for the coming season only;
 * there is no archive of what the books thought in August 2023. Every other choice here
 * was made against a held-out season and this one cannot be. What the validator can still
 * prove is that it is share-neutral by construction — the level does not move, the
 * conservation identities still hold, and the backtest is untouched because the market is
 * absent from it. Judgement, not measurement, is doing the rest, and TUNING.marketWeight
 * turns it off.
 */
const { RULES } = require('./scoring');

// A season, for turning a market total into the per-game rate the model works in. The
// market's total is depressed relative to a full season by the absence it prices in; that
// difference is exactly what the de-bias below removes.
const SEASON_GAMES = 17;

/**
 * How much a line is believed, by how many books stand behind it.
 *
 * Book support is read PER COMPONENT, not per player, and the difference is not small.
 * `mkt_books` is the thinnest line a player carries anywhere across all seven markets —
 * the right thing to report beside a season total, and the wrong thing to weight a single
 * component by. A receiver whose receiving lines eight books agree on but whose
 * rushing-touchdown line comes from one was recorded at 1, so the part of him that was
 * best supported was the part that barely moved. `mkt_books_rec`, `_rush` and `_pass` are
 * the thinnest line WITHIN each component, which is the quantity this blend actually
 * needs; `mkt_books` remains the fallback for a row written before those existed.
 *
 * The threshold itself is a judgement, not a calibration — nothing here was fitted,
 * because nothing here can be (see the header). Five books is roughly where a consensus
 * stops being one operator's shading, and the median line carries two.
 */
const BOOKS_FOR_FULL_WEIGHT = 5;
function bookFactor(books) {
  if (!Number.isFinite(books) || books < 1) return 0;
  return Math.min(1, books / BOOKS_FOR_FULL_WEIGHT);
}

/** Books behind one component, falling back to the player-wide minimum. */
function componentBooks(line, spec) {
  const own = line[spec.books];
  return Number.isFinite(own) && own >= 1 ? own : line.mkt_books;
}

// The three budgets, each with the market fields it needs and the component it moves.
// A component is only ever blended when EVERY line it is built from is present. Treating
// a missing line as a zero is the mistake mkt_complete exists to prevent: silence from
// the books means they saw no liquidity, not that the player scores nothing.
const COMPONENTS = {
  receiving: {
    fields: ['mkt_rec_yards', 'mkt_receptions', 'mkt_rec_tds'],
    points: m => m.mkt_rec_yards * RULES.receiving_yards
      + m.mkt_receptions * RULES.receptions
      + m.mkt_rec_tds * RULES.receiving_tds,
    metrics: ['targets_pg', 'receptions_pg', 'rec_yards_pg', 'rec_tds_pg'],
    books: 'mkt_books_rec',
  },
  rushing: {
    fields: ['mkt_rush_yards', 'mkt_rush_tds'],
    points: m => m.mkt_rush_yards * RULES.rushing_yards + m.mkt_rush_tds * RULES.rushing_tds,
    metrics: ['carries_pg', 'rush_yards_pg', 'rush_tds_pg'],
    books: 'mkt_books_rush',
  },
  passing: {
    // No interception term: market 303 is genuinely empty on both BettingPros endpoints,
    // so a market passing total reads about two dozen points high across a season. That
    // is a level error, and the de-bias below removes exactly that.
    fields: ['mkt_pass_yards', 'mkt_pass_tds'],
    points: m => m.mkt_pass_yards * RULES.passing_yards + m.mkt_pass_tds * RULES.passing_tds,
    metrics: ['attempts_pg', 'pass_yards_pg', 'pass_tds_pg'],
    books: 'mkt_books_pass',
  },
};

/**
 * Blend the market's view of each covered player into the projections, in place.
 *
 * `lines` is sleeper_id -> the mkt_* fields as the board stores them. Players without a
 * line, and players projected from draft capital (whose points come from the rookie curve
 * rather than from these rates), are left exactly as they were.
 */
function applyMarketPrior(projections, lines, { weight = 0.5 } = {}) {
  const summary = { weight, players: 0, blended: {}, debias: {}, skipped_thin: 0 };
  if (!lines || !lines.size || !(weight > 0)) return summary;

  // Pair every projection with its line once, so the de-bias and the blend see the same
  // population.
  const covered = [];
  for (const p of projections) {
    if (p.components?.basis) continue;
    const m = p.sleeper_id != null ? lines.get(String(p.sleeper_id)) : null;
    if (!m) continue;
    covered.push({ p, m });
  }
  if (!covered.length) return summary;

  // De-bias, per component, over the covered population: what the model says these
  // players produce against what the market says they do. Scaling the market by this
  // makes the blend level-neutral by construction, so anything that moves afterwards is
  // a change in share and not a change in level.
  const factors = {};
  for (const [name, spec] of Object.entries(COMPONENTS)) {
    let model = 0;
    let market = 0;
    for (const { p, m } of covered) {
      if (spec.fields.some(f => m[f] == null)) continue;
      const g = p.games || 0;
      model += (p.components[name] || 0) * g;
      market += spec.points(m);
    }
    // Only believed off a real population; otherwise the component is left alone.
    factors[name] = market > 0 && model > 0 ? model / market : null;
    summary.debias[name] = factors[name] == null ? null : Math.round(factors[name] * 1000) / 1000;
  }

  for (const { p, m } of covered) {
    const c = p.components;
    let touched = false;
    let heaviest = 0;
    let heaviestBooks = null;

    for (const [name, spec] of Object.entries(COMPONENTS)) {
      const f = factors[name];
      if (f == null) continue;
      if (spec.fields.some(field => m[field] == null)) continue;
      const modelPg = c[name] || 0;
      if (!(modelPg > 0)) continue;

      // Weighted by the books behind THIS component, not by the thinnest line he carries
      // anywhere. That distinction is the whole point of the per-component counts.
      const books = componentBooks(m, spec);
      const w = weight * bookFactor(books);
      if (!(w > 0)) { summary.skipped_thin++; continue; }
      if (w > heaviest) { heaviest = w; heaviestBooks = books; }

      // The market's per-game claim about him, on the model's level.
      const marketPg = (spec.points(m) * f) / SEASON_GAMES;
      const blended = modelPg * (1 - w) + marketPg * w;
      const scale = blended / modelPg;
      if (!Number.isFinite(scale) || scale <= 0) continue;

      // One factor for the whole component, applied to its points AND to every metric
      // behind them — the same shape the conservation step uses, so the metrics never
      // come adrift from the points they add up to.
      c[name] = Math.round(modelPg * scale * 100) / 100;
      for (const metric of spec.metrics) {
        if (c[metric] != null) c[metric] = Math.round(c[metric] * scale * 1000) / 1000;
      }
      summary.blended[name] = (summary.blended[name] || 0) + 1;
      touched = true;
    }

    if (!touched) continue;
    c.total_tds_pg = Math.round(((c.rec_tds_pg || 0) + (c.rush_tds_pg || 0) + (c.pass_tds_pg || 0)) * 1000) / 1000;
    // Reported for the component the market moved hardest, since that is the one a reader
    // looking at this player's number is being asked to trust.
    c.market_weight = Math.round(heaviest * 1000) / 1000;
    c.market_books = heaviestBooks;
    p.ppg = Math.round(((c.receiving || 0) + (c.rushing || 0) + (c.passing || 0)) * 100) / 100;
    summary.players++;
  }

  return summary;
}

module.exports = { applyMarketPrior, bookFactor, componentBooks, COMPONENTS, BOOKS_FOR_FULL_WEIGHT, SEASON_GAMES };
