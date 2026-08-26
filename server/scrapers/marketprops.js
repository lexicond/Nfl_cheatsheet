/**
 * Season-long player prop lines from BettingPros — what the betting market thinks each
 * player will actually produce over the year.
 *
 * This is the one input the architecture doc calls the best public forecast available and
 * the one the model has been missing. It is also the only market source here that speaks
 * about individual players rather than teams.
 *
 * Four things to know before touching this.
 *
 * **`/v3/props` and `/v3/offers` are not the same view of the same data.** `/props` takes
 * `limit=500` and answers in one request, which makes it the obvious choice and it is the
 * wrong one: it answers 200 with an EMPTY LIST for markets that are perfectly alive on
 * `/offers`. Receptions (330) is the case that matters — 0 props, 87 offers — and reading
 * the empty list as "the books do not price receptions" cost this board a third of every
 * receiver's half-PPR season. `/offers` is what bettingpros.com's own pages are built on,
 * it carries two more players on receiving yards as well, and it is what is used here.
 * Its `limit` maxes out at **10**, so it must be paged; asking for more is a 400, which
 * is easy to misread as the market being unavailable.
 *
 * **The consensus is book id 0, not a `consensus_line` field.** `/offers` has no such
 * field. Each selection carries a list of books and book 0 is BettingPros' own consensus
 * pseudo-book; the real books sit beside it. Reading a real book instead would pick one
 * operator's shading at random.
 *
 * **Best-price lines are not two sides of one market.** They are the best available price
 * across ~23 books and are usually DIFFERENT LINES: 74 of 107 receiving-yards offers had
 * the best over and the best under at different numbers. George Pickens came back with an
 * over at 599.5 (-809) against an under at 1050.5 (-110); de-vigging that pair produces
 * confident nonsense. The consensus book is two-sided and consistent — 98 of those same
 * 107 agree — so it is the only line this reads, and no de-vigging happens at all.
 *
 * **A line is only a median if it is priced like one, so the price is used, not just the
 * line.** The consensus book usually quotes both sides near even money, and there the line is
 * the market's central estimate. It often is not: Kyler Murray came back at 5.5 rushing
 * touchdowns with the over at about 28%, and De'Zhaun Stribling — a rookie receiver — at 74.5
 * receptions on +245 against -376. Read as medians those make Murray a rushing threat he is
 * not priced as and Stribling a top-20 receiver.
 *
 * Every line is therefore converted to the median it implies, by de-vigging the two consensus
 * prices and solving a lognormal: median = line × exp(−sigma × Φ⁻¹(1−p)). At even money that
 * is a no-op by construction, which is the point — there is no threshold to tune and no
 * discontinuity between a "fair" line and a "lopsided" one.
 *
 * The spread that conversion needs is the one thing no sportsbook publishes, and it is why
 * Polymarket is here: its threshold ladders are a survival function per player-stat, so a
 * lognormal fitted through them gives sigma directly from a market. See `polymarket.js`.
 *
 * Measured against the model's own independent estimate of the same statistic, the correction
 * behaves as it should: on the 430 offers already priced near even money it changes almost
 * nothing (mean error 28.7% → 27.9%), and on the lopsided ones it moves them a long way
 * closer (278% → 197%). Adjusted rows are counted and flagged rather than passed off as
 * posted lines — `mkt_adjusted` — because this is the one place a distribution assumption
 * enters a column that is otherwise pure market data.
 *
 * **The consensus pseudo-book can contradict every book behind it.** Ashton Jeanty's rushing
 * yards came back with a consensus of 574.5 while eleven of his twelve real books sat at
 * 974.5-1000.5 — all of them flagged `is_off`, with one lone live outlier at 574.5 that the
 * consensus was echoing. RotoWire's independent pull had DraftKings live at 999.5 priced at
 * evens, confirming the consensus was the wrong number rather than the market having moved.
 * Nothing about that offer looks broken: it parses, it is two-sided, and it is priced close
 * enough to even money to clear the band above. So the consensus is also checked against the
 * books it claims to summarise — `MIN_BOOK_SUPPORT` — and where essentially none of them
 * agree, the median of the books is used in its place rather than the row being thrown away.
 * Six of 320 offers need that. The validator runs the same check from outside, against
 * RotoWire, and independently names the same players, which is the reason to believe it.
 *
 * **The books do not price every category for every player, so the totals are not all the
 * same quantity.** Receiving markets exist for the pass-catching backs and not the rest:
 * 22 of 36 running backs here have a rushing line and no receiving line at all, and
 * adding up what is priced gives them a season total missing a third of their scoring.
 * Jonathan Taylor came out at 203 against the model's 310 largely for that reason. Silence
 * from the books means they saw no liquidity, not that the player scores zero, so the
 * missing terms are neither estimated nor treated as zero — the row is marked incomplete,
 * `mkt_complete` is what the board dims and the validator filters on, and only totals
 * covering a position's full scoring are compared with anything.
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
const { probit } = require('../model/wintotals');
const { fetchShapes, sigmaFor, normaliseName: polymarketName } = require('./polymarket');

const BASE = 'https://api.bettingpros.com/v3';

// Lifted from bettingpros.com's public bundle. Overridable so a rotation can be fixed
// without a deploy.
const API_KEY = process.env.BETTINGPROS_KEY || 'CHi8Hy5CEE4khd46XNYL23dCFX96oUdw6qOt1Dnh';

// BettingPros' own consensus across the books it prices, carried as a pseudo-book.
const CONSENSUS_BOOK = 0;

// The `/offers` route refuses anything above 10 with a 400.
const PAGE_SIZE = 10;

// Past this far from even money the lognormal is being asked to extrapolate into a tail it
// was never fitted on, and a single stale price would move the answer enormously. Those are
// still refused. Everything inside is corrected rather than discarded.
const PRICE_BAND = 0.35;

// A price this close to certainty carries no usable information about the middle.
const PRICE_FLOOR = 0.02;

// Touchdown markets are counts, quoted in whole-step half-numbers on a base of about five.
// A lognormal is a poor model for a small integer, and most of the distance between a posted
// x.5 line and the true median there is quantisation rather than displacement — the books
// cannot post 4.2, so they post 4.5 and move the price. Left uncapped the correction read
// that as a real shift and pulled Calvin Ridley's receiving touchdowns from 4.5 to 3.1,
// against 4.5 at every book RotoWire could see. The shift on a count is therefore capped at
// half a step, which is as far as quantisation alone can account for. Yardage and receptions
// are effectively continuous and are not capped.
const COUNT_COLUMNS = new Set(['mkt_pass_tds', 'mkt_rush_tds', 'mkt_rec_tds']);
const MAX_COUNT_SHIFT = 0.5;

// The least share of an offer's own books that must sit near its consensus line before that
// line is believed. Set where it separates the genuinely broken consensus lines from ordinary
// book-to-book variation: at 0.2 it rejects eight offers of 320, every one of which is a
// consensus contradicted by the market it claims to summarise. Only applied where there are
// at least MIN_BOOKS_TO_CHECK books to be outvoted by.
const MIN_BOOK_SUPPORT = 0.2;
const MIN_BOOKS_TO_CHECK = 3;

// How far a book's line may sit from the consensus and still count as agreeing with it. The
// floor matters: touchdown markets step by a whole touchdown on a base of five or six, so a
// purely proportional tolerance would treat one ordinary step as a disagreement.
const SUPPORT_TOLERANCE = 0.08;
const SUPPORT_TOLERANCE_FLOOR = 0.5;

// Season-long over/under markets, verified live against `/offers`.
//
// Two markets in their season list are deliberately absent. 303 (interceptions) returns
// zero offers AND zero props — it is genuinely unpriced, which means quarterback totals
// here carry no interception term and so read roughly two dozen points high against a
// projection that does score them. That is stated on the column rather than papered over
// with an estimate. Market ids 47-57 are multi-way LEADER markets ("most passing yards")
// and must never be mixed in — they are not two-sided over/unders at all.
// `group` is the scoring component the market belongs to. It exists so book support can
// be reported per component as well as per player: the model blends receiving, rushing and
// passing separately, and weighting each by the thinnest line a player carries ANYWHERE
// throws away most of what the books actually agree on.
const MARKETS = [
  { id: 300, column: 'mkt_pass_yards', label: 'passing yards', min: 25, group: 'pass' },
  { id: 301, column: 'mkt_rush_yards', label: 'rushing yards', min: 40, group: 'rush' },
  { id: 302, column: 'mkt_rec_yards', label: 'receiving yards', min: 60, group: 'rec' },
  { id: 304, column: 'mkt_pass_tds', label: 'passing TDs', min: 25, group: 'pass' },
  { id: 305, column: 'mkt_rush_tds', label: 'rushing TDs', min: 40, group: 'rush' },
  { id: 306, column: 'mkt_rec_tds', label: 'receiving TDs', min: 60, group: 'rec' },
  { id: 330, column: 'mkt_receptions', label: 'receptions', min: 50, group: 'rec' },
];

// A line outside these bounds is not a season total for that stat, whatever the API says.
const PLAUSIBLE = {
  mkt_pass_yards: [1000, 6500], mkt_rush_yards: [50, 2500], mkt_rec_yards: [50, 2200],
  mkt_pass_tds: [5, 60], mkt_rush_tds: [0.5, 30], mkt_rec_tds: [0.5, 25],
  mkt_receptions: [5, 160],
};

const COLUMNS = MARKETS.map(m => m.column);
// The per-component book-count columns, in the order the write below expects them.
const BOOK_GROUPS = ['rec', 'rush', 'pass'];
const BOOK_COLUMNS = BOOK_GROUPS.map(g => `mkt_books_${g}`);

// What a position has to have priced before its total can be read as a season projection.
//
// Quarterbacks are not asked for a rushing line: most have none, and for a pocket passer
// the term is worth a couple of points. They ARE asked for it once a rushing touchdown
// line exists, because a book that prices one and not the other has left a hole in exactly
// the players where running matters.
const REQUIRED_TERMS = {
  QB: ['mkt_pass_yards', 'mkt_pass_tds'],
  RB: ['mkt_rush_yards', 'mkt_rush_tds', 'mkt_rec_yards', 'mkt_rec_tds', 'mkt_receptions'],
  WR: ['mkt_rec_yards', 'mkt_rec_tds', 'mkt_receptions'],
  TE: ['mkt_rec_yards', 'mkt_rec_tds', 'mkt_receptions'],
};

function isComplete(position, v) {
  const required = REQUIRED_TERMS[position];
  if (!required) return false;
  if (required.some(c => v[c] == null)) return false;
  // A rushing touchdown line with no rushing yards line behind it is a hole, not a total.
  if (v.mkt_rush_tds != null && v.mkt_rush_yards == null) return false;
  return true;
}

const HEADERS = {
  'x-api-key': API_KEY,
  Origin: 'https://www.bettingpros.com',
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Every offer in one season market, paged. The page cap is a guard against a pagination
 * bug walking forever, not a real limit — the widest market runs to eleven pages.
 */
