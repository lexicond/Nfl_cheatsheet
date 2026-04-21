const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { fetchSleeper } = require('../scrapers/sleeper');
const { fetchFantasyPros } = require('../scrapers/fantasypros');
const { fetchUnderdog } = require('../scrapers/underdog');

// POST /api/refresh/:source
router.post('/:source', async (req, res) => {
  const { source } = req.params;
  const valid = ['fantasypros', 'underdog', 'sleeper', 'all'];

  if (!valid.includes(source)) {
    return res.status(400).json({ error: `Unknown source. Use: ${valid.join(', ')}` });
  }

  try {
    if (source === 'all') {
      const [fp, ud, sl] = await Promise.allSettled([
        fetchFantasyPros(),
        fetchUnderdog(),
        fetchSleeper(),
      ]);

      const results = {
        fantasypros: fp.status === 'fulfilled' ? fp.value : { success: false, error: fp.reason?.message },
        underdog: ud.status === 'fulfilled' ? ud.value : { success: false, error: ud.reason?.message },
        sleeper: sl.status === 'fulfilled' ? sl.value : { success: false, error: sl.reason?.message },
      };

      // Recompute all consensus values after all sources updated
      recomputeAllConsensus();

      return res.json({ success: true, source: 'all', results, timestamp: new Date().toISOString() });
    }

    let result;
    if (source === 'fantasypros') result = await fetchFantasyPros();
    else if (source === 'underdog') result = await fetchUnderdog();
    else if (source === 'sleeper') result = await fetchSleeper();

    // Recompute consensus after single source update
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
          SELECT adp_sleeper WHERE adp_sleeper IS NOT NULL
        )
      )
    `).run();
  } catch (err) {
    console.error('[recomputeAllConsensus]', err.message);
  }
}

module.exports = router;
