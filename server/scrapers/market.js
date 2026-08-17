const { db } = require('../db');
const { createMatcher, createClaimGuard } = require('../utils/match');
const { scrapeDraftSharks } = require('../utils/draftsharks');

// Home-league platform ADP. ESPN and Yahoo drafts behave differently from the
// industry consensus (notably at QB and TE), so they are worth carrying next to
// the expert boards rather than folded into them invisibly.
const MARKET_SOURCES = [
  { url: 'https://www.draftsharks.com/adp/ppr/espn/12',       column: 'adp_espn',  label: 'ESPN PPR' },
  { url: 'https://www.draftsharks.com/adp/half-ppr/yahoo/12', column: 'adp_yahoo', label: 'Yahoo ½PPR' },
];

async function fetchMarket() {
  const findPlayer = createMatcher(db);
  const now = new Date().toISOString();
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'market'
  `);

  const results = await Promise.allSettled(
    MARKET_SOURCES.map(src => scrapeDraftSharks(src.url).then(players => ({ ...src, players })))
  );

  const notes = [];
  const failures = [];
  let total = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const src = MARKET_SOURCES[i];

    if (result.status === 'rejected') {
      failures.push(`${src.label}: ${result.reason?.message || 'failed'}`);
      console.warn(`[Market] ${src.label} failed: ${result.reason?.message}`);
      continue;
    }

    const { column, label, players } = result.value;
    if (players.length === 0) {
      failures.push(`${label}: empty`);
      continue;
    }

    // Existing players only — these boards never introduce rows of their own.
    const updateAdp = db.prepare(`UPDATE players SET ${column} = @adp, last_updated = @ts WHERE id = @id`);

    const claim = createClaimGuard(`Market ${label}`);
    const count = db.transaction(() => {
      let n = 0;
      for (const p of players) {
        const target = findPlayer(p.name, p.position, p.nfl_team);
        if (!target || !claim(target.id, p.name)) continue;
        updateAdp.run({ id: target.id, adp: p.adp, ts: now });
        n++;
      }
      return n;
    })();

    total += count;
    notes.push(`${label} ${count}`);
    console.log(`[Market] ${label}: ${count} players → ${column}`);
  }

  if (notes.length === 0) {
    updateMeta.run(now, 0, 'error', failures.join('; ').slice(0, 300));
    return { success: false, error: `All market boards failed: ${failures.join('; ')}`, source: 'market', timestamp: now };
  }

  updateMeta.run(now, total, 'ok', notes.join(', ') + (failures.length ? ` | failed: ${failures.join('; ')}` : ''));
  return { success: true, players_updated: total, boards: notes, failed_boards: failures, source: 'market', timestamp: now };
}

module.exports = { fetchMarket };
