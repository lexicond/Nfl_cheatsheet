const axios = require('axios');
const { db } = require('../db');
const { normalizeName } = require('../utils/normalize');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);
function parsePosition(raw) {
  return POS_ALLOW.has((raw || '').toUpperCase()) ? (raw || '').toUpperCase() : null;
}

// FantasyCalc provides dynasty and redraft player values
// numQbs=1 for 1QB, numQbs=2 for superflex; ppr=0.5 for half-PPR
const ENDPOINTS = [
  'https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=1&ppr=0.5',
  'https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=1&ppr=1',
  'https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&ppr=0.5',
];

async function fetchFantasyCalc() {
  const getPlayer = db.prepare(`SELECT id FROM players WHERE name = ? AND position = ?`);
  const getByNorm = db.prepare(`SELECT id FROM players WHERE name_normalized = ? AND position = ?`);
  const updateFC = db.prepare(`
    UPDATE players SET fc_value = @fc_value, last_updated = @last_updated WHERE id = @id
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ? WHERE source = 'fantasycalc'
  `);

  let players = [];
  let lastError = null;

  for (const url of ENDPOINTS) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        timeout: 15000,
      });
      const data = res.data;
      if (Array.isArray(data) && data.length > 0) {
        const parsed = data
          .filter(item => item.player && item.value != null)
          .map(item => ({
            name: item.player.name,
            position: parsePosition(item.player.position),
            value: Math.round(item.value),
          }))
          .filter(p => p.name && p.position);
        if (parsed.length > 0) {
          players = parsed;
          console.log(`[FantasyCalc] Got ${players.length} players from ${url}`);
          break;
        }
      }
    } catch (err) {
      lastError = err;
      console.warn(`[FantasyCalc] ${url} failed: ${err.message}`);
    }
  }

  if (players.length === 0) {
    const now = new Date().toISOString();
    updateMeta.run(now, 0, 'error');
    return {
      success: false,
      error: lastError?.message || 'No data from FantasyCalc',
      source: 'fantasycalc',
      timestamp: now,
    };
  }

  const now = new Date().toISOString();

  const run = db.transaction(() => {
    let count = 0;
    for (const p of players) {
      let existing = getPlayer.get(p.name, p.position);
      if (!existing) existing = getByNorm.get(normalizeName(p.name), p.position);
      if (existing) {
        updateFC.run({ id: existing.id, fc_value: p.value, last_updated: now });
        count++;
      }
    }
    return count;
  });

  const count = run();
  updateMeta.run(now, count, 'ok');
  console.log(`[FantasyCalc] Updated ${count} players`);
  return { success: true, players_updated: count, source: 'fantasycalc', timestamp: now };
}

module.exports = { fetchFantasyCalc };
