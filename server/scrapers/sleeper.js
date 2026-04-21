const axios = require('axios');
const { db, computeConsensus } = require('../db');
const { normalizeName } = require('../utils/normalize');

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

// Compute 0.5 PPR points from projection stats
function calcHalfPprPts(proj) {
  if (!proj) return null;
  const pts =
    (proj.pass_yd || 0) * 0.04 +
    (proj.pass_td || 0) * 4 -
    (proj.pass_int || 0) * 2 +
    (proj.rush_yd || 0) * 0.1 +
    (proj.rush_td || 0) * 6 +
    (proj.rec || 0) * 0.5 +
    (proj.rec_yd || 0) * 0.1 +
    (proj.rec_td || 0) * 6;
  return pts > 0 ? Math.round(pts * 10) / 10 : null;
}

function buildNoteString(proj, position) {
  const pts = proj.pts_half_ppr != null
    ? proj.pts_half_ppr.toFixed(1)
    : (calcHalfPprPts(proj) || '?');
  const year = 2025;

  if (position === 'QB') {
    const passYd = Math.round(proj.pass_yd || 0).toLocaleString();
    const passTd = Math.round(proj.pass_td || 0);
    const passInt = Math.round(proj.pass_int || 0);
    const rushYd = Math.round(proj.rush_yd || 0);
    const rushTd = Math.round(proj.rush_td || 0);
    return `Sleeper ${year}: ${pts}pts | Pass: ${passYd}yds/${passTd}td/${passInt}int | Rush: ${rushYd}yds/${rushTd}td`;
  }
  if (position === 'RB') {
    const rushAtt = Math.round(proj.rush_att || 0);
    const rushYd = Math.round(proj.rush_yd || 0).toLocaleString();
    const rushTd = Math.round(proj.rush_td || 0);
    const rec = Math.round(proj.rec || 0);
    const recYd = Math.round(proj.rec_yd || 0).toLocaleString();
    const recTd = Math.round(proj.rec_td || 0);
    return `Sleeper ${year}: ${pts}pts | Rush: ${rushAtt}att/${rushYd}yds/${rushTd}td | Rec: ${rec}/${recYd}yds/${recTd}td`;
  }
  if (position === 'WR' || position === 'TE') {
    const rec = Math.round(proj.rec || 0);
    const recYd = Math.round(proj.rec_yd || 0).toLocaleString();
    const recTd = Math.round(proj.rec_td || 0);
    const rushYd = Math.round(proj.rush_yd || 0);
    const rushSuffix = rushYd > 15 ? ` | Rush: ${rushYd}yds` : '';
    return `Sleeper ${year}: ${pts}pts | Rec: ${rec}/${recYd}yds/${recTd}td${rushSuffix}`;
  }
  return `Sleeper ${year}: ${pts}pts`;
}

