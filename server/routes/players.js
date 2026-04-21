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

    // Default: hide drafted (drafted=0 means hide drafted rows)
    if (drafted !== '1') {
      conditions.push('(o.drafted IS NULL OR o.drafted = 0)');
    }

    if (search) {
      conditions.push("p.name LIKE @search");
      params.search = `%${search}%`;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Sort logic
    const SORT_COLS = {
      personal_rank: 'CASE WHEN o.personal_rank IS NULL THEN 1 ELSE 0 END, o.personal_rank',
      adp_consensus: 'CASE WHEN p.adp_consensus IS NULL THEN 1 ELSE 0 END, p.adp_consensus',
      adp_underdog: 'CASE WHEN p.adp_underdog IS NULL THEN 1 ELSE 0 END, p.adp_underdog',
      adp_fantasypros: 'CASE WHEN p.adp_fantasypros IS NULL THEN 1 ELSE 0 END, p.adp_fantasypros',
      adp_sleeper: 'CASE WHEN p.adp_sleeper IS NULL THEN 1 ELSE 0 END, p.adp_sleeper',
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
        p.adp_consensus,
        p.pos_rank_fantasypros,
        p.pos_rank_underdog,
        p.pos_rank_sleeper,
        p.last_updated,
        o.personal_rank,
        o.tier,
        CASE WHEN o.starred = 1 THEN 1 ELSE 0 END AS starred,
        CASE WHEN o.flagged = 1 THEN 1 ELSE 0 END AS flagged,
        CASE WHEN o.drafted = 1 THEN 1 ELSE 0 END AS drafted,
        o.note_upside,
        o.note_downside,
        o.note_sources,
        o.note_personal
      FROM players p
      LEFT JOIN player_overrides o ON o.player_id = p.id
      ${whereClause}
      ORDER BY
        CASE WHEN o.drafted = 1 THEN 1 ELSE 0 END,
        ${orderBy}
    `;

    const stmt = db.prepare(query);
    const rows = stmt.all(params);

    // Count contributing ADP sources for tooltip
    const result = rows.map(r => ({
      ...r,
      starred: r.starred === 1,
      flagged: r.flagged === 1,
      drafted: r.drafted === 1,
      adp_source_count: [r.adp_fantasypros, r.adp_underdog, r.adp_sleeper].filter(v => v != null).length,
    }));

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
        // Coerce booleans to 0/1 for SQLite
        if (key === 'starred' || key === 'flagged' || key === 'drafted') {
          val = val ? 1 : 0;
        }
        updates[key] = val;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Check player exists
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
      // Shift all players at >= newRank up by 1
      db.prepare(`
        UPDATE player_overrides
        SET personal_rank = personal_rank + 1
        WHERE personal_rank >= @newRank AND player_id != @playerId
      `).run({ newRank, playerId });

      // Upsert the target player's rank
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
