const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { viewSources } = require('../sources');
const { applyConsensus, activeColumns, parseExcluded } = require('../consensus');

const FORMATS = new Set(['BB', 'RD', 'DYN']);
const LEAGUE_TYPES = new Set(['1QB', '2QB']);

// Sort keys the client may ask for, mapped to how the value is read off a row.
// Sorting happens in JS because the headline number (consensus, dynasty rank) is
// derived per request from the format, and does not exist as a column.
const SORT_KEYS = {
  personal_rank:   { get: r => r.personal_rank, dir: 'asc' },
  adp_consensus:   { get: r => r.adp_consensus, dir: 'asc' },
  adp_fantasypros: { get: r => r.adp_fantasypros, dir: 'asc' },
  adp_underdog:    { get: r => r.adp_underdog, dir: 'asc' },
  adp_ffc:         { get: r => r.adp_ffc, dir: 'asc' },
  adp_ffc_sf:      { get: r => r.adp_ffc_sf, dir: 'asc' },
  adp_fp_rd:       { get: r => r.adp_fp_rd, dir: 'asc' },
  adp_fp_sf:       { get: r => r.adp_fp_sf, dir: 'asc' },
  adp_fp_dyn:      { get: r => r.adp_fp_dyn, dir: 'asc' },
  adp_sl_rd:       { get: r => r.adp_sl_rd, dir: 'asc' },
  adp_sl_sf:       { get: r => r.adp_sl_sf, dir: 'asc' },
  adp_espn:        { get: r => r.adp_espn, dir: 'asc' },
  adp_yahoo:       { get: r => r.adp_yahoo, dir: 'asc' },
  projected_pts:   { get: r => r.projected_pts, dir: 'desc' },
  ktc_value:       { get: r => r.ktc_value, dir: 'desc' },
  fc_value:        { get: r => r.fc_value, dir: 'desc' },
  ds_value:        { get: r => r.ds_value, dir: 'desc' },
  dp_value:        { get: r => r.dp_value, dir: 'desc' },
  adp_fp_dyn_sf:   { get: r => r.adp_fp_dyn_sf, dir: 'asc' },
  adp_sl_dyn:      { get: r => r.adp_sl_dyn, dir: 'asc' },
  age:             { get: r => r.age, dir: 'asc' },
};

// Every format defaults to its own headline number rather than a single source,
// so the board is never ordered by a column that format does not populate.
const DEFAULT_SORT = { BB: 'adp_consensus', RD: 'adp_consensus', DYN: 'adp_consensus' };

// Any one of these means a source has an opinion about the player.
const SIGNAL_COLUMNS = [
  'adp_underdog', 'adp_fantasypros', 'adp_ffc', 'adp_ffc_sf',
  'adp_fp_rd', 'adp_fp_sf', 'adp_fp_dyn',
  'adp_sl_rd', 'adp_sl_sf', 'adp_sl_dyn', 'adp_sl_dyn_sf',
  'adp_espn', 'adp_yahoo',
  'ktc_value', 'ktc_value_sf', 'fc_value', 'fc_value_sf',
  'ds_value', 'ds_value_sf', 'dp_value', 'dp_value_sf',
  'projected_pts',
];

function tierFromAdp(adp) {
  if (adp == null) return null;
  if (adp <= 5) return 1;
  if (adp <= 18) return 2;
  if (adp <= 36) return 3;
  if (adp <= 72) return 4;
  return 5;
}

