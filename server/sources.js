/**
 * The single description of every ADP/value column: what it is, which board it
 * came from, and which format it is allowed to inform.
 *
 * Consensus sets, the refresh UI, the validator and the cheat sheet all read this
 * file, so a column can never be shown under one format while being averaged into
 * another.
 */

// scoring: what the publisher actually scores that board at. The app is a 0.5 PPR
// tool, but not every provider publishes half-PPR for every format — where they
// don't, the closest published board is used and labelled honestly rather than
// silently passed off as half.
const COLUMNS = {
  adp_underdog: {
    label: 'Underdog', short: 'UD', source: 'underdog',
    format: 'BB', league: '1QB', scoring: 'half', kind: 'adp',
    what: 'Underdog Fantasy runs the biggest best-ball tournaments. This is real draft data — where players actually got picked in thousands of live Underdog drafts, not anyone\'s opinion.',
    family: 'underdog',
    provider: 'Underdog best-ball contests, via DraftSharks',
  },
  adp_fantasypros: {
    label: 'FantasyPros BB', short: 'FP BB', source: 'fantasypros',
    format: 'BB', league: '1QB', scoring: 'ppr', kind: 'ecr',
    what: 'FantasyPros blends dozens of expert rankers into one consensus list. It is opinion rather than draft data, and it reacts to news faster than ADP does.',
    family: 'fantasypros_bb',
    provider: 'FantasyPros best-ball ECR (published PPR only)',
  },
  adp_fp_rd: {
    label: 'FantasyPros', short: 'FP', source: 'fantasypros',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'ecr',
    what: 'The same FantasyPros expert consensus, for standard season-long redraft leagues at half-PPR.',
    family: 'fantasypros_rd',
    provider: 'FantasyPros ½PPR redraft ECR',
  },
  adp_fp_sf: {
    label: 'FantasyPros SF', short: 'FP SF', source: 'fantasypros',
    format: 'RD', league: '2QB', scoring: 'half', kind: 'ecr',
    what: 'The same FantasyPros expert consensus, for superflex — leagues where you can start a second quarterback, which pushes quarterbacks far up the board.',
    family: 'fantasypros_rd',
    provider: 'FantasyPros ½PPR superflex ECR',
  },
  adp_fp_dyn: {
    label: 'FantasyPros DYN', short: 'FP DYN', source: 'fantasypros',
    format: 'DYN', league: '1QB', scoring: 'ppr', kind: 'ecr',
    what: 'The same FantasyPros expert consensus, for dynasty — leagues where you keep your roster year to year, so young players are worth more.',
    family: 'fantasypros_dyn',
    provider: 'FantasyPros dynasty ECR (published PPR only)',
  },
  adp_fp_dyn_sf: {
    label: 'FantasyPros DYN SF', short: 'FP DSF', source: 'fantasypros',
    format: 'DYN', league: '2QB', scoring: 'ppr', kind: 'ecr',
    what: 'FantasyPros expert consensus for dynasty superflex: keep-forever leagues that also start a second quarterback.',
    family: 'fantasypros_dyn',
    provider: 'FantasyPros dynasty superflex ECR',
  },
  adp_ffc: {
    label: 'FFC', short: 'FFC', source: 'ffc',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'adp',
    what: 'Fantasy Football Calculator hosts free public mock drafts. This is real ADP averaged over a couple of thousand recent mocks, so it moves quickly but the drafters are anonymous.',
    family: 'ffc',
    provider: 'Fantasy Football Calculator ½PPR mock drafts',
  },
  adp_ffc_sf: {
    label: 'FFC 2QB', short: 'FFC SF', source: 'ffc',
    format: 'RD', league: '2QB', scoring: 'std', kind: 'adp',
    what: 'The same Fantasy Football Calculator mock-draft data, from their two-quarterback drafts. Their 2QB rooms score standard, not half-PPR.',
    family: 'ffc',
    provider: 'Fantasy Football Calculator 2QB mock drafts (standard scoring)',
  },
  adp_sl_rd: {
    label: 'Sleeper', short: 'SL', source: 'sleeper',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'adp',
    what: 'Sleeper is the app a lot of leagues actually run on. This is real ADP from Sleeper\'s own half-PPR drafts.',
    family: 'sleeper_rd',
    provider: 'Sleeper ½PPR drafts',
  },
  adp_sl_sf: {
    label: 'Sleeper SF', short: 'SL SF', source: 'sleeper',
    format: 'RD', league: '2QB', scoring: 'native', kind: 'adp',
    what: 'Real ADP from Sleeper\'s two-quarterback drafts.',
    family: 'sleeper_rd',
    provider: 'Sleeper 2QB drafts',
  },
  adp_sl_dyn: {
    label: 'Sleeper DYN', short: 'SL DYN', source: 'sleeper',
    format: 'DYN', league: '1QB', scoring: 'half', kind: 'adp',
    what: 'Real ADP from Sleeper dynasty start-up drafts — the draft you do when a keep-forever league is first created.',
    family: 'sleeper_dyn',
    provider: 'Sleeper ½PPR dynasty startups',
  },
  adp_sl_dyn_sf: {
    label: 'Sleeper DYN SF', short: 'SL DSF', source: 'sleeper',
    format: 'DYN', league: '2QB', scoring: 'native', kind: 'adp',
    what: 'Real ADP from Sleeper superflex dynasty start-up drafts.',
    family: 'sleeper_dyn',
    provider: 'Sleeper 2QB dynasty startups',
  },
  adp_espn: {
    label: 'ESPN', short: 'ESPN', source: 'market',
    format: 'RD', league: '1QB', scoring: 'ppr', kind: 'adp',
    what: 'ESPN is where a lot of casual home leagues draft. Useful as a check on the wider market, and it usually lags the industry consensus by a week or two.',
    family: 'espn',
    provider: 'ESPN home leagues, via DraftSharks (published PPR only)',
  },
  adp_yahoo: {
    label: 'Yahoo', short: 'YAH', source: 'market',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'adp',
    what: 'Yahoo is the other big home-league platform. Same idea as ESPN — it shows what ordinary leagues are doing rather than what experts think.',
    family: 'yahoo',
    provider: 'Yahoo home leagues, via DraftSharks',
  },
  ktc_value: {
    label: 'KeepTradeCut', short: 'KTC', source: 'dynastydaddy',
    format: 'DYN', league: '1QB', scoring: 'native', kind: 'value',
    what: 'KeepTradeCut is crowd-sourced. Users are shown three players and asked which they would keep, trade and cut; millions of those votes become a value from 0 to 10000. It is the most widely quoted dynasty currency.',
    family: 'ktc',
    provider: 'KeepTradeCut 1QB dynasty values (½PPR), via Dynasty Daddy',
  },
  ktc_value_sf: {
    label: 'KeepTradeCut SF', short: 'KTC SF', source: 'dynastydaddy',
    format: 'DYN', league: '2QB', scoring: 'half', kind: 'value',
    what: 'The KeepTradeCut crowd values for superflex leagues, where quarterbacks are worth far more.',
    family: 'ktc',
    provider: 'KeepTradeCut superflex dynasty values (½PPR), via Dynasty Daddy',
  },
  ds_value: {
    label: 'DynastySuperflex', short: 'DS', source: 'dynastydaddy',
    format: 'DYN', league: '1QB', scoring: 'native', kind: 'value',
    what: 'DynastySuperflex is a separate dynasty trade-value site, run independently of KeepTradeCut. Carried because a second opinion stops one crowd setting the whole board.',
    family: 'dsf',
    provider: 'DynastySuperflex 1QB dynasty values, via Dynasty Daddy',
  },
  ds_value_sf: {
    label: 'DynastySuperflex SF', short: 'DS SF', source: 'dynastydaddy',
    format: 'DYN', league: '2QB', scoring: 'native', kind: 'value',
    what: 'The DynastySuperflex values for superflex leagues.',
    family: 'dsf',
    provider: 'DynastySuperflex superflex dynasty values, via Dynasty Daddy',
  },
  // Displayed but never averaged: DynastyProcess derives its values from FantasyPros
  // dynasty ECR (rho 0.98 against adp_fp_dyn), which the consensus already includes.
  dp_value: {
    label: 'DynastyProcess', short: 'DP', source: 'dynastyprocess',
    format: 'DYN', league: '1QB', scoring: 'native', kind: 'value', consensus: false,
    what: 'DynastyProcess publishes dynasty values built from the FantasyPros dynasty rankings. Shown for reference but never averaged in, because FantasyPros is already in the mix and counting it twice would double its weight.',
    family: 'dynastyprocess',
    provider: 'DynastyProcess 1QB dynasty values (FantasyPros-derived)',
  },
  dp_value_sf: {
    label: 'DynastyProcess SF', short: 'DP SF', source: 'dynastyprocess',
    format: 'DYN', league: '2QB', scoring: 'native', kind: 'value', consensus: false,
    what: 'The DynastyProcess values for superflex, again shown for reference only.',
    family: 'dynastyprocess',
    provider: 'DynastyProcess superflex dynasty values (FantasyPros-derived)',
  },
  // The Fantasy Footballers publish the three hosts' statistical projections rather than
  // a ranking; the rank here is computed from them on this board's scoring. It is a
  // position-by-position rank, not a pick number, so it can be read and sorted but never
  // averaged into an ADP consensus — the two are not the same kind of number.
  ff_pos_rank: {
    label: 'Fantasy Footballers', short: 'FFB', source: 'footballers',
    format: 'BB', league: '1QB', scoring: 'half', kind: 'posrank', consensus: false,
    excludedReason: 'A rank within a position, not a pick number — averaging it with ADP would be meaningless',
    what: 'The Fantasy Footballers rank by position rather than overall. This is their three hosts\' projections — Andy, Jason and Mike — averaged and ranked within each position on half-PPR with four-point passing touchdowns, which is what this board scores.',
    family: 'footballers',
    provider: 'The Fantasy Footballers, three-analyst projections',
  },
  ff_pos_rank_rd: {
    label: 'Fantasy Footballers', short: 'FFB', source: 'footballers',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'posrank', consensus: false,
    excludedReason: 'A rank within a position, not a pick number — averaging it with ADP would be meaningless',
    what: 'The same Fantasy Footballers positional rank, shown on the redraft board.',
    family: 'footballers',
    provider: 'The Fantasy Footballers, three-analyst projections',
  },
  // This board's own expected-points model. Not a market and not a panel of experts:
  // it is computed here from nflverse usage and betting-market team totals — see
  // server/model/. It is registered under all four season-long views because the
  // projection itself does not depend on league type; only value over replacement does,
  // and that is derived per request.
  //
  // `consensus: false` is not a matter of taste. Averaging a projection into an ADP
  // consensus would mix a points forecast with pick numbers, exactly the mistake the
  // positional-rank column already refuses to make. It is displayed, sortable, and
  // deliberately outside every average.
  xfp_points: {
    label: 'Expected Points', short: 'xFP', source: 'expectedpoints',
    format: 'BB', league: '1QB', scoring: 'half', kind: 'model', consensus: false,
    excludedReason: 'A points projection, not a pick number — and this board\'s own model, so averaging it into a market consensus would let the board vote on itself',
    what: 'This board\'s own projection, not anyone else\'s. It works out how many half-PPR points each player should score from three things kept separate: the opportunity his role gives him, what he does per opportunity once the noise is regressed out, and how many points the betting market expects his offence to score. Backtested on a season it had never seen.',
    family: 'expectedpoints',
    provider: 'This board\'s model — nflverse usage × betting-market team totals',
  },
  xfp_points_bb_sf: {
    label: 'Expected Points', short: 'xFP', source: 'expectedpoints',
    format: 'BB', league: '2QB', scoring: 'half', kind: 'model', consensus: false,
    excludedReason: 'A points projection, not a pick number',
    what: 'The same expected-points projection, shown on the best-ball superflex board. The projection does not change with league type; what changes is value over replacement, because a superflex league starts far more quarterbacks.',
    family: 'expectedpoints',
    provider: 'This board\'s model — nflverse usage × betting-market team totals',
  },
  xfp_points_rd: {
    label: 'Expected Points', short: 'xFP', source: 'expectedpoints',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'model', consensus: false,
    excludedReason: 'A points projection, not a pick number',
    what: 'The same expected-points projection, shown on the redraft board.',
    family: 'expectedpoints',
    provider: 'This board\'s model — nflverse usage × betting-market team totals',
  },
  xfp_points_rd_sf: {
    label: 'Expected Points', short: 'xFP', source: 'expectedpoints',
    format: 'RD', league: '2QB', scoring: 'half', kind: 'model', consensus: false,
    excludedReason: 'A points projection, not a pick number',
    what: 'The same expected-points projection, shown on the redraft superflex board.',
    family: 'expectedpoints',
    provider: 'This board\'s model — nflverse usage × betting-market team totals',
  },
  // What the betting market says each player will actually produce this season, scored
  // under this league's rules. Sourced from BettingPros' season-long over/unders — see
  // scrapers/marketprops.js for why only `consensus_line` is trusted.
  //
  // It is NOT the same quantity as the model's projection beside it, and the difference
  // is the whole reason it is worth showing. A line of 1,300 receiving yards is an
  // expected value that already prices in the games he is likely to miss; the model's
  // number is deliberately a full seventeen, because it refuses to forecast injuries.
  // So the market will read low on anyone the books think is fragile, and that gap is
  // information rather than an error in either number.
  //
  // `consensus: false` for the same two reasons the model is excluded — a points total
  // is not a pick number — plus a third: receptions have no published market, so the
  // half-PPR reception term here is estimated rather than priced.
  mkt_points: {
    label: 'Market line', short: 'MKT', source: 'marketprops',
    format: 'BB', league: '1QB', scoring: 'half', kind: 'market', consensus: false,
    excludedReason: 'A points total, not a pick number — and an expected value that already prices in missed games, unlike every projection beside it',
    what: 'The betting market\'s own season-long over/unders for this player — passing, rushing and receiving yards and touchdowns — added up under this board\'s scoring. Unlike an expert ranking this is a number people are staking money on, and unlike the model beside it, it already discounts for the games the books expect him to miss. Receptions are priced too, so every half-PPR category is a real line rather than an estimate — except interceptions, which no book prices for a season, so a quarterback\'s total here reads about two dozen points high. The books also price receiving for only the pass-catching running backs, so a back with no receiving line gets no total at all rather than a rushing-only one.',
    family: 'marketprops',
    provider: 'BettingPros consensus season props, ~23 books',
  },
  mkt_points_bb_sf: {
    label: 'Market line', short: 'MKT', source: 'marketprops',
    format: 'BB', league: '2QB', scoring: 'half', kind: 'market', consensus: false,
    excludedReason: 'A points total, not a pick number',
    what: 'The same market season totals, shown on the best-ball superflex board. Betting lines do not know what league you are in — only the value you place on a quarterback changes.',
    family: 'marketprops',
    provider: 'BettingPros consensus season props, ~23 books',
  },
  mkt_points_rd: {
    label: 'Market line', short: 'MKT', source: 'marketprops',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'market', consensus: false,
    excludedReason: 'A points total, not a pick number',
    what: 'The same market season totals, shown on the redraft board.',
    family: 'marketprops',
    provider: 'BettingPros consensus season props, ~23 books',
  },
  mkt_points_rd_sf: {
    label: 'Market line', short: 'MKT', source: 'marketprops',
    format: 'RD', league: '2QB', scoring: 'half', kind: 'market', consensus: false,
    excludedReason: 'A points total, not a pick number',
    what: 'The same market season totals, shown on the redraft superflex board.',
    family: 'marketprops',
    provider: 'BettingPros consensus season props, ~23 books',
  },
  fc_value: {
    label: 'FantasyCalc', short: 'FC', source: 'fantasycalc',
    format: 'DYN', league: '1QB', scoring: 'half', kind: 'value',
    what: 'FantasyCalc builds its values from trades that actually completed in real leagues, rather than from votes or expert lists — so it reflects what people genuinely paid.',
    family: 'fantasycalc',
    provider: 'FantasyCalc 1QB dynasty trade values',
  },
  fc_value_sf: {
    label: 'FantasyCalc SF', short: 'FC SF', source: 'fantasycalc',
    format: 'DYN', league: '2QB', scoring: 'half', kind: 'value',
    what: 'The FantasyCalc completed-trade values for superflex leagues.',
    family: 'fantasycalc',
    provider: 'FantasyCalc superflex dynasty trade values',
  },
};

