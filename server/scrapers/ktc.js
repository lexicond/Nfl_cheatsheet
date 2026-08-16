const { db } = require('../db');
const { get, JSON_HEADERS } = require('../utils/http');
const { createMatcher } = require('../utils/match');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);

// KeepTradeCut's own pages are client-rendered and rate-limited; DynastyProcess
// republishes the same crowd-sourced values as a daily CSV.
const CSV_URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv';

function parseCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const splitRow = line => {
    const vals = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        vals.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    vals.push(cur.trim());
    return vals;
  };

  const headers = splitRow(lines[0]).map(h => h.replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = splitRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] ?? '').replace(/^"|"$/g, ''); });
    return obj;
  });
}

async function fetchKTC() {
  const findPlayer = createMatcher(db);
  const now = new Date().toISOString();

  const updateKTC = db.prepare(`
    UPDATE players SET ktc_value = @v1qb, ktc_value_sf = @v2qb, last_updated = @ts WHERE id = @id
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'ktc'
  `);

  let rows;
  try {
    const res = await get(CSV_URL, { headers: JSON_HEADERS, timeout: 25000, responseType: 'text' });
    rows = parseCsv(res.data).filter(r => POS_ALLOW.has((r.pos || '').toUpperCase()));
  } catch (err) {
    updateMeta.run(now, 0, 'error', err.message.slice(0, 200));
    console.warn('[KTC] DynastyProcess CSV fetch failed:', err.message);
    return { success: false, error: err.message, source: 'ktc', timestamp: now };
  }

  if (rows.length === 0) {
    updateMeta.run(now, 0, 'error', 'CSV had no skill-position rows');
    return { success: false, error: 'CSV parsed but no skill-position rows', source: 'ktc', timestamp: now };
  }

  const count = db.transaction(() => {
    let n = 0;
    for (const r of rows) {
      const pos = (r.pos || '').toUpperCase();
      const v1qb = parseInt(r.value_1qb, 10);
      const v2qb = parseInt(r.value_2qb, 10);
      if (!r.player || !Number.isFinite(v1qb) || v1qb <= 0) continue;

      const target = findPlayer(r.player, pos, (r.team || '').toUpperCase() || null);
      if (!target) continue;
      updateKTC.run({ id: target.id, v1qb, v2qb: Number.isFinite(v2qb) ? v2qb : v1qb, ts: now });
      n++;
    }
    return n;
  })();

  const scrapeDate = rows[0]?.scrape_date || 'unknown';
  updateMeta.run(now, count, 'ok', `DynastyProcess ${scrapeDate}`);
  console.log(`[KTC] Updated ${count} players from DynastyProcess CSV (${scrapeDate})`);
  return { success: true, players_updated: count, as_of: scrapeDate, source: 'ktc', timestamp: now };
}

module.exports = { fetchKTC };
