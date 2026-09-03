const { db } = require('../db');
const { get, extractJsObject } = require('../utils/http');
const { normalizeName } = require('../utils/normalize');
const { createMatcher, createClaimGuard } = require('../utils/match');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);

// FantasyPros renders its ranking tables client-side; the ECR payload is embedded
// as `ecrData`.
//
// Several plausible-looking URLs (best-ball-cheatsheets, dynasty-superflex-overall,
// best-ball-half-ppr-overall, dynasty-ppr-overall …) quietly redirect to the generic
// standard-scoring redraft board and still return a valid 200 with valid ecrData.
// Nothing in the response says it is the wrong board except the type and scoring
// fields, so `expect` below is checked on every fetch and a mismatch is rejected.
const FP_SOURCES = [
  {
    url: 'https://www.fantasypros.com/nfl/rankings/best-ball-overall.php',
    column: 'adp_fantasypros', tierColumn: 'fp_tier', label: 'Best Ball', primary: true,
    expect: { type: 'Best Ball', scoring: 'PPR', position: 'ALL' },
  },
  {
    url: 'https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php',
    column: 'adp_fp_rd', tierColumn: 'fp_tier_rd', label: 'Redraft ½PPR',
    expect: { type: 'Draft Half PPR', scoring: 'HALF', position: 'ALL' },
  },
  {
    // superflex-cheatsheets.php is the STANDARD-scoring superflex board; this app
    // is half-PPR throughout, so it uses the half-PPR superflex board instead.
    url: 'https://www.fantasypros.com/nfl/rankings/half-point-ppr-superflex-cheatsheets.php',
    column: 'adp_fp_sf', tierColumn: 'fp_tier_sf', label: 'Superflex ½PPR',
    expect: { type: 'Draft Half PPR', scoring: 'HALF', position: 'OP' },
  },
  {
    url: 'https://www.fantasypros.com/nfl/rankings/dynasty-overall.php',
    column: 'adp_fp_dyn', tierColumn: 'fp_tier_dyn', label: 'Dynasty',
    expect: { type: 'Dynasty', scoring: 'PPR', position: 'ALL' },
  },
  {
    // dynasty-superflex-overall.php and the ppr-/half-point-ppr- prefixed variants all
    // redirect to the generic redraft board; this is the real one.
    url: 'https://www.fantasypros.com/nfl/rankings/dynasty-superflex.php',
    column: 'adp_fp_dyn_sf', tierColumn: 'fp_tier_dyn_sf', label: 'Dynasty SF',
    expect: { type: 'Dynasty', scoring: 'PPR', position: 'OP' },
  },
];

function parseByeWeek(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= 18 ? n : null;
}

async function scrapeFpPage(url, expect) {
  const res = await get(url);
  const data = extractJsObject(res.data, 'ecrData');
  if (!data || !Array.isArray(data.players)) throw new Error(`No ecrData at ${url}`);

  if (expect) {
    if (data.type !== expect.type || data.scoring !== expect.scoring) {
      throw new Error(
        `${url} served "${data.type}/${data.scoring}", expected "${expect.type}/${expect.scoring}" ` +
        '— the page most likely now redirects to a different board'
      );
    }
    // The tier stored off these pages is an OVERALL tier, and that is only true while
    // the payload is the overall board. `?position=RB` and the positional pages return
    // the same type and scoring with per-position tiers numbered from 1, which would be
    // written into the same column and read as though a WR3 were an overall Tier 3.
    if (data.position_id !== expect.position) {
      throw new Error(
        `${url} served the ${data.position_id} board, expected ${expect.position} ` +
        '— its tiers would be positional rather than overall'
      );
    }
  }
  const wantYear = new Date().getFullYear();
  if (data.year && Number(data.year) !== wantYear) {
    throw new Error(`${url} served ${data.year} rankings, expected ${wantYear}`);
  }

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
    FP_SOURCES.map(src => scrapeFpPage(src.url, src.expect).then(r => ({ ...src, ...r })))
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

    const { column, tierColumn, label, players, primary } = result.value;
    if (players.length === 0) {
      failures.push(`${label}: empty`);
      continue;
    }

    // Built per column, so the column name never comes from request input.
    const updateRank = db.prepare(`
      UPDATE players
      SET ${column} = @rank,
          ${tierColumn} = @tier,
          nfl_team = COALESCE(@nfl_team, nfl_team),
          bye_week = COALESCE(@bye_week, bye_week),
          last_updated = @ts
      WHERE id = @id
    `);
    // A tier has to be withdrawn, not merely written. FantasyPros drops players off a
    // board between runs, and a tier left behind reads as current because every column
    // beside it is — the cheat sheet would go on grouping a man nobody ranks any more
    // into Tier 4. Cleared inside the transaction, so a board that failed to fetch is
    // skipped entirely and keeps what it had.
    const clearTiers = db.prepare(`UPDATE players SET ${tierColumn} = NULL`);
    const updatePrimaryExtras = db.prepare(`
      UPDATE players SET pos_rank_fantasypros = @pos_rank WHERE id = @id
    `);

    const claim = createClaimGuard(`FantasyPros ${label}`);
    const count = db.transaction(() => {
      let n = 0;
      clearTiers.run();
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
        if (!target || !claim(target.id, p.name)) continue;

        updateRank.run({
          id: target.id, rank: p.rank, tier: p.tier,
          nfl_team: p.nfl_team, bye_week: p.bye_week, ts: now,
        });
        if (primary) updatePrimaryExtras.run({ id: target.id, pos_rank: p.pos_rank });
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