// Which columns average into each format's headline number.
//
// Best ball has no superflex market: Underdog's contests are 1QB and FantasyPros
// publishes no best-ball superflex board, so BB:2QB borrows the superflex redraft
// boards rather than reusing 1QB best-ball data, which would rank quarterbacks
// as if they did not matter.
const CONSENSUS_SOURCES = {
  'BB:1QB': ['adp_underdog', 'adp_fantasypros'],
  'BB:2QB': ['adp_fp_sf', 'adp_sl_sf'],
  'RD:1QB': ['adp_ffc', 'adp_fp_rd', 'adp_sl_rd', 'adp_espn', 'adp_yahoo'],
  'RD:2QB': ['adp_ffc_sf', 'adp_fp_sf', 'adp_sl_sf'],
  'DYN:1QB': ['ktc_value', 'fc_value', 'ds_value', 'adp_fp_dyn', 'adp_sl_dyn'],
  'DYN:2QB': ['ktc_value_sf', 'fc_value_sf', 'ds_value_sf', 'adp_fp_dyn_sf', 'adp_sl_dyn_sf'],
};

// Dynasty sources sit on incompatible scales (KTC 0–10000, FantasyCalc trade
// value, ECR and ADP as draft position), so they are ranked before averaging.
// direction says which end of the scale is "best".
function dynastyInputs(leagueType) {
  return CONSENSUS_SOURCES[`DYN:${leagueType === '2QB' ? '2QB' : '1QB'}`].map(column => ({
    column,
    direction: COLUMNS[column].kind === 'value' ? 'desc' : 'asc',
  }));
}

