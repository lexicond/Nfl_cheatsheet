const axios = require('axios');
const cheerio = require('cheerio');
const { db } = require('../db');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);

async function fetchKTC() {
  const getPlayer = db.prepare(`SELECT id FROM players WHERE name = ? AND position = ?`);
  const updateKTC = db.prepare(`
    UPDATE players SET ktc_value = @ktc_value, last_updated = @last_updated WHERE id = @id
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ? WHERE source = 'ktc'
  `);

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/json,*/*',
  };

  let players = [];
  let lastError = null;

  const PAGE_URLS = [
    'https://keeptradecut.com/dynasty-rankings?format=1',
    'https://keeptradecut.com/dynasty-rankings?page=0&filters=QB|WR|RB|TE|RDP&format=1',
  ];

  for (const url of PAGE_URLS) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
      const $ = cheerio.load(res.data);

      // KTC embeds player data in a script tag as a JS variable
      let found = false;
      $('script').each((_, el) => {
        const txt = $(el).html() || '';
        // Try common variable patterns KTC uses
        const patterns = [
          /var\s+playerData\s*=\s*(\[[\s\S]*?\]);/,
          /playerData\s*=\s*(\[[\s\S]*?\]);/,
          /"rankings"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
        ];
        for (const pattern of patterns) {
          const match = txt.match(pattern);
          if (match) {
            try {
              const arr = JSON.parse(match[1]);
              if (Array.isArray(arr) && arr.length > 0) {
                const parsed = arr
                  .filter(p => p && (p.playerName || p.name) && POS_ALLOW.has((p.position || '').toUpperCase()))
                  .map(p => ({
                    name: p.playerName || p.name,
                    position: (p.position || '').toUpperCase(),
                    value: p.value || p.overallValue || p.tradeValue || 0,
                  }));
                if (parsed.length > 0) {
                  players = parsed;
                  found = true;
                  console.log(`[KTC] Got ${players.length} players from embedded JSON`);
                }
              }
            } catch {}
          }
        }
        return !found; // stop iterating scripts if found
      });

      if (found) break;

      // Fallback: try parsing HTML table if JSON not found
      const rows = $('table tbody tr, .player-row, [class*="PlayerCard"]');
      if (rows.length > 0) {
        rows.each((_, row) => {
          const nameEl = $(row).find('[class*="player-name"], .name, td:nth-child(2) a').first();
          const name = nameEl.text().trim();
          const posEl = $(row).find('[class*="position"], .position, td:nth-child(4)').first();
          const pos = posEl.text().trim().toUpperCase();
          const valEl = $(row).find('[class*="value"], .value, td:nth-child(5)').first();
          const val = parseInt((valEl.text() || '').replace(/[^0-9]/g, ''), 10);
          if (name && POS_ALLOW.has(pos) && !isNaN(val) && val > 0) {
            players.push({ name, position: pos, value: val });
          }
        });
        if (players.length > 0) {
          console.log(`[KTC] Got ${players.length} players from HTML table`);
          break;
        }
      }
    } catch (err) {
      lastError = err;
      console.warn(`[KTC] ${url} failed: ${err.message}`);
    }
  }

  if (players.length === 0) {
    const now = new Date().toISOString();
    updateMeta.run(now, 0, 'error');
    const msg = lastError?.message || 'Could not extract player data from KTC page';
    console.warn('[KTC] Failed:', msg);
    return { success: false, error: msg, source: 'ktc', timestamp: now };
  }

  const now = new Date().toISOString();

  const run = db.transaction(() => {
    let count = 0;
    for (const p of players) {
      const existing = getPlayer.get(p.name, p.position);
      if (existing) {
        updateKTC.run({ id: existing.id, ktc_value: p.value, last_updated: now });
        count++;
      }
    }
    return count;
  });

  const count = run();
  updateMeta.run(now, count, 'ok');
  console.log(`[KTC] Updated ${count} players`);
  return { success: true, players_updated: count, source: 'ktc', timestamp: now };
}

module.exports = { fetchKTC };
