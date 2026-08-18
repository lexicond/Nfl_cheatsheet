#!/usr/bin/env node
/**
 * Hunt for name-matching damage.
 *
 *   node server/scripts/audit-matching.js
 *
 * A player matched to the wrong row, or not matched at all, shows up in one of three
 * ways: a source is missing for someone every other source ranks highly; one source
 * disagrees wildly with the rest; or two rows exist for the same person.
 */
const { db } = require('../db');
const { COLUMNS, consensusColumns, viewSources } = require('../sources');
const { normalizeName } = require('../utils/normalize');
const { firstNamesCompatible } = require('../utils/match');

const rows = db.prepare('SELECT * FROM players WHERE nfl_team IS NOT NULL').all();
const FORMATS = [['BB', '1QB'], ['RD', '1QB'], ['RD', '2QB'], ['DYN', '1QB'], ['DYN', '2QB']];

// Rank a column over the pool so sources on different scales can be compared.
function rankMap(column) {
  const desc = COLUMNS[column].kind === 'value';
  const ranked = rows.filter(r => r[column] != null)
    .sort((a, b) => (desc ? b[column] - a[column] : a[column] - b[column]));
  const m = new Map();
  ranked.forEach((r, i) => m.set(r.id, i + 1));
  return m;
}

console.log('\n=== 1. Missing from a source, but ranked highly by the others ===');
console.log('    (a gap here is usually the matcher failing on a name)\n');
let missingTotal = 0;
for (const [format, league] of FORMATS) {
  const cols = consensusColumns(format, league);
  const ranks = Object.fromEntries(cols.map(c => [c, rankMap(c)]));
  const gaps = [];

  for (const r of rows) {
    const present = cols.filter(c => ranks[c].has(r.id));
    const absent = cols.filter(c => !ranks[c].has(r.id));
    if (present.length < 2 || absent.length === 0) continue;
    const meanRank = present.reduce((a, c) => a + ranks[c].get(r.id), 0) / present.length;
    // Only care about players the market actually values.
    if (meanRank > 150) continue;
    for (const col of absent) {
      // A source that simply does not go this deep is not a matching failure.
      const depth = rows.filter(x => x[col] != null).length;
      if (meanRank > depth) continue;
      gaps.push({ name: r.name, pos: r.position, team: r.nfl_team, col, meanRank: Math.round(meanRank), depth });
    }
  }
  gaps.sort((a, b) => a.meanRank - b.meanRank);
  missingTotal += gaps.length;
  console.log(`${format}:${league} — ${gaps.length} gaps`);
  for (const g of gaps.slice(0, 8)) {
    console.log(`  ${String(g.meanRank).padStart(3)}  ${g.name.padEnd(22)} ${g.pos} ${g.team}  missing from ${COLUMNS[g.col].label} (depth ${g.depth})`);
  }
  if (gaps.length > 8) console.log(`  … and ${gaps.length - 8} more`);
}

console.log('\n=== 2. One source wildly out of line with the rest ===');
console.log('    (a big outlier is either a real disagreement or a wrong match)\n');
let outlierTotal = 0;
for (const [format, league] of FORMATS) {
  const cols = consensusColumns(format, league);
  const ranks = Object.fromEntries(cols.map(c => [c, rankMap(c)]));
  const flagged = [];

  for (const r of rows) {
    const seen = cols.filter(c => ranks[c].has(r.id)).map(c => ({ col: c, rank: ranks[c].get(r.id) }));
    if (seen.length < 3) continue;
    for (const s of seen) {
      const others = seen.filter(o => o.col !== s.col).map(o => o.rank).sort((a, b) => a - b);
      const median = others[Math.floor(others.length / 2)];
      const gap = Math.abs(s.rank - median);
      // Scale the threshold with depth: 40 places apart at pick 10 is a different
      // thing from 40 places apart at pick 200.
      if (gap > Math.max(45, median * 0.7)) {
        flagged.push({ name: r.name, pos: r.position, team: r.nfl_team, col: s.col, rank: s.rank, median, gap });
      }
    }
  }
  flagged.sort((a, b) => b.gap - a.gap);
  outlierTotal += flagged.length;
  console.log(`${format}:${league} — ${flagged.length} outliers`);
  for (const f of flagged.slice(0, 8)) {
    console.log(`  ${f.name.padEnd(22)} ${f.pos} ${f.team}  ${COLUMNS[f.col].label} ranks him ${f.rank}, others ~${f.median}`);
  }
  if (flagged.length > 8) console.log(`  … and ${flagged.length - 8} more`);
}

