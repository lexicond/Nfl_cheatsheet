const { consensusColumns, dynastyInputs, COLUMNS, DEFAULT_OFF_FAMILIES } = require('./sources');

/**
 * Consensus, in one place, so the stored columns and the per-request board can never
 * drift apart — and so turning a source off means the same thing everywhere.
 *
 * `excluded` is a Set of source *families* the caller wants left out. Families rather
 * than columns, so switching Superflex on and off does not silently re-enable a source
 * the user turned off — the 1QB and Superflex boards of one market share a family.
 */

// Which columns actually feed a view once the user's exclusions are applied.
function activeColumns(format, leagueType, excluded = new Set()) {
  return consensusColumns(format, leagueType).filter(c => !excluded.has(COLUMNS[c].family));
}

// ADP formats average the pick numbers directly — they are already on one scale.
function adpConsensus(row, format, leagueType, excluded = new Set()) {
  const vals = activeColumns(format, leagueType, excluded)
    .map(c => row[c])
    .filter(v => v != null && Number.isFinite(Number(v)))
    .map(Number);
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

/**
 * Dynasty sources sit on incompatible scales — KeepTradeCut runs 0–10000, FantasyCalc
 * is a trade value, ECR and ADP are draft positions — so each is turned into a rank
 * over the supplied rows and the ranks are averaged.
 *
 * Ranking has to happen across the whole pool, which is why this takes every row
 * rather than working one player at a time like the ADP path.
 */
function dynastyRanks(rows, leagueType, excluded = new Set()) {
  const inputs = dynastyInputs(leagueType).filter(s => !excluded.has(COLUMNS[s.column].family));
  const perPlayer = new Map();

  for (const { column, direction } of inputs) {
    const ranked = rows
      .filter(r => r[column] != null && Number.isFinite(Number(r[column])))
      .sort((a, b) => (direction === 'desc'
        ? Number(b[column]) - Number(a[column])
        : Number(a[column]) - Number(b[column])));
    ranked.forEach((r, i) => {
      if (!perPlayer.has(r.id)) perPlayer.set(r.id, []);
      perPlayer.get(r.id).push(i + 1);
    });
  }

  const out = new Map();
  for (const [id, ranks] of perPlayer) {
    out.set(id, Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 10) / 10);
  }
  return out;
}

// How many of this view's sources actually have a number for this player.
function sourceCount(row, format, leagueType, excluded = new Set()) {
  return activeColumns(format, leagueType, excluded).filter(c => row[c] != null).length;
}

// Every family a view could offer, so the client can present the full switch list.
function viewFamilies(format, leagueType) {
  return [...new Set(consensusColumns(format, leagueType).map(c => COLUMNS[c].family))];
}

/**
 * How far apart the active sources are on one player.
 *
 * For ADP formats this is a straight pick spread. For dynasty the values are on
 * different scales, so the caller passes rank lookups and the spread is in rank places.
 */
function sourceSpread(row, columns, rankLookups = null) {
  const vals = columns
    .map(c => (rankLookups ? rankLookups[c]?.get(row.id) : row[c]))
    .filter(v => v != null && Number.isFinite(Number(v)))
    .map(Number);
  if (vals.length < 2) return null;
  return Math.round((Math.max(...vals) - Math.min(...vals)) * 10) / 10;
}

/**
 * Attach the headline number, source count and spread to every row for one view.
 * Returns a new array; the input rows are not modified.
 */
function applyConsensus(rows, format, leagueType, excluded = new Set()) {
  const columns = activeColumns(format, leagueType, excluded);

  // Dynasty needs per-source ranks both for the headline and for the spread, so they
  // are built once here rather than per row.
  let dyn = null;
  let dynLookups = null;
  if (format === 'DYN') {
    dyn = dynastyRanks(rows, leagueType, excluded);
    dynLookups = {};
    for (const { column, direction } of dynastyInputs(leagueType)) {
      if (!columns.includes(column)) continue;
      const ranked = rows
        .filter(r => r[column] != null && Number.isFinite(Number(r[column])))
        .sort((a, b) => (direction === 'desc'
          ? Number(b[column]) - Number(a[column])
          : Number(a[column]) - Number(b[column])));
      const m = new Map();
      ranked.forEach((r, i) => m.set(r.id, i + 1));
      dynLookups[column] = m;
    }
  }

  return rows.map(r => ({
    ...r,
    h: format === 'DYN' ? (dyn.get(r.id) ?? null) : adpConsensus(r, format, leagueType, excluded),
    sourceCount: sourceCount(r, format, leagueType, excluded),
    spread: sourceSpread(r, columns, dynLookups),
  }));
}

const ALL_FAMILIES = new Set(Object.values(COLUMNS).map(c => c.family));

/**
 * Turn the request parameter into a validated set of excluded families. Unknown names
 * are dropped rather than silently changing which sources are averaged.
 *
 * A request that says nothing at all gets the defaults; `exclude=` with an empty value
 * means the user has deliberately switched everything on.
 */
function parseExcluded(raw) {
  if (raw == null) return new Set(DEFAULT_OFF_FAMILIES);
  const names = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return new Set(names.filter(n => ALL_FAMILIES.has(n)));
}

module.exports = {
  activeColumns, adpConsensus, dynastyRanks, sourceCount, sourceSpread,
  applyConsensus, parseExcluded, viewFamilies,
};
