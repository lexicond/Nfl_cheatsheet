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
 * **A line is only a median if it is priced like one.** The consensus book usually quotes
 * both sides near even money, and there the line is the market's central estimate. It does
 * not always: book 68 alone posted De'Zhaun Stribling — a rookie receiver — at 74.5
 * receptions, over at +245 against under at -376, which is the market saying he has about
 * a 27% chance of getting there, not that it expects him to. Read as a median that line
 * makes him a top-20 receiver. Measured across all seven markets only 3-8% of offers are
 * lopsided like that, so they are rejected rather than corrected: recovering a median from
 * a one-sided quote needs an assumed distribution shape the market has not published, and
 * a guessed number that looks like a market line is worse than no number.
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

const BASE = 'https://api.bettingpros.com/v3';

// Lifted from bettingpros.com's public bundle. Overridable so a rotation can be fixed
// without a deploy.
const API_KEY = process.env.BETTINGPROS_KEY || 'CHi8Hy5CEE4khd46XNYL23dCFX96oUdw6qOt1Dnh';

// BettingPros' own consensus across the books it prices, carried as a pseudo-book.
const CONSENSUS_BOOK = 0;

// The `/offers` route refuses anything above 10 with a 400.
const PAGE_SIZE = 10;

// How far the de-vigged over price may sit from even money before the line stops being a
// median. A quote at -110/-110 is 0.500; the widest kept here is a bit past 2/1 against.
// Chosen from the data: the median offer sits within 0.03 of even, so this rejects the
// lopsided tail without touching the market proper.
const PRICE_BAND = 0.15;

// Season-long over/under markets, verified live against `/offers`.
//
// Two markets in their season list are deliberately absent. 303 (interceptions) returns
// zero offers AND zero props — it is genuinely unpriced, which means quarterback totals
// here carry no interception term and so read roughly two dozen points high against a
// projection that does score them. That is stated on the column rather than papered over
// with an estimate. Market ids 47-57 are multi-way LEADER markets ("most passing yards")
// and must never be mixed in — they are not two-sided over/unders at all.
const MARKETS = [
  { id: 300, column: 'mkt_pass_yards', label: 'passing yards', min: 25 },
  { id: 301, column: 'mkt_rush_yards', label: 'rushing yards', min: 40 },
  { id: 302, column: 'mkt_rec_yards', label: 'receiving yards', min: 60 },
  { id: 304, column: 'mkt_pass_tds', label: 'passing TDs', min: 25 },
  { id: 305, column: 'mkt_rush_tds', label: 'rushing TDs', min: 40 },
  { id: 306, column: 'mkt_rec_tds', label: 'receiving TDs', min: 60 },
  { id: 330, column: 'mkt_receptions', label: 'receptions', min: 50 },
];

// A line outside these bounds is not a season total for that stat, whatever the API says.
const PLAUSIBLE = {
  mkt_pass_yards: [1000, 6500], mkt_rush_yards: [50, 2500], mkt_rec_yards: [50, 2200],
  mkt_pass_tds: [5, 60], mkt_rush_tds: [0.5, 30], mkt_rec_tds: [0.5, 25],
  mkt_receptions: [5, 160],
};

const COLUMNS = MARKETS.map(m => m.column);

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
  const values = new Map();       // player row id -> { column: line }
  const positionOf = new Map();
  const books = new Map();        // player row id -> THINNEST book count across his lines
  const counts = {};
  const failures = [];
  let sidesDisagreed = 0;
  let lopsided = 0;
  let completeRows = 0;

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
      if (pOver != null && Math.abs(pOver - 0.5) > PRICE_BAND) { lopsided++; continue; }

      const participant = (offer.participants || [])[0];
      const sleeperId = byFantasyPros.get(String(participant?.id));
      if (!sleeperId) continue;
      const row = bySleeper.get(sleeperId);
      if (!row) continue;

      positionOf.set(row.id, row.position);
      if (!values.has(row.id)) values.set(row.id, {});
      values.get(row.id)[m.column] = over;
      // The weakest link, not the widest: a player whose receiving yards eight books agree
      // on but whose receptions come from one is only as trustworthy as that one.
      const seen = books.get(row.id);
      books.set(row.id, seen == null ? bookCount(offer) : Math.min(seen, bookCount(offer)));
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
      mkt_points = @mkt_points, mkt_books = @mkt_books,
      mkt_complete = @mkt_complete, last_updated = @ts
    WHERE id = @id
  `);

  let written = 0;
  db.transaction(() => {
    // Clear every row first: a line that is withdrawn must not persist as though current.
    db.prepare(`UPDATE players SET ${COLUMNS.map(c => `${c} = NULL`).join(', ')},
                mkt_points = NULL, mkt_books = NULL, mkt_complete = NULL
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
        mkt_points: Math.round(pts * 10) / 10,
        mkt_books: books.get(id) || null,
        mkt_complete: complete ? 1 : 0,
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
  console.log(`[MarketProps] ${completeRows} of ${written} totals cover their position's full scoring; the rest are marked partial`);

  return {
    success: true, players_updated: written, counts, sides_disagreed: sidesDisagreed, lopsided, complete: completeRows,
    failures, source: 'marketprops', timestamp: now,
  };
}

module.exports = {
  fetchMarketProps, MARKETS, PLAUSIBLE, REQUIRED_TERMS,
  fetchOffers, consensusLine, overProbability, isComplete,
};