// GET /api/players
router.get('/', (req, res) => {
  try {
    const { position, tier, starred, drafted, search, sort } = req.query;
    // Sources the user has switched off. They are dropped from the average, not just
    // hidden, so the headline number always matches the sources shown as feeding it.
    const excluded = parseExcluded(req.query.exclude);
    const format = FORMATS.has(req.query.format) ? req.query.format : 'BB';
    const leagueType = LEAGUE_TYPES.has(req.query.leagueType) ? req.query.leagueType : '1QB';
    const isSF = leagueType === '2QB';

    // The whole table is read every time (a few thousand rows) so that positional
    // ranks are computed over every player, not just the ones passing the filters —
    // otherwise hiding drafted players would silently renumber everyone below them.
    const rows = db.prepare(`
      SELECT
        p.*,
        o.personal_rank,
        o.tier,
        CASE WHEN o.starred = 1 THEN 1 ELSE 0 END AS starred,
        CASE WHEN o.flagged = 1 THEN 1 ELSE 0 END AS flagged,
        CASE WHEN o.drafted = 1 THEN 1 ELSE 0 END AS drafted,
        o.note_upside, o.note_downside, o.note_sources, o.note_personal
      FROM players p
      LEFT JOIN player_overrides o ON o.player_id = p.id
    `).all();

    // Consensus is recomputed per request rather than read from the stored column,
    // because the user's exclusions change it.
    const withConsensus = applyConsensus(rows, format, leagueType, excluded);

    const enriched = withConsensus.map(r => {
      const headline = r.h;
      const sourceCount = r.sourceCount;

      // Trend compares against the stored best-ball baseline, the only series with
      // a saved previous value.
      const adpTrend = (r.adp_consensus_prev != null && r.adp_consensus != null)
        ? Math.round((r.adp_consensus_prev - r.adp_consensus) * 10) / 10
        : null;

      return {
        ...r,
        starred: r.starred === 1,
        flagged: r.flagged === 1,
        drafted: r.drafted === 1,
        ktc_value: isSF ? (r.ktc_value_sf ?? r.ktc_value) : r.ktc_value,
        fc_value: isSF ? (r.fc_value_sf ?? r.fc_value) : r.fc_value,
        ds_value: isSF ? (r.ds_value_sf ?? r.ds_value) : r.ds_value,
        dp_value: isSF ? (r.dp_value_sf ?? r.dp_value) : r.dp_value,
        adp_fp_dyn: isSF ? r.adp_fp_dyn_sf : r.adp_fp_dyn,
        adp_sl_dyn: isSF ? r.adp_sl_dyn_sf : r.adp_sl_dyn,
        adp_consensus: headline,
        adp_source_count: sourceCount,
        adp_trend: adpTrend,
        tier_auto: tierFromAdp(headline),
      };
    });

    // Positional ranks, computed over the full pool: where a player sits among his
    // position by this format's consensus, and by projected points.
    rankWithin(enriched, p => p.adp_consensus, 'asc', 'pos_rank_consensus');
    rankWithin(enriched, p => p.projected_pts, 'desc', 'proj_pos_rank');

    for (const p of enriched) {
      // Positive = the market is drafting him later than his projection says he ranks.
      p.value_score = (p.proj_pos_rank != null && p.pos_rank_consensus != null && format !== 'DYN')
        ? p.pos_rank_consensus - p.proj_pos_rank
        : null;
    }

    // Rows with no market, projection or dynasty signal and no user data are noise —
    // roughly a thousand deep-bench names that only lengthen the payload. The test
    // deliberately spans every source, not just the current format's, so switching
    // format never makes a player disappear from search.
    const relevant = enriched.filter(p =>
      SIGNAL_COLUMNS.some(c => p[c] != null) ||
      p.personal_rank != null || p.tier != null ||
      p.starred || p.flagged || p.drafted ||
      p.note_upside || p.note_downside || p.note_personal
    );

    const positions = position
      ? position.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      : [];
    const tierFilter = tier != null && tier !== '' ? parseInt(tier, 10) : null;
    const needle = search ? String(search).toLowerCase() : null;

    const result = relevant.filter(p => {
      if (positions.length > 0 && !positions.includes(p.position)) return false;
      if (tierFilter != null && Number.isFinite(tierFilter) && p.tier !== tierFilter) return false;
      if (starred === '1' && !p.starred) return false;
      if (drafted !== '1' && p.drafted) return false;
      if (needle && !p.name.toLowerCase().includes(needle)) return false;
      return true;
    });

    const sortKey = SORT_KEYS[sort] ? sort : DEFAULT_SORT[format];
    const { get, dir } = SORT_KEYS[sortKey];

    result.sort((a, b) => {
      // Drafted players always sink, whatever the sort.
      if (a.drafted !== b.drafted) return a.drafted ? 1 : -1;
      const av = get(a);
      const bv = get(b);
      // Unranked players sort last rather than jumbling in at the top.
      if (av == null && bv == null) return a.name.localeCompare(b.name);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return a.name.localeCompare(b.name);
      return dir === 'desc' ? bv - av : av - bv;
    });

    res.json({
      view: viewSources(format, leagueType),
      excluded: [...excluded],
      active_sources: activeColumns(format, leagueType, excluded),
      players: result.map(project),
    });
  } catch (err) {
    console.error('[GET /api/players]', err);
    res.status(500).json({ error: err.message });
  }
});

