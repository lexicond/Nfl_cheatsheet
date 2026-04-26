const axios = require('axios');
const cheerio = require('cheerio');
const { db, computeConsensus } = require('../db');
const { normalizeName } = require('../utils/normalize');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://www.fantasypros.com/',
};

const URLS = [
  'https://www.fantasypros.com/nfl/rankings/best-ball-cheatsheets.php',
];

// Position abbreviation normalisation
const POS_MAP = { 'QB': 'QB', 'RB': 'RB', 'WR': 'WR', 'TE': 'TE', 'K': 'K', 'DST': 'DEF', 'DEF': 'DEF' };

function parsePosition(raw) {
  return POS_MAP[(raw || '').toUpperCase().trim()] || raw?.toUpperCase().trim() || null;
}

async function fetchFantasyPros() {
  const getPlayer = db.prepare(`SELECT * FROM players WHERE name = ? AND position = ?`);
  const getByNorm = db.prepare(`SELECT * FROM players WHERE name_normalized = ? AND position = ?`);
  const upsertPlayer = db.prepare(`
    INSERT INTO players (name, position, nfl_team, adp_fantasypros, pos_rank_fantasypros, adp_consensus, last_updated)
    VALUES (@name, @position, @nfl_team, @adp_fantasypros, @pos_rank_fantasypros, @adp_consensus, @last_updated)
    ON CONFLICT DO NOTHING
  `);
  const updatePlayer = db.prepare(`
    UPDATE players
    SET nfl_team = COALESCE(@nfl_team, nfl_team),
        adp_fantasypros = @adp_fantasypros,
        pos_rank_fantasypros = @pos_rank_fantasypros,
        adp_consensus = @adp_consensus,
        last_updated = @last_updated
    WHERE name = @name AND position = @position
  `);
  const updatePlayerById = db.prepare(`
    UPDATE players
    SET nfl_team = COALESCE(@nfl_team, nfl_team),
        adp_fantasypros = @adp_fantasypros,
        pos_rank_fantasypros = @pos_rank_fantasypros,
        adp_consensus = @adp_consensus,
        last_updated = @last_updated
    WHERE id = @id
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ? WHERE source = 'fantasypros'
  `);

  function findExisting(name, pos) {
    return getPlayer.get(name, pos) || getByNorm.get(normalizeName(name), pos) || null;
  }

  let html = null;
  let lastError = null;

  for (const url of URLS) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
      if (res.status === 200 && res.data && res.data.length > 500) {
        html = res.data;
        break;
      }
    } catch (err) {
      lastError = err;
      console.warn(`[FantasyPros] URL ${url} failed: ${err.message}`);
    }
  }

  if (!html) {
    const now = new Date().toISOString();
    const msg = lastError ? lastError.message : 'No data returned';
    updateMeta.run(now, 0, 'error');
    console.error('[FantasyPros] All URLs failed:', msg);
    return { success: false, error: msg, source: 'fantasypros', timestamp: now };
  }

  const $ = cheerio.load(html);
  const players = [];

  // Try multiple table selectors — FantasyPros changes their markup occasionally
  $('table#ranking-table tbody tr, table.ranking-table tbody tr, #data tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;

    const rankText = $(cells[0]).text().trim();
    const rank = parseFloat(rankText) || (i + 1);

    // Name cell often has player-name span + small team/pos span
    const nameCell = $(cells[2]).length ? $(cells[2]) : $(cells[1]);
    const nameEl = nameCell.find('.player-name, .player-info a, a').first();
    const name = (nameEl.text() || nameCell.text()).trim().replace(/\s+/g, ' ').split('\n')[0].trim();

    const posTeamText = nameCell.find('small, .player-team').text().trim();
    const parts = posTeamText.split(/\s*[-–]\s*|\s+/);
    let position = null;
    let nfl_team = null;

    // Usually format: "WR - CIN" or "WR CIN"
    if (parts.length >= 2) {
      position = parsePosition(parts[0]);
      nfl_team = parts[parts.length - 1].toUpperCase();
    } else if (parts.length === 1) {
      position = parsePosition(parts[0]);
    }

    // Fallback: look for explicit position column
    if (!position) {
      const posCell = $(cells[3]).text().trim();
      position = parsePosition(posCell);
    }

    if (!name || name.length < 2) return;

    players.push({ name, position, nfl_team, rank });
  });

  // If the above selector found nothing, try the embedded JSON data
  if (players.length === 0) {
    const scriptContent = $('script').map((i, el) => $(el).html()).get().join('\n');
    const match = scriptContent.match(/ecrData\s*=\s*(\{[\s\S]*?\});/);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        const rows = data.players || [];
        rows.forEach((p, i) => {
          players.push({
            name: p.player_name || p.name,
            position: parsePosition(p.player_position_id || p.position),
            nfl_team: p.player_team_id || p.team,
            rank: p.rank_ecr || p.rank || i + 1,
          });
        });
      } catch (e) {
        console.warn('[FantasyPros] JSON parse failed:', e.message);
      }
    }
  }

  if (players.length === 0) {
    const now = new Date().toISOString();
    updateMeta.run(now, 0, 'error');
    return {
      success: false,
      error: 'Could not parse any player data from FantasyPros (site may have changed layout or blocked request)',
      source: 'fantasypros',
      timestamp: now,
    };
  }

  // Build position rank map
  const posRankCounters = {};
  const now = new Date().toISOString();

  const runUpserts = db.transaction(() => {
    let count = 0;
    players.forEach(p => {
      if (!p.name || !p.position) return;
      posRankCounters[p.position] = (posRankCounters[p.position] || 0) + 1;
      const posRank = posRankCounters[p.position];

      const existing = findExisting(p.name, p.position);
      const adpConsensus = computeConsensus(
        p.rank,
        existing ? existing.adp_underdog : null,
        existing ? existing.adp_ffc : null,
      );

      const row = {
        nfl_team: p.nfl_team || null,
        adp_fantasypros: p.rank,
        pos_rank_fantasypros: posRank,
        adp_consensus: adpConsensus,
        last_updated: now,
      };

      if (existing) {
        updatePlayerById.run({ ...row, id: existing.id });
      } else {
        upsertPlayer.run({ ...row, name: p.name, position: p.position });
      }
      count++;
    });
    return count;
  });

  const count = runUpserts();
  updateMeta.run(now, count, 'ok');
  console.log(`[FantasyPros] Updated ${count} players`);
  return { success: true, players_updated: count, source: 'fantasypros', timestamp: now };
}

module.exports = { fetchFantasyPros };
