const axios = require('axios');
const cheerio = require('cheerio');
const { db } = require('../db');
const { normalizeName } = require('../utils/normalize');
const { scrapeDraftSharks } = require('../utils/draftsharks');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'en-US,en;q=0.5',
};

// Underdog JSON API endpoints (tried in order)
const API_URLS = [
  'https://api.underdogfantasy.com/v1/fantasy_draft_rankings',
  'https://api.underdogfantasy.com/v3/fantasy_draft_rankings',
  'https://api.underdogfantasy.com/v2/fantasy_draft_rankings',
  'https://api.underdogfantasy.com/v1/player_rankings',
  'https://api.underdogfantasy.com/v2/player_rankings',
  'https://api.underdogfantasy.com/v1/best_ball_rankings',
];

const POS_MAP = { 'QB': 'QB', 'RB': 'RB', 'WR': 'WR', 'TE': 'TE', 'K': 'K', 'DST': 'DEF', 'D/ST': 'DEF' };
function parsePosition(raw) {
  return POS_MAP[(raw || '').toUpperCase().trim()] || (raw || '').toUpperCase().trim() || null;
}

async function fetchUnderdog() {
  const getPlayer = db.prepare(`SELECT * FROM players WHERE name = ? AND position = ?`);
  const getByNorm = db.prepare(`SELECT * FROM players WHERE name_normalized = ? AND position = ?`);
  const getByLastName = db.prepare(`SELECT * FROM players WHERE name_normalized LIKE ? AND position = ?`);
  const upsertPlayer = db.prepare(`
    INSERT INTO players (name, position, nfl_team, adp_underdog, pos_rank_underdog, last_updated)
    VALUES (@name, @position, @nfl_team, @adp_underdog, @pos_rank_underdog, @last_updated)
    ON CONFLICT DO NOTHING
  `);
  const updatePlayer = db.prepare(`
    UPDATE players
    SET nfl_team = COALESCE(@nfl_team, nfl_team),
        adp_underdog = @adp_underdog,
        pos_rank_underdog = @pos_rank_underdog,
        last_updated = @last_updated
    WHERE id = @id
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'underdog'
  `);

  function findExisting(name, pos) {
    let row = getPlayer.get(name, pos);
    if (row) return row;
    const norm = normalizeName(name);
    row = getByNorm.get(norm, pos);
    if (row) return row;
    const parts = norm.split(' ');
    if (parts.length >= 2) {
      const lastName = parts[parts.length - 1];
      row = getByLastName.get(`% ${lastName}`, pos);
      if (!row) row = getByLastName.get(`${lastName} %`, pos);
    }
    return row || null;
  }

  let players = [];
  let udSource = 'Underdog';
  const now = new Date().toISOString();

  // 1. Try Underdog JSON API endpoints
  for (const url of API_URLS) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
      const data = res.data;
      const rankings = data.rankings || data.players || data.player_rankings || data.data || [];
      if (Array.isArray(rankings) && rankings.length > 0) {
        const mapped = rankings.map((p, i) => ({
          name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || p.player_name,
          position: parsePosition(p.position || p.player_position),
          nfl_team: (p.team || p.nfl_team || p.team_abbr || '').toUpperCase() || null,
          adp: p.adp || p.average_pick || p.rank || i + 1,
        })).filter(p => p.name);
        if (mapped.length > 0) {
          players = mapped;
          udSource = 'Underdog';
          console.log(`[Underdog] Got ${players.length} players from API: ${url}`);
          break;
        }
      }
    } catch (err) {
      console.warn(`[Underdog] API ${url} failed: ${err.message}`);
    }
  }

  // 2. DraftSharks confirmed Underdog BB URL
  if (players.length === 0) {
    try {
      players = await scrapeDraftSharks('https://www.draftsharks.com/adp/best-ball/half-ppr/underdog/12');
      if (players.length > 0) {
        udSource = 'DraftSharks';
        console.log(`[Underdog] Got ${players.length} players from DraftSharks BB`);
      }
    } catch (err) {
      console.warn('[Underdog] DraftSharks BB scrape failed:', err.message);
    }
  }

  // 3. Underdog pick-rates HTML page (best-effort, may be JS-rendered)
  if (players.length === 0) {
    try {
      const res = await axios.get('https://underdogfantasy.com/pick-rates', {
        headers: { ...HEADERS, Accept: 'text/html' },
        timeout: 15000,
      });
      const $ = cheerio.load(res.data);
      const scraped = [];
      $('tr, .player-row, [class*="player"]').each((_, el) => {
        const cells = $(el).find('td, [class*="cell"]');
        if (cells.length >= 3) {
          const name = $(cells[0]).text().trim();
          const pos = $(cells[1]).text().trim();
          const adpText = $(cells[2]).text().trim();
          const adp = parseFloat(adpText);
          if (name && !isNaN(adp)) {
            scraped.push({ name, position: parsePosition(pos), nfl_team: null, adp });
          }
        }
      });
      if (scraped.length > 0) {
        players = scraped;
        udSource = 'Underdog';
        console.log(`[Underdog] Got ${players.length} players from pick-rates page`);
      }
    } catch (err) {
      console.warn('[Underdog] Pick-rates fallback failed:', err.message);
    }
  }

  // 4. FFC half-PPR as final fallback
  if (players.length === 0) {
    const YEAR = new Date().getFullYear();
    const ffcUrls = [
      `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${YEAR}&position=all`,
      `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${YEAR - 1}&position=all`,
    ];
    for (const url of ffcUrls) {
      try {
        const res = await axios.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          timeout: 15000,
        });
        if (res.data && Array.isArray(res.data.players) && res.data.players.length > 0) {
          players = res.data.players
            .map(p => ({
              name: p.name,
              position: parsePosition(p.position),
              nfl_team: (p.team || '').toUpperCase() || null,
              adp: parseFloat(p.adp),
            }))
            .filter(p => p.name && p.position && !isNaN(p.adp) && ['QB', 'RB', 'WR', 'TE'].includes(p.position));
          if (players.length > 0) {
            udSource = 'FFC';
            console.log(`[Underdog] Got ${players.length} players from FFC fallback`);
            break;
          }
        }
      } catch (err) {
        console.warn(`[Underdog] FFC fallback ${url} failed:`, err.message);
      }
    }
  }

  if (players.length === 0) {
    updateMeta.run(now, 0, 'error', null);
    console.error('[Underdog] All sources failed');
    return { success: false, error: 'No data from any Underdog/DraftSharks/FFC endpoint', source: 'underdog', timestamp: now };
  }

  const posRankCounters = {};
  const runUpserts = db.transaction(() => {
    let count = 0;
    players.forEach(p => {
      if (!p.name || !p.position) return;
      posRankCounters[p.position] = (posRankCounters[p.position] || 0) + 1;
      const posRank = posRankCounters[p.position];

      const existing = findExisting(p.name, p.position);
      const row = {
        nfl_team: p.nfl_team || null,
        adp_underdog: p.adp,
        pos_rank_underdog: posRank,
        last_updated: now,
      };

      if (existing) {
        updatePlayer.run({ ...row, id: existing.id });
      } else {
        upsertPlayer.run({ ...row, name: p.name, position: p.position });
      }
      count++;
    });
    return count;
  });

  const count = runUpserts();
  updateMeta.run(now, count, 'ok', udSource);
  console.log(`[Underdog] Updated ${count} players (source: ${udSource})`);
  return { success: true, players_updated: count, source: 'underdog', actual_source: udSource, timestamp: now };
}

module.exports = { fetchUnderdog };
