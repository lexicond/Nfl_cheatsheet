const { db } = require('../db');
const { get, JSON_HEADERS } = require('../utils/http');
const { normalizeName } = require('../utils/normalize');
const { createMatcher } = require('../utils/match');
const { scrapeDraftSharks } = require('../utils/draftsharks');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);
const SEASON_YEAR = new Date().getFullYear();

// Underdog publishes no public ADP API (every documented endpoint now 404s), so
// DraftSharks' Underdog best-ball board is the primary read, with FFC half-PPR
// redraft ADP as a clearly-labelled stand-in if that ever goes dark.
const DRAFTSHARKS_UD = 'https://www.draftsharks.com/adp/best-ball/half-ppr/underdog/12';
const FFC_FALLBACKS = [
  `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${SEASON_YEAR}&position=all`,
  `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${SEASON_YEAR - 1}&position=all`,
];

async function fromFfc() {
  for (const url of FFC_FALLBACKS) {
    try {
      const res = await get(url, { headers: JSON_HEADERS, timeout: 20000 });
      const rows = res.data?.players;
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const players = rows
        .map(p => ({
          name: p.name,
          position: (p.position || '').toUpperCase(),
          nfl_team: (p.team || '').toUpperCase() || null,
          adp: parseFloat(p.adp),
        }))
        .filter(p => p.name && POS_ALLOW.has(p.position) && Number.isFinite(p.adp));
      if (players.length > 0) return players;
    } catch (err) {
      console.warn(`[Underdog] FFC fallback ${url} failed: ${err.message}`);
    }
  }
  return [];
}

async function fetchUnderdog() {
  const findPlayer = createMatcher(db);
  const now = new Date().toISOString();

  const insertPlayer = db.prepare(`
    INSERT INTO players (name, name_normalized, position, nfl_team, adp_underdog, pos_rank_underdog, last_updated)
    VALUES (@name, @name_normalized, @position, @nfl_team, @adp, @pos_rank, @ts)
  `);
  const updatePlayer = db.prepare(`
    UPDATE players
    SET adp_underdog = @adp,
        pos_rank_underdog = @pos_rank,
        nfl_team = COALESCE(@nfl_team, nfl_team),
        last_updated = @ts
    WHERE id = @id
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'underdog'
  `);

  let players = [];
  let via = 'Underdog (via DraftSharks)';

  try {
    players = await scrapeDraftSharks(DRAFTSHARKS_UD);
    console.log(`[Underdog] DraftSharks best-ball board: ${players.length} players`);
  } catch (err) {
    console.warn('[Underdog] DraftSharks scrape failed:', err.message);
  }

  if (players.length === 0) {
    players = await fromFfc();
    if (players.length > 0) {
      via = 'FFC ½PPR redraft (Underdog unavailable)';
      console.log(`[Underdog] Falling back to FFC: ${players.length} players`);
    }
  }

  if (players.length === 0) {
    updateMeta.run(now, 0, 'error', 'DraftSharks and FFC both unavailable');
    return { success: false, error: 'No Underdog ADP available', source: 'underdog', timestamp: now };
  }

  // Position rank follows draft order, so rank by ADP rather than by response order.
  players.sort((a, b) => a.adp - b.adp);

  const posCounters = {};
  const count = db.transaction(() => {
    let n = 0;
    for (const p of players) {
      if (!p.name || !POS_ALLOW.has(p.position)) continue;
      posCounters[p.position] = (posCounters[p.position] || 0) + 1;
      const pos_rank = posCounters[p.position];

      const target = findPlayer(p.name, p.position, p.nfl_team);
      if (target) {
        updatePlayer.run({ id: target.id, adp: p.adp, pos_rank, nfl_team: p.nfl_team, ts: now });
      } else {
        insertPlayer.run({
          name: p.name,
          name_normalized: normalizeName(p.name),
          position: p.position,
          nfl_team: p.nfl_team,
          adp: p.adp,
          pos_rank,
          ts: now,
        });
      }
      n++;
    }
    return n;
  })();

  updateMeta.run(now, count, 'ok', via);
  console.log(`[Underdog] Updated ${count} players (${via})`);
  return { success: true, players_updated: count, actual_source: via, source: 'underdog', timestamp: now };
}

module.exports = { fetchUnderdog };
