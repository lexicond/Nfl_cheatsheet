const axios = require('axios');
const { db } = require('../db');
const { normalizeName } = require('../utils/normalize');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);
const CSV_URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv';

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    // Handle quoted fields with commas
    const vals = [];
    let cur = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { vals.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/^"|"$/g, ''); });
    return obj;
  });
}

async function fetchKTC() {
  const getByName = db.prepare(`SELECT id FROM players WHERE name = ? AND position = ?`);
  const getByNorm = db.prepare(`SELECT id FROM players WHERE name_normalized = ? AND position = ?`);
  const getByLastName = db.prepare(`SELECT id FROM players WHERE name_normalized LIKE ? AND position = ?`);

  const updateKTC = db.prepare(`
    UPDATE players SET ktc_value = @v1qb, ktc_value_sf = @v2qb, last_updated = @ts WHERE id = @id
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'ktc'
  `);

  let csvText = '';
  try {
    const res = await axios.get(CSV_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/plain' },
      timeout: 20000,
    });
    csvText = res.data;
  } catch (err) {
    const now = new Date().toISOString();
    updateMeta.run(now, 0, 'error', null);
    console.warn('[KTC] DynastyProcess CSV fetch failed:', err.message);
    return { success: false, error: err.message, source: 'ktc', timestamp: now };
  }

  const rows = parseCsv(csvText).filter(r => {
    const pos = (r.pos || '').toUpperCase();
    return POS_ALLOW.has(pos);
  });

  if (rows.length === 0) {
    const now = new Date().toISOString();
    updateMeta.run(now, 0, 'error', 'empty CSV');
    return { success: false, error: 'CSV parsed but no skill-position rows', source: 'ktc', timestamp: now };
  }

  const now = new Date().toISOString();

  function findPlayer(playerName, pos) {
    // 1. Exact name
    let row = getByName.get(playerName, pos);
    if (row) return row;
    // 2. Normalized name
    const norm = normalizeName(playerName);
    row = getByNorm.get(norm, pos);
    if (row) return row;
    // 3. Last name + position (for partial matches)
    const parts = norm.split(' ');
    if (parts.length >= 2) {
      const lastName = parts[parts.length - 1];
      row = getByLastName.get(`% ${lastName}`, pos);
      if (!row) row = getByLastName.get(`${lastName} %`, pos); // first-name last match
    }
    return row || null;
  }

  const run = db.transaction(() => {
    let count = 0;
    for (const r of rows) {
      const pos = (r.pos || '').toUpperCase();
      const v1qb = parseInt(r.value_1qb, 10);
      const v2qb = parseInt(r.value_2qb, 10);
      if (!r.player || isNaN(v1qb) || v1qb <= 0) continue;

      const existing = findPlayer(r.player, pos);
      if (existing) {
        updateKTC.run({ id: existing.id, v1qb, v2qb: isNaN(v2qb) ? v1qb : v2qb, ts: now });
        count++;
      }
    }
    return count;
  });

  const count = run();
  const scrapeDate = rows[0]?.scrape_date || 'unknown';
  updateMeta.run(now, count, 'ok', `DynastyProcess ${scrapeDate}`);
  console.log(`[KTC] Updated ${count} players from DynastyProcess CSV (${scrapeDate})`);
  return { success: true, players_updated: count, source: 'ktc', timestamp: now };
}

module.exports = { fetchKTC };
