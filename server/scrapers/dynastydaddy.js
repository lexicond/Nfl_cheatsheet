const { db } = require('../db');
const { get, JSON_HEADERS } = require('../utils/http');
const { createMatcher } = require('../utils/match');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);
const BASE = 'https://dynasty-daddy.com/api/v1/player';

// Dynasty Daddy aggregates several dynasty markets and exposes each one separately.
// Market codes come from its own repository (PlayerInfoRepository.GetPlayerValuesForMarket):
//   0 KeepTradeCut · 1 FantasyCalc · 2 DynastyProcess · 3 DynastySuperflex
//   4 KeepTradeCut redraft · 5 FantasyCalc redraft
//
// Only 0 and 3 are read here. FantasyCalc is already fetched from its own API, and
// DynastyProcess is fetched directly for its ECR columns — pulling either through
// Dynasty Daddy as well would put the same market into the consensus twice.
const MARKETS = [
  { code: 0, columns: ['ktc_value', 'ktc_value_sf'], label: 'KeepTradeCut' },
  { code: 3, columns: ['ds_value', 'ds_value_sf'], label: 'DynastySuperflex' },
];

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

async function fetchDynastyDaddy() {
  const findPlayer = createMatcher(db);
  const now = new Date().toISOString();

  const bySleeperId = db.prepare('SELECT id FROM players WHERE sleeper_player_id = ?');
  const updateAge = db.prepare('UPDATE players SET age = @age WHERE id = @id');
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'dynastydaddy'
  `);

  // The roster call carries the names, positions, ages and — crucially — the Sleeper
  // ids, so every market row can be resolved by id instead of by name string.
  let roster;
  try {
    const res = await get(`${BASE}/all/today`, { headers: JSON_HEADERS, timeout: 40000 });
    roster = Array.isArray(res.data) ? res.data : [];
    if (roster.length === 0) throw new Error('player/all/today returned no rows');
  } catch (err) {
    updateMeta.run(now, 0, 'error', err.message.slice(0, 200));
    console.warn('[DynastyDaddy] Roster fetch failed:', err.message);
    return { success: false, error: err.message, source: 'dynastydaddy', timestamp: now };
  }

  const byNameId = new Map();
  for (const p of roster) {
    if (p?.name_id && POS_ALLOW.has(p.position)) byNameId.set(p.name_id, p);
  }

  // Resolve each Dynasty Daddy player to a local row once, then reuse for both markets.
  const resolved = new Map();
  let ageCount = 0;
  db.transaction(() => {
    for (const [nameId, p] of byNameId) {
      const sid = p.sleeper_id != null ? String(p.sleeper_id) : null;
      const target = (sid && bySleeperId.get(sid)) || findPlayer(p.full_name, p.position, p.team);
      if (!target) continue;
      resolved.set(nameId, target.id);
      const age = Number(p.age);
      if (Number.isFinite(age) && age > 0 && age < 50) { updateAge.run({ id: target.id, age }); ageCount++; }
    }
  })();

  const notes = [];
  const failures = [];

  for (const market of MARKETS) {
    let rows;
    try {
      const res = await get(`${BASE}/all/market/${market.code}`, { headers: JSON_HEADERS, timeout: 40000 });
      rows = Array.isArray(res.data) ? res.data : [];
      if (rows.length === 0) throw new Error('empty market response');
    } catch (err) {
      failures.push(`${market.label}: ${err.message}`);
      console.warn(`[DynastyDaddy] ${market.label} failed:`, err.message);
      continue;
    }

    const [col1qb, colSf] = market.columns;
    const update = db.prepare(
      `UPDATE players SET ${col1qb} = @v1, ${colSf} = @vsf, last_updated = @ts WHERE id = @id`
    );

    const count = db.transaction(() => {
      let n = 0;
      for (const r of rows) {
        const id = resolved.get(r.name_id);
        if (!id) continue;
        const v1 = num(r.trade_value);
        const vsf = num(r.sf_trade_value);
        if (v1 == null && vsf == null) continue;
        update.run({ id, v1, vsf, ts: now });
        n++;
      }
      return n;
    })();

    notes.push(`${market.label} ${count}`);
    console.log(`[DynastyDaddy] ${market.label}: ${count} players → ${col1qb}/${colSf}`);
  }

  if (notes.length === 0) {
    updateMeta.run(now, 0, 'error', failures.join('; ').slice(0, 300));
    return { success: false, error: `All markets failed: ${failures.join('; ')}`, source: 'dynastydaddy', timestamp: now };
  }

  console.log(`[DynastyDaddy] Ages: ${ageCount} players`);
  updateMeta.run(now, resolved.size, 'ok',
    `${notes.join(', ')}; ages ${ageCount}` + (failures.length ? ` | failed: ${failures.join('; ')}` : ''));
  return {
    success: true, players_updated: resolved.size, markets: notes,
    ages_updated: ageCount, failed_markets: failures,
    source: 'dynastydaddy', timestamp: now,
  };
}

module.exports = { fetchDynastyDaddy };
