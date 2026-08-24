/**
 * Season-long player futures from RotoWire — a second vendor's read on the same betting
 * markets BettingPros reports, used to check it rather than to feed the board.
 *
 * **Why it does not write a column.** It carries the same six markets from broadly the same
 * books, so publishing it beside `MKT` would put two renderings of one market on the board and
 * invite them to be read as two opinions. What it is genuinely good for is catching the case
 * where BettingPros' consensus has come adrift from the market it claims to summarise —
 * which is not hypothetical. Ashton Jeanty's rushing-yards consensus read 574.5 while every
 * live book RotoWire could see had him near 999.5, and it was RotoWire that settled which
 * number was wrong. `validate-projections.js` runs the comparison and reports it.
 *
 * **Its own metadata is not to be trusted.** The brief warned that a Lamar Jackson row came
 * back as a cornerback with a null team, and rows here really do disagree with the board on
 * team and position. So nothing is read from `team`, `pos` or `playerID`: the join is on an
 * exact normalised name against players the board already has, a name matching more than one
 * player is skipped rather than guessed, and everything else comes from the board's own row.
 *
 * **Circa is documented as the sharp reference and is currently absent.** So are BetMGM,
 * BetRivers, Hard Rock and theScore — all five return null on every row. Only DraftKings,
 * Caesars and FanDuel carry lines today. That is worth knowing before building anything on
 * "prefer Circa when present": present is doing a lot of work in that sentence.
 *
 * **Numbers are thousands-separated strings.** `"2,400.0"` parses to 2 without the comma
 * stripped, which is the kind of failure that produces a confident wrong answer rather than
 * an error.
 */
const { get } = require('../utils/http');

const BASE = 'https://www.rotowire.com/betting/nfl/tables/all-player-futures-plus-proj.php';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://www.rotowire.com/betting/nfl/player-futures-plus-proj.php',
  Accept: 'application/json',
};

// Their stat slugs mapped onto the market columns this board stores. `rushplusrecyds` and
// `sacks` are documented as returning an empty array and are not requested; there is no
// receptions table at all, which is the one market BettingPros does carry and this does not.
const STATS = [
  { slug: 'passyds', column: 'mkt_pass_yards', label: 'passing yards' },
  { slug: 'passtd', column: 'mkt_pass_tds', label: 'passing TDs' },
  { slug: 'rushyds', column: 'mkt_rush_yards', label: 'rushing yards' },
  { slug: 'rushtd', column: 'mkt_rush_tds', label: 'rushing TDs' },
  { slug: 'recyds', column: 'mkt_rec_yards', label: 'receiving yards' },
  { slug: 'rectd', column: 'mkt_rec_tds', label: 'receiving TDs' },
];

const BOOKS = ['draftkings', 'fanduel', 'mgm', 'betrivers', 'caesars', 'hardrock', 'thescore', 'circasports'];

/** Their numbers are strings, and the thousands separator is not optional to handle. */
function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

const normaliseName = s => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Every future RotoWire publishes, one row per player-stat.
 *
 * Each row carries the books' lines and RotoWire's own season projection. Nothing is joined
 * here — the caller supplies whatever index it wants matched against, so this stays a pure
 * read of the source.
 */
async function fetchPlayerFutures() {
  const rows = [];
  const failures = [];
  for (const stat of STATS) {
    let data;
    try {
      const res = await get(`${BASE}?future=${stat.slug}`, { headers: HEADERS, timeout: 45000, retries: 1 });
      data = res.data;
    } catch (err) {
      failures.push(`${stat.label}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(data) || data.length === 0) {
      failures.push(`${stat.label}: empty`);
      continue;
    }
    for (const row of data) {
      const books = {};
      for (const book of BOOKS) {
        const line = toNumber(row[`${book}_val`]);
        if (line != null) books[book] = { line, price: toNumber(row[`${book}_ml`]) };
      }
      rows.push({
        name: row.betSubject,
        key: normaliseName(row.betSubject),
        column: stat.column,
        label: stat.label,
        // Their own projection, not a market line. Runs about 7% above the lines.
        projection: toNumber(row.proj),
        books,
      });
    }
  }
  return { rows, failures };
}

module.exports = { fetchPlayerFutures, normaliseName, STATS, BOOKS };
