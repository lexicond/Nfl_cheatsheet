/**
 * Season-long threshold ladders from Polymarket — the only free read on the SHAPE of a
 * player's season, rather than just its middle.
 *
 * Everything else here publishes one number: a line, a projection, a rank. Polymarket
 * publishes a survival function. One event per player-stat, five binary markets at ascending
 * thresholds, and because it charges on resolution rather than taking vig, **the price is the
 * probability** — there is no de-vigging step. Ashton Jeanty's rushing yards come back as
 * P(≥574.5) = 0.58, P(≥774.5) = 0.365, P(≥974.5) = 0.235, and so on. Fit a lognormal through
 * those and you have his median and his spread, straight from a market.
 *
 * **What that is for here.** A betting line is only the market's median when it is priced at
 * even money. BettingPros posts plenty that are not — Kyler Murray at 5.5 rushing touchdowns
 * with the over at roughly 28% — and reading those as medians puts a player's expected season
 * far above what the market actually thinks. Converting a lopsided quote into a median needs a
 * distribution, and the width of that distribution is exactly what nothing else publishes.
 * This supplies it: `sigmaFor(stat, sleeperId)` gives the player's own fitted spread where
 * Polymarket prices him, and the stat's typical spread where it does not.
 *
 * The measured spreads order themselves the way anyone who watches football would expect,
 * which is the main reason to believe them: passing yards 0.19 (a starting quarterback is
 * predictable), passing touchdowns 0.32, rushing yards 0.55, rushing touchdowns 0.60,
 * receiving yards 0.62, receiving touchdowns 0.76.
 *
 * **Treat it as low precision.** Event liquidity runs from about $300 to $10k and individual
 * rungs can be under $50, so it is used for shape and never for the central estimate — the
 * fitted median is recorded for comparison and nothing reads it. Thin books also make the
 * ladder non-monotonic (a higher threshold priced above a lower one, which is impossible), so
 * monotonicity is imposed before anything is fitted.
 *
 * **There are no player ids at all.** Names are parsed out of the event title and matched
 * through the board's own crosswalk, which is why this is the one market source here that
 * does any name matching. It is deliberately strict: exact normalised name, and a name that
 * matches more than one player is skipped rather than guessed at.
 */
const fs = require('fs');
const path = require('path');
const { get } = require('../utils/http');
const { probit } = require('../model/wintotals');

const GAMMA = 'https://gamma-api.polymarket.com';

const CACHE_DIR = process.env.NFLVERSE_CACHE
  || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', '..'), '.nflverse-cache');
const CACHE_FILE = path.join(CACHE_DIR, 'polymarket-shapes.json');

// `Pro Football: {Name} 2026-27 Regular Season {Stat}`.
const TITLE = /^Pro Football: (.+?) \d{4}-\d{2} Regular Season (.+)$/;
const THRESHOLD = /([\d,]+(?:\.\d+)?)\s*\+/;

// Polymarket's stat wording mapped onto the market columns this board stores.
const STAT_COLUMN = {
  'Passing Yards': 'mkt_pass_yards',
  'Passing Touchdowns': 'mkt_pass_tds',
  'Rushing Yards': 'mkt_rush_yards',
  'Rushing Touchdowns': 'mkt_rush_tds',
  'Receiving Yards': 'mkt_rec_yards',
  'Receiving Touchdowns': 'mkt_rec_tds',
};

// Receptions have no ladder. Their spread is taken from receiving yards, which is the
// closest thing published and slightly too wide: yards are receptions times yards-per-catch,
// and both vary, so ln-yards must be more dispersed than ln-receptions. Erring wide makes the
// correction more conservative — it moves a lopsided line further — so it is stated here
// rather than tuned, and `SIGMA_FALLBACK` is what gets used if Polymarket is unreachable.
const BORROWED_SIGMA = { mkt_receptions: 'mkt_rec_yards' };

// Used only when Polymarket cannot be reached at all and there is no cache. These are the
// medians measured from a live pull, so the correction degrades rather than disappearing.
const SIGMA_FALLBACK = {
  mkt_pass_yards: 0.19, mkt_pass_tds: 0.32, mkt_rush_yards: 0.55,
  mkt_rush_tds: 0.60, mkt_rec_yards: 0.62, mkt_rec_tds: 0.76, mkt_receptions: 0.62,
};

// A ladder needs this many usable rungs before a two-parameter fit means anything.
const MIN_RUNGS = 3;

// Prices this close to 0 or 1 carry almost no information about the middle of the
// distribution and dominate a least-squares fit in log space.
const PRICE_FLOOR = 0.02;

const normaliseName = s => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

