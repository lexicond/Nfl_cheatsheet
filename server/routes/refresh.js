const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { fetchSleeper } = require('../scrapers/sleeper');
const { fetchFantasyPros } = require('../scrapers/fantasypros');
const { fetchUnderdog } = require('../scrapers/underdog');
const { fetchFFC } = require('../scrapers/ffc');
const { fetchKTC } = require('../scrapers/ktc');
const { fetchFantasyCalc } = require('../scrapers/fantasycalc');

const SCRAPERS = {
  fantasypros: fetchFantasyPros,
  underdog: fetchUnderdog,
  sleeper: fetchSleeper,
  ffc: fetchFFC,
  ktc: fetchKTC,
  fantasycalc: fetchFantasyCalc,
};

// POST /api/refresh/:source
router.post('/:source', async (req, res) => {
  const { source } = req.params;
  const valid = [...Object.keys(SCRAPERS), 'all'];

  if (!valid.includes(source)) {
    return res.status(400).json({ error: `Unknown source. Use: ${valid.join(', ')}` });
  }

  try {
    if (source === 'all') {
      // Save previous consensus before recompute
      saveConsensusSnapshot();

      const settled = await Promise.allSettled(
        Object.entries(SCRAPERS).map(([key, fn]) =>
          fn().then(r => [key, r]).catch(e => [key, { success: false, error: e.message }])
        )
      );

      const results = {};
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          const [key, result] = s.value;
          results[key] = result;
        }
      }

      recomputeAllConsensus();
      return res.json({ success: true, source: 'all', results, timestamp: new Date().toISOString() });
    }

    // Single source refresh
    saveConsensusSnapshot();
    const fn = SCRAPERS[source];
    const result = await fn();
    recomputeAllConsensus();

    res.json(result);
  } catch (err) {
    console.error(`[POST /api/refresh/${source}]`, err);
    res.status(500).json({ success: false, error: err.message, source, timestamp: new Date().toISOString() });
  }
});

// GET /api/source-status
router.get('/status', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM source_metadata').all();
    const status = {};
    rows.forEach(r => { status[r.source] = r; });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Snapshot current consensus so trend arrows can show movement on next refresh
function saveConsensusSnapshot() {
  try {
    db.prepare(`
      UPDATE players SET adp_consensus_prev = adp_consensus WHERE adp_consensus IS NOT NULL
    `).run();
  } catch (err) {
    console.error('[saveConsensusSnapshot]', err.message);
  }
}

// Recompute the stored adp_consensus as BB 1QB baseline (FP BB + UD BB + SL BB)
// This is used only for trend arrows (adp_consensus_prev comparison).
// Per-request consensus for all formats is computed in JS in routes/players.js.
function recomputeAllConsensus() {
  try {
    db.prepare(`
      UPDATE players
      SET adp_consensus = (
        SELECT AVG(v)
        FROM (
          SELECT adp_fantasypros AS v WHERE adp_fantasypros IS NOT NULL
          UNION ALL
          SELECT adp_underdog WHERE adp_underdog IS NOT NULL
          UNION ALL
          SELECT adp_sl_bb WHERE adp_sl_bb IS NOT NULL
        )
      )
    `).run();
  } catch (err) {
    console.error('[recomputeAllConsensus]', err.message);
  }
}

module.exports = router;
