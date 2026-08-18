const { db } = require('../db');
const { get, JSON_HEADERS } = require('../utils/http');
const { createMatcher, createClaimGuard } = require('../utils/match');

const POS_ALLOW = new Set(['QB', 'RB', 'WR', 'TE']);

// FantasyCalc derives dynasty values from real completed trades.
const BASE = 'https://api.fantasycalc.com/values/current';
const URL_1QB = `${BASE}?isDynasty=true&numQbs=1&ppr=0.5`;
const URL_SF = `${BASE}?isDynasty=true&numQbs=2&ppr=0.5`;

async function fetchEndpoint(url) {
  const res = await get(url, { headers: JSON_HEADERS, timeout: 25000 });
  const data = res.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const parsed = data
    .filter(item => item?.player && item.value != null)
    .map(item => ({
      name: item.player.name,
      position: (item.player.position || '').toUpperCase(),
      nfl_team: (item.player.maybeTeam || '').toUpperCase() || null,
      sleeper_id: item.player.sleeperId != null ? String(item.player.sleeperId) : null,
      value: Math.round(Number(item.value)),
    }))
    .filter(p => p.name && POS_ALLOW.has(p.position) && Number.isFinite(p.value));
  return parsed.length > 0 ? parsed : null;
}

async function fetchFantasyCalc() {
  const findPlayer = createMatcher(db);
  const now = new Date().toISOString();

  const bySleeperId = db.prepare('SELECT id FROM players WHERE sleeper_player_id = ?');
  // Each column is written only when its own endpoint answered. A league type whose
  // fetch failed keeps its previous value rather than being handed the other one's.
  const updateFC = db.prepare(`
    UPDATE players SET
      fc_value    = CASE WHEN @has1qb = 1 THEN @v1qb ELSE fc_value END,
      fc_value_sf = CASE WHEN @hasSf  = 1 THEN @vsf  ELSE fc_value_sf END,
      last_updated = @ts
    WHERE id = @id
  `);
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ? WHERE source = 'fantasycalc'
  `);

  const [res1, resSf] = await Promise.allSettled([fetchEndpoint(URL_1QB), fetchEndpoint(URL_SF)]);
  const players1QB = res1.status === 'fulfilled' ? res1.value : null;
  const playersSF = resSf.status === 'fulfilled' ? resSf.value : null;

  if (!players1QB && !playersSF) {
    const reason = [res1, resSf].map(r => r.reason?.message).filter(Boolean).join('; ') || 'empty response';
    updateMeta.run(now, 0, 'error', reason.slice(0, 200));
    console.warn('[FantasyCalc] Both endpoints failed:', reason);
    return { success: false, error: reason, source: 'fantasycalc', timestamp: now };
  }

  // FantasyCalc carries Sleeper ids, so key the SF lookup off those rather than
  // re-matching by name and risking the two variants landing on different rows.
  const sfByKey = new Map();
  for (const p of playersSF || []) {
    if (p.sleeper_id) sfByKey.set(`sid:${p.sleeper_id}`, p.value);
    sfByKey.set(`name:${p.name.toLowerCase()}|${p.position}`, p.value);
  }

  const base = players1QB || playersSF;
  const claim = createClaimGuard('FantasyCalc');
  const count = db.transaction(() => {
    let n = 0;
    for (const p of base) {
      const target = (p.sleeper_id && bySleeperId.get(p.sleeper_id)) || findPlayer(p.name, p.position, p.nfl_team);
      if (!target || !claim(target.id, p.name)) continue;

      const v1qb = players1QB ? p.value : null;
      const vsf = playersSF
        ? (sfByKey.get(`sid:${p.sleeper_id}`) ?? sfByKey.get(`name:${p.name.toLowerCase()}|${p.position}`) ?? null)
        : null;

      // Never cross-fill. If one endpoint failed, writing the other league type's value
      // into its column produces a superflex trade value that is really a 1QB one — it
      // then feeds the superflex dynasty consensus, and nothing anywhere says so. The
      // column that has no fresh data keeps whatever it had, which is this repo's rule
      // for a failed source everywhere else.
      updateFC.run({
        id: target.id,
        v1qb, vsf,
        has1qb: players1QB ? 1 : 0,
        hasSf: playersSF ? 1 : 0,
        ts: now,
      });
      n++;
    }
    return n;
  })();

  const notes = players1QB && playersSF
    ? '1QB ok, SF ok'
    : `${players1QB ? '1QB ok' : '1QB failed'}, ${playersSF ? 'SF ok' : 'SF failed'}` +
      ' — the failed side kept its previous values rather than borrowing the other';
  updateMeta.run(now, count, 'ok', notes);
  console.log(`[FantasyCalc] Updated ${count} players (${notes})`);
  return { success: true, players_updated: count, source: 'fantasycalc', timestamp: now };
}

module.exports = { fetchFantasyCalc };
