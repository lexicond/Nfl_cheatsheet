const express = require('express');
const router = express.Router();
const { db } = require('../db');

// GET /api/players
router.get('/', (req, res) => {
  try {
    const {
      position,
      tier,
      starred,
      drafted,
      search,
      sort = 'adp_consensus',
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
      personal_rank:   'CASE WHEN o.personal_rank IS NULL THEN 1 ELSE 0 END, o.personal_rank',
      adp_consensus:   'CASE WHEN p.adp_consensus IS NULL THEN 1 ELSE 0 END, p.adp_consensus',
      adp_underdog:    'CASE WHEN p.adp_underdog IS NULL THEN 1 ELSE 0 END, p.adp_underdog',
      adp_fantasypros: 'CASE WHEN p.adp_fantasypros IS NULL THEN 1 ELSE 0 END, p.adp_fantasypros',
      adp_sleeper:     'CASE WHEN p.adp_sleeper IS NULL THEN 1 ELSE 0 END, p.adp_sleeper',
      adp_ffc:         'CASE WHEN p.adp_ffc IS NULL THEN 1 ELSE 0 END, p.adp_ffc',
      projected_pts:   'CASE WHEN p.projected_pts IS NULL THEN 1 ELSE 0 END, p.projected_pts DESC',
      ktc_value:       'CASE WHEN p.ktc_value IS NULL THEN 1 ELSE 0 END, p.ktc_value DESC',
      fc_value:        'CASE WHEN p.fc_value IS NULL THEN 1 ELSE 0 END, p.fc_value DESC',
    };
    const orderBy = SORT_COLS[sort] || SORT_COLS.adp_consensus;

    const query = `
      SELECT
        p.id,
        p.name,
        p.position,
        p.nfl_team,
        p.bye_week,
        p.adp_fantasypros,
        p.adp_underdog,
        p.adp_sleeper,
        p.adp_ffc,
        p.adp_consensus,
        p.adp_consensus_prev,
        p.pos_rank_fantasypros,
        p.pos_rank_underdog,
        p.pos_rank_sleeper,
        p.projected_pts,
        p.ktc_value,
        p.fc_value,
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
        -- Positional projected rank (global, not filtered subset)
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

    // Compute adp_trend and value_score (vs positional projected rank) in JS
    // adp_trend: positive = ADP went down (player rising in draft boards)
    const result = rows.map((r, idx) => {
      const adpTrend = (r.adp_consensus_prev != null && r.adp_consensus != null)
        ? Math.round((r.adp_consensus_prev - r.adp_consensus) * 10) / 10
        : null;

      // value_score: how many picks later vs projection says (positive = VALUE, draft later than projected)
      // adp_rank = position in sorted result (idx+1), proj_pos_rank = positional rank by proj_pts
      // overall_adp_rank is the list position here (within filtered set, imperfect but useful for display)
      let valueScore = null;
      if (r.proj_pos_rank != null && r.adp_consensus != null) {
        // Use overall consensus rank position from the full (unfiltered) list
        const overallAdpRank = Math.round(r.adp_consensus);
        valueScore = overallAdpRank - r.proj_pos_rank;
      }

      return {
        ...r,
        starred: r.starred === 1,
        flagged: r.flagged === 1,
        drafted: r.drafted === 1,
        adp_source_count: [r.adp_fantasypros, r.adp_underdog, r.adp_sleeper, r.adp_ffc].filter(v => v != null).length,
        adp_trend: adpTrend,
        value_score: valueScore,
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
