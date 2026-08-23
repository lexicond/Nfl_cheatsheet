const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { viewSources, sleeperBaseline, COLUMNS, FIELD_ALIAS } = require('../sources');
const { applyConsensus, activeColumns, parseExcluded } = require('../consensus');
const { replacementLevels } = require('../model/combine');

const FORMATS = new Set(['BB', 'RD', 'DYN']);
const LEAGUE_TYPES = new Set(['1QB', '2QB']);
const TEAM_SIZES = [8, 10, 12, 14];

// Sort keys the client may ask for, mapped to how the value is read off a row.
// Sorting happens in JS because the headline number (consensus, dynasty rank) is
// derived per request from the format, and does not exist as a column.
// Sort keys. Every source column is sortable by name, so the client can offer exactly
// the sources currently switched on without this list needing to know about them.
const DERIVED_SORTS = {
  personal_rank: { get: r => r.personal_rank, dir: 'asc' },
  adp_consensus: { get: r => r.adp_consensus, dir: 'asc' },
  projected_pts: { get: r => r.projected_pts, dir: 'desc' },
  xfp_points:    { get: r => r.xfp_points, dir: 'desc' },
  xfp_vor:       { get: r => r.xfp_vor, dir: 'desc' },
  xfp_ceiling:   { get: r => r.xfp_ceiling, dir: 'desc' },
  xfp_edge:      { get: r => r.xfp_edge, dir: 'desc' },
  age:           { get: r => r.age, dir: 'asc' },
  spread:        { get: r => r.spread, dir: 'desc' },
  sleeper_gap:   { get: r => r.sleeper_gap, dir: 'desc' },
};

/**
 * Resolve a requested sort key.
 *
 * A source column only sorts if it is actually live in this view — otherwise the board
 * would silently stay ordered by a source the user has switched off and can no longer
 * see, while the dropdown shows something else entirely.
 */
function sortSpec(key, allowedColumns) {
  if (DERIVED_SORTS[key]) return DERIVED_SORTS[key];
  const col = COLUMNS[key];
  if (!col || !allowedColumns.includes(key)) return null;
  // A source column: values count down from the best (trade values) or up (ADP, ranks).
  const field = FIELD_ALIAS[key] || key;
  return { get: r => r[field], dir: col.kind === 'value' ? 'desc' : 'asc' };
}

// Every format defaults to its own headline number rather than a single source, so the
// board is never ordered by a column that format does not populate.
const DEFAULT_SORT = { BB: 'adp_consensus', RD: 'adp_consensus', DYN: 'adp_consensus' };

// Any one of these means a source has an opinion about the player.
const SIGNAL_COLUMNS = [
  'adp_underdog', 'adp_fantasypros', 'adp_ffc', 'adp_ffc_sf',
  'adp_fp_rd', 'adp_fp_sf', 'adp_fp_dyn', 'adp_fp_dyn_sf',
  'adp_sl_rd', 'adp_sl_sf', 'adp_sl_dyn', 'adp_sl_dyn_sf',
  'adp_espn', 'adp_yahoo',
  'ktc_value', 'ktc_value_sf', 'fc_value', 'fc_value_sf',
  'ds_value', 'ds_value_sf', 'dp_value', 'dp_value_sf',
  'projected_pts', 'xfp_points',
];

// Tier boundaries in rounds rather than picks, so they follow the league size.
const TIER_ROUNDS = [0.5, 1.5, 3, 6];

function tierForPick(pick, teamSize) {
  if (pick == null) return null;
  const round = pick / teamSize;
  for (let i = 0; i < TIER_ROUNDS.length; i++) {
    if (round <= TIER_ROUNDS[i]) return i + 1;
  }
  return 5;
}

