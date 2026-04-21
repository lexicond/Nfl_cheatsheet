const axios = require('axios');
const cheerio = require('cheerio');
const { db, computeConsensus } = require('../db');
const { normalizeName } = require('./sleeper');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'en-US,en;q=0.5',
};

// Direct Underdog API endpoints (JSON)
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
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'underdog'
  `);

  let players = [];
  let lastError = null;
  let udSource = 'Underdog';

  // 1. Try Underdog JSON API endpoints
  for (const url of API_URLS) {
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
      const data = res.data;
      const rankings = data.rankings || data.players || data.player_rankings || data.data || [];
      if (Array.isArray(rankings) && rankings.length > 0) {
        players = rankings.map((p, i) => ({
          name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || p.player_name,
          position: parsePosition(p.position || p.player_position),
          nfl_team: (p.team || p.nfl_team || p.team_abbr || '').toUpperCase() || null,
          adp: p.adp || p.average_pick || p.rank || i + 1,
        })).filter(p => p.name);

        if (players.length > 0) {
          console.log(`[Underdog] Got ${players.length} players from API: ${url}`);
          udSource = 'Underdog';
          break;
        }
      }
    } catch (err) {
      lastError = err;
      console.warn(`[Underdog] API ${url} failed: ${err.message}`);
    }
  }

  // 2. DraftSharks Underdog ADP page (scrape)
  if (players.length === 0) {
    try {
      const res = await axios.get('https://www.draftsharks.com/adp/underdog', {
        headers: { ...HEADERS, Accept: 'text/html' },
        timeout: 20000,
      });
      const $ = cheerio.load(res.data);
      // DraftSharks renders a table with columns: Rank, Player, Team, Position, ADP, ...
      $('table tbody tr').each((i, row) => {
        const cells = $(row).find('td');
        if (cells.length < 4) return;
        const nameEl = $(cells[1]).find('a').first();
        const name = (nameEl.text() || $(cells[1]).text()).trim();
        const team = $(cells[2]).text().trim();
        const pos = $(cells[3]).text().trim();
        // ADP may be in column 4 or 5 depending on table layout
        const adpText = $(cells[4]).text().trim() || $(cells[3]).text().trim();
        const adp = parseFloat(adpText);
        if (name && !isNaN(adp) && adp > 0) {
          players.push({
            name,
            position: parsePosition(pos),
            nfl_team: team.toUpperCase() || null,
            adp,
          });
        }
      });
      if (players.length > 0) {
        console.log(`[Underdog] Got ${players.length} players from DraftSharks`);
        udSource = 'DraftSharks';
      }
    } catch (err) {
      console.warn('[Underdog] DraftSharks scrape failed:', err.message);
    }
  }

  // 3. Underdog pick-rates HTML page (may be JS-rendered, best effort)
  if (players.length === 0) {
    try {
      const res = await axios.get('https://underdogfantasy.com/pick-rates', {
        headers: { ...HEADERS, Accept: 'text/html' },
        timeout: 15000,
      });
      const $ = cheerio.load(res.data);
      $('tr, .player-row, [class*="player"]').each((i, el) => {
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
      if (players.length > 0) {
        console.log(`[Underdog] Got ${players.length} players from pick-rates page`);
        udSource = 'Underdog';
      }
    } catch (err) {
      console.warn('[Underdog] Pick-rates fallback failed:', err.message);
    }
  }

  // 4. Final fallback: FFC half-PPR ADP
  if (players.length === 0) {
    const ffcUrls = [
      'https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=2025&position=all',
      'https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=2024&position=all',
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
            console.log(`[Underdog] Got ${players.length} players from FFC fallback`);
            udSource = 'FFC';
            break;
          }
        }
      } catch (err) {
        console.warn(`[Underdog] FFC fallback ${url} failed:`, err.message);
      }
    }
  }

  if (players.length === 0) {
    const now = new Date().toISOString();
    const msg = lastError ? lastError.message : 'No data returned from any Underdog/DraftSharks/FFC endpoint';
    updateMeta.run(now, 0, 'error', null);
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
        existing ? existing.adp_sleeper : null,
        existing ? existing.adp_ffc : null,
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
  updateMeta.run(now, count, 'ok', udSource);
  console.log(`[Underdog] Updated ${count} players (source: ${udSource})`);
  return { success: true, players_updated: count, source: 'underdog', actual_source: udSource, timestamp: now };
}

module.exports = { fetchUnderdog };