async function fetchOffers(marketId, season) {
  const out = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 40) {
    const res = await get(
      `${BASE}/offers?sport=NFL&market_id=${marketId}&season=${season}&limit=${PAGE_SIZE}&page=${page}`,
      { headers: HEADERS, timeout: 45000, retries: 1 },
    );
    totalPages = Number(res.data?._pagination?.total_pages) || 0;
    const offers = res.data?.offers;
    if (Array.isArray(offers)) out.push(...offers);
    page++;
    // Their pages fire these back to back; a short gap keeps a full refresh well clear
    // of anything that would look like hammering.
    if (page <= totalPages) await sleep(100);
  }
  return out;
}

/** The consensus book's line for one side, or null if it is off the board. */
function consensusLine(offer, side) {
  const selection = (offer.selections || []).find(s => s.selection === side);
  const book = (selection?.books || []).find(b => b.id === CONSENSUS_BOOK);
  const line = book?.lines?.[0];
  if (!line || line.active === false || line.is_off) return null;
  const n = Number(line.line);
  return Number.isFinite(n) ? n : null;
}

/** American odds to an implied probability, vig included. */
function impliedProbability(cost) {
  const c = Number(cost);
  if (!Number.isFinite(c) || c === 0) return null;
  return c < 0 ? -c / (-c + 100) : 100 / (c + 100);
}

