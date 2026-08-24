#!/usr/bin/env node
// Run every scraper against the live sources, then rebuild derived columns.
// Usage: node server/scripts/refresh-all.js
const { db } = require('../db');
// The source list comes from the route rather than a second copy kept here. The copy
// that used to live in this file fell a source behind the moment one was added, so a
// command-line refresh quietly skipped it while the UI refreshed everything.
const { recomputeDerived, SCRAPERS } = require('../routes/refresh');


(async () => {
  db.prepare('UPDATE players SET adp_consensus_prev = adp_consensus WHERE adp_consensus IS NOT NULL').run();

  const failures = [];
  for (const [name, fn] of Object.entries(SCRAPERS)) {
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
