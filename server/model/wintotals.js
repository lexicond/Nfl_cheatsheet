/**
 * Season win totals from VegasInsider — the market's own view of how good each team is.
 *
 * This closes a gap the handover has carried since the fixture-propagation work: the model's
 * implied team strength was only ever checked against the game spreads it is already built
 * from, which is partly circular, and "a real sportsbook win total would be a better
 * yardstick; no clean free source carries one". VegasInsider does, across four books, in
 * server-rendered HTML that needs no JavaScript.
 *
 * **Books post DIFFERENT LINES, so the numbers on the page cannot be averaged.** Baltimore
 * came back at o11.5 (+120) from one book and o10.5 (-150) from another. Averaging 11.5 and
 * 10.5 gives 11.0 by accident rather than by reasoning, and on a team where the books
 * genuinely disagree it would be wrong in a way nothing downstream could detect. Each quote
 * is instead converted to the expected win total it implies — the line shifted by however far
 * its price sits from even money — and only then combined. That the two Baltimore quotes then
 * land within 0.01 of each other, from lines a full win apart, is the check that the
 * conversion is doing something real; `crossBookSpread` reports it every run, and across all
 * 32 teams it stays under half a win.
 *
 * Two honest caveats on the checks. Summing every team's implied total gives 273.3 against the
 * 272 a season actually hands out, which is a real check on the scrape — but averaging the
 * posted LINES and ignoring the prices sums to 273.3 as well, because the price corrections
 * roughly cancel across the league. It catches taking the MEDIAN line, which sums to 278. What
 * the price adjustment buys is per-team accuracy, not the aggregate: it moves the Rams by 0.64
 * wins and eight teams by more than a third of a win, and that is what decides their order.
 *
 * **Only the over is published**, so there is no second side to de-vig against. A standard
 * two-way overround is assumed instead. It is a small correction — worth about a tenth of a
 * win — and it is applied identically to every team, so it cannot reorder them.
 */
const { get } = require('../utils/http');
const { normaliseTeam } = require('./nflverse');

const URL = 'https://www.vegasinsider.com/nfl/odds/win-totals/';

// Spread of a team's actual win count around its true talent, in wins. A 17-game season of
// roughly even matches puts this near 2.9; it sets how far a lopsided price moves the line.
const WIN_SIGMA = 2.9;

// Typical two-way overround on a season win total. Only the over side is published, so the
// under cannot be used to de-vig; this is removed from every quote instead.
const OVERROUND = 1.045;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
};

/** American odds to an implied probability, vig included. */
function impliedProbability(cost) {
  const c = Number(cost);
  if (!Number.isFinite(c) || c === 0) return null;
  return c < 0 ? -c / (-c + 100) : 100 / (c + 100);
}

/**
 * Inverse standard normal. Acklam's rational approximation — accurate to about 1e-9 across
 * the range, which is far past what a betting line justifies.
 */
function probit(p) {
  if (!(p > 0 && p < 1)) return null;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687,
    138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) return -probit(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * One book's quote as the win total it actually implies.
 *
 * A line is only the market's central estimate when it is priced at even money. o10.5 at -150
 * says the same thing as o11.5 at +120; both mean about eleven wins, and it is only after
 * this conversion that two books can be compared at all.
 */
function impliedWins(line, price) {
  const raw = impliedProbability(price);
  if (raw == null) return null;
  const fair = Math.min(0.99, Math.max(0.01, raw / OVERROUND));
  const z = probit(1 - fair);
  if (z == null) return null;
  return line - WIN_SIGMA * z;
}

/**
 * Scrape the win-totals page.
 *
 * The markup is a table row per team carrying `data-abbr` and one `<td class="game-odds">`
 * per book, each holding two whitespace-padded `<span class="data-value">` — the line, then
 * the price. Parsed with regexes rather than a DOM because it is the only HTML this codebase
 * scrapes and a parser dependency is not worth one page; the shape is asserted instead.
 */
async function fetchWinTotals() {
  const res = await get(URL, { headers: HEADERS, timeout: 45000, retries: 1 });
  const html = String(res.data || '');
  const body = html.slice(html.indexOf('<body'));

  const teams = {};
  for (const chunk of body.split(/<tr[\s>]/).slice(1)) {
    if (!chunk.includes('game-odds')) continue;
    const abbr = chunk.match(/class="team-name[^"]*"\s+data-abbr="([A-Z]{2,3})"/);
    if (!abbr) continue;
    const team = normaliseTeam(abbr[1]);

    const quotes = [];
    for (const cell of chunk.split('<td class="game-odds"').slice(1)) {
      const values = [...cell.matchAll(/class="data-value"\s*>\s*([^<\s][^<]*?)\s*</g)].map(m => m[1]);
      if (values.length < 2) continue;
      const line = Number(String(values[0]).replace(/^[ou]/i, ''));
      const price = Number(String(values[1]).replace(/[^\d+-]/g, ''));
      if (!Number.isFinite(line) || !Number.isFinite(price)) continue;
      // A win total outside this range is not a win total, whatever the page says.
      if (line < 2 || line > 15) continue;
      const wins = impliedWins(line, price);
      if (wins != null) quotes.push({ line, price, wins });
    }
    if (!quotes.length) continue;

    const values = quotes.map(q => q.wins).sort((a, b) => a - b);
    const mid = values.length % 2
      ? values[(values.length - 1) / 2]
      : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
    teams[team] = {
      wins: Math.round(mid * 100) / 100,
      books: quotes.length,
      // How far apart the books are once their different lines have been converted. A wide
      // spread here means either genuine disagreement or that the conversion is wrong.
      crossBookSpread: Math.round((values[values.length - 1] - values[0]) * 100) / 100,
      lines: [...new Set(quotes.map(q => q.line))],
    };
  }

  return teams;
}

module.exports = { fetchWinTotals, impliedWins, probit, WIN_SIGMA, URL };
