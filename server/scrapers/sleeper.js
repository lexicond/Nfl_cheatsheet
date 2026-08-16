const axios = require('axios');
const { db } = require('../db');
const { normalizeName } = require('../utils/normalize');
const { scrapeDraftSharks } = require('../utils/draftsharks');

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const SEASON_YEAR = new Date().getFullYear();

// DraftSharks Sleeper ADP by format.
// No separate BB URL exists for Sleeper; adp/half-ppr/sleeper/12 is used for both BB and RD consensus.
const SLEEPER_ADP_SOURCES = [
  { url: 'https://www.draftsharks.com/adp/half-ppr/sleeper/12', column: 'adp_sl_rd', label: 'RD' },
  { url: 'https://www.draftsharks.com/adp/dynasty/superflex/ppr/sleeper/12', column: 'adp_sl_sf', label: 'SF/DYN' },
];

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

  if (position === 'QB') {
    const passYd = Math.round(proj.pass_yd || 0).toLocaleString();
    const passTd = Math.round(proj.pass_td || 0);
    const passInt = Math.round(proj.pass_int || 0);
    const rushYd = Math.round(proj.rush_yd || 0);
    const rushTd = Math.round(proj.rush_td || 0);
    return `Sleeper ${SEASON_YEAR}: ${pts}pts | Pass: ${passYd}yds/${passTd}td/${passInt}int | Rush: ${rushYd}yds/${rushTd}td`;
  }
  if (position === 'RB') {
    const rushAtt = Math.round(proj.rush_att || 0);
    const rushYd = Math.round(proj.rush_yd || 0).toLocaleString();
    const rushTd = Math.round(proj.rush_td || 0);
    const rec = Math.round(proj.rec || 0);
    const recYd = Math.round(proj.rec_yd || 0).toLocaleString();
    const recTd = Math.round(proj.rec_td || 0);
    return `Sleeper ${SEASON_YEAR}: ${pts}pts | Rush: ${rushAtt}att/${rushYd}yds/${rushTd}td | Rec: ${rec}/${recYd}yds/${recTd}td`;
  }
  if (position === 'WR' || position === 'TE') {
    const rec = Math.round(proj.rec || 0);
    const recYd = Math.round(proj.rec_yd || 0).toLocaleString();
    const recTd = Math.round(proj.rec_td || 0);
    const rushYd = Math.round(proj.rush_yd || 0);
    const rushSuffix = rushYd > 15 ? ` | Rush: ${rushYd}yds` : '';
    return `Sleeper ${SEASON_YEAR}: ${pts}pts | Rec: ${rec}/${recYd}yds/${recTd}td${rushSuffix}`;
  }
  return `Sleeper ${SEASON_YEAR}: ${pts}pts`;
}

async function fetchSleeper() {
  const upsertPlayer = db.prepare(`
    INSERT INTO players (name, position, nfl_team, sleeper_player_id, last_updated)
    VALUES (@name, @position, @nfl_team, @sleeper_player_id, @last_updated)
    ON CONFLICT DO NOTHING
  `);
  const updatePlayer = db.prepare(`
    UPDATE players
    SET nfl_team = COALESCE(@nfl_team, nfl_team),
        sleeper_player_id = @sleeper_player_id,
        last_updated = @last_updated
    WHERE id = @id
  `);
  const getPlayer = db.prepare(`SELECT * FROM players WHERE name = ? AND position = ?`);
  const getByNorm = db.prepare(`SELECT * FROM players WHERE name_normalized = ? AND position = ?`);
  const getPlayerById = db.prepare(`SELECT id, position FROM players WHERE sleeper_player_id = ?`);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ? WHERE source = 'sleeper'
  `);
  const updateProjectedPts = db.prepare(`UPDATE players SET projected_pts = ? WHERE id = ?`);
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

  function findExisting(name, pos) {
    return getPlayer.get(name, pos) || getByNorm.get(normalizeName(name), pos) || null;
  }

  // --- Part 1: Sleeper API for player metadata + projections ---
  let playerCount = 0;
  const now = new Date().toISOString();

  try {
    const playersRes = await axios.get('https://api.sleeper.app/v1/players/nfl', { timeout: 30000 });
    const allPlayers = playersRes.data;

    const skillPlayers = Object.values(allPlayers)
      .filter(p => p.active && POSITIONS.has(p.position) && p.search_rank && p.search_rank < 9999)
      .sort((a, b) => (a.search_rank || 9999) - (b.search_rank || 9999));

    const runUpserts = db.transaction(() => {
      let count = 0;
      for (const p of skillPlayers) {
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
        if (!name.trim()) continue;

        const existing = findExisting(name, p.position);
        const row = {
          nfl_team: p.team || null,
          sleeper_player_id: p.player_id || null,
          last_updated: now,
        };

        if (existing) {
          updatePlayer.run({ ...row, id: existing.id });
        } else {
          upsertPlayer.run({ ...row, name, position: p.position });
        }
        count++;
      }
      return count;
    });

    playerCount = runUpserts();
    updateMeta.run(now, playerCount, 'ok');
    console.log(`[Sleeper] Updated ${playerCount} players (metadata)`);

    // Projections (best-effort)
    try {
      const projRes = await axios.get(`https://api.sleeper.app/v1/projections/nfl/${SEASON_YEAR}/0`, { timeout: 30000 });
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
              upsertNote.run({ player_id: playerRow.id, note_sources: buildNoteString(proj, playerRow.position) });
              projCount++;
            }
          }
          return projCount;
        });
        console.log(`[Sleeper] Updated ${updateProj()} players with projections`);
      }
    } catch (projErr) {
      console.warn('[Sleeper] Projections fetch failed (non-fatal):', projErr.message);
    }
  } catch (err) {
    updateMeta.run(now, 0, 'error');
    console.error('[Sleeper] API fetch failed:', err.message);
    return { success: false, error: err.message, source: 'sleeper', timestamp: now };
  }

  // --- Part 2: DraftSharks ADP by format (parallel) ---
  const adpResults = await Promise.allSettled(
    SLEEPER_ADP_SOURCES.map(src => scrapeDraftSharks(src.url).then(players => ({ ...src, players })))
  );

  const adpCounts = {};
  for (const result of adpResults) {
    if (result.status === 'rejected') {
      console.warn(`[Sleeper] ADP scrape failed: ${result.reason?.message}`);
      continue;
    }
    const { column, label, players } = result.value;
    if (players.length === 0) {
      console.warn(`[Sleeper] ADP: no players from DraftSharks ${label}`);
      continue;
    }

    const updateAdp = db.prepare(`UPDATE players SET ${column} = @adp, last_updated = @ts WHERE id = @id`);
    const run = db.transaction(() => {
      let count = 0;
      players.forEach(p => {
        if (!p.name || !p.position) return;
        const existing = findExisting(p.name, p.position);
        if (!existing) return;
        updateAdp.run({ adp: p.adp, ts: now, id: existing.id });
        count++;
      });
      return count;
    });

    const count = run();
    adpCounts[label] = count;
    console.log(`[Sleeper] ADP ${label}: ${count} players → ${column}`);
  }

  return {
    success: true,
    players_updated: playerCount,
    adp_counts: adpCounts,
    source: 'sleeper',
    timestamp: now,
  };
}

module.exports = { fetchSleeper, normalizeName };
