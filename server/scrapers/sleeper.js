const { db } = require('../db');
const { get, JSON_HEADERS } = require('../utils/http');
const { normalizeName } = require('../utils/normalize');

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const SEASON_YEAR = new Date().getFullYear();

const PLAYERS_URL = 'https://api.sleeper.app/v1/players/nfl';
const PROJECTIONS_URL = `https://api.sleeper.app/projections/nfl/${SEASON_YEAR}` +
  '?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&order_by=pts_half_ppr';

// Sleeper reports "no ADP" as the sentinel 999 rather than null.
const ADP_SENTINEL = 999;
function cleanAdp(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= ADP_SENTINEL) return null;
  return Math.round(n * 10) / 10;
}

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

function buildNoteString(proj, position, pts) {
  const ptsStr = pts != null ? pts.toFixed(1) : '?';
  const r = n => Math.round(n || 0);
  if (position === 'QB') {
    return `Sleeper ${SEASON_YEAR} proj: ${ptsStr}pts | Pass ${r(proj.pass_yd).toLocaleString()}yds/${r(proj.pass_td)}td/${r(proj.pass_int)}int | Rush ${r(proj.rush_yd)}yds/${r(proj.rush_td)}td`;
  }
  if (position === 'RB') {
    return `Sleeper ${SEASON_YEAR} proj: ${ptsStr}pts | Rush ${r(proj.rush_att)}att/${r(proj.rush_yd).toLocaleString()}yds/${r(proj.rush_td)}td | Rec ${r(proj.rec)}/${r(proj.rec_yd).toLocaleString()}yds/${r(proj.rec_td)}td`;
  }
  const rushSuffix = r(proj.rush_yd) > 15 ? ` | Rush ${r(proj.rush_yd)}yds` : '';
  return `Sleeper ${SEASON_YEAR} proj: ${ptsStr}pts | Rec ${r(proj.rec)}/${r(proj.rec_yd).toLocaleString()}yds/${r(proj.rec_td)}td${rushSuffix}`;
}

