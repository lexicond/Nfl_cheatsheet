#!/usr/bin/env node
/**
 * Does each format actually contain what its label claims?
 *
 *   node server/scripts/validate-sources.js
 *
 * Every source here is fetched from a URL that can silently change meaning: a page
 * 302s to a different board, a "superflex" feed turns out to be 1QB, a "dynasty"
 * column is really redraft. All of those still return valid data, so the only way
 * to catch them is to assert on what the numbers imply about the format.
 *
 * Exits non-zero if any assertion fails.
 */
const { db } = require('../db');
const { COLUMNS, CONSENSUS_SOURCES, consensusColumns } = require('../sources');

let failures = 0;
let warnings = 0;

const ok = m => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = m => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const warn = m => { console.log(`  \x1b[33m!\x1b[0m ${m}`); warnings++; };
const section = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

const rows = db.prepare('SELECT * FROM players WHERE nfl_team IS NOT NULL').all();

function headline(r, format, leagueType) {
  if (format === 'DYN') return leagueType === '2QB' ? r.dyn_rank_consensus_sf : r.dyn_rank_consensus;
  const vals = consensusColumns(format, leagueType).map(c => r[c]).filter(v => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function board(format, leagueType) {
  return rows
    .map(r => ({ ...r, h: headline(r, format, leagueType) }))
    .filter(r => r.h != null)
    .sort((a, b) => a.h - b.h);
}

function rankedBy(column, direction) {
  return rows
    .filter(r => r[column] != null)
    .sort((a, b) => (direction === 'desc' ? b[column] - a[column] : a[column] - b[column]));
}

const FORMATS = [['BB', '1QB'], ['BB', '2QB'], ['RD', '1QB'], ['RD', '2QB'], ['DYN', '1QB'], ['DYN', '2QB']];
const name = (f, l) => `${f}:${l}`;

/* 1. Superflex must value quarterbacks; 1QB must not. */
section('Superflex vs 1QB — quarterback placement');
for (const [format, league] of FORMATS) {
  const top12 = board(format, league).slice(0, 12);
  const qbs = top12.filter(p => p.position === 'QB').length;
  const firstQb = board(format, league).findIndex(p => p.position === 'QB') + 1;
  const label = `${name(format, league)}: ${qbs} QB in top 12, QB1 at overall ${firstQb || '—'}`;

  if (league === '2QB') {
    if (qbs >= 3 && firstQb > 0 && firstQb <= 5) ok(label);
    else bad(`${label} — a superflex board should open with quarterbacks; this looks like 1QB data`);
  } else {
    if (qbs <= 1) ok(label);
    else bad(`${label} — a 1QB board should not be QB-heavy early; this looks like superflex data`);
  }
}

/* 2. Dynasty must skew younger than redraft — old proven veterans are a redraft tell. */
section('Dynasty vs redraft — age of the top of the board');
const meanAge = list => {
  const ages = list.map(p => p.age).filter(a => a != null);
  return ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null;
};
for (const league of ['1QB', '2QB']) {
  const dyn = meanAge(board('DYN', league).slice(0, 24));
  const rd = meanAge(board('RD', league).slice(0, 24));
  if (dyn == null || rd == null) { warn(`${league}: no age data, cannot compare`); continue; }
  const label = `${league}: dynasty top-24 mean age ${dyn.toFixed(1)} vs redraft ${rd.toFixed(1)}`;
  if (dyn < rd - 0.3) ok(label);
  else bad(`${label} — dynasty should be clearly younger; this dynasty column may be redraft data`);

  const oldInDyn = board('DYN', league).slice(0, 10).filter(p => p.age != null && p.age >= 30);
  if (oldInDyn.length === 0) ok(`${league}: no player aged 30+ in the dynasty top 10`);
  else warn(`${league}: age 30+ inside dynasty top 10 — ${oldInDyn.map(p => `${p.name} (${p.age})`).join(', ')}`);
}

/* 3. Best ball and redraft must not be the same board. */
section('Best ball vs redraft — the two boards must differ');
for (const league of ['1QB', '2QB']) {
  const bb = board('BB', league).slice(0, 100).map(p => p.id);
  const rdRank = new Map(board('RD', league).map((p, i) => [p.id, i + 1]));
  const diffs = bb.map((id, i) => (rdRank.has(id) ? Math.abs(rdRank.get(id) - (i + 1)) : null)).filter(v => v != null);
  if (diffs.length < 20) { warn(`${league}: too little overlap to compare (${diffs.length})`); continue; }
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const label = `${league}: mean rank gap between best ball and redraft over the top 100 is ${mean.toFixed(1)}`;
  if (mean >= 3) ok(label);
  else bad(`${label} — the two boards are nearly identical; best ball may be reading redraft data`);
}

/* 4. Scoring: the app is half-PPR, so anything else should be a deliberate exception. */
section('Scoring — every consensus input');
for (const [key, cols] of Object.entries(CONSENSUS_SOURCES)) {
  const offenders = cols.filter(c => COLUMNS[c].scoring === 'std');
  const halves = cols.filter(c => COLUMNS[c].scoring === 'half').length;
  if (offenders.length === 0) ok(`${key}: ${halves}/${cols.length} half-PPR, none standard-scoring`);
  else warn(`${key}: standard-scoring input in a half-PPR consensus — ${offenders.map(c => COLUMNS[c].label).join(', ')}`);
}

/* 5. No source may enter a consensus twice under two names. */
section('Independence — are any two inputs the same market?');
function spearman(colA, colB) {
  const dirA = COLUMNS[colA].kind === 'value' ? 'desc' : 'asc';
  const dirB = COLUMNS[colB].kind === 'value' ? 'desc' : 'asc';
  const shared = rows.filter(r => r[colA] != null && r[colB] != null);
  if (shared.length < 50) return null;
  const rank = (col, dir) => {
    const m = new Map();
    shared.slice().sort((x, y) => (dir === 'desc' ? y[col] - x[col] : x[col] - y[col]))
      .forEach((r, i) => m.set(r.id, i + 1));
    return m;
  };
  const ra = rank(colA, dirA);
  const rb = rank(colB, dirB);
  const n = shared.length;
  let d2 = 0;
  for (const r of shared) { const d = ra.get(r.id) - rb.get(r.id); d2 += d * d; }
  return 1 - (6 * d2) / (n * (n * n - 1));
}
for (const [key, cols] of Object.entries(CONSENSUS_SOURCES)) {
  let worst = null;
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      const rho = spearman(cols[i], cols[j]);
      if (rho != null && (!worst || rho > worst.rho)) worst = { rho, a: cols[i], b: cols[j] };
    }
  }
  if (!worst) { warn(`${key}: not enough overlap to test independence`); continue; }
  const label = `${key}: closest pair ${COLUMNS[worst.a].short} / ${COLUMNS[worst.b].short} at rho ${worst.rho.toFixed(3)}`;
  if (worst.rho < 0.97) ok(label);
  else warn(`${label} — that is high enough to suspect one market entering the consensus twice`);
}

