const axios = require('axios');
const { db } = require('../db');
const { normalizeName } = require('../utils/normalize');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);
function parsePosition(raw) {
  return POS_ALLOW.has((raw || '').toUpperCase()) ? (raw || '').toUpperCase() : null;
}

// FantasyCalc provides dynasty player values
// Fetch both 1QB and SF (numQbs=2) variants so the UI can switch without re-fetching
const BASE = 'https://api.fantasycalc.com/values/current';
const URL_1QB = `${BASE}?isDynasty=true&numQbs=1&ppr=0.5`;
const URL_SF  = `${BASE}?isDynasty=true&numQbs=2&ppr=0.5`;

async function fetchEndpoint(url) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    timeout: 15000,
  });
  const data = res.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const parsed = data
    .filter(item => item.player && item.value != null)
    .map(item => ({
      name: item.player.name,
      position: parsePosition(item.player.position),
      value: Math.round(item.value),
    }))
    .filter(p => p.name && p.position);
  return parsed.length > 0 ? parsed : null;
}

async function fetchFantasyCalc() {
  const getPlayer = db.prepare(`SELECT id FROM players WHERE name = ? AND position = ?`);
  const getByNorm = db.prepare(`SELECT id FROM players WHERE name_normalized = ? AND position = ?`);
  const updateFC = db.prepare(`
    UPDATE players SET fc_value = @fc_value, fc_value_sf = @fc_value_sf, last_updated = @last_updated WHERE id = @id
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ? WHERE source = 'fantasycalc'
  `);

  function findExisting(name, pos) {
    return getPlayer.get(name, pos) || getByNorm.get(normalizeName(name), pos) || null;
  }

  // Fetch 1QB and SF variants in parallel
  let players1QB = null;
  let playersSF = null;
  let lastError = null;

  try {
    [players1QB, playersSF] = await Promise.all([
      fetchEndpoint(URL_1QB).catch(err => { lastError = err; return null; }),
      fetchEndpoint(URL_SF).catch(err => { lastError = err; return null; }),
    ]);
  } catch (err) {
    lastError = err;
  }

  if (!players1QB && !playersSF) {
    const now = new Date().toISOString();
    updateMeta.run(now, 0, 'error');
    return {
      success: false,
      error: lastError?.message || 'No data from FantasyCalc',
      source: 'fantasycalc',
      timestamp: now,
    };
  }

  // Build lookup maps: normalized_name+pos → value
  const map1QB = new Map();
  const mapSF = new Map();

  (players1QB || []).forEach(p => map1QB.set(`${normalizeName(p.name)}|${p.position}`, p.value));
  (playersSF  || []).forEach(p => mapSF.set(`${normalizeName(p.name)}|${p.position}`, p.value));

  // Merge all unique players across both sets
  const allNames = new Map();
  (players1QB || []).forEach(p => allNames.set(`${normalizeName(p.name)}|${p.position}`, p));
  (playersSF  || []).forEach(p => allNames.set(`${normalizeName(p.name)}|${p.position}`, p));

  const now = new Date().toISOString();

  const run = db.transaction(() => {
    let count = 0;
    for (const p of allNames.values()) {
      const existing = findExisting(p.name, p.position);
      if (!existing) continue;

      const key = `${normalizeName(p.name)}|${p.position}`;
      const v1qb = map1QB.get(key) ?? null;
      const vsf  = mapSF.get(key) ?? null;

      updateFC.run({
        id: existing.id,
        fc_value: v1qb,
        fc_value_sf: vsf,
        last_updated: now,
      });
      count++;
    }
    return count;
  });

  const count = run();
  updateMeta.run(now, count, 'ok');
  console.log(`[FantasyCalc] Updated ${count} players (1QB + SF variants)`);
  return { success: true, players_updated: count, source: 'fantasycalc', timestamp: now };
}

module.exports = { fetchFantasyCalc };