/** The consensus book's price for one side, or null if it is off the board. */
function consensusPrice(offer, side) {
  const selection = (offer.selections || []).find(s => s.selection === side);
  const book = (selection?.books || []).find(b => b.id === CONSENSUS_BOOK);
  const line = book?.lines?.[0];
  if (!line || line.active === false || line.is_off) return null;
  return impliedProbability(line.cost);
}

/**
 * The market's chance of going over, with the vig taken out.
 *
 * De-vigging is only valid because both prices come from the consensus book at the SAME
 * line — the two best-price quotes are usually at different numbers and de-vigging those
 * would be meaningless. Returns null when either side is unpriced.
 */
function overProbability(offer) {
  const over = consensusPrice(offer, 'over');
  const under = consensusPrice(offer, 'under');
  if (over == null || under == null) return null;
  const total = over + under;
  return total > 0 ? over / total : null;
}

/**
 * The median this quote implies, given how far its price sits from even money.
 *
 * At p = 0.5 this returns the line unchanged. Below it the market is saying the line is a
 * stretch and the median sits lower; above it, higher. `sigma` is the spread of the player's
 * season in log space — see `polymarket.js` for where it comes from.
 */
function impliedMedian(line, pOver, sigma, column) {
  if (!(line > 0) || !(sigma > 0)) return null;
  if (pOver == null) return line;
  const p = Math.min(1 - PRICE_FLOOR, Math.max(PRICE_FLOOR, pOver));
  const z = probit(1 - p);
  if (z == null || !Number.isFinite(z)) return null;
  const median = line * Math.exp(-sigma * z);
  if (!COUNT_COLUMNS.has(column)) return median;
  // See MAX_COUNT_SHIFT: on a count, most of the gap is the book rounding to a half-number.
  const shift = Math.max(-MAX_COUNT_SHIFT, Math.min(MAX_COUNT_SHIFT, median - line));
  return line + shift;
}

