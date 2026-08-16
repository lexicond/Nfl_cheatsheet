const { db } = require('../db');
const { get, extractJsObject } = require('../utils/http');
const { normalizeName } = require('../utils/normalize');
const { createMatcher } = require('../utils/match');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);

// FantasyPros renders its ranking tables client-side; the ECR payload is embedded
// as `ecrData`. Note that best-ball-cheatsheets.php now 302s to the generic
// consensus page — best-ball-overall.php is the live best-ball URL.
const FP_SOURCES = [
  { url: 'https://www.fantasypros.com/nfl/rankings/best-ball-overall.php',          column: 'adp_fantasypros', label: 'Best Ball', primary: true },
  { url: 'https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php', column: 'adp_fp_rd',       label: 'Redraft ½PPR' },
  { url: 'https://www.fantasypros.com/nfl/rankings/superflex-cheatsheets.php',      column: 'adp_fp_sf',       label: 'Superflex' },
  { url: 'https://www.fantasypros.com/nfl/rankings/dynasty-overall.php',            column: 'adp_fp_dyn',      label: 'Dynasty' },
];

function parseByeWeek(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= 18 ? n : null;
}

async function scrapeFpPage(url) {
  const res = await get(url);
  const data = extractJsObject(res.data, 'ecrData');
  if (!data || !Array.isArray(data.players)) throw new Error(`No ecrData at ${url}`);

  const players = [];
  for (const p of data.players) {
    const position = (p.player_position_id || '').toUpperCase();
    if (!POS_ALLOW.has(position)) continue;
    const name = (p.player_name || '').trim();
    const rank = Number(p.rank_ecr);
    if (!name || !Number.isFinite(rank) || rank <= 0) continue;
    players.push({
      name,
      position,
      nfl_team: (p.player_team_id || '').toUpperCase() || null,
      rank,
      bye_week: parseByeWeek(p.player_bye_week),
      tier: Number.isFinite(Number(p.tier)) ? Number(p.tier) : null,
      pos_rank: parseInt(String(p.pos_rank || '').replace(/\D/g, ''), 10) || null,
    });
  }
  return { players, year: data.year, updated: data.last_updated };
}

async function fetchFantasyPros() {
  const findPlayer = createMatcher(db);
  const now = new Date().toISOString();

  const insertPlayer = db.prepare(`
    INSERT INTO players (name, name_normalized, position, nfl_team, bye_week, last_updated)
    VALUES (@name, @name_normalized, @position, @nfl_team, @bye_week, @last_updated)
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'fantasypros'
  `);

  const results = await Promise.allSettled(
    FP_SOURCES.map(src => scrapeFpPage(src.url).then(r => ({ ...src, ...r })))
  );

  const notes = [];
  const failures = [];
  let primaryCount = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const src = FP_SOURCES[i];

    if (result.status === 'rejected') {
      failures.push(`${src.label}: ${result.reason?.message || 'failed'}`);
      console.warn(`[FantasyPros] ${src.label} failed: ${result.reason?.message}`);
      continue;
    }

    const { column, label, players, primary } = result.value;
    if (players.length === 0) {
      failures.push(`${label}: empty`);
      continue;
    }

    // Built per column, so the column name never comes from request input.
    const updateRank = db.prepare(`
      UPDATE players
      SET ${column} = @rank,
          nfl_team = COALESCE(@nfl_team, nfl_team),
          bye_week = COALESCE(@bye_week, bye_week),
          last_updated = @ts
      WHERE id = @id
    `);
    const updatePrimaryExtras = db.prepare(`
      UPDATE players SET pos_rank_fantasypros = @pos_rank, fp_tier = @tier WHERE id = @id
    `);

    const count = db.transaction(() => {
      let n = 0;
      for (const p of players) {
        let target = findPlayer(p.name, p.position, p.nfl_team);

        // Only the best-ball page may introduce players; the other pages would
        // otherwise create duplicate rows for anyone the matcher misses.
        if (!target && primary) {
          const info = insertPlayer.run({
            name: p.name,
            name_normalized: normalizeName(p.name),
            position: p.position,
            nfl_team: p.nfl_team,
            bye_week: p.bye_week,
            last_updated: now,
          });
          target = { id: info.lastInsertRowid };
        }
        if (!target) continue;

        updateRank.run({ id: target.id, rank: p.rank, nfl_team: p.nfl_team, bye_week: p.bye_week, ts: now });
        if (primary) updatePrimaryExtras.run({ id: target.id, pos_rank: p.pos_rank, tier: p.tier });
        n++;
      }
      return n;
    })();

    if (primary) primaryCount = count;
    notes.push(`${label} ${count}`);
    console.log(`[FantasyPros] ${label}: ${count} players → ${column}`);
  }

  if (notes.length === 0) {
    updateMeta.run(now, 0, 'error', failures.join('; ').slice(0, 300));
    return { success: false, error: `All FantasyPros pages failed: ${failures.join('; ')}`, source: 'fantasypros', timestamp: now };
  }

  updateMeta.run(now, primaryCount, 'ok', notes.join(', ') + (failures.length ? ` | failed: ${failures.join('; ')}` : ''));
  return {
    success: true,
    players_updated: primaryCount,
    pages: notes,
    failed_pages: failures,
    source: 'fantasypros',
    timestamp: now,
  };
}

module.exports = { fetchFantasyPros };
