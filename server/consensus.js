const { consensusColumns, dynastyInputs, COLUMNS } = require('./sources');

/**
 * Consensus, in one place, so the stored columns and the per-request board can never
 * drift apart — and so turning a source off means the same thing everywhere.
 *
 * `excluded` is a Set of column names the caller wants left out of the average.
 */

// Which columns actually feed a view once the user's exclusions are applied.
function activeColumns(format, leagueType, excluded = new Set()) {
  return consensusColumns(format, leagueType).filter(c => !excluded.has(c));
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
  const inputs = dynastyInputs(leagueType).filter(s => !excluded.has(s.column));
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

/**
 * Attach the headline number and its source count to every row for one view.
 * Returns a new array; the input rows are not modified.
 */
function applyConsensus(rows, format, leagueType, excluded = new Set()) {
  const dyn = format === 'DYN' ? dynastyRanks(rows, leagueType, excluded) : null;
  return rows.map(r => ({
    ...r,
    h: format === 'DYN' ? (dyn.get(r.id) ?? null) : adpConsensus(r, format, leagueType, excluded),
    sourceCount: sourceCount(r, format, leagueType, excluded),
  }));
}

// Turn a comma-separated request parameter into a validated exclusion set. Unknown
// names are dropped rather than silently changing which columns are averaged.
function parseExcluded(raw) {
  if (!raw) return new Set();
  const names = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return new Set(names.filter(n => Object.prototype.hasOwnProperty.call(COLUMNS, n)));
}

module.exports = { activeColumns, adpConsensus, dynastyRanks, sourceCount, applyConsensus, parseExcluded };
