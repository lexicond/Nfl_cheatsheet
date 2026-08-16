#!/usr/bin/env node
/**
 * Render a standalone draft cheat sheet from whatever is currently in the DB.
 *
 *   node server/scripts/build-cheatsheet.js [outfile]
 *
 * The output is a single self-contained HTML file — no server, no network — so it
 * works on a phone in a draft room with no signal. Run refresh-all.js first.
 */
const fs = require('fs');
const path = require('path');
const { db, computeConsensus } = require('../db');

const SEASON = new Date().getFullYear();
const OUT = process.argv[2] || path.join(__dirname, '..', '..', 'cheatsheets', `draft-room-${SEASON}.html`);
const ASSETS = path.join(__dirname, '..', 'cheatsheet');

const FORMATS = [['BB', '1QB'], ['BB', '2QB'], ['RD', '1QB'], ['RD', '2QB'], ['DYN', '1QB'], ['DYN', '2QB']];
const PER_FORMAT = 300;

const SOURCE_COUNT = {
  'BB:1QB': '2 best-ball sources', 'BB:2QB': '2 superflex sources',
  'RD:1QB': '5 redraft markets', 'RD:2QB': '3 superflex sources',
  'DYN:1QB': '4 dynasty sources', 'DYN:2QB': '3 dynasty sources',
};

function headline(r, format, leagueType) {
  if (format === 'DYN') return leagueType === '2QB' ? r.dyn_rank_consensus_sf : r.dyn_rank_consensus;
  return computeConsensus(r, format, leagueType);
}

// Only rostered players: Sleeper still carries historical ADP for retired names,
// and a free agent is not draftable either way.
const rows = db.prepare('SELECT * FROM players WHERE nfl_team IS NOT NULL').all();

const keep = new Set();
for (const [format, leagueType] of FORMATS) {
  rows
    .map(r => ({ id: r.id, v: headline(r, format, leagueType) }))
    .filter(x => x.v != null)
    .sort((a, b) => a.v - b.v)
    .slice(0, PER_FORMAT)
    .forEach(x => keep.add(x.id));
}

const num = v => (v == null ? null : Math.round(Number(v) * 10) / 10);
const int = v => (v == null ? null : Math.round(Number(v)));

const players = rows.filter(r => keep.has(r.id)).map(r => ({
  n: r.name, t: r.nfl_team, p: r.position, b: r.bye_week, pr: num(r.projected_pts),
  ud: num(r.adp_underdog), fpb: num(r.adp_fantasypros), fpr: num(r.adp_fp_rd),
  fps: num(r.adp_fp_sf), fpd: num(r.adp_fp_dyn), ffc: num(r.adp_ffc), ffs: num(r.adp_ffc_sf),
  slr: num(r.adp_sl_rd), sls: num(r.adp_sl_sf), esp: num(r.adp_espn), yah: num(r.adp_yahoo),
  ktc: r.ktc_value, kts: r.ktc_value_sf, fc: int(r.fc_value), fcs: int(r.fc_value_sf),
  dy: num(r.dyn_rank_consensus), dys: num(r.dyn_rank_consensus_sf),
}));

const meta = {};
for (const m of db.prepare('SELECT * FROM source_metadata').all()) meta[m.source] = m;

const fetchedAt = key => {
  const v = meta[key]?.last_fetched;
  if (!v) return 'never';
  return new Date(v).toUTCString().replace(/^\w+, /, '').replace(/:\d\d GMT$/, ' UTC');
};

