const axios = require('axios');
const cheerio = require('cheerio');
const { db } = require('../db');
const { normalizeName } = require('../utils/normalize');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://www.fantasypros.com/',
};

const POS_MAP = { 'QB': 'QB', 'RB': 'RB', 'WR': 'WR', 'TE': 'TE', 'K': 'K', 'DST': 'DEF', 'DEF': 'DEF' };
function parsePosition(raw) {
  return POS_MAP[(raw || '').toUpperCase().trim()] || raw?.toUpperCase().trim() || null;
}

// Three format-specific FantasyPros ranking pages
const FP_SOURCES = [
  { url: 'https://www.fantasypros.com/nfl/rankings/best-ball-cheatsheets.php', column: 'adp_fantasypros', label: 'BB 1QB' },
  { url: 'https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php', column: 'adp_fp_rd', label: 'RD 0.5PPR' },
  { url: 'https://www.fantasypros.com/nfl/rankings/superflex-cheatsheets.php', column: 'adp_fp_sf', label: 'SF/2QB' },
];

async function scrapeOneFPPage(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  if (res.status !== 200 || !res.data || res.data.length < 500) return [];

  const $ = cheerio.load(res.data);
  const players = [];

  $('table#ranking-table tbody tr, table.ranking-table tbody tr, #data tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;

    const rankText = $(cells[0]).text().trim();
    const rank = parseFloat(rankText) || (i + 1);

    const nameCell = $(cells[2]).length ? $(cells[2]) : $(cells[1]);
    const nameEl = nameCell.find('.player-name, .player-info a, a').first();
    const name = (nameEl.text() || nameCell.text()).trim().replace(/\s+/g, ' ').split('\n')[0].trim();

    const posTeamText = nameCell.find('small, .player-team').text().trim();
    const parts = posTeamText.split(/\s*[-–]\s*|\s+/);
    let position = null;
    let nfl_team = null;

    if (parts.length >= 2) {
      position = parsePosition(parts[0]);
      nfl_team = parts[parts.length - 1].toUpperCase();
    } else if (parts.length === 1) {
      position = parsePosition(parts[0]);
    }

    if (!position) {
      const posCell = $(cells[3]).text().trim();
      position = parsePosition(posCell);
    }

    if (!name || name.length < 2) return;
    players.push({ name, position, nfl_team, rank });
  });

  // Fallback: embedded JSON
  if (players.length === 0) {
    const scriptContent = $('script').map((i, el) => $(el).html()).get().join('\n');
    const match = scriptContent.match(/ecrData\s*=\s*(\{[\s\S]*?\});/);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        (data.players || []).forEach((p, i) => {
          players.push({
            name: p.player_name || p.name,
            position: parsePosition(p.player_position_id || p.position),
            nfl_team: p.player_team_id || p.team,
            rank: p.rank_ecr || p.rank || i + 1,
          });
        });
      } catch {}
    }
  }

  return players;
}

async function fetchFantasyPros() {
  const getPlayer = db.prepare(`SELECT * FROM players WHERE name = ? AND position = ?`);
  const getByNorm = db.prepare(`SELECT * FROM players WHERE name_normalized = ? AND position = ?`);
  const upsertPlayer = db.prepare(`
    INSERT INTO players (name, position, nfl_team, adp_fantasypros, pos_rank_fantasypros, last_updated)
    VALUES (@name, @position, @nfl_team, @adp_fantasypros, @pos_rank_fantasypros, @last_updated)
    ON CONFLICT DO NOTHING
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ? WHERE source = 'fantasypros'
  `);

  function findExisting(name, pos) {
    return getPlayer.get(name, pos) || getByNorm.get(normalizeName(name), pos) || null;
  }

  // Fetch all 3 pages in parallel
  const results = await Promise.allSettled(
    FP_SOURCES.map(src => scrapeOneFPPage(src.url).then(players => ({ ...src, players })))
  );

  const now = new Date().toISOString();
  let totalCount = 0;
  let anySuccess = false;

  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn(`[FantasyPros] Fetch failed: ${result.reason?.message}`);
      continue;
    }
    const { url, column, label, players } = result.value;
    if (players.length === 0) {
      console.warn(`[FantasyPros] No players parsed from ${label} (${url})`);
      continue;
    }

    // Build per-column update statement dynamically
    const updateByName = db.prepare(`
      UPDATE players SET ${column} = @val, pos_rank_fantasypros = @posRank,
        nfl_team = COALESCE(@nfl_team, nfl_team), last_updated = @last_updated
      WHERE name = @name AND position = @position
    `);
    const updateById = db.prepare(`
      UPDATE players SET ${column} = @val, pos_rank_fantasypros = @posRank,
        nfl_team = COALESCE(@nfl_team, nfl_team), last_updated = @last_updated
      WHERE id = @id
    `);

    const posRankCounters = {};
    const run = db.transaction(() => {
      let count = 0;
      players.forEach(p => {
        if (!p.name || !p.position) return;
        posRankCounters[p.position] = (posRankCounters[p.position] || 0) + 1;
        const posRank = posRankCounters[p.position];

        const existing = findExisting(p.name, p.position);
        const row = { val: p.rank, posRank, nfl_team: p.nfl_team || null, last_updated: now };

        if (existing) {
          updateById.run({ ...row, id: existing.id });
        } else if (column === 'adp_fantasypros') {
          // Only insert new players when processing the primary column
          upsertPlayer.run({ name: p.name, position: p.position, nfl_team: p.nfl_team || null,
            adp_fantasypros: p.rank, pos_rank_fantasypros: posRank, last_updated: now });
        } else {
          updateByName.run({ ...row, name: p.name, position: p.position });
        }
        count++;
      });
      return count;
    });

    const count = run();
    totalCount += count;
    anySuccess = true;
    console.log(`[FantasyPros] ${label}: ${count} players → ${column}`);
  }

  if (!anySuccess) {
    updateMeta.run(now, 0, 'error');
    return { success: false, error: 'All FantasyPros URLs failed', source: 'fantasypros', timestamp: now };
  }

  updateMeta.run(now, totalCount, 'ok');
  return { success: true, players_updated: totalCount, source: 'fantasypros', timestamp: now };
}

module.exports = { fetchFantasyPros };