async function fetchSleeper() {
  const upsertPlayer = db.prepare(`
    INSERT INTO players (name, position, nfl_team, adp_sleeper, pos_rank_sleeper, adp_consensus, sleeper_player_id, last_updated)
    VALUES (@name, @position, @nfl_team, @adp_sleeper, @pos_rank_sleeper, @adp_consensus, @sleeper_player_id, @last_updated)
    ON CONFLICT DO NOTHING
  `);

  const updatePlayer = db.prepare(`
    UPDATE players
    SET nfl_team = COALESCE(@nfl_team, nfl_team),
        adp_sleeper = @adp_sleeper,
        pos_rank_sleeper = @pos_rank_sleeper,
        adp_consensus = @adp_consensus,
        sleeper_player_id = @sleeper_player_id,
        last_updated = @last_updated
    WHERE name = @name AND position = @position
  `);

  const getPlayer = db.prepare(`SELECT * FROM players WHERE name = ? AND position = ?`);
  const getPlayerById = db.prepare(`SELECT id, position FROM players WHERE sleeper_player_id = ?`);

  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ? WHERE source = 'sleeper'
  `);

  const updateProjectedPts = db.prepare(`
    UPDATE players SET projected_pts = ? WHERE id = ?
  `);

  // Auto-populate note_sources for players with no notes yet
  const upsertNote = db.prepare(`
    INSERT INTO player_overrides (player_id, note_sources, updated_at)
    VALUES (@player_id, @note_sources, datetime('now'))
    ON CONFLICT(player_id) DO UPDATE SET
      note_sources = CASE
        WHEN player_overrides.note_sources IS NULL OR player_overrides.note_sources = ''
        THEN excluded.note_sources
        ELSE player_overrides.note_sources
      END,
      updated_at = CASE
        WHEN player_overrides.note_sources IS NULL OR player_overrides.note_sources = ''
        THEN datetime('now')
        ELSE player_overrides.updated_at
      END
  `);

  try {
    // 1. Fetch all NFL players
    const playersRes = await axios.get('https://api.sleeper.app/v1/players/nfl', { timeout: 30000 });
    const allPlayers = playersRes.data;

    const skillPlayers = Object.values(allPlayers)
      .filter(p => p.active && POSITIONS.has(p.position) && p.search_rank && p.search_rank < 9999)
      .sort((a, b) => (a.search_rank || 9999) - (b.search_rank || 9999));

    const posRankCounters = {};
    const now = new Date().toISOString();

    const runUpserts = db.transaction(() => {
      let count = 0;
      for (const p of skillPlayers) {
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
        if (!name.trim()) continue;

        const position = p.position;
        posRankCounters[position] = (posRankCounters[position] || 0) + 1;
        const posRank = posRankCounters[position];
        const adpSleeper = p.search_rank < 9999 ? p.search_rank : null;

        const existing = getPlayer.get(name, position);
        const adpConsensus = computeConsensus(
          existing ? existing.adp_fantasypros : null,
          existing ? existing.adp_underdog : null,
          existing ? existing.adp_ffc : null,
        );

        const row = {
          name,
          position,
          nfl_team: p.team || null,
          adp_sleeper: adpSleeper,
          pos_rank_sleeper: posRank,
          adp_consensus: adpConsensus,
          sleeper_player_id: p.player_id || null,
          last_updated: now,
        };

        if (existing) {
          updatePlayer.run(row);
        } else {
          upsertPlayer.run(row);
        }
        count++;
      }
      return count;
    });

    const count = runUpserts();
    updateMeta.run(now, count, 'ok');
    console.log(`[Sleeper] Updated ${count} players`);

    // 2. Fetch season projections (best-effort, don't fail main result)
    try {
      const projRes = await axios.get('https://api.sleeper.app/v1/projections/nfl/2025/0', { timeout: 30000 });
      const projData = projRes.data;

      if (projData && typeof projData === 'object') {
        const updateProj = db.transaction(() => {
          let projCount = 0;
          for (const [playerId, proj] of Object.entries(projData)) {
            if (!proj) continue;
            const playerRow = getPlayerById.get(playerId);
            if (!playerRow) continue;

            const pts = proj.pts_half_ppr != null
              ? Math.round(proj.pts_half_ppr * 10) / 10
              : calcHalfPprPts(proj);

            if (pts != null && pts > 0) {
              updateProjectedPts.run(pts, playerRow.id);
              // Auto-populate note_sources with projection summary if empty
              const noteStr = buildNoteString(proj, playerRow.position);
              upsertNote.run({ player_id: playerRow.id, note_sources: noteStr });
              projCount++;
            }
          }
          return projCount;
        });

        const projCount = updateProj();
        console.log(`[Sleeper] Updated ${projCount} players with projections`);
      }
    } catch (projErr) {
      console.warn('[Sleeper] Projections fetch failed (non-fatal):', projErr.message);
    }

    return { success: true, players_updated: count, source: 'sleeper', timestamp: now };
  } catch (err) {
    const now = new Date().toISOString();
    updateMeta.run(now, 0, 'error');
    console.error('[Sleeper] Fetch failed:', err.message);
    return { success: false, error: err.message, source: 'sleeper', timestamp: now };
  }
}

module.exports = { fetchSleeper, normalizeName }; // normalizeName re-exported for backward compat
