const axios = require('axios');
const cheerio = require('cheerio');
const { db, computeConsensus } = require('../db');
const { normalizeName } = require('../utils/normalize');

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

// DraftSharks ADP is "round.pick" e.g. "1.10" = round 1 pick 10 = overall pick 10 in 12-team
function parseRoundPick(str, teamSize = 12) {
  const parts = String(str).split('.');
  if (parts.length !== 2) return null;
  const round = parseInt(parts[0], 10);
  const pick = parseInt(parts[1], 10);
  if (isNaN(round) || isNaN(pick) || round < 1 || pick < 1) return null;
  return (round - 1) * teamSize + pick;
}

async function fetchUnderdog() {
  const getPlayer = db.prepare(`SELECT * FROM players WHERE name = ? AND position = ?`);
  const getByNorm = db.prepare(`SELECT * FROM players WHERE name_normalized = ? AND position = ?`);
  // Query name_normalized with a lowercase last-name pattern for abbreviated names (e.g. "B. Robinson")
  const getByLastName = db.prepare(`SELECT * FROM players WHERE name_normalized LIKE ? AND position = ?`);
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
    WHERE id = @id
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
      // DraftSharks table: Rank | Player (link, may be abbreviated) | ADP (round.pick) | Position | Team
      $('table tbody tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 3) return;

        // Player name: first anchor in the row
        const nameEl = $(row).find('a').first();
        const rawName = (nameEl.text() || $(cells[1]).text()).trim();

        // Find ADP (round.pick pattern), position, team by scanning all cells
        let adpOverall = null;
        let pos = null;
        let team = null;
        cells.each((_, cell) => {
          const txt = $(cell).text().trim();
          const adpMatch = txt.match(/^(\d{1,2})\.(\d{1,2})$/);
          if (adpMatch && adpOverall == null) {
            adpOverall = parseRoundPick(txt);
          }
          if (/^(QB|RB|WR|TE|K|DEF|DST)$/i.test(txt) && pos == null) {
            pos = txt.toUpperCase();
          }
          if (/^[A-Z]{2,3}$/.test(txt) && txt !== pos && !['NFL', 'ADP', 'RK'].includes(txt) && team == null) {
            team = txt;
          }
        });

        if (rawName && adpOverall != null && pos) {
          players.push({
            name: rawName,
            position: parsePosition(pos),
            nfl_team: team || null,
            adp: adpOverall,
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
    const SEASON_YEAR = new Date().getFullYear();
    const ffcUrls = [
      `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${SEASON_YEAR}&position=all`,
      `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${SEASON_YEAR - 1}&position=all`,
      `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${SEASON_YEAR - 2}&position=all`,
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

  function findExisting(name, pos) {
    let row = getPlayer.get(name, pos);
    if (row) return row;
    const norm = normalizeName(name);
    row = getByNorm.get(norm, pos);
    if (row) return row;
    // Abbreviated name: extract last name for LIKE query against name_normalized (lowercase)
    const parts = norm.split(' ');
    if (parts.length >= 2) {
      const lastName = parts[parts.length - 1]; // already lowercase
      row = getByLastName.get(`% ${lastName}`, pos);
      if (!row) row = getByLastName.get(`${lastName} %`, pos);
    }
    return row || null;
  }

  const runUpserts = db.transaction(() => {
    let count = 0;
    players.forEach(p => {
      if (!p.name || !p.position) return;
      posRankCounters[p.position] = (posRankCounters[p.position] || 0) + 1;
      const posRank = posRankCounters[p.position];

      const existing = findExisting(p.name, p.position);
      const adpConsensus = computeConsensus(
        existing ? existing.adp_fantasypros : null,
        p.adp,
        existing ? existing.adp_ffc : null,
      );

      const row = {
        nfl_team: p.nfl_team || null,
        adp_underdog: p.adp,
        pos_rank_underdog: posRank,
        adp_consensus: adpConsensus,
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