console.log('\n=== 3. Possible duplicate rows for one player ===\n');
const groups = new Map();
for (const r of db.prepare('SELECT * FROM players').all()) {
  const key = `${normalizeName(r.name)}|${r.position}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
// Two rows sharing a name and position are only a duplicate if they are the same man.
// Distinct Sleeper ids are proof they are not — Frank Gore and Frank Gore Jr. are both
// running backs on the same roster and are two different players. Flagging them buries
// the real duplicates this check exists to find.
const dupes = [...groups.values()].filter(g => {
  if (g.length < 2) return false;
  const ids = g.map(r => r.sleeper_player_id).filter(Boolean);
  return !(ids.length === g.length && new Set(ids).size === g.length);
});
console.log(dupes.length === 0 ? '  none' : '');
for (const g of dupes.slice(0, 12)) {
  console.log(`  ${g.map(r => `${r.name} (${r.nfl_team || 'FA'}, id ${r.id})`).join('  |  ')}`);
}

// Same surname, same position, same team — the case the matcher is most likely to
// confuse. Where the first names are also compatible it is not a risk but a genuine
// duplicate: one player split across two rows, showing up twice on the board.
console.log('\n=== 4. Same surname, position and team (matcher confusion risk) ===\n');
const bySurname = new Map();
for (const r of rows) {
  const parts = normalizeName(r.name).split(' ');
  if (parts.length < 2) continue;
  const key = `${parts[parts.length - 1]}|${r.position}|${r.nfl_team}`;
  if (!bySurname.has(key)) bySurname.set(key, []);
  bySurname.get(key).push(r);
}
const clashes = [...bySurname.values()].filter(g => g.length > 1);
const firstOf = r => normalizeName(r.name).split(' ')[0];
const sameePlayer = [];
for (const g of clashes) {
  for (let i = 0; i < g.length; i++) {
    for (let j = i + 1; j < g.length; j++) {
      // Distinct Sleeper ids settle it: two ids are two men, however alike the names.
      // Without this, Frank Gore and Frank Gore Jr. — same surname, same position, same
      // roster, compatible first names — read as one player split in two, and the check
      // fails forever on a pair that is correct.
      const distinctIds = g[i].sleeper_player_id && g[j].sleeper_player_id
        && g[i].sleeper_player_id !== g[j].sleeper_player_id;
      if (!distinctIds && firstNamesCompatible(firstOf(g[i]), firstOf(g[j]))) {
        sameePlayer.push([g[i], g[j]]);
      }
    }
  }
}
console.log(clashes.length === 0 ? '  none' : '');
for (const g of clashes) {
  console.log(`  ${g.map(r => `${r.name} (${r.position} ${r.nfl_team})`).join('  vs  ')}`);
}
if (sameePlayer.length) {
  console.log('\n  LIKELY THE SAME PLAYER SPLIT ACROSS ROWS — he will appear twice on the board:');
  for (const [a, b] of sameePlayer) {
    console.log(`    ${a.name} (id ${a.id}) and ${b.name} (id ${b.id}) — ${a.position} ${a.nfl_team}`);
  }
}

console.log(`\nSummary: ${missingTotal} coverage gaps, ${outlierTotal} outliers, ` +
  `${dupes.length + sameePlayer.length} duplicate rows, ${clashes.length} surname clashes\n`);
process.exit(dupes.length + sameePlayer.length > 0 ? 1 : 0);
