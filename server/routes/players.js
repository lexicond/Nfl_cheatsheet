const express = require('express');
const router = express.Router();
const { db } = require('../db');

// Compute consensus ADP for the given format+leagueType from format-specific source columns
function computeFormatConsensus(r, format, leagueType) {
  const vals = [];
  if (format === 'DYN') return null;
  const isSF = leagueType === '2QB';
  if (format === 'BB' && !isSF) {
    // adp_sl_rd used for BB Sleeper — no separate BB URL exists for Sleeper
    [r.adp_fantasypros, r.adp_underdog, r.adp_sl_rd].forEach(v => v != null && vals.push(v));
  } else if (format === 'BB' && isSF) {
    [r.adp_fp_sf, r.adp_underdog, r.adp_sl_sf].forEach(v => v != null && vals.push(v));
  } else if (format === 'RD' && !isSF) {
    [r.adp_fp_rd, r.adp_ffc, r.adp_sl_rd].forEach(v => v != null && vals.push(v));
  } else {
    // RD SF
    [r.adp_fp_sf, r.adp_sl_sf].forEach(v => v != null && vals.push(v));
  }
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
}

// GET /api/players
router.get('/', (req, res) => {
  try {
    const {
      position,
      tier,
      starred,
      drafted,
      search,
      sort,
      leagueType = '1QB',
      format = 'BB',
    } = req.query;

    let conditions = [];
    let params = {};

    if (position) {
      const positions = position.split(',').map(p => p.trim().toUpperCase());
      conditions.push(`p.position IN (${positions.map((_, i) => `@pos${i}`).join(',')})`);
      positions.forEach((pos, i) => { params[`pos${i}`] = pos; });
    }

    if (tier) {
      conditions.push('o.tier = @tier');
      params.tier = parseInt(tier, 10);
    }

    if (starred === '1') {
      conditions.push('o.starred = 1');
    }

    if (drafted !== '1') {
      conditions.push('(o.drafted IS NULL OR o.drafted = 0)');
    }

    if (search) {
      conditions.push("p.name LIKE @search");
      params.search = `%${search}%`;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const SORT_COLS = {
      personal_rank:    'CASE WHEN o.personal_rank IS NULL THEN 1 ELSE 0 END, o.personal_rank',
      adp_consensus:    'CASE WHEN p.adp_consensus IS NULL THEN 1 ELSE 0 END, p.adp_consensus',
      adp_fantasypros:  'CASE WHEN p.adp_fantasypros IS NULL THEN 1 ELSE 0 END, p.adp_fantasypros',
      adp_underdog:     'CASE WHEN p.adp_underdog IS NULL THEN 1 ELSE 0 END, p.adp_underdog',
      adp_ffc:          'CASE WHEN p.adp_ffc IS NULL THEN 1 ELSE 0 END, p.adp_ffc',
      adp_fp_rd:        'CASE WHEN p.adp_fp_rd IS NULL THEN 1 ELSE 0 END, p.adp_fp_rd',
      adp_fp_sf:        'CASE WHEN p.adp_fp_sf IS NULL THEN 1 ELSE 0 END, p.adp_fp_sf',
      adp_sl_bb:        'CASE WHEN p.adp_sl_bb IS NULL THEN 1 ELSE 0 END, p.adp_sl_bb',
      adp_sl_rd:        'CASE WHEN p.adp_sl_rd IS NULL THEN 1 ELSE 0 END, p.adp_sl_rd',
      adp_sl_sf:        'CASE WHEN p.adp_sl_sf IS NULL THEN 1 ELSE 0 END, p.adp_sl_sf',
      projected_pts:    'CASE WHEN p.projected_pts IS NULL THEN 1 ELSE 0 END, p.projected_pts DESC',
      ktc_value:        'CASE WHEN p.ktc_value IS NULL THEN 1 ELSE 0 END, p.ktc_value DESC',
      fc_value:         'CASE WHEN p.fc_value IS NULL THEN 1 ELSE 0 END, p.fc_value DESC',
    };

    // Format-aware default sort (Sleeper for each ADP format, KTC for dynasty)
    const FORMAT_DEFAULT_SORT = { BB: 'adp_sl_bb', RD: 'adp_sl_rd', DYN: 'ktc_value' };
    const effectiveSort = sort || FORMAT_DEFAULT_SORT[format] || 'adp_sl_bb';
    const orderBy = SORT_COLS[effectiveSort] || SORT_COLS.adp_sl_bb;

    const query = `
      SELECT
        p.id,
        p.name,
        p.position,
        p.nfl_team,
        p.bye_week,
        p.adp_fantasypros,
        p.adp_underdog,
        p.adp_ffc,
        p.adp_fp_rd,
        p.adp_fp_sf,
        p.adp_sl_bb,
        p.adp_sl_rd,
        p.adp_sl_sf,
        p.adp_consensus,
        p.adp_consensus_prev,
        p.pos_rank_fantasypros,
        p.pos_rank_underdog,
        p.projected_pts,
        p.ktc_value,
        p.ktc_value_sf,
        p.fc_value,
        p.fc_value_sf,
        p.last_updated,
        o.personal_rank,
        o.tier,
        CASE WHEN o.starred = 1 THEN 1 ELSE 0 END AS starred,
        CASE WHEN o.flagged = 1 THEN 1 ELSE 0 END AS flagged,
        CASE WHEN o.drafted = 1 THEN 1 ELSE 0 END AS drafted,
        o.note_upside,
        o.note_downside,
        o.note_sources,
        o.note_personal,
        CASE WHEN p.projected_pts IS NOT NULL THEN (
          SELECT COUNT(*) + 1
          FROM players p2
          WHERE p2.position = p.position
            AND p2.projected_pts > p.projected_pts
            AND p2.projected_pts IS NOT NULL
        ) ELSE NULL END AS proj_pos_rank
      FROM players p
      LEFT JOIN player_overrides o ON o.player_id = p.id
      ${whereClause}
      ORDER BY
        CASE WHEN o.drafted = 1 THEN 1 ELSE 0 END,
        ${orderBy}
    `;

    const rows = db.prepare(query).all(params);
    const useSF = leagueType === '2QB';

    const result = rows.map((r) => {
      const formatConsensus = computeFormatConsensus(r, format, leagueType);

      // Trend uses stored adp_consensus (BB 1QB baseline) for movement indication
      const adpTrend = (r.adp_consensus_prev != null && r.adp_consensus != null)
        ? Math.round((r.adp_consensus_prev - r.adp_consensus) * 10) / 10
        : null;

      let valueScore = null;
      if (r.proj_pos_rank != null && formatConsensus != null) {
        valueScore = Math.round(formatConsensus) - r.proj_pos_rank;
      }

      let tier_auto = null;
      if (formatConsensus != null) {
        const adp = formatConsensus;
        if (adp <= 5) tier_auto = 1;
        else if (adp <= 18) tier_auto = 2;
        else if (adp <= 36) tier_auto = 3;
        else if (adp <= 72) tier_auto = 4;
        else tier_auto = 5;
      }

      const ktcValue = useSF ? (r.ktc_value_sf || r.ktc_value) : r.ktc_value;
      const fcValue  = useSF ? (r.fc_value_sf  || r.fc_value)  : r.fc_value;

      // Count sources that contributed to this format's consensus
      const sourcesUsed = [];
      if (format === 'BB' && !useSF) {
        [r.adp_fantasypros, r.adp_underdog, r.adp_sl_rd].forEach(v => v != null && sourcesUsed.push(v));
      } else if (format === 'BB' && useSF) {
        [r.adp_fp_sf, r.adp_underdog, r.adp_sl_sf].forEach(v => v != null && sourcesUsed.push(v));
      } else if (format === 'RD' && !useSF) {
        [r.adp_fp_rd, r.adp_ffc, r.adp_sl_rd].forEach(v => v != null && sourcesUsed.push(v));
      } else if (format === 'RD' && useSF) {
        [r.adp_fp_sf, r.adp_sl_sf].forEach(v => v != null && sourcesUsed.push(v));
      }

      return {
        ...r,
        starred: r.starred === 1,
        flagged: r.flagged === 1,
        drafted: r.drafted === 1,
        ktc_value: ktcValue,
        fc_value: fcValue,
        adp_consensus: formatConsensus,
        adp_source_count: sourcesUsed.length,
        adp_trend: adpTrend,
        value_score: valueScore,
        tier_auto,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[GET /api/players]', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/players/:id/override
router.patch('/:id/override', (req, res) => {
  try {
    const playerId = parseInt(req.params.id, 10);
    const allowed = ['personal_rank', 'tier', 'starred', 'flagged', 'drafted',
                     'note_upside', 'note_downside', 'note_sources', 'note_personal'];

    const updates = {};
    for (const key of allowed) {
      if (key in req.body) {
        let val = req.body[key];
        if (key === 'starred' || key === 'flagged' || key === 'drafted') {
          val = val ? 1 : 0;
        }
        updates[key] = val;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const player = db.prepare('SELECT id FROM players WHERE id = ?').get(playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const existing = db.prepare('SELECT player_id FROM player_overrides WHERE player_id = ?').get(playerId);

    if (existing) {
      const setClauses = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE player_overrides SET ${setClauses}, updated_at = datetime('now') WHERE player_id = @player_id`)
        .run({ ...updates, player_id: playerId });
    } else {
      const cols = ['player_id', ...Object.keys(updates)];
      const vals = cols.map(c => `@${c}`).join(', ');
      db.prepare(`INSERT INTO player_overrides (${cols.join(', ')}) VALUES (${vals})`)
        .run({ ...updates, player_id: playerId });
    }

    res.json({ success: true, player_id: playerId, updated: updates });
  } catch (err) {
    console.error('[PATCH /api/players/:id/override]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/players/:id/reorder
router.post('/:id/reorder', (req, res) => {
  try {
    const playerId = parseInt(req.params.id, 10);
    const newRank = parseInt(req.body.personal_rank, 10);

    if (!newRank || newRank < 1) {
      return res.status(400).json({ error: 'personal_rank must be a positive integer' });
    }

    const player = db.prepare('SELECT id FROM players WHERE id = ?').get(playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const reorder = db.transaction(() => {
      db.prepare(`
        UPDATE player_overrides
        SET personal_rank = personal_rank + 1
        WHERE personal_rank >= @newRank AND player_id != @playerId
      `).run({ newRank, playerId });

      const existing = db.prepare('SELECT player_id FROM player_overrides WHERE player_id = ?').get(playerId);
      if (existing) {
        db.prepare(`UPDATE player_overrides SET personal_rank = ?, updated_at = datetime('now') WHERE player_id = ?`)
          .run(newRank, playerId);
      } else {
        db.prepare(`INSERT INTO player_overrides (player_id, personal_rank) VALUES (?, ?)`)
          .run(playerId, newRank);
      }
    });

    reorder();
    res.json({ success: true, player_id: playerId, personal_rank: newRank });
  } catch (err) {
    console.error('[POST /api/players/:id/reorder]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
