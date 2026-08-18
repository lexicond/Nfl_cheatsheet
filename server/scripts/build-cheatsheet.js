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
const { db } = require('../db');
const { viewSources, COLUMNS, DEFAULT_OFF_FAMILIES } = require('../sources');

const SEASON = new Date().getFullYear();

// --draft <id|url> attaches a live Sleeper draft; --user <name> marks your own picks
// and counts down to your turn. Without them the sheet is the static snapshot it has
// always been.
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
// Which flags consume the argument after them. Assuming they all do meant --no-poll
// swallowed the output path and the build silently overwrote the committed sheet.
const VALUE_FLAGS = new Set(['--draft', '--user', '--format']);
const positional = argv.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));

const OUT = positional[0] || path.join(__dirname, '..', '..', 'cheatsheets', `draft-room-${SEASON}.html`);
const ASSETS = path.join(__dirname, '..', 'cheatsheet');

const FORMATS = [['BB', '1QB'], ['BB', '2QB'], ['RD', '1QB'], ['RD', '2QB'], ['DYN', '1QB'], ['DYN', '2QB']];
const PER_FORMAT = 300;

const { adpConsensus } = require('../consensus');

function headline(r, format, leagueType) {
  if (format === 'DYN') return leagueType === '2QB' ? r.dyn_rank_consensus_sf : r.dyn_rank_consensus;
  return adpConsensus(r, format, leagueType);
}

// The embedded player rows use short keys to keep the file small, so the registry's
// column names are mapped onto them. Anything unmapped would silently lose its
// explanation, so the build fails loudly instead.
const PAYLOAD_KEY = {
  adp_underdog: 'ud', adp_fantasypros: 'fpb',
  adp_fp_rd: 'fpr', adp_fp_sf: 'fps', adp_fp_dyn: 'fpd', adp_fp_dyn_sf: 'fpds',
  adp_ffc: 'ffc', adp_ffc_sf: 'ffs',
  adp_sl_rd: 'slr', adp_sl_sf: 'sls', adp_sl_dyn: 'sld', adp_sl_dyn_sf: 'slds',
  adp_espn: 'esp', adp_yahoo: 'yah',
  ktc_value: 'ktc', ktc_value_sf: 'kts',
  ds_value: 'ds', ds_value_sf: 'dss',
  fc_value: 'fc', fc_value_sf: 'fcs',
  dp_value: 'dp', dp_value_sf: 'dps',
  ff_pos_rank: 'ffb', ff_pos_rank_rd: 'ffb',
};

// Everything the page needs to describe and toggle its own sources, taken straight
// from the registry so the sheet and the app always explain them the same way.
const SOURCE_META = {};
const REFERENCE_SOURCES = {};
for (const [format, leagueType] of FORMATS) {
  const view = viewSources(format, leagueType);
  const keyOf = s => {
    const k = PAYLOAD_KEY[s.column];
    if (!k) throw new Error(`No payload key mapped for source column "${s.column}" — add it to PAYLOAD_KEY`);
    return k;
  };
  REFERENCE_SOURCES[`${format}:${leagueType}`] = view.reference.map(s => [keyOf(s), s.short]);
  for (const s of [...view.consensus, ...view.reference]) {
    SOURCE_META[keyOf(s)] = {
      label: s.label, kind: s.kind, kindLabel: s.kindLabel,
      scoringLabel: s.scoringLabel, provider: s.provider, what: s.what,
    };
  }
}

