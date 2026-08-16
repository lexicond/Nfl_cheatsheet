const express = require('express');
const router = express.Router();
const { db, computeConsensus } = require('../db');
const { fetchSleeper } = require('../scrapers/sleeper');
const { fetchFantasyPros } = require('../scrapers/fantasypros');
const { fetchUnderdog } = require('../scrapers/underdog');
const { fetchFFC } = require('../scrapers/ffc');
const { fetchKTC } = require('../scrapers/ktc');
const { fetchFantasyCalc } = require('../scrapers/fantasycalc');
const { fetchMarket } = require('../scrapers/market');

// Sleeper runs first on a full refresh: it owns the roster rows and the Sleeper
// ids the other sources match against.
const SCRAPERS = {
  sleeper: fetchSleeper,
  fantasypros: fetchFantasyPros,
  underdog: fetchUnderdog,
  ffc: fetchFFC,
  market: fetchMarket,
  ktc: fetchKTC,
  fantasycalc: fetchFantasyCalc,
};

// Dynasty sources publish on incompatible scales (KTC 0–10000, FantasyCalc trade
// value, FP/Sleeper draft position), so they are averaged as ranks, not raw values.
const DYNASTY_SOURCES = {
  '1QB': [
    { column: 'ktc_value', direction: 'desc' },
    { column: 'fc_value', direction: 'desc' },
    { column: 'adp_fp_dyn', direction: 'asc' },
    { column: 'adp_sl_dyn', direction: 'asc' },
  ],
  // FantasyPros publishes no superflex dynasty board, so its 1QB ranks are left out
  // here rather than quietly pushing quarterbacks down the superflex list.
  '2QB': [
    { column: 'ktc_value_sf', direction: 'desc' },
    { column: 'fc_value_sf', direction: 'desc' },
    { column: 'adp_sl_dyn_sf', direction: 'asc' },
  ],
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
             ktc_value, ktc_value_sf, fc_value, fc_value_sf,
             adp_fp_dyn, adp_sl_dyn, adp_sl_dyn_sf
      FROM players
    `).all();

    const dynRanks = { '1QB': new Map(), '2QB': new Map() };

    for (const [leagueType, sources] of Object.entries(DYNASTY_SOURCES)) {
      const perPlayer = new Map();
      for (const src of sources) {
        const ranked = rows
          .filter(r => r[src.column] != null && Number.isFinite(Number(r[src.column])))
          .sort((a, b) => src.direction === 'desc'
            ? Number(b[src.column]) - Number(a[src.column])
            : Number(a[src.column]) - Number(b[src.column]));
        ranked.forEach((r, i) => {
          if (!perPlayer.has(r.id)) perPlayer.set(r.id, []);
          perPlayer.get(r.id).push(i + 1);
        });
      }
      for (const [id, ranks] of perPlayer) {
        dynRanks[leagueType].set(id, Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 10) / 10);
      }
    }

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
          consensus: computeConsensus(r, 'BB', '1QB'),
          dyn: dynRanks['1QB'].get(r.id) ?? null,
          dynSf: dynRanks['2QB'].get(r.id) ?? null,
        });
      }
    })();
  } catch (err) {
    console.error('[recomputeDerived]', err.message);
  }
}

module.exports = router;
module.exports.recomputeDerived = recomputeDerived;