/* 6. Freshness and depth. */
section('Freshness and coverage');
const DAY = 86400000;
for (const meta of db.prepare('SELECT * FROM source_metadata').all()) {
  if (!meta.last_fetched) { bad(`${meta.source}: never fetched`); continue; }
  const ageDays = (Date.now() - new Date(meta.last_fetched).getTime()) / DAY;
  if (meta.status === 'error') bad(`${meta.source}: last fetch failed — ${meta.notes || 'no detail'}`);
  else if (ageDays > 3) warn(`${meta.source}: ${ageDays.toFixed(1)} days old`);
  else ok(`${meta.source}: ${ageDays < 1 ? 'fresh' : ageDays.toFixed(1) + 'd'}, ${meta.player_count} players`);
}
for (const [key, cols] of Object.entries(CONSENSUS_SOURCES)) {
  for (const col of cols) {
    const n = rows.filter(r => r[col] != null).length;
    if (n < 100) bad(`${key}: ${COLUMNS[col].label} covers only ${n} rostered players`);
  }
}

/* 7. Every consensus input must be declared for the format it feeds. */
section('Registry — inputs declared for the format they feed');
for (const [key, cols] of Object.entries(CONSENSUS_SOURCES)) {
  const [format, league] = key.split(':');
  // Best ball has no superflex market of its own and knowingly borrows the redraft
  // superflex boards; every other format must use columns declared for it.
  const exempt = key === 'BB:2QB';
  const wrong = cols.filter(c => COLUMNS[c].format !== format || COLUMNS[c].league !== league);
  if (wrong.length === 0) ok(`${key}: all ${cols.length} inputs declared ${key}`);
  else if (exempt) ok(`${key}: borrows ${wrong.map(c => COLUMNS[c].short).join(', ')} — documented, no best-ball superflex market exists`);
  else bad(`${key}: inputs declared for another format — ${wrong.map(c => `${COLUMNS[c].short} is ${COLUMNS[c].format}:${COLUMNS[c].league}`).join('; ')}`);
}

console.log(`\n${failures === 0 ? '\x1b[32mPASSED\x1b[0m' : '\x1b[31mFAILED\x1b[0m'} — ${failures} failure(s), ${warnings} warning(s)\n`);
process.exit(failures === 0 ? 0 : 1);