// Payload key -> source family, so the sheet can hold one off-list across every view.
const FAMILY_OF = {};
for (const [column, def] of Object.entries(COLUMNS)) {
  const k = PAYLOAD_KEY[column];
  if (k) FAMILY_OF[k] = def.family;
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
  // sid is Sleeper's own player id — how a live draft's picks find their row without
  // going anywhere near name matching.
  sid: r.sleeper_player_id || null,
  n: r.name, t: r.nfl_team, p: r.position, b: r.bye_week, pr: num(r.projected_pts),
  ud: num(r.adp_underdog), fpb: num(r.adp_fantasypros), fpr: num(r.adp_fp_rd),
  fps: num(r.adp_fp_sf), fpd: num(r.adp_fp_dyn), ffc: num(r.adp_ffc), ffs: num(r.adp_ffc_sf),
  slr: num(r.adp_sl_rd), sls: num(r.adp_sl_sf), esp: num(r.adp_espn), yah: num(r.adp_yahoo),
  ktc: r.ktc_value, kts: r.ktc_value_sf,
  ds: r.ds_value, dss: r.ds_value_sf,
  fc: int(r.fc_value), fcs: int(r.fc_value_sf),
  fpd: num(r.adp_fp_dyn), fpds: num(r.adp_fp_dyn_sf),
  dp: r.dp_value, dps: r.dp_value_sf,
  ffb: r.ff_pos_rank,
  sld: num(r.adp_sl_dyn), slds: num(r.adp_sl_dyn_sf),
  age: r.age == null ? null : Math.round(Number(r.age)),
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
const liveJs = fs.readFileSync(path.join(ASSETS, 'live.js'), 'utf8');

// Accepts a draft URL or a bare id, the same as the app.
const draftRef = flag('draft');
const draftId = draftRef
  ? (/^\d{6,25}$/.test(draftRef.trim())
      ? draftRef.trim()
      : (draftRef.match(/sleeper\.(?:com|app)\/draft\/[a-z]+\/(\d{6,25})/i) || [])[1] || null)
  : null;
if (draftRef && !draftId) {
  console.error(`Could not read a draft id from "${draftRef}"`);
  process.exit(1);
}
// Sleeper's scoring_type says half_ppr for a best ball league and a redraft one alike,
// so which of the two this is cannot be read off the draft — take it from --format,
// defaulting to redraft. Dynasty and superflex it can tell, and does.
const liveFormat = ['BB', 'RD'].includes((flag('format') || '').toUpperCase())
  ? flag('format').toUpperCase()
  : 'RD';
// Resolved here rather than in the page, so the sheet opens on the right board on the
// very first paint — before any poll has answered, and still correctly if none ever does
// because the draft room's wifi is gone. fetchDraft asserts the sport and season, so a
// wrong id fails at build time rather than halfway through a draft.
async function resolveLive() {
  if (!draftId) return null;
  const { fetchDraft, fetchUser, fetchPicks } = require('../scrapers/sleeperDraft');
  const meta = await fetchDraft(draftId);
  const sc = meta.scoring_type || '';
  let slot = null;
  const username = flag('user');
  if (username && meta.draft_order) {
    try {
      const u = await fetchUser(username);
      slot = meta.draft_order[u.user_id] ?? null;
      if (slot == null) console.warn(`[live] ${username} is not in this draft — no pick countdown`);
    } catch (err) {
      console.warn(`[live] could not resolve ${username}: ${err.message}`);
    }
  }
  // The picks so far are baked in too, so the sheet is already correct the moment it
  // opens — before any poll answers, and at all in a viewer that cannot reach Sleeper.
  const picks = await fetchPicks(draftId);
  const taken = {};
  for (const p of picks) {
    if (p.player_id == null) continue;
    taken[String(p.player_id)] = {
      pick: p.pick_no, round: p.round, slot: p.draft_slot,
      mine: slot != null && p.draft_slot === slot,
    };
  }

  return {
    draftId,
    username: username || null,
    slot,
    season: meta.season,
    name: meta.league_name,
    teams: [8, 10, 12, 14].includes(meta.teams) ? meta.teams : null,
    // Dynasty and superflex are legible in the scoring type; best ball and redraft are
    // not, since Sleeper calls both half_ppr.
    format: /dynasty/.test(sc) ? 'DYN' : liveFormat,
    league: /2qb|superflex/.test(sc) ? '2QB' : '1QB',
    // Everything the bar needs before its first poll.
    draftType: meta.type,
    rounds: meta.rounds,
    reversal: meta.reversal_round,
    status: meta.status,
    taken,
    pickCount: picks.length,
    builtAt: new Date().toISOString(),
    // --no-poll is for somewhere the page cannot reach Sleeper at all: it then presents
    // itself honestly as a snapshot rather than sitting there claiming to be live.
    poll: !argv.includes('--no-poll'),
  };
}
const builtAt = new Date().toUTCString().replace(/^\w+, /, '').replace(/:\d\d GMT$/, ' UTC');

function build(LIVE) {
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
      ${players.length} rostered players · 8 sources
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
      <span class="lab">Teams</span>
      <div class="seg" role="group" aria-label="League size">
        <button data-set="teams=8" aria-pressed="false">8</button>
        <button data-set="teams=10" aria-pressed="false">10</button>
        <button data-set="teams=12" aria-pressed="true">12</button>
        <button data-set="teams=14" aria-pressed="false">14</button>
      </div>
    </div>
    <div class="group">
      <span class="lab">Sort</span>
      <select class="selectish" id="sortby" aria-label="Sort the board by"></select>
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
    ${LIVE ? `<div class="group">
      <span class="lab">Drafted</span>
      <div class="seg" role="group" aria-label="Players already taken">
        <button data-set="hideTaken=1" aria-pressed="true">Hide</button>
        <button data-set="hideTaken=0" aria-pressed="false">Show</button>
      </div>
    </div>` : ''}
    <div class="note" id="count"></div>
  </nav>

  <div id="livebar" class="livebar" hidden></div>

  <section class="sec" id="sources-sec">
    <div class="sec-head">
      <h2>What this board is made of</h2>
      <p id="src-lead"></p>
    </div>
    <div class="srcbar">
      <div class="srclist" id="src-list"></div>
      <button class="srcreset" id="src-reset" hidden>Turn every source on</button>
    </div>
  </section>

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
      <p id="board-why"></p>
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
      <li><b>KeepTradeCut and DynastySuperflex</b> — two independent dynasty markets, 1QB and superflex, via Dynasty Daddy · ${fetchedAt('dynastydaddy')}</li>
      <li><b>FantasyCalc</b> — dynasty trade values, 1QB and superflex · ${fetchedAt('fantasycalc')}</li>
      <li><b>The Fantasy Footballers</b> — Andy, Jason and Mike's projections, averaged and ranked within each position on this board's scoring · ${fetchedAt('footballers')}</li>
      <li><b>DynastyProcess</b> — dynasty values and player ages; shown but not averaged, being FantasyPros-derived · ${fetchedAt('dynastyprocess')}</li>
    </ul>
    <p class="fine">
      Each format averages only the sources that publish that format, so redraft ADP never skews the best-ball
      board and 1QB rankings never skew superflex — superflex boards come from genuinely superflex feeds, and
      dynasty from genuinely dynasty ones. Dynasty has no ADP: its number is the mean <em>rank</em> across
      KeepTradeCut, DynastySuperflex, FantasyCalc, FantasyPros dynasty and Sleeper dynasty ADP, which sit on
      different scales. DynastyProcess is displayed but deliberately left out of that average, since its values
      track FantasyPros dynasty ECR at rho 0.98 and would weight FantasyPros twice.
      Projections are Sleeper's half-PPR season totals. Players without an NFL team are excluded.
    </p>
  </footer>
</div>

<script>
const PLAYERS = ${JSON.stringify(players)};
const SOURCE_META = ${JSON.stringify(SOURCE_META)};
const FAMILY_OF = ${JSON.stringify(FAMILY_OF)};
const DEFAULT_OFF = ${JSON.stringify(DEFAULT_OFF_FAMILIES)};
const REFERENCE_SOURCES = ${JSON.stringify(REFERENCE_SOURCES)};
const LIVE = ${JSON.stringify(LIVE)};
${liveJs}
${js}
startLive();
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`Wrote ${OUT} — ${players.length} players, ${(html.length / 1024).toFixed(0)} KB`
  + (LIVE ? ` — following ${LIVE.name || 'draft ' + LIVE.draftId}`
      + (LIVE.slot ? `, you at slot ${LIVE.slot}` : '') : ''));
}

resolveLive()
  .then(build)
  .catch(err => { console.error(err.message); process.exit(1); });
