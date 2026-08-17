#!/usr/bin/env node
/**
 * Turning a source off must change the consensus, not just hide a column.
 *
 *   node server/scripts/test-source-toggle.js
 *
 * Runs against the database directly, so it needs no browser and no running server.
 * Exits non-zero on failure.
 */
const { db } = require('../db');
const { viewSources, COLUMNS } = require('../sources');
const { applyConsensus, activeColumns, parseExcluded } = require('../consensus');

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails++;
};

const rows = db.prepare('SELECT * FROM players WHERE nfl_team IS NOT NULL').all();
const order = list => list.filter(r => r.h != null).sort((a, b) => a.h - b.h).map(r => r.id);
const FORMATS = [['BB', '1QB'], ['BB', '2QB'], ['RD', '1QB'], ['RD', '2QB'], ['DYN', '1QB'], ['DYN', '2QB']];

for (const [format, league] of FORMATS) {
  console.log(`\n${format}:${league}`);
  const view = viewSources(format, league);
  const all = applyConsensus(rows, format, league);
  const baseOrder = order(all);
  const cols = view.consensus.map(s => s.column);

  check(`${cols.length} sources feed the consensus`, cols.length > 0, cols.map(c => COLUMNS[c].short).join(' + '));

  // Dropping any one input must move the board.
  for (const col of cols) {
    const dropped = applyConsensus(rows, format, league, new Set([col]));
    const changedOrder = JSON.stringify(order(dropped)) !== JSON.stringify(baseOrder);
    const changedCount = dropped.some(r => {
      const before = all.find(x => x.id === r.id);
      return before && r.sourceCount !== before.sourceCount;
    });
    check(`dropping ${COLUMNS[col].short} changes the board`, changedOrder && changedCount);
  }

  // Reference columns are displayed but must never move the number.
  for (const ref of view.reference) {
    const dropped = applyConsensus(rows, format, league, new Set([ref.column]));
    check(`dropping ${ref.short} leaves the consensus alone (reference only)`,
      JSON.stringify(order(dropped)) === JSON.stringify(baseOrder));
  }

  // One source left is still a usable board.
  const lastOnly = new Set(cols.slice(1));
  const single = applyConsensus(rows, format, league, lastOnly);
  check('a single remaining source still ranks players', order(single).length > 50,
    `${order(single).length} ranked on ${COLUMNS[cols[0]].short} alone`);

  // Excluding everything yields no ranking rather than a wrong one.
  const none = applyConsensus(rows, format, league, new Set(cols));
  check('excluding every source ranks nobody', order(none).length === 0);

  // Exclusions must not leak between views.
  const otherFormat = FORMATS.find(([f, l]) => f !== format || l !== league);
  const leak = applyConsensus(rows, otherFormat[0], otherFormat[1], new Set(cols));
  const clean = applyConsensus(rows, otherFormat[0], otherFormat[1]);
  const shared = cols.filter(c => activeColumns(otherFormat[0], otherFormat[1]).includes(c));
  if (shared.length === 0) {
    check(`exclusions do not leak into ${otherFormat[0]}:${otherFormat[1]}`,
      JSON.stringify(order(leak)) === JSON.stringify(order(clean)));
  }
}

console.log('\nInput handling');
check('unknown column names are ignored', parseExcluded('not_a_column,adp_espn').size === 1);
check('empty parameter yields no exclusions', parseExcluded('').size === 0);
check('undefined parameter yields no exclusions', parseExcluded(undefined).size === 0);
check('whitespace is tolerated', parseExcluded(' adp_espn , adp_yahoo ').size === 2);

console.log(`\n${fails === 0 ? 'PASSED' : `FAILED — ${fails}`}\n`);
process.exit(fails === 0 ? 0 : 1);