/**
 * What share of an offer's real books quote a line near its consensus.
 *
 * Returns null when there are too few books to judge — an offer nobody but the consensus
 * prices is thin, which `mkt_books` already reports, but it is not contradicted.
 *
 * Lines flagged `is_off` are counted. A suspended quote is still the number that book last
 * stood behind, and in the case this exists to catch it was the eleven suspended books that
 * were right and the one live book that was wrong.
 */
function bookSupport(offer, side, consensus) {
  const selection = (offer.selections || []).find(s => s.selection === side);
  const lines = [];
  for (const book of selection?.books || []) {
    if (book.id === CONSENSUS_BOOK) continue;
    for (const l of book.lines || []) {
      const n = Number(l.line);
      if (Number.isFinite(n)) lines.push(n);
    }
  }
  if (lines.length < MIN_BOOKS_TO_CHECK) return null;
  const tolerance = Math.max(SUPPORT_TOLERANCE * Math.abs(consensus), SUPPORT_TOLERANCE_FLOOR);
  return lines.filter(l => Math.abs(l - consensus) <= tolerance).length / lines.length;
}

/** The median line across an offer's real books, ignoring the consensus pseudo-book. */
function bookMedian(offer, side) {
  const selection = (offer.selections || []).find(s => s.selection === side);
  const lines = [];
  for (const book of selection?.books || []) {
    if (book.id === CONSENSUS_BOOK) continue;
    for (const l of book.lines || []) {
      const n = Number(l.line);
      if (Number.isFinite(n)) lines.push(n);
    }
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a - b);
  return lines.length % 2
    ? lines[(lines.length - 1) / 2]
    : (lines[lines.length / 2 - 1] + lines[lines.length / 2]) / 2;
}

/** How many real books priced this offer at all — the consensus is only as good as its inputs. */
function bookCount(offer) {
  const ids = new Set();
  for (const s of offer.selections || []) {
    for (const b of s.books || []) if (b.id !== CONSENSUS_BOOK) ids.add(b.id);
  }
  return ids.size;
}

