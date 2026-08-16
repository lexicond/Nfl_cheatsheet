const { db } = require('../db');
const { get, JSON_HEADERS } = require('../utils/http');
const { normalizeName } = require('../utils/normalize');
const { createMatcher } = require('../utils/match');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);
const SEASON_YEAR = new Date().getFullYear();

// Fantasy Football Calculator publishes real mock-draft ADP, free and unauthenticated.
// half-ppr feeds the 1QB redraft consensus; 2qb feeds the superflex one.
function endpointsFor(scoring, year) {
  return `https://fantasyfootballcalculator.com/api/v1/adp/${scoring}?teams=12&year=${year}&position=all`;
}

const FFC_SOURCES = [
  { scoring: 'half-ppr', column: 'adp_ffc',    label: '½PPR', primary: true },
  { scoring: '2qb',      column: 'adp_ffc_sf', label: '2QB' },
];

async function fetchOne(scoring) {
  // Fall back a season only if the current one has not opened yet.
  for (const year of [SEASON_YEAR, SEASON_YEAR - 1]) {
    try {
      const res = await get(endpointsFor(scoring, year), { headers: JSON_HEADERS, timeout: 20000 });
      const rows = res.data?.players;
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const players = rows
        .map(p => ({
          name: p.name,
          position: (p.position || '').toUpperCase(),
          nfl_team: (p.team || '').toUpperCase() || null,
          adp: parseFloat(p.adp),
          bye_week: Number.isFinite(Number(p.bye)) && Number(p.bye) > 0 ? Number(p.bye) : null,
        }))
        .filter(p => p.name && POS_ALLOW.has(p.position) && Number.isFinite(p.adp));
      if (players.length > 0) {
        return { players, year, drafts: res.data?.meta?.total_drafts ?? null, through: res.data?.meta?.end_date ?? null };
      }
    } catch (err) {
      console.warn(`[FFC] ${scoring} ${year} failed: ${err.message}`);
    }
  }
  return null;
}

async function fetchFFC() {
  const findPlayer = createMatcher(db);
  const now = new Date().toISOString();

  const insertPlayer = db.prepare(`
    INSERT INTO players (name, name_normalized, position, nfl_team, bye_week, adp_ffc, last_updated)
    VALUES (@name, @name_normalized, @position, @nfl_team, @bye_week, @adp, @ts)
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'ffc'
  `);

  const results = await Promise.all(FFC_SOURCES.map(async src => ({ ...src, data: await fetchOne(src.scoring) })));

  const notes = [];
  let primaryCount = 0;

  for (const src of results) {
    if (!src.data) {
      console.warn(`[FFC] No data for ${src.label}`);
      continue;
    }
    const { players, year, drafts, through } = src.data;

    const updateAdp = db.prepare(`
      UPDATE players
      SET ${src.column} = @adp,
          nfl_team = COALESCE(@nfl_team, nfl_team),
          bye_week = COALESCE(@bye_week, bye_week),
          last_updated = @ts
      WHERE id = @id
    `);

    const count = db.transaction(() => {
      let n = 0;
      for (const p of players) {
        let target = findPlayer(p.name, p.position, p.nfl_team);
        if (!target && src.primary) {
          const info = insertPlayer.run({
            name: p.name,
            name_normalized: normalizeName(p.name),
            position: p.position,
            nfl_team: p.nfl_team,
            bye_week: p.bye_week,
            adp: p.adp,
            ts: now,
          });
          target = { id: info.lastInsertRowid };
        }
        if (!target) continue;
        updateAdp.run({ id: target.id, adp: p.adp, nfl_team: p.nfl_team, bye_week: p.bye_week, ts: now });
        n++;
      }
      return n;
    })();

    if (src.primary) primaryCount = count;
    notes.push(`${src.label} ${count} (${year}, ${drafts ?? '?'} drafts thru ${through ?? '?'})`);
    console.log(`[FFC] ${src.label}: ${count} players → ${src.column}`);
  }

  if (notes.length === 0) {
    updateMeta.run(now, 0, 'error', 'No FFC data for any scoring format');
    return { success: false, error: 'No data from FFC', source: 'ffc', timestamp: now };
  }

  updateMeta.run(now, primaryCount, 'ok', notes.join('; '));
  return { success: true, players_updated: primaryCount, formats: notes, source: 'ffc', timestamp: now };
}

module.exports = { fetchFFC };
