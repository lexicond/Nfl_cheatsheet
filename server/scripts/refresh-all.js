#!/usr/bin/env node
// Run every scraper against the live sources, then rebuild derived columns.
// Usage: node server/scripts/refresh-all.js
const { db } = require('../db');
const { recomputeDerived } = require('../routes/refresh');

const SCRAPERS = [
  ['sleeper', () => require('../scrapers/sleeper').fetchSleeper()],
  ['fantasypros', () => require('../scrapers/fantasypros').fetchFantasyPros()],
  ['underdog', () => require('../scrapers/underdog').fetchUnderdog()],
  ['ffc', () => require('../scrapers/ffc').fetchFFC()],
  ['market', () => require('../scrapers/market').fetchMarket()],
  ['ktc', () => require('../scrapers/ktc').fetchKTC()],
  ['fantasycalc', () => require('../scrapers/fantasycalc').fetchFantasyCalc()],
];

(async () => {
  db.prepare('UPDATE players SET adp_consensus_prev = adp_consensus WHERE adp_consensus IS NOT NULL').run();

  const failures = [];
  for (const [name, fn] of SCRAPERS) {
    const started = Date.now();
    try {
      const r = await fn();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  → ${name}: ${r.success ? 'ok' : 'FAILED'} in ${secs}s${r.error ? ` (${r.error})` : ''}`);
      if (!r.success) failures.push(name);
    } catch (err) {
      console.error(`  → ${name}: THREW ${err.message}`);
      failures.push(name);
    }
  }

  recomputeDerived();
  console.log(failures.length ? `\nFailed sources: ${failures.join(', ')}` : '\nAll sources refreshed');
  process.exit(failures.length ? 1 : 0);
})();