async function fetchMarketProps() {
  const now = new Date().toISOString();
  const season = new Date().getFullYear();
  const updateMeta = db.prepare(`
    UPDATE source_metadata SET last_fetched = ?, player_count = ?, status = ?, notes = ?
    WHERE source = 'marketprops'
  `);

  // fantasypros_id is BettingPros' own participant id, and the crosswalk carries it — so
  // this joins exactly, with no name matching anywhere in the path.
  let byFantasyPros;
  let crosswalkRows = [];
  try {
    const { rows } = await fetchCsv('ids', SOURCES.ids(), { maxAgeHours: 24, kind: 'ids' });
    crosswalkRows = rows;
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

  // Polymarket's distribution shapes, used to turn a priced line into the median it implies.
  // Its ladders carry no player ids, so it is handed a name index built from the same
  // crosswalk; a name that resolves to more than one player is marked rather than guessed.
  let shapes = { byPlayer: {}, byStat: {} };
  try {
    const byName = new Map();
    for (const r of crosswalkRows) {
      if (!r.sleeper_id || r.sleeper_id === 'NA' || !r.name) continue;
      const key = polymarketName(r.name);
      if (!key) continue;
      byName.set(key, byName.has(key) ? 'AMBIGUOUS' : String(r.sleeper_id));
    }
    shapes = await fetchShapes(byName);
  } catch (err) {
    // Shape is a refinement, not a requirement: without it the fallback spreads apply and
    // the correction degrades rather than the column disappearing.
    console.warn(`[MarketProps] Polymarket shapes unavailable (${err.message}) — using fallback spreads`);
  }

  const bySleeper = db.prepare('SELECT id, position FROM players WHERE sleeper_player_id = ?');
  const values = new Map();       // player row id -> { column: line }
  const positionOf = new Map();
  const books = new Map();        // player row id -> THINNEST book count across his lines
  const groupBooks = new Map();   // player row id -> { rec, rush, pass }: thinnest WITHIN each
  const counts = {};
  const failures = [];
  let sidesDisagreed = 0;
  let lopsided = 0;
  let completeRows = 0;
  let unsupported = 0;
  let adjusted = 0;
  let adjustedFromLadder = 0;
  const adjustedTerms = new Map();

  for (const m of MARKETS) {
    let offers;
    try {
      offers = await fetchOffers(m.id, season);
    } catch (err) {
      failures.push(`${m.label}: ${err.message}`);
      continue;
    }
    if (offers.length < m.min) {
      // A market that has gone quiet must say so. Silently accepting a thin response is
      // how "receptions are not priced" became a fact about this board for a week.
      failures.push(`${m.label}: only ${offers.length} offers (expected ${m.min}+)`);
      continue;
    }

    let n = 0;
    for (const offer of offers) {
      const over = consensusLine(offer, 'over');
      if (over == null) continue;
      // The consensus book quotes both sides at one number on all but a handful. Where it
      // does not, it is mid-move between two quotes; the over side is taken throughout so
      // there is one rule rather than a per-row judgement, and the count is reported.
      const under = consensusLine(offer, 'under');
      if (under != null && under !== over) sidesDisagreed++;

      const [lo, hi] = PLAUSIBLE[m.column];
      if (over < lo || over > hi) continue;

      // A lopsided price means this line is not the market's central estimate. Rejected
      // rather than adjusted — see the header. An offer priced on one side only cannot be
      // checked, so it is kept and its thin book count is what warns the reader.
      const pOver = overProbability(offer);
      // Past the band the lognormal would be extrapolating into a tail it was never fitted
      // on, where one stale price moves the answer enormously. Those are still refused.
      if (pOver != null && Math.abs(pOver - 0.5) > PRICE_BAND) { lopsided++; continue; }

      // A consensus its own books do not support is not a consensus — take theirs instead.
      // The price belongs to the consensus quote, so it is dropped along with it: a repaired
      // line is the books' median, uncorrected.
      let line = over;
      let priced = pOver;
      const support = bookSupport(offer, 'over', over);
      if (support != null && support < MIN_BOOK_SUPPORT) {
        const fromBooks = bookMedian(offer, 'over');
        if (fromBooks == null) continue;
        line = fromBooks;
        priced = null;
        unsupported++;
      }

      const participant = (offer.participants || [])[0];
      const sleeperId = byFantasyPros.get(String(participant?.id));
      if (!sleeperId) continue;
      const row = bySleeper.get(sleeperId);
      if (!row) continue;

      positionOf.set(row.id, row.position);

      // The line as posted is only the median when it is priced at even money. Convert it.
      const { sigma, basis } = sigmaFor(shapes, m.column, sleeperId);
      const median = impliedMedian(line, priced, sigma, m.column);
      if (median == null || median <= 0) continue;
      const [floor, ceiling] = PLAUSIBLE[m.column];
      // Neither the correction nor a repair may carry a line outside what that statistic
      // can be.
      if (median < floor || median > ceiling) continue;
      const moved = Math.abs(median - over) / over > 0.02;
      if (moved) {
        adjusted++;
        if (basis === 'player' && priced != null) adjustedFromLadder++;
      }

      if (!values.has(row.id)) values.set(row.id, {});
      values.get(row.id)[m.column] = Math.round(median * 10) / 10;
      adjustedTerms.set(row.id, (adjustedTerms.get(row.id) || 0) + (moved ? 1 : 0));
      // The weakest link, not the widest: a player whose receiving yards eight books agree
      // on but whose receptions come from one is only as trustworthy as that one.
      const seen = books.get(row.id);
      const count = bookCount(offer);
      books.set(row.id, seen == null ? count : Math.min(seen, count));
      // The same rule again, but only over the markets that feed one scoring component,
      // so a thin line on a statistic he barely accrues cannot mute the rest of him.
      if (!groupBooks.has(row.id)) groupBooks.set(row.id, {});
      const g = groupBooks.get(row.id);
      g[m.group] = g[m.group] == null ? count : Math.min(g[m.group], count);
      n++;
    }
    counts[m.label] = n;
  }

  if (values.size === 0) {
    const msg = failures.length ? failures.join('; ') : 'no offers matched the board';
    updateMeta.run(now, 0, 'error', msg);
    console.error('[MarketProps] ', msg);
    return { success: false, error: msg, source: 'marketprops', timestamp: now };
  }

  // Score the market's own lines under this league's rules, so there is one number
  // directly comparable with the model's projection.
  const update = db.prepare(`
    UPDATE players SET
      ${COLUMNS.map(c => `${c} = @${c}`).join(', ')},
      ${BOOK_COLUMNS.map(c => `${c} = @${c}`).join(', ')},
      mkt_points = @mkt_points, mkt_books = @mkt_books,
      mkt_complete = @mkt_complete, mkt_adjusted = @mkt_adjusted, last_updated = @ts
    WHERE id = @id
  `);

  let written = 0;
  db.transaction(() => {
    // Clear every row first: a line that is withdrawn must not persist as though current.
    db.prepare(`UPDATE players SET ${COLUMNS.map(c => `${c} = NULL`).join(', ')},
                ${BOOK_COLUMNS.map(c => `${c} = NULL`).join(', ')},
                mkt_points = NULL, mkt_books = NULL, mkt_complete = NULL, mkt_adjusted = NULL
                WHERE mkt_points IS NOT NULL OR ${COLUMNS.map(c => `${c} IS NOT NULL`).join(' OR ')}`).run();

    for (const [id, v] of values) {
      const complete = isComplete(positionOf.get(id), v);
      if (complete) completeRows++;
      const pts =
        (v.mkt_pass_yards || 0) * RULES.passing_yards +
        (v.mkt_pass_tds || 0) * RULES.passing_tds +
        (v.mkt_rush_yards || 0) * RULES.rushing_yards +
        (v.mkt_rush_tds || 0) * RULES.rushing_tds +
        (v.mkt_rec_yards || 0) * RULES.receiving_yards +
        (v.mkt_rec_tds || 0) * RULES.receiving_tds +
        (v.mkt_receptions || 0) * RULES.receptions;
      update.run({
        id, ts: now,
        ...Object.fromEntries(COLUMNS.map(c => [c, v[c] ?? null])),
        ...Object.fromEntries(BOOK_GROUPS.map(g => [`mkt_books_${g}`, groupBooks.get(id)?.[g] ?? null])),
        mkt_points: Math.round(pts * 10) / 10,
        mkt_books: books.get(id) || null,
        mkt_complete: complete ? 1 : 0,
        mkt_adjusted: adjustedTerms.get(id) || 0,
      });
      written++;
    }
  })();

  const note = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')
    + (failures.length ? ` · FAILED: ${failures.join('; ')}` : '');
  updateMeta.run(now, written, failures.length ? 'warn' : 'ok', note);
  console.log(`[MarketProps] ${written} players carry a season line — ${note}`);
  console.log(`[MarketProps] consensus book two-sided on all but ${sidesDisagreed} offers; best-price lines never read`);
  console.log(`[MarketProps] dropped ${lopsided} offers priced too far from even money to read as a median`);
  console.log(`[MarketProps] repaired ${unsupported} offers whose consensus line no book behind it agreed with`);
  console.log(`[MarketProps] price-adjusted ${adjusted} lines to the median they imply ` +
    `(${adjustedFromLadder} using the player's own Polymarket ladder, the rest his position's typical spread)`);
  console.log(`[MarketProps] ${completeRows} of ${written} totals cover their position's full scoring; the rest are marked partial`);

  return {
    success: true, players_updated: written, counts, sides_disagreed: sidesDisagreed, lopsided, unsupported, adjusted, complete: completeRows,
    failures, source: 'marketprops', timestamp: now,
  };
}

module.exports = {
  fetchMarketProps, MARKETS, PLAUSIBLE, REQUIRED_TERMS,
  fetchOffers, consensusLine, overProbability, isComplete, bookSupport, bookMedian,
};
