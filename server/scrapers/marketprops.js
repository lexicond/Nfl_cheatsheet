/**
 * Season-long player prop lines from BettingPros — what the betting market thinks each
 * player will actually produce over the year.
 *
 * This is the one input the architecture doc calls the best public forecast available and
 * the one the model has been missing. It is also the only market source here that speaks
 * about individual players rather than teams.
 *
 * Three things to know before touching this.
 *
 * **The key is borrowed, not issued.** It is lifted from BettingPros' own public frontend
 * bundle and can rotate without warning. Every failure path here is soft: no key, a 401, a
 * thin response and the board simply keeps whatever it had. Nothing downstream may depend
 * on this existing.
 *
 * **`over.line` and `under.line` are best prices across ~23 books and are usually
 * DIFFERENT LINES.** Only 13 of 108 receiving-yards props had them agree. George Pickens
 * came back with an over at 599.5 (-809) and an under at 1050.5 (-110); de-vigging that
 * pair produces confident nonsense. `consensus_line` is the market's median and is the
 * only field used here.
 *
 * **These are expected values, not healthy-season numbers.** A line of 1,300 receiving
 * yards already prices in the chance he misses time. The model's own projection assumes a
 * full season on purpose, so the two are not the same quantity and the market number is
 * NOT blended into the projection — it is carried alongside it, as a second opinion the
 * board can be read against. Blending would need the availability gap reconciled first,
 * and doing that carelessly would quietly turn the projection back into something that
 * forecasts injuries.
 */
const { db } = require('../db');
const { get } = require('../utils/http');
const { fetchCsv, SOURCES } = require('../model/nflverse');
const { RULES } = require('../model/scoring');

const BASE = 'https://api.bettingpros.com/v3';

// Yards per reception by position, from 2023–25 nflverse totals. Used only to estimate
// the reception count the market does not publish.
const YARDS_PER_RECEPTION = { WR: 12.6, TE: 10.4, RB: 7.9, QB: 8.0 };

// Lifted from bettingpros.com's public bundle. Overridable so a rotation can be fixed
// without a deploy.
const API_KEY = process.env.BETTINGPROS_KEY || 'CHi8Hy5CEE4khd46XNYL23dCFX96oUdw6qOt1Dnh';

// Season-long markets, verified live. 330 (receptions) is listed but returns nothing, so
// it is deliberately absent: a market that answers 200 with an empty list would otherwise
// read as "no player has a reception line" rather than "this market is broken".
// Market ids 47–57 are multi-way LEADER markets ("most passing yards") and must never be
// mixed in here — they are not two-sided over/unders.
const MARKETS = [
  { id: 300, column: 'mkt_pass_yards', label: 'passing yards', min: 25 },
  { id: 301, column: 'mkt_rush_yards', label: 'rushing yards', min: 40 },
  { id: 302, column: 'mkt_rec_yards', label: 'receiving yards', min: 60 },
  { id: 304, column: 'mkt_pass_tds', label: 'passing TDs', min: 25 },
  { id: 305, column: 'mkt_rush_tds', label: 'rushing TDs', min: 40 },
  { id: 306, column: 'mkt_rec_tds', label: 'receiving TDs', min: 60 },
];

// A line outside these bounds is not a season total for that stat, whatever the API says.
const PLAUSIBLE = {
  mkt_pass_yards: [1000, 6500], mkt_rush_yards: [50, 2500], mkt_rec_yards: [50, 2200],
  mkt_pass_tds: [5, 60], mkt_rush_tds: [0.5, 30], mkt_rec_tds: [0.5, 25],
};

async function fetchMarket(marketId) {
  const res = await get(
    `${BASE}/props?sport=NFL&market_id=${marketId}&season=${new Date().getFullYear()}&limit=500`,
    {
      headers: {
        'x-api-key': API_KEY,
        Origin: 'https://www.bettingpros.com',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      },
      timeout: 45000,
      retries: 1,
    },
  );
  return Array.isArray(res.data?.props) ? res.data.props : [];
}

