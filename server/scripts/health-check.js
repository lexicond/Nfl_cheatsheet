#!/usr/bin/env node
// Self-repairing health check. Usage: node server/scripts/health-check.js [--repair]

const path = require('path');
// Load db from parent directory context
process.chdir(path.join(__dirname, '..', '..'));
const { db } = require('../server/db');
const { normalizeName } = require('../server/utils/normalize');

const REPAIR = process.argv.includes('--repair');
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
let exitCode = 0;

function log(level, msg) {
  const prefix = level === 'ok' ? '✓' : level === 'warn' ? '⚠' : '✗';
  console.log(`${prefix} ${msg}`);
  if (level === 'error') exitCode = 1;
}

// 1. Source freshness
console.log('\n=== Source Freshness ===');
const sources = db.prepare('SELECT * FROM source_metadata').all();
for (const s of sources) {
  if (!s.last_fetched) {
    log('warn', `${s.source}: never fetched`);
    continue;
  }
  const age = Date.now() - new Date(s.last_fetched).getTime();
  const ageDays = (age / 86400000).toFixed(1);
  if (age > STALE_MS) {
    log('warn', `${s.source}: stale (${ageDays} days old)`);
  } else if (s.status === 'error') {
    log('error', `${s.source}: last fetch failed (${ageDays} days ago)`);
  } else {
    log('ok', `${s.source}: ${ageDays}d ago, ${s.player_count} players`);
  }
}

// 2. Player counts and coverage
console.log('\n=== Player Coverage ===');
const total = db.prepare('SELECT COUNT(*) as c FROM players').get().c;
const withProj = db.prepare('SELECT COUNT(*) as c FROM players WHERE projected_pts IS NOT NULL').get().c;
const withKTC = db.prepare('SELECT COUNT(*) as c FROM players WHERE ktc_value IS NOT NULL').get().c;
const withNorm = db.prepare('SELECT COUNT(*) as c FROM players WHERE name_normalized IS NOT NULL').get().c;
const withFP = db.prepare('SELECT COUNT(*) as c FROM players WHERE adp_fantasypros IS NOT NULL').get().c;
const withUD = db.prepare('SELECT COUNT(*) as c FROM players WHERE adp_underdog IS NOT NULL').get().c;

log(total > 500 ? 'ok' : 'warn', `Total players: ${total}`);
log(withNorm === total ? 'ok' : 'warn', `name_normalized: ${withNorm}/${total} (${(100*withNorm/total).toFixed(0)}%)`);
log(withProj > 100 ? 'ok' : 'warn', `projected_pts: ${withProj}/${total} (${(100*withProj/total).toFixed(0)}%)`);
log(withKTC > 100 ? 'ok' : 'warn', `ktc_value: ${withKTC}/${total} (${(100*withKTC/total).toFixed(0)}%)`);
log(withFP > 100 ? 'ok' : 'warn', `adp_fantasypros: ${withFP}/${total}`);
log(withUD > 100 ? 'ok' : 'warn', `adp_underdog: ${withUD}/${total}`);

// 3. Ranking consistency — top 20 consensus should appear in top 35 of each source
console.log('\n=== Ranking Consistency (top 20 consensus) ===');
const top20 = db.prepare(`
  SELECT name, position, adp_consensus, adp_fantasypros, adp_underdog, adp_ffc
  FROM players WHERE adp_consensus IS NOT NULL
  ORDER BY adp_consensus LIMIT 20
`).all();

for (const p of top20) {
  const mismatches = [];
  if (p.adp_fantasypros != null && p.adp_fantasypros > 35) mismatches.push(`FP:${p.adp_fantasypros.toFixed(0)}`);
  if (p.adp_underdog != null && p.adp_underdog > 35) mismatches.push(`UD:${p.adp_underdog.toFixed(0)}`);
  if (p.adp_ffc != null && p.adp_ffc > 35) mismatches.push(`FFC:${p.adp_ffc.toFixed(0)}`);
  if (mismatches.length > 0) {
    log('warn', `${p.name} (consensus ${p.adp_consensus.toFixed(0)}) ranked outside top 35 in: ${mismatches.join(', ')}`);
  } else {
    log('ok', `${p.name} ${p.position} consensus=${p.adp_consensus.toFixed(1)}`);
  }
}

// 4. Data year check
console.log('\n=== Data Year Check ===');
const cutoff = new Date('2026-01-01').getTime();
for (const s of sources) {
  if (!s.last_fetched) continue;
  if (new Date(s.last_fetched).getTime() < cutoff) {
    log('warn', `${s.source}: last fetched before 2026 (${s.last_fetched.slice(0, 10)})`);
  }
}

// 5. Self-repair: populate missing name_normalized
if (REPAIR) {
  console.log('\n=== Self-Repair: name_normalized ===');
  const missing = db.prepare('SELECT id, name FROM players WHERE name_normalized IS NULL').all();
  if (missing.length > 0) {
    const upd = db.prepare('UPDATE players SET name_normalized = ? WHERE id = ?');
    const tx = db.transaction(() => { for (const p of missing) upd.run(normalizeName(p.name), p.id); });
    tx();
    log('ok', `Repaired name_normalized for ${missing.length} players`);
  } else {
    log('ok', 'All players already have name_normalized');
  }
}

console.log(`\nHealth check ${exitCode === 0 ? 'PASSED' : 'FAILED'}\n`);
process.exit(exitCode);