function consensusColumns(format, leagueType) {
  return CONSENSUS_SOURCES[`${format}:${leagueType === '2QB' ? '2QB' : '1QB'}`] || [];
}

// Turned off unless the user says otherwise. The board defaults to the four the user
// rates: FantasyPros, Sleeper, Underdog and KeepTradeCut. The rest stay available in
// the Sources panel, one tick away.
const DEFAULT_OFF_FAMILIES = ['ffc', 'espn', 'yahoo', 'dsf', 'fantasycalc', 'dynastyprocess'];

// Sleeper is the baseline for the disagreement column: it is where the drafting
// actually happens, so what matters is whether a player is cheaper or dearer there.
// Sleeper publishes no best-ball ADP, so best-ball views fall back to its half-PPR
// redraft board and say so.
const SLEEPER_BASELINE = {
  'BB:1QB': { column: 'adp_sl_rd', proxy: true },
  'BB:2QB': { column: 'adp_sl_sf', proxy: true },
  'RD:1QB': { column: 'adp_sl_rd', proxy: false },
  'RD:2QB': { column: 'adp_sl_sf', proxy: false },
  'DYN:1QB': { column: 'adp_sl_dyn', proxy: false },
  'DYN:2QB': { column: 'adp_sl_dyn_sf', proxy: false },
};

