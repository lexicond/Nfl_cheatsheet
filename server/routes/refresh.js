const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { adpConsensus, dynastyRanks } = require('../consensus');
const { fetchSleeper } = require('../scrapers/sleeper');
const { fetchFantasyPros } = require('../scrapers/fantasypros');
const { fetchUnderdog } = require('../scrapers/underdog');
const { fetchFFC } = require('../scrapers/ffc');
const { fetchDynastyProcess } = require('../scrapers/dynastyprocess');
const { fetchDynastyDaddy } = require('../scrapers/dynastydaddy');
const { fetchFantasyCalc } = require('../scrapers/fantasycalc');
const { fetchFootballers } = require('../scrapers/footballers');
const { fetchMarket } = require('../scrapers/market');

// Sleeper runs first on a full refresh: it owns the roster rows and the Sleeper
// ids the other sources match against.
const SCRAPERS = {
  sleeper: fetchSleeper,
  fantasypros: fetchFantasyPros,
  underdog: fetchUnderdog,
  ffc: fetchFFC,
  market: fetchMarket,
  dynastyprocess: fetchDynastyProcess,
  dynastydaddy: fetchDynastyDaddy,
  fantasycalc: fetchFantasyCalc,
  footballers: fetchFootballers,
};

// POST /api/refresh/:source
router.post('/:source', async (req, res) => {
  const { source } = req.params;
  const valid = [...Object.keys(SCRAPERS), 'all'];

  if (!valid.includes(source)) {
    return res.status(400).json({ error: `Unknown source. Use: ${valid.join(', ')}` });
  }

  try {
    saveConsensusSnapshot();

    if (source === 'all') {
      const results = {};
      // Sequential, not parallel: the scrapers all write the same SQLite file and
      // every non-Sleeper source matches against rows Sleeper has to insert first.
      for (const [key, fn] of Object.entries(SCRAPERS)) {
        try {
          results[key] = await fn();
        } catch (err) {
          console.error(`[refresh:all] ${key} threw:`, err.message);
          results[key] = { success: false, error: err.message, source: key };
        }
      }
      recomputeDerived();
      const failed = Object.entries(results).filter(([, r]) => !r.success).map(([k]) => k);
      return res.json({
        success: failed.length === 0,
        source: 'all',
        failed_sources: failed,
        results,
        timestamp: new Date().toISOString(),
      });
    }

    const result = await SCRAPERS[source]();
    recomputeDerived();
    res.json(result);
  } catch (err) {
    console.error(`[POST /api/refresh/${source}]`, err);
    res.status(500).json({ success: false, error: err.message, source, timestamp: new Date().toISOString() });
  }
});

// GET /api/refresh/status
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

// Snapshot the current consensus so trend arrows can show movement after the refresh.
function saveConsensusSnapshot() {
  try {
    db.prepare('UPDATE players SET adp_consensus_prev = adp_consensus WHERE adp_consensus IS NOT NULL').run();
  } catch (err) {
    console.error('[saveConsensusSnapshot]', err.message);
  }
}

/**
 * Rebuild the stored derived columns:
 *  - adp_consensus: best-ball 1QB baseline, the series the trend arrows compare against
 *  - dyn_rank_consensus[_sf]: mean rank across the dynasty value sources
 * Per-request consensus for the other formats is computed in routes/players.js.
 */
function recomputeDerived() {
  try {
    const rows = db.prepare(`
      SELECT id, adp_underdog, adp_fantasypros,
             ktc_value, ktc_value_sf, fc_value, fc_value_sf, ds_value, ds_value_sf,
             adp_fp_dyn, adp_fp_dyn_sf, adp_sl_dyn, adp_sl_dyn_sf
      FROM players
    `).all();

    const dyn1qb = dynastyRanks(rows, '1QB');
    const dynSf = dynastyRanks(rows, '2QB');

    const update = db.prepare(`
      UPDATE players SET adp_consensus = @consensus,
                         dyn_rank_consensus = @dyn,
                         dyn_rank_consensus_sf = @dynSf
      WHERE id = @id
    `);

    db.transaction(() => {
      for (const r of rows) {
        update.run({
          id: r.id,
          // Stored as the best-ball 1QB baseline; the trend arrows compare against it.
          consensus: adpConsensus(r, 'BB', '1QB'),
          dyn: dyn1qb.get(r.id) ?? null,
          dynSf: dynSf.get(r.id) ?? null,
        });
      }
    })();
  } catch (err) {
    console.error('[recomputeDerived]', err.message);
  }
}

module.exports = router;
module.exports.recomputeDerived = recomputeDerived;
