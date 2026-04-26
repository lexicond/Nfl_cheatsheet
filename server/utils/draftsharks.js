const axios = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*',
};

const POS_MAP = { 'QB': 'QB', 'RB': 'RB', 'WR': 'WR', 'TE': 'TE', 'K': 'K', 'DEF': 'DEF', 'DST': 'DEF' };

// "1.10" → overall pick 10 in a 12-team draft
function parseRoundPick(str, teamSize = 12) {
  const parts = String(str).split('.');
  if (parts.length !== 2) return null;
  const round = parseInt(parts[0], 10);
  const pick = parseInt(parts[1], 10);
  if (isNaN(round) || isNaN(pick) || round < 1 || pick < 1) return null;
  return (round - 1) * teamSize + pick;
}

/**
 * Scrape a DraftSharks ADP table page.
 * Returns array of { name, position, nfl_team, adp }.
 * DraftSharks pages use round.pick format (e.g. "1.10") for all draft types.
 */
async function scrapeDraftSharks(url, teamSize = 12) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  const $ = cheerio.load(res.data);
  const players = [];

  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;

    const nameEl = $(row).find('a').first();
    const rawName = (nameEl.text() || $(cells[1]).text()).trim();
    if (!rawName || rawName.length < 2) return;

    let adp = null;
    let pos = null;
    let team = null;

    cells.each((_, cell) => {
      const txt = $(cell).text().trim();
      if (adp == null) {
        const rpMatch = txt.match(/^(\d{1,2})\.(\d{1,2})$/);
        if (rpMatch) { adp = parseRoundPick(txt, teamSize); return; }
        // Some dynasty pages show a plain overall pick integer
        if (/^\d+$/.test(txt)) {
          const n = parseInt(txt, 10);
          if (n > 0 && n < 700) { adp = n; return; }
        }
      }
      if (pos == null && POS_MAP[txt.toUpperCase()]) pos = POS_MAP[txt.toUpperCase()];
      if (team == null && /^[A-Z]{2,3}$/.test(txt) && !POS_MAP[txt] && !['NFL', 'ADP', 'RK', 'AVG'].includes(txt)) {
        team = txt;
      }
    });

    if (rawName && adp != null && pos) {
      players.push({ name: rawName, position: pos, nfl_team: team || null, adp });
    }
  });

  return players;
}

module.exports = { scrapeDraftSharks, parseRoundPick };