// GET /api/players
router.get('/', (req, res) => {
  try {
    const { position, tier, starred, drafted, search, sort } = req.query;
    // Sources the user has switched off. They are dropped from the average, not just
    // hidden, so the headline number always matches the sources shown as feeding it.
    const excluded = parseExcluded(req.query.exclude);
    // Round numbers and tier bands depend on how many teams are in the league.
    const teamSize = TEAM_SIZES.includes(Number(req.query.teamSize)) ? Number(req.query.teamSize) : 12;
    const format = FORMATS.has(req.query.format) ? req.query.format : 'BB';
    const leagueType = LEAGUE_TYPES.has(req.query.leagueType) ? req.query.leagueType : '1QB';
    const isSF = leagueType === '2QB';

    // The whole table is read every time (a few thousand rows) so that positional
    // ranks are computed over every player, not just the ones passing the filters —
    // otherwise hiding drafted players would silently renumber everyone below them.
    //
    // A live Sleeper draft, when one is connected, takes players off the board through
    // the same route as the manual tick. The two stay separate columns: `drafted` is
    // what you marked by hand, `draft_pick_no` is what the draft room did, and
    // disconnecting clears the second without touching the first.
    //
    // The MIN(pick_no) join keeps one row per player even if a draft ever reports him
    // twice (a keeper listed alongside his pick) — a duplicate row here would show the
    // player twice on the board and skew every positional rank computed below.
    const rows = db.prepare(`
      SELECT
        p.*,
        o.personal_rank,
        o.tier,
        CASE WHEN o.starred = 1 THEN 1 ELSE 0 END AS starred,
        CASE WHEN o.flagged = 1 THEN 1 ELSE 0 END AS flagged,
        CASE WHEN o.drafted = 1 THEN 1 ELSE 0 END AS drafted_manual,
        o.note_upside, o.note_downside, o.note_sources, o.note_personal,
        d.pick_no AS draft_pick_no,
        d.round AS draft_round,
        d.draft_slot AS draft_slot
      FROM players p
      LEFT JOIN player_overrides o ON o.player_id = p.id
      LEFT JOIN draft_picks d ON d.player_id = p.id AND d.pick_no = (
        SELECT MIN(x.pick_no) FROM draft_picks x WHERE x.player_id = p.id
      )
    `).all();

    // Who owns each draft slot, resolved once rather than per player.
    const draftSession = db.prepare('SELECT * FROM draft_sync WHERE id = 1').get() || null;
    const slotNames = new Map();
    if (draftSession) {
      const parse = (json) => {
        try {
          return json ? JSON.parse(json) : {};
        } catch {
          return {};
        }
      };
      const teamNames = parse(draftSession.team_names);
      const draftOrder = parse(draftSession.draft_order);
      for (const [uid, slot] of Object.entries(draftOrder)) {
        if (teamNames[uid]) slotNames.set(slot, teamNames[uid]);
      }
    }
    // Mock drafts have no league behind them and so no team names — the slot stands in.
    const teamForSlot = (slot) => (slot ? slotNames.get(slot) || `Slot ${slot}` : null);

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

      const takenLive = r.draft_pick_no != null;

      return {
        ...r,
        starred: r.starred === 1,
        flagged: r.flagged === 1,
        drafted_manual: r.drafted_manual === 1,
        // One flag for "off the board", however he got there: the sink-to-bottom sort,
        // the Hide Drafted filter and the strikethrough all read this.
        drafted: r.drafted_manual === 1 || takenLive,
        drafted_by: takenLive ? teamForSlot(r.draft_slot) : null,
        drafted_by_me: takenLive && draftSession != null
          && draftSession.my_slot != null && r.draft_slot === draftSession.my_slot,
        ktc_value: isSF ? (r.ktc_value_sf ?? r.ktc_value) : r.ktc_value,
        fc_value: isSF ? (r.fc_value_sf ?? r.fc_value) : r.fc_value,
        ds_value: isSF ? (r.ds_value_sf ?? r.ds_value) : r.ds_value,
        dp_value: isSF ? (r.dp_value_sf ?? r.dp_value) : r.dp_value,
        adp_fp_dyn: isSF ? r.adp_fp_dyn_sf : r.adp_fp_dyn,
        adp_sl_dyn: isSF ? r.adp_sl_dyn_sf : r.adp_sl_dyn,
        adp_consensus: headline,
        adp_source_count: sourceCount,
        adp_trend: adpTrend,
        // Dynasty's headline is already a rank, so it needs no pick-to-round mapping.
        round: headline != null && format !== 'DYN' ? Math.ceil(headline / teamSize) : null,
        tier_auto: tierForPick(headline, teamSize),
      };
    });

    // How this player sits on Sleeper against the consensus. Sleeper is where the
    // drafting happens, so the useful question is whether he comes cheaper there.
    // Computed from Sleeper's own board whether or not Sleeper feeds the consensus.
    const baseline = sleeperBaseline(format, leagueType);
    let sleeperNorms = null;
    if (baseline) {
      const slRank = new Map();
      enriched
        .filter(p => p[baseline.column] != null)
        .sort((a, b) => a[baseline.column] - b[baseline.column])
        .forEach((p, i) => slRank.set(p.id, i + 1));

      const consensusRank = new Map();
      enriched
        .filter(p => p.adp_consensus != null)
        .sort((a, b) => a.adp_consensus - b.adp_consensus)
        .forEach((p, i) => consensusRank.set(p.id, i + 1));

      for (const p of enriched) {
        const sl = slRank.get(p.id);
        const cons = consensusRank.get(p.id);
        // Positive means Sleeper drafts him later than the consensus rates him, so he
        // can be had cheaper there.
        p.sleeper_gap = sl != null && cons != null ? sl - cons : null;
      }

      // Best ball has no Sleeper board, so the baseline is Sleeper's redraft ADP — and
      // best ball values positions differently, which puts a standing offset on whole
      // positions (quarterbacks read positive, tight ends negative, before any player
      // is genuinely cheap). The median offset per position is reported so the number
      // can be read against its own norm instead of against zero.
      const norms = {};
      for (const pos of ['QB', 'RB', 'WR', 'TE']) {
        const vals = enriched
          .filter(p => p.position === pos && p.sleeper_gap != null && p.adp_consensus != null
            && consensusRank.get(p.id) <= 150)
          .map(p => p.sleeper_gap)
          .sort((a, b) => a - b);
        norms[pos] = vals.length >= 8 ? vals[Math.floor(vals.length / 2)] : 0;
      }
      sleeperNorms = norms;
    } else {
      for (const p of enriched) p.sleeper_gap = null;
    }

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

    // The expected-points model's outputs that depend on the league rather than on the
    // player. Value over replacement cannot be stored alongside the projection because
    // it moves with league size and with superflex: the last startable quarterback in a
    // 12-team superflex league is a far worse player than in a 1QB league, so every
    // quarterback is worth more there. Recomputing it per request is what makes the
    // Superflex switch mean something for this column.
    rankWithin(enriched, p => p.xfp_points, 'desc', 'xfp_pos_rank');

    const xfpLevels = replacementLevels(
      enriched.filter(p => p.xfp_points != null).map(p => ({ position: p.position, points: p.xfp_points })),
      { teams: teamSize, leagueType },
    );
    for (const p of enriched) {
      p.xfp_vor = p.xfp_points != null
        ? Math.round((p.xfp_points - (xfpLevels[p.position] ?? 0)) * 10) / 10
        : null;
    }

    // ADP arbitrage, cross-position. value_score compares a player against his own
    // position; this compares where value over replacement puts him on the whole board
    // against where the market is drafting him — which is the question a pick actually
    // poses, since a pick is spent across positions, not within one.
    if (format !== 'DYN') {
      const vorRank = new Map();
      enriched
        .filter(p => p.xfp_vor != null)
        .sort((a, b) => b.xfp_vor - a.xfp_vor)
        .forEach((p, i) => vorRank.set(p.id, i + 1));

      const marketRank = new Map();
      enriched
        .filter(p => p.adp_consensus != null)
        .sort((a, b) => a.adp_consensus - b.adp_consensus)
        .forEach((p, i) => marketRank.set(p.id, i + 1));

      for (const p of enriched) {
        const v = vorRank.get(p.id);
        const m = marketRank.get(p.id);
        // Positive means the model ranks him higher than the market drafts him.
        p.xfp_edge = v != null && m != null ? m - v : null;
      }
    } else {
      for (const p of enriched) p.xfp_edge = null;
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
      // Filter on the tier the board actually shows him in: yours if you set one,
      // otherwise the automatic one. Matching only hand-set tiers meant the T1-T5
      // buttons emptied the board for anyone who had never set one by hand — which is
      // everyone, by default, while every row displays an automatic tier badge.
      if (tierFilter != null && Number.isFinite(tierFilter)
        && (p.tier ?? p.tier_auto) !== tierFilter) return false;
      if (starred === '1' && !p.starred) return false;
      if (drafted !== '1' && p.drafted) return false;
      if (needle && !p.name.toLowerCase().includes(needle)) return false;
      return true;
    });

    // Reference columns are displayed but not averaged; they are still sortable.
    const sortable = [
      ...activeColumns(format, leagueType, excluded),
      ...viewSources(format, leagueType).reference
        .filter(r => !excluded.has(r.family))
        .map(r => r.column),
    ];
    const resolved = sortSpec(sort, sortable);
    const effectiveSort = resolved ? sort : DEFAULT_SORT[format];
    const { get, dir } = resolved || DERIVED_SORTS[DEFAULT_SORT[format]];

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
      team_size: teamSize,
      // What the board was actually ordered by, so the client can correct a stale choice.
      sort: effectiveSort,
      sleeper_baseline: baseline ? { ...baseline, positional_norms: sleeperNorms } : null,
      // What each position's value-over-replacement is measured against, so the board
      // can explain a VOR number rather than just printing it.
      xfp_replacement: xfpLevels,
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
  'xfp_points', 'xfp_ppg', 'xfp_games', 'xfp_floor', 'xfp_ceiling', 'xfp_best_ball',
  'xfp_confidence', 'xfp_components', 'xfp_pos_rank', 'xfp_vor', 'xfp_edge',
  'ktc_value', 'fc_value', 'ds_value', 'dp_value', 'adp_fp_dyn', 'adp_sl_dyn',
  'age', 'fp_tier', 'tier_auto', 'round', 'spread', 'sleeper_gap',
  'ff_pos_rank', 'ff_points',
  'personal_rank', 'tier', 'starred', 'flagged', 'drafted', 'drafted_manual',
  'draft_pick_no', 'draft_round', 'drafted_by', 'drafted_by_me',
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
    group.sort((a, b) => {
      const diff = dir === 'desc'
        ? Number(valueOf(b)) - Number(valueOf(a))
        : Number(valueOf(a)) - Number(valueOf(b));
      // Ties break on name, exactly as the board does, so the row at the top of the
      // board is never shown as the second-ranked player at his position.
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
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