async function fetchMarketProps() {
  const now = new Date().toISOString();
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ?
    WHERE source = 'marketprops'
  `);

  // fantasypros_id is BettingPros' own participant id, and the crosswalk carries it — so
  // this joins exactly, with no name matching anywhere in the path.
  let byFantasyPros;
  try {
    const { rows } = await fetchCsv('ids', SOURCES.ids(), { maxAgeHours: 24, kind: 'ids' });
    byFantasyPros = new Map();
    for (const r of rows) {
      if (r.fantasypros_id && r.fantasypros_id !== 'NA' && r.sleeper_id && r.sleeper_id !== 'NA') {
        byFantasyPros.set(String(r.fantasypros_id), String(r.sleeper_id));
      }
    }
  } catch (err) {
    updateMeta.run(now, 0, 'error', `crosswalk unavailable: ${err.message}`);
    return { success: false, error: err.message, source: 'marketprops', timestamp: now };
  }

  const bySleeper = db.prepare('SELECT id, position FROM players WHERE sleeper_player_id = ?');
  const positionOf = new Map();
  const values = new Map();          // player row id -> { column: line }
  const counts = {};
  const mismatched = {};
  const failures = [];

  for (const m of MARKETS) {
    let props;
    try {
      props = await fetchMarket(m.id);
    } catch (err) {
      failures.push(`${m.label}: ${err.message}`);
      continue;
    }
    if (props.length < m.min) {
      failures.push(`${m.label}: only ${props.length} props (expected ${m.min}+)`);
      continue;
    }

    let n = 0;
    let differing = 0;
    for (const p of props) {
      // consensus_line only. See the header: the best-price lines routinely disagree.
      const line = Number(p.over?.consensus_line);
      if (!Number.isFinite(line)) continue;
      const [lo, hi] = PLAUSIBLE[m.column];
      if (line < lo || line > hi) continue;
      if (p.over?.line != null && p.under?.line != null && p.over.line !== p.under.line) differing++;

      const sleeperId = byFantasyPros.get(String(p.participant?.id));
      if (!sleeperId) continue;
      const row = bySleeper.get(sleeperId);
      if (!row) continue;

      positionOf.set(row.id, row.position);
      if (!values.has(row.id)) values.set(row.id, {});
      values.get(row.id)[m.column] = line;
      n++;
    }
    counts[m.label] = n;
    mismatched[m.label] = differing;
  }

  if (values.size === 0) {
    const msg = failures.length ? failures.join('; ') : 'no props matched the board';
    updateMeta.run(now, 0, 'error', msg);
    console.error('[MarketProps] ', msg);
    return { success: false, error: msg, source: 'marketprops', timestamp: now };
  }

  // Score the market's own lines under this league's rules, so there is one number
  // directly comparable with the model's projection.
  const cols = MARKETS.map(m => m.column);
  const update = db.prepare(`
    UPDATE players SET
      ${cols.map(c => `${c} = @${c}`).join(', ')},
      mkt_points = @mkt_points, last_updated = @ts
    WHERE id = @id
  `);

  let written = 0;
  db.transaction(() => {
    // Clear every row first: a line that is withdrawn must not persist as though current.
    db.prepare(`UPDATE players SET ${cols.map(c => `${c} = NULL`).join(', ')}, mkt_points = NULL
                WHERE mkt_points IS NOT NULL OR ${cols.map(c => `${c} IS NOT NULL`).join(' OR ')}`).run();

    for (const [id, v] of values) {
      // Receptions are the one half-PPR category with no market: BettingPros lists a
      // receptions market (330) and it returns nothing. Leaving the term out would make
      // this figure incomparable with the model's for exactly the players it matters
      // most for — a receiver's catches are worth a third of his season at half a point
      // each. So it is estimated from the market's own receiving-yards line at the
      // position's typical yards per catch, and it is the only estimated term here.
      const pos = positionOf.get(id);
      const ypr = YARDS_PER_RECEPTION[pos] ?? 11.0;
      const estReceptions = (v.mkt_rec_yards || 0) / ypr;

      const pts =
        (v.mkt_pass_yards || 0) * RULES.passing_yards +
        (v.mkt_pass_tds || 0) * RULES.passing_tds +
        (v.mkt_rush_yards || 0) * RULES.rushing_yards +
        (v.mkt_rush_tds || 0) * RULES.rushing_tds +
        (v.mkt_rec_yards || 0) * RULES.receiving_yards +
        (v.mkt_rec_tds || 0) * RULES.receiving_tds +
        estReceptions * RULES.receptions;
      update.run({
        id, ts: now,
        ...Object.fromEntries(cols.map(c => [c, v[c] ?? null])),
        mkt_points: Math.round(pts * 10) / 10,
      });
      written++;
    }
  })();

  const note = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')
    + (failures.length ? ` · FAILED: ${failures.join('; ')}` : '');
  updateMeta.run(now, written, failures.length ? 'warn' : 'ok', note);
  console.log(`[MarketProps] ${written} players carry a season line — ${note}`);
  console.log(`[MarketProps] over/under lines disagreed on ${Object.values(mismatched).reduce((a, b) => a + b, 0)} props; consensus_line used throughout`);

  return {
    success: true, players_updated: written, counts, mismatched,
    failures, source: 'marketprops', timestamp: now,
  };
}

module.exports = { fetchMarketProps, MARKETS, PLAUSIBLE };
