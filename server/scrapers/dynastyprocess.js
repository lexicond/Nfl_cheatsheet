const { db } = require('../db');
const { get, JSON_HEADERS } = require('../utils/http');
const { createMatcher, createClaimGuard } = require('../utils/match');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);

// DynastyProcess publishes a daily CSV of its own dynasty values plus the
// FantasyPros dynasty ECR they are built from (ecr_1qb / ecr_2qb).
//
// These are NOT KeepTradeCut values, despite often being described that way — they
// correlate 0.98 with FantasyPros dynasty ECR, so dp_value is kept as a displayed
// column but deliberately excluded from the dynasty consensus, which already
// averages FantasyPros directly. Ages come from here; they drive the dynasty-versus-
// redraft check in scripts/validate-sources.js.
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

async function fetchDynastyProcess() {
  const findPlayer = createMatcher(db);
  const now = new Date().toISOString();

  const updateValues = db.prepare(`
    UPDATE players
    SET dp_value = @v1qb, dp_value_sf = @v2qb,
        age = COALESCE(@age, age),
        last_updated = @ts
    WHERE id = @id
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'dynastyprocess'
  `);

  let rows;
  try {
    const res = await get(CSV_URL, { headers: JSON_HEADERS, timeout: 25000, responseType: 'text' });
    rows = parseCsv(res.data).filter(r => POS_ALLOW.has((r.pos || '').toUpperCase()));
  } catch (err) {
    updateMeta.run(now, 0, 'error', err.message.slice(0, 200));
    console.warn('[DynastyProcess] DynastyProcess CSV fetch failed:', err.message);
    return { success: false, error: err.message, source: 'dynastyprocess', timestamp: now };
  }

  if (rows.length === 0) {
    updateMeta.run(now, 0, 'error', 'CSV had no skill-position rows');
    return { success: false, error: 'CSV parsed but no skill-position rows', source: 'dynastyprocess', timestamp: now };
  }

  const claim = createClaimGuard('DynastyProcess');
  const count = db.transaction(() => {
    let n = 0;
    for (const r of rows) {
      const pos = (r.pos || '').toUpperCase();
      const v1qb = parseInt(r.value_1qb, 10);
      const v2qb = parseInt(r.value_2qb, 10);
      if (!r.player || !Number.isFinite(v1qb) || v1qb <= 0) continue;

      const target = findPlayer(r.player, pos, (r.team || '').toUpperCase() || null);
      if (!target || !claim(target.id, r.player)) continue;
      const age = parseFloat(r.age);
      updateValues.run({
        id: target.id,
        v1qb,
        v2qb: Number.isFinite(v2qb) ? v2qb : v1qb,
        age: Number.isFinite(age) && age > 0 && age < 50 ? age : null,
        ts: now,
      });
      n++;
    }
    return n;
  })();

  const scrapeDate = rows[0]?.scrape_date || 'unknown';
  updateMeta.run(now, count, 'ok', `DynastyProcess ${scrapeDate}`);
  console.log(`[DynastyProcess] Updated ${count} players (values + ages), CSV dated ${scrapeDate}`);
  return { success: true, players_updated: count, as_of: scrapeDate, source: 'dynastyprocess', timestamp: now };
}

module.exports = { fetchDynastyProcess };
