const axios = require('axios');
const { db, computeConsensus } = require('../db');

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchSleeper() {
  const upsertPlayer = db.prepare(`
    INSERT INTO players (name, position, nfl_team, adp_sleeper, pos_rank_sleeper, adp_consensus, last_updated)
    VALUES (@name, @position, @nfl_team, @adp_sleeper, @pos_rank_sleeper, @adp_consensus, @last_updated)
    ON CONFLICT DO NOTHING
  `);

  const updatePlayer = db.prepare(`
    UPDATE players
    SET nfl_team = COALESCE(@nfl_team, nfl_team),
        adp_sleeper = @adp_sleeper,
        pos_rank_sleeper = @pos_rank_sleeper,
        adp_consensus = @adp_consensus,
        last_updated = @last_updated
    WHERE name = @name AND position = @position
  `);

  const getPlayer = db.prepare(`SELECT * FROM players WHERE name = ? AND position = ?`);

  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ? WHERE source = 'sleeper'
  `);

  try {
    // Fetch all NFL players
    const playersRes = await axios.get('https://api.sleeper.app/v1/players/nfl', { timeout: 30000 });
    const allPlayers = playersRes.data;

    // Collect skill-position players and sort by search_rank (Sleeper's default ranking)
    const skillPlayers = Object.values(allPlayers)
      .filter(p => p.active && POSITIONS.has(p.position) && p.search_rank && p.search_rank < 9999)
      .sort((a, b) => (a.search_rank || 9999) - (b.search_rank || 9999));

    // Build position rank counters
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

        // Use search_rank as a rough ADP proxy (scaled to 1-based picks)
        const adpSleeper = p.search_rank < 9999 ? p.search_rank : null;

        const existing = getPlayer.get(name, position);
        const adpConsensus = computeConsensus(
          existing ? existing.adp_fantasypros : null,
          existing ? existing.adp_underdog : null,
          adpSleeper
        );

        const row = {
          name,
          position,
          nfl_team: p.team || null,
          adp_sleeper: adpSleeper,
          pos_rank_sleeper: posRank,
          adp_consensus: adpConsensus,
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
    return { success: true, players_updated: count, source: 'sleeper', timestamp: now };
  } catch (err) {
    const now = new Date().toISOString();
    updateMeta.run(now, 0, 'error');
    console.error('[Sleeper] Fetch failed:', err.message);
    return { success: false, error: err.message, source: 'sleeper', timestamp: now };
  }
}

module.exports = { fetchSleeper, normalizeName };
