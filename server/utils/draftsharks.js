const { get, extractJsObject } = require('./http');

const POS_MAP = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE' };

/**
 * Scrape a DraftSharks ADP page.
 *
 * The visible table is rendered client-side, so there is nothing to parse in the
 * DOM. The page ships its data as a `vueAppData` object literal holding
 * `seed.players` (id → name/team/pos) and `seed.adpSets` (id → overall pick).
 *
 * Returns [{ name, position, nfl_team, adp, pos_adp }] sorted by adp.
 */
async function scrapeDraftSharks(url) {
  const res = await get(url);
  const data = extractJsObject(res.data, 'vueAppData');
  if (!data || !data.seed) throw new Error(`No vueAppData payload at ${url}`);

  const { players = {}, adpSets = {} } = data.seed;
  const setKeys = Object.keys(adpSets);
  if (setKeys.length === 0) throw new Error(`No adpSets at ${url}`);

  // A page requested with explicit slugs returns exactly one set; if more than one
  // ever comes back, take the largest rather than whichever key hashes first.
  const rows = setKeys
    .map(k => adpSets[k])
    .filter(Array.isArray)
    .sort((a, b) => b.length - a.length)[0] || [];

  const out = [];
  for (const row of rows) {
    const p = players[row.id];
    if (!p) continue;
    const position = POS_MAP[(p.pos || p.fp || '').toUpperCase()];
    if (!position) continue;
    const name = [p.fn, p.ln].filter(Boolean).join(' ').trim();
    const adp = Number(row.pick);
    if (!name || !Number.isFinite(adp) || adp <= 0) continue;
    out.push({
      name,
      position,
      nfl_team: (p.tm || '').toUpperCase() || null,
      adp,
      pos_adp: Number.isFinite(Number(row.posAdp)) ? Number(row.posAdp) : null,
    });
  }

  out.sort((a, b) => a.adp - b.adp);
  return out;
}

module.exports = { scrapeDraftSharks };