async function fetchSleeper() {
  const now = new Date().toISOString();

  const insertPlayer = db.prepare(`
    INSERT INTO players (name, name_normalized, position, nfl_team, sleeper_player_id, last_updated)
    VALUES (@name, @name_normalized, @position, @nfl_team, @sleeper_player_id, @last_updated)
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'sleeper'
  `);
  const bySleeperId = db.prepare('SELECT id, position FROM players WHERE sleeper_player_id = ?');
  const byNorm = db.prepare('SELECT id FROM players WHERE name_normalized = ? AND position = ?');
  const linkSleeperId = db.prepare(`
    UPDATE players SET sleeper_player_id = @sid, nfl_team = COALESCE(@team, nfl_team), last_updated = @ts WHERE id = @id
  `);
  const updateStats = db.prepare(`
    UPDATE players
    SET projected_pts = @pts,
        adp_sl_rd = @adp_rd,
        adp_sl_sf = @adp_sf,
        adp_sl_dyn = @adp_dyn,
        adp_sl_dyn_sf = @adp_dyn_sf,
        last_updated = @ts
    WHERE id = @id
  `);
  const upsertNote = db.prepare(`
    INSERT INTO player_overrides (player_id, note_sources, updated_at)
    VALUES (@player_id, @note_sources, datetime('now'))
    ON CONFLICT(player_id) DO UPDATE SET
      note_sources = CASE
        WHEN player_overrides.note_sources IS NULL
          OR player_overrides.note_sources = ''
          OR player_overrides.note_sources LIKE 'Sleeper %'
        THEN excluded.note_sources
        ELSE player_overrides.note_sources
      END,
      updated_at = datetime('now')
  `);
  // Refreshes overwrite the auto-generated projection line (prefix "Sleeper ") so it
  // never goes stale, but anything the user typed into that field is left alone.

  // --- Roster: names, teams and the Sleeper id every other lookup keys off ---
  let rosterCount = 0;
  try {
    const res = await get(PLAYERS_URL, { headers: JSON_HEADERS, timeout: 45000 });
    const all = res.data && typeof res.data === 'object' ? Object.values(res.data) : [];
    const skill = all.filter(p =>
      p && p.active && POSITIONS.has(p.position) && p.search_rank && p.search_rank < 9999
    );

    rosterCount = db.transaction(() => {
      let count = 0;
      for (const p of skill) {
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
        if (!name) continue;
        const sid = p.player_id ? String(p.player_id) : null;
        const team = p.team ? String(p.team).toUpperCase() : null;

        const existing = (sid && bySleeperId.get(sid)) || byNorm.get(normalizeName(name), p.position);
        if (existing) {
          linkSleeperId.run({ id: existing.id, sid, team, ts: now });
        } else {
          insertPlayer.run({
            name,
            name_normalized: normalizeName(name),
            position: p.position,
            nfl_team: team,
            sleeper_player_id: sid,
            last_updated: now,
          });
        }
        count++;
      }
      return count;
    })();
    console.log(`[Sleeper] Roster: ${rosterCount} players`);
  } catch (err) {
    updateMeta.run(now, 0, 'error', `roster: ${err.message}`);
    console.error('[Sleeper] Roster fetch failed:', err.message);
    return { success: false, error: err.message, source: 'sleeper', timestamp: now };
  }

  // --- Projections + Sleeper's own per-format ADP ---
  // The /v1/projections/... path still responds 200 but returns empty objects, so
  // this uses the season endpoint that actually carries stats.
  let statCount = 0;
  const adpCounts = { rd: 0, sf: 0, dyn: 0 };
  try {
    const res = await get(PROJECTIONS_URL, { headers: JSON_HEADERS, timeout: 60000 });
    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) throw new Error('projections endpoint returned no rows');

    statCount = db.transaction(() => {
      let count = 0;
      for (const row of rows) {
        const sid = row.player_id != null ? String(row.player_id) : null;
        const player = row.player || {};
        const position = player.position;
        if (!POSITIONS.has(position)) continue;

        const name = [player.first_name, player.last_name].filter(Boolean).join(' ').trim();
        const target = (sid && bySleeperId.get(sid)) || (name && byNorm.get(normalizeName(name), position));
        if (!target) continue;

        // Sleeper keeps historical ADP on players who are no longer rostered — Tom
        // Brady still carries an adp_half_ppr. A null team is how it marks them, so
        // ADP from a teamless player is discarded rather than ranked.
        const rostered = !!player.team;

        const stats = row.stats || {};
        const pts = stats.pts_half_ppr != null
          ? Math.round(Number(stats.pts_half_ppr) * 10) / 10
          : calcHalfPprPts(stats);

        const adp_rd = rostered ? cleanAdp(stats.adp_half_ppr) : null;
        const adp_sf = rostered ? cleanAdp(stats.adp_2qb) : null;
        const adp_dyn = rostered ? (cleanAdp(stats.adp_dynasty_half_ppr) ?? cleanAdp(stats.adp_dynasty_ppr)) : null;
        const adp_dyn_sf = rostered ? cleanAdp(stats.adp_dynasty_2qb) : null;

        if (pts == null && adp_rd == null && adp_sf == null && adp_dyn == null && adp_dyn_sf == null) continue;

        updateStats.run({
          id: target.id,
          pts: pts != null && pts > 0 ? pts : null,
          adp_rd, adp_sf, adp_dyn, adp_dyn_sf,
          ts: now,
        });
        if (adp_rd != null) adpCounts.rd++;
        if (adp_sf != null) adpCounts.sf++;
        if (adp_dyn != null || adp_dyn_sf != null) adpCounts.dyn++;

        if (pts != null && pts > 0) {
          upsertNote.run({ player_id: target.id, note_sources: buildNoteString(stats, position, pts) });
        }
        count++;
      }
      return count;
    })();
    console.log(`[Sleeper] Stats: ${statCount} players | ADP half-PPR ${adpCounts.rd}, 2QB ${adpCounts.sf}, dynasty ${adpCounts.dyn}`);
  } catch (err) {
    // Roster already landed, so this is a partial success rather than a failure.
    updateMeta.run(now, rosterCount, 'ok', `roster only — projections failed: ${err.message}`);
    console.warn('[Sleeper] Projections/ADP fetch failed:', err.message);
    return {
      success: true, partial: true, players_updated: rosterCount,
      error: err.message, source: 'sleeper', timestamp: now,
    };
  }

  updateMeta.run(now, rosterCount, 'ok', `${statCount} with projections/ADP`);
  return {
    success: true,
    players_updated: rosterCount,
    stats_updated: statCount,
    adp_counts: adpCounts,
    source: 'sleeper',
    timestamp: now,
  };
}

module.exports = { fetchSleeper };
