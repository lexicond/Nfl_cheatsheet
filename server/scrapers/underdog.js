const { db } = require('../db');
const { normalizeName } = require('../utils/normalize');
const { scrapeDraftSharks } = require('../utils/draftsharks');

// Underdog only runs Best Ball drafts — BB half-PPR 12-team via DraftSharks
const UNDERDOG_BB_URL = 'https://www.draftsharks.com/adp/best-ball/half-ppr/underdog/12';

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
  const now = new Date().toISOString();

  try {
    players = await scrapeDraftSharks(UNDERDOG_BB_URL);
    if (players.length === 0) throw new Error('DraftSharks returned no players');
    console.log(`[Underdog] Got ${players.length} players from DraftSharks BB`);
  } catch (err) {
    console.error('[Underdog] DraftSharks scrape failed:', err.message);
    updateMeta.run(now, 0, 'error', null);
    return { success: false, error: err.message, source: 'underdog', timestamp: now };
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
  updateMeta.run(now, count, 'ok', 'DraftSharks');
  console.log(`[Underdog] Updated ${count} players (BB only)`);
  return { success: true, players_updated: count, source: 'underdog', actual_source: 'DraftSharks', timestamp: now };
}

module.exports = { fetchUnderdog };
