const axios = require('axios');
const cheerio = require('cheerio');
const { db, computeConsensus } = require('../db');
const { normalizeName } = require('./sleeper');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'en-US,en;q=0.5',
};

const API_URLS = [
  'https://api.underdogfantasy.com/v1/fantasy_draft_rankings',
  'https://api.underdogfantasy.com/v3/fantasy_draft_rankings',
  'https://api.underdogfantasy.com/v1/player_rankings',
];

const POS_MAP = { 'QB': 'QB', 'RB': 'RB', 'WR': 'WR', 'TE': 'TE', 'K': 'K', 'DST': 'DEF', 'D/ST': 'DEF' };
function parsePosition(raw) {
  return POS_MAP[(raw || '').toUpperCase().trim()] || (raw || '').toUpperCase().trim() || null;
}

async function fetchUnderdog() {
  const getPlayer = db.prepare(`SELECT * FROM players WHERE name = ? AND position = ?`);
  const upsertPlayer = db.prepare(`
    INSERT INTO players (name, position, nfl_team, adp_underdog, pos_rank_underdog, adp_consensus, last_updated)
    VALUES (@name, @position, @nfl_team, @adp_underdog, @pos_rank_underdog, @adp_consensus, @last_updated)
    ON CONFLICT DO NOTHING
  `);
  const updatePlayer = db.prepare(`
    UPDATE players
    SET nfl_team = COALESCE(@nfl_team, nfl_team),
        adp_underdog = @adp_underdog,
        pos_rank_underdog = @pos_rank_underdog,
        adp_consensus = @adp_consensus,
        last_updated = @last_updated
    WHERE name = @name AND position = @position
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ? WHERE source = 'underdog'
  `);

  let players = [];
  let lastError = null;

  // Try JSON API endpoints first
  for (const url of API_URLS) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
      const data = res.data;

      // Handle various response shapes
      const rankings = data.rankings || data.players || data.player_rankings || data.data || [];
      if (Array.isArray(rankings) && rankings.length > 0) {
        players = rankings.map((p, i) => ({
          name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || p.player_name,
          position: parsePosition(p.position || p.player_position),
          nfl_team: (p.team || p.nfl_team || p.team_abbr || '').toUpperCase() || null,
          adp: p.adp || p.average_pick || p.rank || i + 1,
        })).filter(p => p.name);

        if (players.length > 0) {
          console.log(`[Underdog] Got ${players.length} players from ${url}`);
          break;
        }
      }
    } catch (err) {
      lastError = err;
      console.warn(`[Underdog] API ${url} failed: ${err.message}`);
    }
  }

  // Fallback: try scraping the picks page (may be JS-rendered, best effort)
  if (players.length === 0) {
    try {
      const res = await axios.get('https://underdogfantasy.com/pick-rates', {
        headers: { ...HEADERS, Accept: 'text/html' },
        timeout: 15000,
      });
      const $ = cheerio.load(res.data);
      $('tr, .player-row, [class*="player"]').each((i, el) => {
        const text = $(el).text().trim();
        const cells = $(el).find('td, [class*="cell"]');
        if (cells.length >= 3) {
          const name = $(cells[0]).text().trim();
          const pos = $(cells[1]).text().trim();
          const adpText = $(cells[2]).text().trim();
          const adp = parseFloat(adpText);
          if (name && !isNaN(adp)) {
            players.push({ name, position: parsePosition(pos), nfl_team: null, adp });
          }
        }
      });
    } catch (err) {
      console.warn('[Underdog] Scrape fallback failed:', err.message);
    }
  }

  if (players.length === 0) {
    const now = new Date().toISOString();
    const msg = lastError ? lastError.message : 'No data returned from any Underdog endpoint';
    updateMeta.run(now, 0, 'error');
    console.error('[Underdog] All sources failed:', msg);
    return { success: false, error: msg, source: 'underdog', timestamp: now };
  }

  const posRankCounters = {};
  const now = new Date().toISOString();

  const runUpserts = db.transaction(() => {
    let count = 0;
    players.forEach(p => {
      if (!p.name || !p.position) return;
      posRankCounters[p.position] = (posRankCounters[p.position] || 0) + 1;
      const posRank = posRankCounters[p.position];

      const existing = getPlayer.get(p.name, p.position);
      const adpConsensus = computeConsensus(
        existing ? existing.adp_fantasypros : null,
        p.adp,
        existing ? existing.adp_sleeper : null
      );

      const row = {
        name: p.name,
        position: p.position,
        nfl_team: p.nfl_team || null,
        adp_underdog: p.adp,
        pos_rank_underdog: posRank,
        adp_consensus: adpConsensus,
        last_updated: now,
      };

      if (existing) {
        updatePlayer.run(row);
      } else {
        upsertPlayer.run(row);
      }
      count++;
    });
    return count;
  });

  const count = runUpserts();
  updateMeta.run(now, count, 'ok');
  console.log(`[Underdog] Updated ${count} players`);
  return { success: true, players_updated: count, source: 'underdog', timestamp: now };
}

module.exports = { fetchUnderdog };
