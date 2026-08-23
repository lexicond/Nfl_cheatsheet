const { db } = require('../db');
const { get, BROWSER_HEADERS } = require('../utils/http');
const { createMatcher, createClaimGuard } = require('../utils/match');

const SEASON_YEAR = new Date().getFullYear();

// Every position's page carries the same payload — one fetch is the whole board. The
// running-back page is used simply because it exists; nothing about it is RB-specific.
const URL = `https://www.thefantasyfootballers.com/${SEASON_YEAR}-running-back-rankings-draft/`;

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const ANALYSTS = ['Andy', 'Jason', 'Mike'];

/**
 * The Fantasy Footballers do not publish a ranking. They publish each of the three
 * hosts' statistical projections, and their site ranks them in the browser under
 * whichever scoring the reader picked — its default being half-PPR with six-point
 * passing touchdowns.
 *
 * So the ranking is computed here instead, from their projections, under *this* board's
 * scoring: half-PPR with four-point passing touchdowns. That is deliberate. Taking their
 * on-screen order would import a quarterback ranking built for a scoring system this
 * league does not use, and quarterbacks are exactly where the two differ.
 *
 * Identical formula to the Sleeper projection scoring, so the two columns are comparable.
 */
function halfPprPoints(row) {
  const n = k => Number(row[k]) || 0;
  return (
    n('passing_yards') * 0.04 +
    n('passing_touchdowns') * 4 -
    n('interceptions_thrown') * 2 +
    n('rushing_yards') * 0.1 +
    n('rushing_touchdowns') * 6 +
    n('receptions') * 0.5 +
    n('receiving_yards') * 0.1 +
    n('receiving_touchdowns') * 6 -
    n('fumbles_lost') * 2
  );
}

/**
 * Pull `window.udk.data` out of the page.
 *
 * It is assigned more than once — an empty object early on, the real payload later — so
 * this takes the last assignment that is actually followed by the projections key, and
 * brace-matches from there while tracking string state.
 */
function extractUdkData(html) {
  if (typeof html !== 'string') return null;
  const marker = /window\.udk\.data\s*=\s*(?=\{"projections")/g;
  let at = -1;
  for (let m = marker.exec(html); m; m = marker.exec(html)) at = m.index + m[0].length;
  if (at < 0) return null;

  const start = html.indexOf('{', at);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchFootballers() {
  const now = new Date().toISOString();
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ?
    WHERE source = 'footballers'
  `);

  let data;
  try {
    const res = await get(URL, { headers: BROWSER_HEADERS, timeout: 45000 });
    data = extractUdkData(res.data);
    if (!data || !Array.isArray(data.projections)) {
      throw new Error('no projections payload in the page — the rankings markup has changed');
    }
  } catch (err) {
    updateMeta.run(now, 0, 'error', err.message);
    console.error('[Footballers] Fetch failed:', err.message);
    return { success: false, error: err.message, source: 'footballers', timestamp: now };
  }

  const rows = data.projections;

  // The one rule: this page returns a valid-looking payload whatever it is actually of.
  // A stale season, a missing analyst or a position that quietly emptied would all still
  // parse, and would silently rank the board on last year's opinions.
  const seasons = [...new Set(rows.map(r => String(r.season)))];
  if (!seasons.includes(String(SEASON_YEAR))) {
    const msg = `projections are for ${seasons.join('/')}, not ${SEASON_YEAR}`;
    updateMeta.run(now, 0, 'error', msg);
    return { success: false, error: msg, source: 'footballers', timestamp: now };
  }

  const analysts = [...new Set(rows.map(r => r.analyst_name).filter(Boolean))];
  const missing = ANALYSTS.filter(a => !analysts.includes(a));
  if (missing.length > 0) {
    const msg = `missing analyst${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`;
    updateMeta.run(now, 0, 'error', msg);
    return { success: false, error: msg, source: 'footballers', timestamp: now };
  }

  // Mean projected points per player across the analysts who ranked him.
  const byPlayer = new Map();
  for (const r of rows) {
    if (String(r.season) !== String(SEASON_YEAR)) continue;
    const pos = r.fantasy_position;
    if (!POSITIONS.has(pos)) continue;              // they also project kickers
    const name = String(r.name || '').trim();
    if (!name) continue;
    const key = `${name}|${pos}`;
    if (!byPlayer.has(key)) {
      byPlayer.set(key, { name, pos, team: r.team || null, pts: [] });
    }
    byPlayer.get(key).pts.push(halfPprPoints(r));
  }

  const players = [...byPlayer.values()].map(p => ({
    ...p,
    points: Math.round((p.pts.reduce((a, b) => a + b, 0) / p.pts.length) * 10) / 10,
    analysts: p.pts.length,
  }));

  // A position that came back nearly empty means the page changed shape, not that the
  // Footballers stopped rating running backs.
  const counts = {};
  for (const pos of POSITIONS) counts[pos] = players.filter(p => p.pos === pos).length;
  const thin = Object.entries(counts).filter(([, n]) => n < 20).map(([pos]) => pos);
  if (thin.length > 0) {
    const msg = `too few players at ${thin.join(', ')} — ${JSON.stringify(counts)}`;
    updateMeta.run(now, 0, 'error', msg);
    return { success: false, error: msg, source: 'footballers', timestamp: now };
  }

  // Rank within position on those points. This is the number the board shows: the
  // Footballers rank by position only, so a positional rank is what they actually say.
  for (const pos of POSITIONS) {
    players
      .filter(p => p.pos === pos)
      .sort((a, b) => b.points - a.points)
      .forEach((p, i) => { p.rank = i + 1; });
  }

  const matcher = createMatcher(db);
  const claim = createClaimGuard('Footballers');
  const update = db.prepare(`
    UPDATE players SET ff_pos_rank = @rank, ff_points = @points, last_updated = @ts WHERE id = @id
  `);

  let matched = 0;
  const unmatched = [];
  db.transaction(() => {
    for (const p of players) {
      const hit = matcher(p.name, p.pos, p.team);
      if (!hit) { unmatched.push(`${p.name} (${p.pos})`); continue; }
      if (!claim(hit.id, p.name)) continue;
      update.run({ id: hit.id, rank: p.rank, points: p.points, ts: now });
      matched++;
    }
  })();

  const note = `${matched} matched · ${analysts.length} analysts · ` +
    Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
  updateMeta.run(now, matched, 'ok', note);
  console.log(`[Footballers] ${matched}/${players.length} players ranked — ${note}`);
  if (unmatched.length > 0) {
    console.log(`[Footballers] Unmatched: ${unmatched.slice(0, 8).join(', ')}${unmatched.length > 8 ? ` …+${unmatched.length - 8}` : ''}`);
  }

  return {
    success: true,
    players_updated: matched,
    counts,
    analysts,
    unmatched: unmatched.length,
    source: 'footballers',
    timestamp: now,
  };
}

module.exports = { fetchFootballers, halfPprPoints, extractUdkData };
