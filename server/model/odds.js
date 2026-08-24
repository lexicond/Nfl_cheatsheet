/**
 * The Odds API — live game lines, and the Super Bowl market as a sanity check.
 *
 * nflverse's schedule file carries a spread and total for every game a book has priced,
 * but in August that is only the part of the season the market has got to: 112 of 272
 * for 2026. The Odds API has all 272, which is the difference between pricing a team's
 * environment off six games and off its whole schedule.
 *
 * It is strictly an upgrade, never a dependency. No key, a failed call or a thin
 * response and the model falls back to nflverse exactly as before — the key does not
 * exist on the deployment unless somebody sets it, and a draft board that stops working
 * because a third-party quota ran out would be worse than one priced off six games.
 *
 * What this API does NOT have, having been checked rather than assumed: no season-long
 * player props and no team win totals. The only NFL keys it exposes are
 * `americanfootball_nfl` (per-game h2h/spreads/totals, plus per-game player props on the
 * per-event endpoint) and `americanfootball_nfl_super_bowl_winner` (outrights). Season
 * player totals would have to be scraped from a sportsbook page.
 */
const { get, JSON_HEADERS } = require('../utils/http');

const BASE = 'https://api.the-odds-api.com/v4';

// The env var is read defensively: it has been seen in the wild with a trailing space in
// its NAME, which makes process.env.odds_api undefined while `env` still shows it.
function apiKey() {
  const direct = process.env.ODDS_API_KEY || process.env.odds_api;
  if (direct) return String(direct).trim();
  const loose = Object.keys(process.env).find(k => k.trim().toLowerCase() === 'odds_api'
    || k.trim().toLowerCase() === 'odds_api_key');
  return loose ? String(process.env[loose]).trim() : null;
}

// Median is used rather than a mean across books: one stale book should not move a line.
function median(vals) {
  if (!vals.length) return null;
  const s = vals.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const TEAM_BY_NAME = {
  'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL',
  'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR', 'Chicago Bears': 'CHI',
  'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL',
  'Denver Broncos': 'DEN', 'Detroit Lions': 'DET', 'Green Bay Packers': 'GB',
  'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX',
  'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC',
  'Los Angeles Rams': 'LA', 'Miami Dolphins': 'MIA', 'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG',
  'New York Jets': 'NYJ', 'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT',
  'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA', 'Tampa Bay Buccaneers': 'TB',
  'Tennessee Titans': 'TEN', 'Washington Commanders': 'WAS',
};

/**
 * Every priced regular-season game, as the same shape loadSchedules returns, so the
 * environment layer cannot tell the difference between this and the nflverse file.
 *
 * spread_line is quoted from the HOME team's perspective and positive means home
 * favoured — matching nflverse. The API quotes a handicap per team where negative means
 * favoured, so the home team's point is negated.
 */
async function loadOddsGames(season) {
  const key = apiKey();
  if (!key) return { games: [], available: false, reason: 'no API key in the environment' };

  let payload;
  try {
    const res = await get(
      `${BASE}/sports/americanfootball_nfl/odds?regions=us&markets=spreads,totals&oddsFormat=american&apiKey=${key}`,
      { headers: JSON_HEADERS, timeout: 45000, retries: 1 },
    );
    payload = res.data;
  } catch (err) {
    return { games: [], available: false, reason: err.message };
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    return { games: [], available: false, reason: 'no events returned' };
  }

  const games = [];
  let unknownTeam = 0;
  for (const ev of payload) {
    const home = TEAM_BY_NAME[ev.home_team];
    const away = TEAM_BY_NAME[ev.away_team];
    // A renamed or relocated franchise must not silently become a missing team.
    if (!home || !away) { unknownTeam++; continue; }

    const spreads = [];
    const totals = [];
    for (const bk of ev.bookmakers || []) {
      for (const mkt of bk.markets || []) {
        if (mkt.key === 'spreads') {
          const h = (mkt.outcomes || []).find(o => o.name === ev.home_team);
          if (h && Number.isFinite(Number(h.point))) spreads.push(-Number(h.point));
        } else if (mkt.key === 'totals') {
          const o = (mkt.outcomes || [])[0];
          if (o && Number.isFinite(Number(o.point))) totals.push(Number(o.point));
        }
      }
    }
    const spread = median(spreads);
    const total = median(totals);
    if (spread == null || total == null) continue;

    games.push({
      game_id: ev.id,
      season,
      week: null,
      game_type: 'REG',
      home_team: home,
      away_team: away,
      home_score: null,
      away_score: null,
      spread_line: spread,
      total_line: total,
      commence: ev.commence_time,
    });
  }

  // The one rule. A live market that answers 200 with a handful of preseason friendlies,
  // or with totals that are not football numbers, must not quietly replace the schedule.
  const totalsSeen = games.map(g => g.total_line);
  const plausible = totalsSeen.filter(t => t >= 30 && t <= 65).length;
  if (games.length < 32) {
    return { games: [], available: false, reason: `only ${games.length} priced games returned` };
  }
  if (plausible / games.length < 0.9) {
    return { games: [], available: false, reason: 'game totals are not in a plausible NFL range' };
  }

  return {
    games,
    available: true,
    priced: games.length,
    unknownTeam,
    meanTotal: Math.round((totalsSeen.reduce((a, b) => a + b, 0) / totalsSeen.length) * 100) / 100,
  };
}

/**
 * Super Bowl outright prices, de-vigged into win probabilities.
 *
 * Not an input to any projection — a market ranking of team strength, used to check the
 * win totals the model implies. Multi-way markets carry a large overround, so the
 * probabilities are normalised to sum to one.
 */
async function loadSuperBowlMarket() {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await get(
      `${BASE}/sports/americanfootball_nfl_super_bowl_winner/odds?regions=us&markets=outrights&oddsFormat=decimal&apiKey=${key}`,
      { headers: JSON_HEADERS, timeout: 45000, retries: 1 },
    );
    const ev = Array.isArray(res.data) ? res.data[0] : null;
    if (!ev) return null;
    // Take the book quoting the most teams; a partial board would distort the normalising.
    const book = (ev.bookmakers || []).slice()
      .sort((a, b) => (b.markets?.[0]?.outcomes?.length || 0) - (a.markets?.[0]?.outcomes?.length || 0))[0];
    const outcomes = book?.markets?.[0]?.outcomes || [];
    if (outcomes.length < 24) return null;

    const raw = outcomes
      .map(o => ({ team: TEAM_BY_NAME[o.name], p: 1 / Number(o.price) }))
      .filter(o => o.team && Number.isFinite(o.p));
    const sum = raw.reduce((a, b) => a + b.p, 0);
    const out = new Map();
    for (const o of raw) out.set(o.team, o.p / sum);
    return { book: book.title, probs: out, overround: Math.round(sum * 1000) / 1000 };
  } catch {
    return null;
  }
}

module.exports = { loadOddsGames, loadSuperBowlMarket, apiKey, TEAM_BY_NAME, median };
