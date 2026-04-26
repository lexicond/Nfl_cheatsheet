const express = require('express');
const router = express.Router();
const { db } = require('../db');

const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// GET /api/health
router.get('/', (req, res) => {
  try {
    const sources = db.prepare('SELECT * FROM source_metadata').all();
    const playerCount = db.prepare('SELECT COUNT(*) as c FROM players').get().c;
    const projCount = db.prepare('SELECT COUNT(*) as c FROM players WHERE projected_pts IS NOT NULL').get().c;
    const ktcCount = db.prepare('SELECT COUNT(*) as c FROM players WHERE ktc_value IS NOT NULL').get().c;
    const normCount = db.prepare('SELECT COUNT(*) as c FROM players WHERE name_normalized IS NOT NULL').get().c;

    // Top-20 consensus consistency check
    const top20 = db.prepare(`
      SELECT p.name, p.position, p.adp_consensus, p.adp_fantasypros, p.adp_underdog, p.adp_ffc
      FROM players p WHERE p.adp_consensus IS NOT NULL
      ORDER BY p.adp_consensus LIMIT 20
    `).all();

    const consistencyMismatches = top20.filter(p => {
      const sources = [p.adp_fantasypros, p.adp_underdog, p.adp_ffc].filter(v => v != null);
      if (sources.length < 2) return false;
      return sources.some(v => Math.abs(v - p.adp_consensus) > 20);
    });

    let overallStatus = 'ok';
    const sourceDetails = {};

    for (const s of sources) {
      const isStale = s.last_fetched
        ? (Date.now() - new Date(s.last_fetched).getTime()) > STALE_MS
        : true;
      const detail = {
        status: s.status || 'never',
        last_fetched: s.last_fetched,
        player_count: s.player_count,
        stale: isStale,
      };
      if (s.notes) detail.notes = s.notes;
      sourceDetails[s.source] = detail;
      if (s.status === 'error' || isStale) overallStatus = 'degraded';
    }

    res.json({
      status: overallStatus,
      player_count: playerCount,
      name_normalized_coverage: playerCount > 0 ? (normCount / playerCount).toFixed(2) : '0.00',
      projected_pts_coverage: playerCount > 0 ? (projCount / playerCount).toFixed(2) : '0.00',
      ktc_value_coverage: playerCount > 0 ? (ktcCount / playerCount).toFixed(2) : '0.00',
      top20_consistency_mismatches: consistencyMismatches.map(p => p.name),
      sources: sourceDetails,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