// Fields the board actually renders. Internal matching columns (name_normalized,
// sleeper ids, per-format duplicates the current view cannot show) stay server-side.
const RESPONSE_FIELDS = [
  'id', 'name', 'position', 'nfl_team', 'bye_week',
  'adp_fantasypros', 'adp_underdog', 'adp_ffc', 'adp_ffc_sf',
  'adp_fp_rd', 'adp_fp_sf', 'adp_fp_dyn',
  'adp_sl_rd', 'adp_sl_sf', 'adp_espn', 'adp_yahoo',
  'adp_consensus', 'adp_source_count', 'adp_trend',
  'projected_pts', 'proj_pos_rank', 'pos_rank_consensus', 'value_score',
  'ktc_value', 'fc_value', 'ds_value', 'dp_value', 'adp_fp_dyn', 'adp_sl_dyn',
  'age', 'fp_tier', 'tier_auto',
  'personal_rank', 'tier', 'starred', 'flagged', 'drafted',
  'note_upside', 'note_downside', 'note_sources', 'note_personal',
  'last_updated',
];

function project(p) {
  const out = {};
  for (const f of RESPONSE_FIELDS) out[f] = p[f] ?? null;
  return out;
}

// Assign 1-based ranks within each position, skipping players with no value.
function rankWithin(players, valueOf, dir, field) {
  const byPosition = new Map();
  for (const p of players) {
    p[field] = null;
    const v = valueOf(p);
    if (v == null || !Number.isFinite(Number(v))) continue;
    if (!byPosition.has(p.position)) byPosition.set(p.position, []);
    byPosition.get(p.position).push(p);
  }
  for (const group of byPosition.values()) {
    group.sort((a, b) => dir === 'desc'
      ? Number(valueOf(b)) - Number(valueOf(a))
      : Number(valueOf(a)) - Number(valueOf(b)));
    group.forEach((p, i) => { p[field] = i + 1; });
  }
}

// PATCH /api/players/:id/override
router.patch('/:id/override', (req, res) => {
  try {
    const playerId = parseInt(req.params.id, 10);
    if (!Number.isFinite(playerId)) return res.status(400).json({ error: 'Invalid player id' });

    const allowed = ['personal_rank', 'tier', 'starred', 'flagged', 'drafted',
                     'note_upside', 'note_downside', 'note_sources', 'note_personal'];

    const updates = {};
    for (const key of allowed) {
      if (!(key in req.body)) continue;
      let val = req.body[key];
      if (key === 'starred' || key === 'flagged' || key === 'drafted') val = val ? 1 : 0;
      else if (key === 'personal_rank' || key === 'tier') {
        // Clearing is legitimate; a non-numeric value is not.
        if (val === null || val === '') val = null;
        else {
          const n = parseInt(val, 10);
          if (!Number.isFinite(n)) return res.status(400).json({ error: `${key} must be a number or null` });
          val = n;
        }
      }
      updates[key] = val;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const player = db.prepare('SELECT id FROM players WHERE id = ?').get(playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const cols = Object.keys(updates);
    db.prepare(`
      INSERT INTO player_overrides (player_id, ${cols.join(', ')})
      VALUES (@player_id, ${cols.map(c => `@${c}`).join(', ')})
      ON CONFLICT(player_id) DO UPDATE SET
        ${cols.map(c => `${c} = excluded.${c}`).join(', ')},
        updated_at = datetime('now')
    `).run({ ...updates, player_id: playerId });

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

    if (!Number.isFinite(playerId)) return res.status(400).json({ error: 'Invalid player id' });
    if (!Number.isFinite(newRank) || newRank < 1) {
      return res.status(400).json({ error: 'personal_rank must be a positive integer' });
    }

    const player = db.prepare('SELECT id FROM players WHERE id = ?').get(playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    db.transaction(() => {
      // Free the slot before claiming it, and only shift ranks at or below it.
      db.prepare(`
        UPDATE player_overrides
        SET personal_rank = personal_rank + 1, updated_at = datetime('now')
        WHERE personal_rank IS NOT NULL AND personal_rank >= @newRank AND player_id != @playerId
      `).run({ newRank, playerId });

      db.prepare(`
        INSERT INTO player_overrides (player_id, personal_rank)
        VALUES (@playerId, @newRank)
        ON CONFLICT(player_id) DO UPDATE SET personal_rank = @newRank, updated_at = datetime('now')
      `).run({ playerId, newRank });
    })();

    res.json({ success: true, player_id: playerId, personal_rank: newRank });
  } catch (err) {
    console.error('[POST /api/players/:id/reorder]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