function sleeperBaseline(format, leagueType) {
  return SLEEPER_BASELINE[`${format}:${leagueType === '2QB' ? '2QB' : '1QB'}`] || null;
}

const SCORING_LABEL = {
  half: '½ PPR', ppr: 'PPR', std: 'standard', native: 'platform default',
};

// What kind of number this is — the distinction that matters most when deciding
// whether to trust a source: did people really draft this way, or does someone think
// they should?
const KIND_LABEL = {
  adp: 'Real draft data',
  ecr: 'Expert rankings',
  value: 'Trade values',
  posrank: 'Projection rank, by position',
  model: 'This board\'s own model',
  market: 'Betting market',
};

// Superflex dynasty columns are sent to the client under their base name, because a
// board only ever shows one league type at a time. This maps a column to the key the
// player payload actually carries.
const FIELD_ALIAS = {
  ff_pos_rank_rd: 'ff_pos_rank',
  xfp_points_bb_sf: 'xfp_points',
  xfp_points_rd: 'xfp_points',
  xfp_points_rd_sf: 'xfp_points',
  mkt_points_bb_sf: 'mkt_points',
  mkt_points_rd: 'mkt_points',
  mkt_points_rd_sf: 'mkt_points',
  ktc_value_sf: 'ktc_value',
  fc_value_sf: 'fc_value',
  ds_value_sf: 'ds_value',
  dp_value_sf: 'dp_value',
  adp_fp_dyn_sf: 'adp_fp_dyn',
  adp_sl_dyn_sf: 'adp_sl_dyn',
};