const css = fs.readFileSync(path.join(ASSETS, 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(ASSETS, 'board.js'), 'utf8');
const builtAt = new Date().toUTCString().replace(/^\w+, /, '').replace(/:\d\d GMT$/, ' UTC');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Draft Room ${SEASON}</title>
<style>
${css}
</style>
</head>
<body>
<div class="wrap">

  <header class="masthead">
    <div>
      <h1>Draft Room ${SEASON}</h1>
      <div class="sub">Half-PPR · 12-team · Consensus board</div>
    </div>
    <div class="stamp">
      Built <b>${builtAt}</b><br>
      ${players.length} rostered players · 7 sources
    </div>
  </header>

  <nav class="rail" aria-label="Board controls">
    <div class="group">
      <span class="lab">Format</span>
      <div class="seg" role="group" aria-label="Format">
        <button data-set="format=BB" aria-pressed="true">Best ball</button>
        <button data-set="format=RD" aria-pressed="false">Redraft</button>
        <button data-set="format=DYN" aria-pressed="false">Dynasty</button>
      </div>
    </div>
    <div class="group">
      <span class="lab">League</span>
      <div class="seg" role="group" aria-label="League type">
        <button data-set="league=1QB" aria-pressed="true">1QB</button>
        <button data-set="league=2QB" aria-pressed="false">Superflex</button>
      </div>
    </div>
    <div class="group">
      <span class="lab">View</span>
      <div class="seg" role="group" aria-label="View">
        <button data-set="view=board" aria-pressed="true">Board</button>
        <button data-set="view=tiers" aria-pressed="false">Tiers</button>
      </div>
    </div>
    <div class="group">
      <span class="lab">Pos</span>
      <div class="seg pos" role="group" aria-label="Position">
        <button data-set="pos=null" aria-pressed="true">All</button>
        <button data-set="pos=QB" data-p="QB" aria-pressed="false">QB</button>
        <button data-set="pos=RB" data-p="RB" aria-pressed="false">RB</button>
        <button data-set="pos=WR" data-p="WR" aria-pressed="false">WR</button>
        <button data-set="pos=TE" data-p="TE" aria-pressed="false">TE</button>
      </div>
    </div>
    <div class="note" id="count"></div>
  </nav>

  <section class="sec" id="map-sec">
    <div class="sec-head">
      <h2>Where each position runs out</h2>
      <p>Every ranked player plotted on the same pick axis. Marked gaps are the two widest drop-offs in supply after round 1.</p>
    </div>
    <div class="map" id="map"></div>
    <div class="map-axis"><div></div><div class="map-ticks" id="map-ticks"></div></div>
  </section>

  <section class="sec" id="board-sec">
    <div class="sec-head">
      <h2>The board</h2>
      <p id="board-why">Grouped by the round the pick actually falls in, at 12 teams.</p>
    </div>
    <div id="board"></div>
  </section>

  <section class="sec" id="cols-sec" hidden>
    <div class="sec-head">
      <h2>Positional tiers</h2>
      <p>Tiers cut where the market leaves a real gap, not at round numbers — the last name in a tier is the one worth reaching for.</p>
    </div>
    <div class="cols" id="cols"></div>
  </section>

  <section class="sec" id="calls-sec">
    <div class="sec-head">
      <h2>Where cost and projection disagree</h2>
      <p>Positional draft rank against positional projection rank, top 180 picks only.</p>
    </div>
    <div class="calls">
      <div class="panel">
        <h3>Projections say later than the market drafts</h3>
        <p class="why">Sleeper projects them well above where they cost.</p>
        <ol id="values"></ol>
      </div>
      <div class="panel">
        <h3>The market drafts earlier than projections say</h3>
        <p class="why">Pay for the role or the upside, not the projected line.</p>
        <ol id="reaches"></ol>
      </div>
    </div>
  </section>

  <footer>
    <h4>Sources, last fetched</h4>
    <ul>
      <li><b>Underdog</b> — best-ball ADP, ½PPR 12-team, via DraftSharks · ${fetchedAt('underdog')}</li>
      <li><b>FantasyPros</b> — expert consensus rankings for best ball, ½PPR redraft, superflex and dynasty · ${fetchedAt('fantasypros')}</li>
      <li><b>Fantasy Football Calculator</b> — live mock-draft ADP, ½PPR and 2QB · ${fetchedAt('ffc')}</li>
      <li><b>Sleeper</b> — season projections and Sleeper's own ADP by format · ${fetchedAt('sleeper')}</li>
      <li><b>ESPN and Yahoo</b> — home-league platform ADP, via DraftSharks · ${fetchedAt('market')}</li>
      <li><b>KeepTradeCut</b> — dynasty values, 1QB and superflex, via DynastyProcess · ${fetchedAt('ktc')}</li>
      <li><b>FantasyCalc</b> — dynasty trade values, 1QB and superflex · ${fetchedAt('fantasycalc')}</li>
    </ul>
    <p class="fine">
      Each format averages only the sources that publish that format, so redraft ADP never skews the best-ball
      board and 1QB rankings never skew superflex. Dynasty has no ADP: its number is the mean <em>rank</em> across
      KeepTradeCut, FantasyCalc, FantasyPros dynasty and Sleeper dynasty ADP, which sit on different scales.
      Projections are Sleeper's half-PPR season totals. Players without an NFL team are excluded.
    </p>
  </footer>
</div>

<script>
const PLAYERS = ${JSON.stringify(players)};
const SOURCE_COUNT = ${JSON.stringify(SOURCE_COUNT)};
${js}
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`Wrote ${OUT} — ${players.length} players, ${(html.length / 1024).toFixed(0)} KB`);
