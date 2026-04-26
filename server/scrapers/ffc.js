const axios = require('axios');
const { db, computeConsensus } = require('../db');
const { normalizeName } = require('../utils/normalize');

const POS_MAP = { 'QB': 'QB', 'RB': 'RB', 'WR': 'WR', 'TE': 'TE', 'K': 'K', 'DST': 'DEF', 'D/ST': 'DEF' };
function parsePosition(raw) {
  return POS_MAP[(raw || '').toUpperCase().trim()] || null;
}

// Fantasy Football Calculator — free public JSON API, no auth required
// Try current year first, then fall back to prior years
const SEASON_YEAR = new Date().getFullYear();
const ENDPOINTS = [
  `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${SEASON_YEAR}&position=all`,
  `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${SEASON_YEAR - 1}&position=all`,
  `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${SEASON_YEAR - 2}&position=all`,
];

async function fetchFFC() {
  const getPlayer = db.prepare(`SELECT * FROM players WHERE name = ? AND position = ?`);
  const getByNorm = db.prepare(`SELECT * FROM players WHERE name_normalized = ? AND position = ?`);
  const updateFFC = db.prepare(`
    UPDATE players
    SET adp_ffc = @adp_ffc,
        nfl_team = COALESCE(@nfl_team, nfl_team),
        adp_consensus = @adp_consensus,
        last_updated = @last_updated
    WHERE id = @id
  `);
  const upsertPlayer = db.prepare(`
    INSERT INTO players (name, position, nfl_team, adp_ffc, adp_consensus, last_updated)
    VALUES (@name, @position, @nfl_team, @adp_ffc, @adp_consensus, @last_updated)
    ON CONFLICT DO NOTHING
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ? WHERE source = 'ffc'
  `);

  function findExisting(name, pos) {
    return getPlayer.get(name, pos) || getByNorm.get(normalizeName(name), pos) || null;
  }

  let players = [];
  let lastError = null;

  for (const url of ENDPOINTS) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        timeout: 15000,
      });
      const data = res.data;
      if (data && Array.isArray(data.players) && data.players.length > 0) {
        const parsed = data.players
          .map(p => ({
            name: p.name,
            position: parsePosition(p.position),
            nfl_team: (p.team || '').toUpperCase() || null,
            adp: parseFloat(p.adp),
          }))
          .filter(p => p.name && p.position && !isNaN(p.adp) && ['QB', 'RB', 'WR', 'TE'].includes(p.position));
        if (parsed.length > 0) {
          players = parsed;
          console.log(`[FFC] Got ${players.length} players from ${url}`);
          break;
        }
      }
    } catch (err) {
      lastError = err;
      console.warn(`[FFC] ${url} failed: ${err.message}`);
    }
  }

  if (players.length === 0) {
    const now = new Date().toISOString();
    updateMeta.run(now, 0, 'error');
    return {
      success: false,
      error: lastError?.message || 'No data from FFC',
      source: 'ffc',
      timestamp: now,
    };
  }

  const now = new Date().toISOString();

  const run = db.transaction(() => {
    let count = 0;
    for (const p of players) {
      const existing = findExisting(p.name, p.position);
      const consensus = computeConsensus(
        existing?.adp_fantasypros ?? null,
        existing?.adp_underdog ?? null,
        p.adp,
      );
      const row = {
        nfl_team: p.nfl_team,
        adp_ffc: p.adp,
        adp_consensus: consensus,
        last_updated: now,
      };
      if (existing) {
        updateFFC.run({ ...row, id: existing.id });
      } else {
        upsertPlayer.run({ ...row, name: p.name, position: p.position });
      }
      count++;
    }
    return count;
  });

  const count = run();
  updateMeta.run(now, count, 'ok');
  console.log(`[FFC] Updated ${count} players`);
  return { success: true, players_updated: count, source: 'ffc', timestamp: now };
}

module.exports = { fetchFFC };