/**
 * Everything the UI needs to explain one view: the sources being averaged, and the
 * ones shown alongside for reference but deliberately left out of the average.
 */
function viewSources(format, leagueType) {
  const league = leagueType === '2QB' ? '2QB' : '1QB';
  const consensus = consensusColumns(format, league);
  const reference = Object.keys(COLUMNS).filter(c =>
    !consensus.includes(c) &&
    COLUMNS[c].format === format &&
    COLUMNS[c].league === league
  );
  const describe = (column, inConsensus) => {
    const c = COLUMNS[column];
    return {
      column,
      field: FIELD_ALIAS[column] || column,
      label: c.label,
      short: c.short,
      source: c.source,
      kind: c.kind,
      kindLabel: KIND_LABEL[c.kind],
      scoring: c.scoring,
      scoringLabel: SCORING_LABEL[c.scoring],
      family: c.family,
      provider: c.provider,
      what: c.what,
      inConsensus,
      defaultOn: !DEFAULT_OFF_FAMILIES.includes(c.family),
      // Set on the few columns that exist but must never be averaged.
      excludedReason: c.consensus === false
        ? (c.excludedReason || 'Derived from FantasyPros, which is already averaged in')
        : null,
    };
  };
  return {
    format,
    leagueType: league,
    consensus: consensus.map(c => describe(c, true)),
    reference: reference.map(c => describe(c, false)),
  };
}

module.exports = {
  COLUMNS, CONSENSUS_SOURCES, consensusColumns, dynastyInputs,
  viewSources, sleeperBaseline, SCORING_LABEL, KIND_LABEL,
  DEFAULT_OFF_FAMILIES, FIELD_ALIAS,
};
