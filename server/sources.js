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
    provider: 'Underdog best-ball contests, via DraftSharks',
  },
  adp_fantasypros: {
    label: 'FantasyPros BB', short: 'FP BB', source: 'fantasypros',
    format: 'BB', league: '1QB', scoring: 'ppr', kind: 'ecr',
    what: 'FantasyPros blends dozens of expert rankers into one consensus list. It is opinion rather than draft data, and it reacts to news faster than ADP does.',
    provider: 'FantasyPros best-ball ECR (published PPR only)',
  },
  adp_fp_rd: {
    label: 'FantasyPros', short: 'FP', source: 'fantasypros',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'ecr',
    what: 'The same FantasyPros expert consensus, for standard season-long redraft leagues at half-PPR.',
    provider: 'FantasyPros ½PPR redraft ECR',
  },
  adp_fp_sf: {
    label: 'FantasyPros SF', short: 'FP SF', source: 'fantasypros',
    format: 'RD', league: '2QB', scoring: 'half', kind: 'ecr',
    what: 'The same FantasyPros expert consensus, for superflex — leagues where you can start a second quarterback, which pushes quarterbacks far up the board.',
    provider: 'FantasyPros ½PPR superflex ECR',
  },
  adp_fp_dyn: {
    label: 'FantasyPros DYN', short: 'FP DYN', source: 'fantasypros',
    format: 'DYN', league: '1QB', scoring: 'ppr', kind: 'ecr',
    what: 'The same FantasyPros expert consensus, for dynasty — leagues where you keep your roster year to year, so young players are worth more.',
    provider: 'FantasyPros dynasty ECR (published PPR only)',
  },
  adp_fp_dyn_sf: {
    label: 'FantasyPros DYN SF', short: 'FP DSF', source: 'fantasypros',
    format: 'DYN', league: '2QB', scoring: 'ppr', kind: 'ecr',
    what: 'FantasyPros expert consensus for dynasty superflex: keep-forever leagues that also start a second quarterback.',
    provider: 'FantasyPros dynasty superflex ECR',
  },
  adp_ffc: {
    label: 'FFC', short: 'FFC', source: 'ffc',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'adp',
    what: 'Fantasy Football Calculator hosts free public mock drafts. This is real ADP averaged over a couple of thousand recent mocks, so it moves quickly but the drafters are anonymous.',
    provider: 'Fantasy Football Calculator ½PPR mock drafts',
  },
  adp_ffc_sf: {
    label: 'FFC 2QB', short: 'FFC SF', source: 'ffc',
    format: 'RD', league: '2QB', scoring: 'std', kind: 'adp',
    what: 'The same Fantasy Football Calculator mock-draft data, from their two-quarterback drafts. Their 2QB rooms score standard, not half-PPR.',
    provider: 'Fantasy Football Calculator 2QB mock drafts (standard scoring)',
  },
  adp_sl_rd: {
    label: 'Sleeper', short: 'SL', source: 'sleeper',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'adp',
    what: 'Sleeper is the app a lot of leagues actually run on. This is real ADP from Sleeper\'s own half-PPR drafts.',
    provider: 'Sleeper ½PPR drafts',
  },
  adp_sl_sf: {
    label: 'Sleeper SF', short: 'SL SF', source: 'sleeper',
    format: 'RD', league: '2QB', scoring: 'native', kind: 'adp',
    what: 'Real ADP from Sleeper\'s two-quarterback drafts.',
    provider: 'Sleeper 2QB drafts',
  },
  adp_sl_dyn: {
    label: 'Sleeper DYN', short: 'SL DYN', source: 'sleeper',
    format: 'DYN', league: '1QB', scoring: 'half', kind: 'adp',
    what: 'Real ADP from Sleeper dynasty start-up drafts — the draft you do when a keep-forever league is first created.',
    provider: 'Sleeper ½PPR dynasty startups',
  },
  adp_sl_dyn_sf: {
    label: 'Sleeper DYN SF', short: 'SL DSF', source: 'sleeper',
    format: 'DYN', league: '2QB', scoring: 'native', kind: 'adp',
    what: 'Real ADP from Sleeper superflex dynasty start-up drafts.',
    provider: 'Sleeper 2QB dynasty startups',
  },
  adp_espn: {
    label: 'ESPN', short: 'ESPN', source: 'market',
    format: 'RD', league: '1QB', scoring: 'ppr', kind: 'adp',
    what: 'ESPN is where a lot of casual home leagues draft. Useful as a check on the wider market, and it usually lags the industry consensus by a week or two.',
    provider: 'ESPN home leagues, via DraftSharks (published PPR only)',
  },
  adp_yahoo: {
    label: 'Yahoo', short: 'YAH', source: 'market',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'adp',
    what: 'Yahoo is the other big home-league platform. Same idea as ESPN — it shows what ordinary leagues are doing rather than what experts think.',
    provider: 'Yahoo home leagues, via DraftSharks',
  },
  ktc_value: {
    label: 'KeepTradeCut', short: 'KTC', source: 'dynastydaddy',
    format: 'DYN', league: '1QB', scoring: 'native', kind: 'value',
    what: 'KeepTradeCut is crowd-sourced. Users are shown three players and asked which they would keep, trade and cut; millions of those votes become a value from 0 to 10000. It is the most widely quoted dynasty currency.',
    provider: 'KeepTradeCut 1QB dynasty values (½PPR), via Dynasty Daddy',
  },
  ktc_value_sf: {
    label: 'KeepTradeCut SF', short: 'KTC SF', source: 'dynastydaddy',
    format: 'DYN', league: '2QB', scoring: 'half', kind: 'value',
    what: 'The KeepTradeCut crowd values for superflex leagues, where quarterbacks are worth far more.',
    provider: 'KeepTradeCut superflex dynasty values (½PPR), via Dynasty Daddy',
  },
  ds_value: {
    label: 'DynastySuperflex', short: 'DS', source: 'dynastydaddy',
    format: 'DYN', league: '1QB', scoring: 'native', kind: 'value',
    what: 'DynastySuperflex is a separate dynasty trade-value site, run independently of KeepTradeCut. Carried because a second opinion stops one crowd setting the whole board.',
    provider: 'DynastySuperflex 1QB dynasty values, via Dynasty Daddy',
  },
  ds_value_sf: {
    label: 'DynastySuperflex SF', short: 'DS SF', source: 'dynastydaddy',
    format: 'DYN', league: '2QB', scoring: 'native', kind: 'value',
    what: 'The DynastySuperflex values for superflex leagues.',
    provider: 'DynastySuperflex superflex dynasty values, via Dynasty Daddy',
  },
  // Displayed but never averaged: DynastyProcess derives its values from FantasyPros
  // dynasty ECR (rho 0.98 against adp_fp_dyn), which the consensus already includes.
  dp_value: {
    label: 'DynastyProcess', short: 'DP', source: 'dynastyprocess',
    format: 'DYN', league: '1QB', scoring: 'native', kind: 'value', consensus: false,
    what: 'DynastyProcess publishes dynasty values built from the FantasyPros dynasty rankings. Shown for reference but never averaged in, because FantasyPros is already in the mix and counting it twice would double its weight.',
    provider: 'DynastyProcess 1QB dynasty values (FantasyPros-derived)',
  },
  dp_value_sf: {
    label: 'DynastyProcess SF', short: 'DP SF', source: 'dynastyprocess',
    format: 'DYN', league: '2QB', scoring: 'native', kind: 'value', consensus: false,
    what: 'The DynastyProcess values for superflex, again shown for reference only.',
    provider: 'DynastyProcess superflex dynasty values (FantasyPros-derived)',
  },
  fc_value: {
    label: 'FantasyCalc', short: 'FC', source: 'fantasycalc',
    format: 'DYN', league: '1QB', scoring: 'half', kind: 'value',
    what: 'FantasyCalc builds its values from trades that actually completed in real leagues, rather than from votes or expert lists — so it reflects what people genuinely paid.',
    provider: 'FantasyCalc 1QB dynasty trade values',
  },
  fc_value_sf: {
    label: 'FantasyCalc SF', short: 'FC SF', source: 'fantasycalc',
    format: 'DYN', league: '2QB', scoring: 'half', kind: 'value',
    what: 'The FantasyCalc completed-trade values for superflex leagues.',
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
};

// Superflex dynasty columns are sent to the client under their base name, because a
// board only ever shows one league type at a time. This maps a column to the key the
// player payload actually carries.
const FIELD_ALIAS = {
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
      provider: c.provider,
      what: c.what,
      inConsensus,
      // Set on the few columns that exist but must never be averaged.
      excludedReason: c.consensus === false
        ? 'Derived from FantasyPros, which is already averaged in'
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
  viewSources, SCORING_LABEL, KIND_LABEL,
};
