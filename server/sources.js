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
    provider: 'Underdog best-ball contests, via DraftSharks',
  },
  adp_fantasypros: {
    label: 'FantasyPros BB', short: 'FP BB', source: 'fantasypros',
    format: 'BB', league: '1QB', scoring: 'ppr', kind: 'ecr',
    provider: 'FantasyPros best-ball ECR (published PPR only)',
  },
  adp_fp_rd: {
    label: 'FantasyPros', short: 'FP', source: 'fantasypros',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'ecr',
    provider: 'FantasyPros ½PPR redraft ECR',
  },
  adp_fp_sf: {
    label: 'FantasyPros SF', short: 'FP SF', source: 'fantasypros',
    format: 'RD', league: '2QB', scoring: 'half', kind: 'ecr',
    provider: 'FantasyPros ½PPR superflex ECR',
  },
  adp_fp_dyn: {
    label: 'FantasyPros DYN', short: 'FP DYN', source: 'fantasypros',
    format: 'DYN', league: '1QB', scoring: 'ppr', kind: 'ecr',
    provider: 'FantasyPros dynasty ECR (published PPR only)',
  },
  adp_fp_dyn_sf: {
    label: 'FantasyPros DYN SF', short: 'FP DSF', source: 'fantasypros',
    format: 'DYN', league: '2QB', scoring: 'ppr', kind: 'ecr',
    provider: 'FantasyPros dynasty superflex ECR',
  },
  adp_ffc: {
    label: 'FFC', short: 'FFC', source: 'ffc',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'adp',
    provider: 'Fantasy Football Calculator ½PPR mock drafts',
  },
  adp_ffc_sf: {
    label: 'FFC 2QB', short: 'FFC SF', source: 'ffc',
    format: 'RD', league: '2QB', scoring: 'std', kind: 'adp',
    provider: 'Fantasy Football Calculator 2QB mock drafts (standard scoring)',
  },
  adp_sl_rd: {
    label: 'Sleeper', short: 'SL', source: 'sleeper',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'adp',
    provider: 'Sleeper ½PPR drafts',
  },
  adp_sl_sf: {
    label: 'Sleeper SF', short: 'SL SF', source: 'sleeper',
    format: 'RD', league: '2QB', scoring: 'native', kind: 'adp',
    provider: 'Sleeper 2QB drafts',
  },
  adp_sl_dyn: {
    label: 'Sleeper DYN', short: 'SL DYN', source: 'sleeper',
    format: 'DYN', league: '1QB', scoring: 'half', kind: 'adp',
    provider: 'Sleeper ½PPR dynasty startups',
  },
  adp_sl_dyn_sf: {
    label: 'Sleeper DYN SF', short: 'SL DSF', source: 'sleeper',
    format: 'DYN', league: '2QB', scoring: 'native', kind: 'adp',
    provider: 'Sleeper 2QB dynasty startups',
  },
  adp_espn: {
    label: 'ESPN', short: 'ESPN', source: 'market',
    format: 'RD', league: '1QB', scoring: 'ppr', kind: 'adp',
    provider: 'ESPN home leagues, via DraftSharks (published PPR only)',
  },
  adp_yahoo: {
    label: 'Yahoo', short: 'YAH', source: 'market',
    format: 'RD', league: '1QB', scoring: 'half', kind: 'adp',
    provider: 'Yahoo home leagues, via DraftSharks',
  },
  ktc_value: {
    label: 'KeepTradeCut', short: 'KTC', source: 'dynastydaddy',
    format: 'DYN', league: '1QB', scoring: 'native', kind: 'value',
    provider: 'KeepTradeCut 1QB dynasty values (½PPR), via Dynasty Daddy',
  },
  ktc_value_sf: {
    label: 'KeepTradeCut SF', short: 'KTC SF', source: 'dynastydaddy',
    format: 'DYN', league: '2QB', scoring: 'half', kind: 'value',
    provider: 'KeepTradeCut superflex dynasty values (½PPR), via Dynasty Daddy',
  },
  ds_value: {
    label: 'DynastySuperflex', short: 'DS', source: 'dynastydaddy',
    format: 'DYN', league: '1QB', scoring: 'native', kind: 'value',
    provider: 'DynastySuperflex 1QB dynasty values, via Dynasty Daddy',
  },
  ds_value_sf: {
    label: 'DynastySuperflex SF', short: 'DS SF', source: 'dynastydaddy',
    format: 'DYN', league: '2QB', scoring: 'native', kind: 'value',
    provider: 'DynastySuperflex superflex dynasty values, via Dynasty Daddy',
  },
  // Displayed but never averaged: DynastyProcess derives its values from FantasyPros
  // dynasty ECR (rho 0.98 against adp_fp_dyn), which the consensus already includes.
  dp_value: {
    label: 'DynastyProcess', short: 'DP', source: 'dynastyprocess',
    format: 'DYN', league: '1QB', scoring: 'native', kind: 'value', consensus: false,
    provider: 'DynastyProcess 1QB dynasty values (FantasyPros-derived)',
  },
  dp_value_sf: {
    label: 'DynastyProcess SF', short: 'DP SF', source: 'dynastyprocess',
    format: 'DYN', league: '2QB', scoring: 'native', kind: 'value', consensus: false,
    provider: 'DynastyProcess superflex dynasty values (FantasyPros-derived)',
  },
  fc_value: {
    label: 'FantasyCalc', short: 'FC', source: 'fantasycalc',
    format: 'DYN', league: '1QB', scoring: 'half', kind: 'value',
    provider: 'FantasyCalc 1QB dynasty trade values',
  },
  fc_value_sf: {
    label: 'FantasyCalc SF', short: 'FC SF', source: 'fantasycalc',
    format: 'DYN', league: '2QB', scoring: 'half', kind: 'value',
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

module.exports = { COLUMNS, CONSENSUS_SOURCES, consensusColumns, dynastyInputs, SCORING_LABEL };