async function fetchNflEvents() {
  const out = [];
  for (let page = 0; page < 12; page++) {
    const res = await get(
      `${GAMMA}/events?limit=100&offset=${page * 100}&active=true&closed=false&tag_slug=nfl`,
      { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Chrome/124' },
        timeout: 45000, retries: 1 },
    );
    const batch = Array.isArray(res.data) ? res.data : [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/**
 * Fit a lognormal to one ladder.
 *
 * With P(X ≥ x) = p, a lognormal gives ln x = mu + sigma·Φ⁻¹(1−p), so the rungs are a straight
 * line in (Φ⁻¹(1−p), ln x) and an ordinary least-squares slope is the spread. Returns null
 * unless enough rungs survive the monotonicity and price filters.
 */
function fitLadder(rungs) {
  const sorted = [...rungs].sort((a, b) => a.x - b.x);
  // A survival function cannot rise. Thin books make it do so anyway; take the running
  // minimum rather than dropping the rung, which would bias the fit toward the liquid end.
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].p > sorted[i - 1].p) sorted[i].p = sorted[i - 1].p;
  }
  const points = [];
  let previous = null;
  for (const r of sorted) {
    // After the running minimum, a repeated probability carries no new information and would
    // otherwise weight one price several times over.
    if (previous != null && r.p === previous) continue;
    previous = r.p;
    if (r.p <= PRICE_FLOOR || r.p >= 1 - PRICE_FLOOR) continue;
    const z = probit(1 - r.p);
    if (z == null || !Number.isFinite(z) || !(r.x > 0)) continue;
    points.push({ y: Math.log(r.x), z });
  }
  if (points.length < MIN_RUNGS) return null;

  const meanZ = points.reduce((a, q) => a + q.z, 0) / points.length;
  const meanY = points.reduce((a, q) => a + q.y, 0) / points.length;
  const cov = points.reduce((a, q) => a + (q.z - meanZ) * (q.y - meanY), 0);
  const varZ = points.reduce((a, q) => a + (q.z - meanZ) ** 2, 0);
  if (varZ <= 0) return null;

  const sigma = cov / varZ;
  // A spread outside this is not a season distribution, it is a failed fit on a thin book.
  if (!(sigma > 0.05 && sigma < 2)) return null;
  return { sigma, median: Math.exp(meanY - sigma * meanZ), rungs: points.length };
}

/**
 * Every player-stat ladder Polymarket is running, fitted.
 *
 * `byPlayer` is keyed `sleeperId|column`; `byStat` is the median spread per column, which is
 * what most players end up using. Cached for a day — the ladders reprice faster than that but
 * the SHAPE does not, and shape is all this is used for.
 */
async function fetchShapes(crosswalkByName, { maxAgeHours = 24 } = {}) {
  try {
    const age = (Date.now() - fs.statSync(CACHE_FILE).mtimeMs) / 3600000;
    if (age <= maxAgeHours) {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cached && cached.byStat) return { ...cached, source: 'cache' };
    }
  } catch { /* no cache, or an unreadable one — fetch */ }

  const events = await fetchNflEvents();
  const byPlayer = {};
  const perStat = {};
  let unmatched = 0;
  let ambiguous = 0;

  for (const event of events) {
    const title = String(event.title || '').match(TITLE);
    if (!title) continue;
    const column = STAT_COLUMN[title[2]];
    if (!column) continue;

    const rungs = [];
    for (const market of event.markets || []) {
      const threshold = String(market.question || '').match(THRESHOLD);
      if (!threshold) continue;
      let prices;
      try { prices = JSON.parse(market.outcomePrices); } catch { continue; }
      const p = Number(Array.isArray(prices) ? prices[0] : NaN);
      const x = Number(threshold[1].replace(/,/g, ''));
      if (Number.isFinite(p) && Number.isFinite(x)) rungs.push({ x, p });
    }
    if (rungs.length < MIN_RUNGS) continue;

    const fit = fitLadder(rungs);
    if (!fit) continue;
    (perStat[column] = perStat[column] || []).push(fit.sigma);

    const match = crosswalkByName?.get(normaliseName(title[1]));
    if (!match) { unmatched++; continue; }
    if (match === 'AMBIGUOUS') { ambiguous++; continue; }
    byPlayer[`${match}|${column}`] = {
      sigma: Math.round(fit.sigma * 1000) / 1000,
      median: Math.round(fit.median * 10) / 10,
      rungs: fit.rungs,
      liquidity: Math.round(Number(event.liquidity) || 0),
    };
  }

  const byStat = {};
  for (const [column, values] of Object.entries(perStat)) {
    values.sort((a, b) => a - b);
    byStat[column] = Math.round(values[Math.floor(values.length / 2)] * 1000) / 1000;
  }
  for (const [column, from] of Object.entries(BORROWED_SIGMA)) {
    if (byStat[from] != null) byStat[column] = byStat[from];
  }

  const shapes = {
    byPlayer, byStat, unmatched, ambiguous,
    ladders: Object.values(perStat).reduce((a, v) => a + v.length, 0),
    fetched_at: new Date().toISOString(),
    source: 'live',
  };
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(shapes));
  } catch { /* an unwritable cache must not stop a refresh */ }
  return shapes;
}

/** The spread to use for one player and stat: his own where it exists, the stat's otherwise. */
function sigmaFor(shapes, column, sleeperId) {
  const own = sleeperId != null && shapes?.byPlayer?.[`${sleeperId}|${column}`];
  if (own && own.sigma > 0) return { sigma: own.sigma, basis: 'player' };
  const stat = shapes?.byStat?.[column];
  if (stat > 0) return { sigma: stat, basis: 'stat' };
  return { sigma: SIGMA_FALLBACK[column], basis: 'fallback' };
}

module.exports = {
  fetchShapes, sigmaFor, fitLadder, normaliseName,
  STAT_COLUMN, SIGMA_FALLBACK, CACHE_FILE,
};
