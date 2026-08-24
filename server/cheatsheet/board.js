const POS = ['QB', 'RB', 'WR', 'TE'];
const TEAM_SIZES = [8, 10, 12, 14];

const state = {
  format: 'BB', league: '1QB', view: 'board', pos: null,
  teams: 12, sort: '', off: null,
  // Mid-draft the players already gone are noise, so they come off by default. The
  // toggle only appears when a live draft is attached.
  hideTaken: true,
};

// Sources switched off, by family. One list for the whole sheet rather than one per
// view: a family covers a market's 1QB and Superflex boards together, so flipping
// Superflex cannot silently re-enable something you turned off.
try {
  const saved = JSON.parse(localStorage.getItem('draftroom_prefs') || 'null');
  if (saved && typeof saved === 'object') {
    if (Array.isArray(saved.off)) state.off = saved.off;
    if (TEAM_SIZES.includes(saved.teams)) state.teams = saved.teams;
  }
} catch (e) { /* private mode or corrupt value — fall back to the defaults */ }
if (state.off === null) state.off = DEFAULT_OFF.slice();

// A sheet built for one specific draft opens on that draft's board — set here, before
// the first render, so it is right on the first paint and stays right even if the room
// has no signal and no poll ever answers.
if (typeof LIVE !== 'undefined' && LIVE) {
  if (LIVE.format) state.format = LIVE.format;
  if (LIVE.league) state.league = LIVE.league;
  if (LIVE.teams) state.teams = LIVE.teams;
}

const isOff = field => state.off.includes(FAMILY_OF[field]);

// data-set carries strings; the state they drive is not all strings.
function coerceSet(k, v) {
  if (v === 'null') return null;
  if (k === 'teams') return Number(v);
  if (k === 'hideTaken') return v === '1';
  return v;
}

function savePrefs() {
  try {
    localStorage.setItem('draftroom_prefs', JSON.stringify({ off: state.off, teams: state.teams }));
  } catch (e) { /* ignore */ }
}

// Which source columns average into the headline number for each format. Mirrors
// the app: only sources that publish a format feed that format's consensus.
const SOURCES = {
  'BB:1QB': [['ud', 'Underdog'], ['fpb', 'FantasyPros BB']],
  'BB:2QB': [['fps', 'FantasyPros SF'], ['sls', 'Sleeper 2QB']],
  'RD:1QB': [['ffc', 'FFC'], ['fpr', 'FantasyPros'], ['slr', 'Sleeper'], ['esp', 'ESPN'], ['yah', 'Yahoo']],
  'RD:2QB': [['ffs', 'FFC 2QB'], ['fps', 'FantasyPros SF'], ['sls', 'Sleeper 2QB']],
};

const key = () => state.format + ':' + state.league;

// Sleeper is where the drafting happens, so the disagreement that matters is against
// Sleeper's own board. Best ball has no Sleeper board; its half-PPR redraft ADP stands
// in and the column header says so.
const SLEEPER_FIELD = {
  'BB:1QB': 'slr', 'BB:2QB': 'sls',
  'RD:1QB': 'slr', 'RD:2QB': 'sls',
  'DYN:1QB': 'sld', 'DYN:2QB': 'slds',
};

// The sources feeding the current view, minus anything switched off.
function activeSources() {
  const defs = state.format === 'DYN' ? DYN_SOURCES[state.league] : SOURCES[key()];
  return defs.filter(([f]) => !isOff(f));
}

function headline(p) {
  const active = activeSources();
  if (!active.length) return null;

  if (state.format === 'DYN') {
    // Dynasty values are on different scales, so ranks are averaged, not the values.
    const ranks = active.map(([f]) => DYN_RANKS[f]).filter(Boolean);
    const mine = ranks.map(r => r.get(p.n)).filter(v => v != null);
    if (!mine.length) return null;
    return Math.round((mine.reduce((a, b) => a + b, 0) / mine.length) * 10) / 10;
  }

  const vals = active.map(([f]) => p[f]).filter(v => v != null);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

// Dynasty inputs, in the same order the app averages them.
const DYN_SOURCES = {
  '1QB': [['ktc', 'KTC'], ['ds', 'DSF'], ['fc', 'FCalc'], ['fpd', 'FP DYN'], ['sld', 'SL DYN']],
  '2QB': [['kts', 'KTC'], ['dss', 'DSF'], ['fcs', 'FCalc'], ['fpds', 'FP DYN'], ['slds', 'SL DYN']],
};

function sourceCount(p) {
  return activeSources().filter(([f]) => p[f] != null).length;
}

// How far apart the active sources are on one player, in places.
function spreadOf(p) {
  const active = activeSources();
  const vals = state.format === 'DYN'
    ? active.map(([f]) => DYN_RANKS[f] && DYN_RANKS[f].get(p.n)).filter(v => v != null)
    : active.map(([f]) => p[f]).filter(v => v != null);
  if (vals.length < 2) return null;
  return Math.round(Math.max(...vals) - Math.min(...vals));
}

// Dynasty ranks have to be built across the whole pool before any one player can be
// scored, so they are rebuilt whenever the active set changes.
let DYN_RANKS = {};
function buildDynastyRanks() {
  DYN_RANKS = {};
  if (state.format !== 'DYN') return;
  for (const [field] of DYN_SOURCES[state.league]) {
    const desc = SOURCE_META[field] && SOURCE_META[field].kind === 'value';
    const ranked = PLAYERS.filter(p => p[field] != null)
      .sort((a, b) => (desc ? b[field] - a[field] : a[field] - b[field]));
    const m = new Map();
    ranked.forEach((p, i) => m.set(p.n, i + 1));
    DYN_RANKS[field] = m;
  }
}

// How much of a flex spot each position actually takes. A flex is overwhelmingly a
// back or a receiver, so splitting it evenly would set the tight-end bar far too high.
const FLEX_SHARE = { RB: 0.4, WR: 0.45, TE: 0.15 };
let ROUND_REPLACEMENT = {};

/**
 * The projection of the last player at each position worth starting in this league.
 * Subtracting it is what makes a quarterback's points comparable with a running back's
 * — at four-point passing touchdowns quarterbacks out-score everyone and are still not
 * automatically the better pick.
 *
 * Mirrors replacementLevels in server/model/combine.js. Kept in step by hand because
 * the sheet is a single standalone file with no imports; if one changes, change both.
 */
function replacementLevels(rows) {
  const sf = state.leagueType === '2QB';
  const slots = { QB: sf ? 1.7 : 1, RB: 2, WR: 3, TE: 1, FLEX: 1 };
  const out = {};
  for (const pos of POS) {
    const flex = pos === 'QB' ? 0 : slots.FLEX * (FLEX_SHARE[pos] || 0);
    const depth = Math.max(1, Math.round(state.teams * (slots[pos] + flex)));
    const ranked = rows.filter(p => p.p === pos && p.xfp != null).sort((a, b) => b.xfp - a.xfp);
    if (!ranked.length) { out[pos] = 0; continue; }
    // Average a few either side of the boundary so one odd projection cannot move a
    // whole position's value.
    const band = ranked.slice(Math.max(0, depth - 2), Math.min(ranked.length, depth + 3));
    out[pos] = band.length
      ? band.reduce((a, p) => a + p.xfp, 0) / band.length
      : ranked[ranked.length - 1].xfp;
  }
  return out;
}

// The ranked pool for the current format, with positional ranks attached.
function pool() {
  buildDynastyRanks();
  let rows = PLAYERS
    .map(p => ({ ...p, h: headline(p), sc: sourceCount(p), taken: p.sid ? TAKEN[p.sid] : null }))
    .filter(p => p.h != null)
    .sort((a, b) => a.h - b.h);

  const posN = {};
  rows.forEach(p => { posN[p.p] = (posN[p.p] || 0) + 1; p.pr_pos = posN[p.p]; });

  // Projection rank within position, over the same pool.
  POS.forEach(pos => {
    rows.filter(p => p.p === pos && p.pr != null)
      .sort((a, b) => b.pr - a.pr)
      .forEach((p, i) => { p.projRank = i + 1; });
  });

  rows.forEach(p => {
    p.value = (p.projRank != null && state.format !== 'DYN') ? p.pr_pos - p.projRank : null;
    p.spread = spreadOf(p);
    p.round = state.format === 'DYN' ? null : Math.ceil(p.h / state.teams);
  });

  // Value over replacement, from the model's projection. Computed here rather than
  // baked in by the generator because it moves with league size and with superflex,
  // both of which the reader can change on the page — the same reason the app derives
  // it per request instead of storing it.
  const repl = replacementLevels(rows);
  rows.forEach(p => {
    p.xvor = (p.xfp != null && state.format !== 'DYN')
      ? Math.round(p.xfp - (repl[p.p] || 0)) : null;
  });
  ROUND_REPLACEMENT = repl;

  // Sleeper gap: where Sleeper drafts him against where the consensus rates him.
  // Positive means he comes cheaper on Sleeper. Taken from Sleeper's own board whether
  // or not Sleeper is one of the ticked sources.
  const slField = SLEEPER_FIELD[key()];
  const slRank = new Map();
  PLAYERS.filter(p => p[slField] != null)
    .sort((a, b) => a[slField] - b[slField])
    .forEach((p, i) => slRank.set(p.n, i + 1));
  rows.sort((a, b) => a.h - b.h);
  rows.forEach((p, i) => {
    const sl = slRank.get(p.n);
    p.slGap = sl != null ? sl - (i + 1) : null;
  });

  // Best ball has no Sleeper board, so the baseline is Sleeper's redraft ADP — and best
  // ball values positions differently, which puts a standing offset on whole positions.
  // Subtracting each position's median makes the number read against its own norm.
  const norms = {};
  for (const pos of POS) {
    const vals = rows.filter((p, i) => p.p === pos && p.slGap != null && i < 150)
      .map(p => p.slGap).sort((a, b) => a - b);
    norms[pos] = vals.length >= 8 ? vals[Math.floor(vals.length / 2)] : 0;
  }
  rows.forEach(p => {
    p.slNorm = norms[p.p] || 0;
    p.slGapAdj = p.slGap == null ? null : p.slGap - p.slNorm;
  });

  // Drafted players come out only at the very end. Every rank above — positional rank,
  // projection rank, the Sleeper gap and its positional norms — is counted over the
  // whole pool, so a player being taken elsewhere in the room never renumbers anyone
  // still on the board. Filtering earlier made all of them drift as the draft went on.
  return state.hideTaken ? rows.filter(p => !p.taken) : rows;
}

// Tier breaks fall where the market itself leaves a gap, not on round numbers.
// The gap that counts as a break widens as ADP gets deeper, because a two-pick
// difference at pick 5 means far more than at pick 120.
function tierBreaks(list) {
  const tiers = [];
  let cur = [];
  for (let i = 0; i < list.length; i++) {
    cur.push(list[i]);
    const next = list[i + 1];
    if (!next) break;
    const gap = next.h - list[i].h;
    const threshold = Math.max(2.5, list[i].h * 0.14);
    if (gap >= threshold && cur.length >= 2) { tiers.push(cur); cur = []; }
  }
  if (cur.length) tiers.push(cur);
  return tiers;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt1 = v => (v == null ? '–' : v.toFixed(1));

/* ---------------- scarcity map ---------------- */
function renderMap(rows) {
  const el = document.getElementById('map');
  const host = document.getElementById('map-sec');
  if (state.format === 'DYN') { host.hidden = true; return; }
  host.hidden = false;

  const MAX = state.teams * 15;
  el.innerHTML = POS.map(pos => {
    const list = rows.filter(p => p.p === pos && p.h <= MAX);
    const dots = list.map(p =>
      `<i class="map-dot" style="left:${(p.h / MAX) * 100}%;background:var(--${pos.toLowerCase()})"></i>`
    ).join('');

    // Mark the two widest gaps inside the top 180 — the picks after which this
    // position's supply visibly thins.
    const gaps = [];
    for (let i = 0; i < list.length - 1; i++) gaps.push({ at: list[i].h, size: list[i + 1].h - list[i].h, after: i + 1 });
    const cliffs = gaps.filter(g => g.at > state.teams).sort((a, b) => b.size - a.size).slice(0, 2)
      .map(g => `<i class="map-cliff${g.at / MAX > 0.82 ? ' flip' : ''}" style="left:${(g.at / MAX) * 100}%" data-n="${pos}${g.after}"></i>`).join('');

    return `<div class="map-row">
      <div class="map-lab" style="color:var(--${pos.toLowerCase()})">${pos}</div>
      <div class="map-track">${dots}${cliffs}</div>
    </div>`;
  }).join('');

  const step = state.teams * 2;
  const ticks = [1];
  for (let t = step; t < MAX; t += step) ticks.push(t);
  document.getElementById('map-ticks').innerHTML =
    ticks.map(n => `<span style="left:${(n / MAX) * 100}%">${n}</span>`).join('');
}

/* ---------------- board ---------------- */
function renderBoard(rows) {
  const refs = (REFERENCE_SOURCES[key()] || []).filter(([f]) => !isOff(f));
  const cols = [...activeSources(), ...refs].map(([f, label]) => [label, p => p[f]]);
  const slProxy = state.format === 'BB';
  // The model's derived columns ride with its source column: switching it off in the
  // sources list takes the whole family away rather than leaving VOR with nothing
  // behind it. Dynasty never shows them — this is a one-season projection.
  const showModel = state.format !== 'DYN' && !isOff('xfp');

  // One table with one sticky header, rather than a fresh table per round — the header
  // has to stay put as you scroll a 240-row board mid-draft.
  const head = `<thead><tr>
    <th class="l">#</th><th class="l">Player</th><th>Pos</th>
    <th>${state.format === 'DYN' ? 'Age' : 'Bye'}</th>
    ${cols.map(c => `<th>${esc(c[0])}</th>`).join('')}
    <th>${state.format === 'DYN' ? 'Rank' : 'Consensus'}</th>
    ${state.format === 'DYN' ? '' : '<th>Rd</th>'}
    <th title="Places cheaper (+) or dearer (-) on Sleeper than the consensus${slProxy ? '. Sleeper publishes no best-ball board, so this is its half-PPR redraft ADP' : ''}">&Delta; SL</th>
    <th title="How many places apart your ticked sources are on him">Split</th>
    ${showModel ? `<th title="Points above the last ${state.teams}-team ${state.leagueType === '2QB' ? 'superflex' : '1QB'} starter at his position, from this board's own model. The number to compare across positions — raw points are not comparable.">VOR</th>`
      + '<th title="85th-percentile season from simulating the year week by week. Best ball starts your best players automatically, so the ceiling is closer to what you are buying than the average is.">Ceil</th>' : ''}
    <th>Proj</th><th>Proj rk</th>
  </tr></thead>`;

  const colCount = 4 + cols.length + (state.format === 'DYN' ? 3 : 4) + 2 + (showModel ? 2 : 0);
  // Round markers only mean anything while the board is in draft order. Under any other
  // sort they would interleave — Round 34, Round 19, Round 31 — so they are dropped and
  // the Rd column carries the round instead.
  const showGroups = state.sort === '';
  let body = '';
  let lastGroup = null;
  let n = 0;

  for (const p of rows) {
    n++;
    const group = state.format === 'DYN'
      ? `Top ${Math.ceil(n / 24) * 24}`
      : `Round ${p.round}`;
    if (showGroups && group !== lastGroup) {
      body += `<tr class="roundrow"><td colspan="${colCount}">${esc(group)}</td></tr>`;
      lastGroup = group;
    }

    const d = p.value;
    const delta = d == null || Math.abs(d) < 8 ? ''
      : `<span class="delta ${d > 0 ? 'up' : 'down'}" title="${d > 0
          ? `Projects ${d} spots higher at ${p.p} than his draft cost`
          : `Drafted ${Math.abs(d)} spots earlier at ${p.p} than he projects`}">${d > 0 ? '\u25b2' : '\u25bc'}${Math.abs(d)}</span>`;

    const g = p.slGapAdj;
    const normNote = p.slNorm ? ` (against the ${p.slNorm > 0 ? '+' : ''}${p.slNorm} every ${p.p} carries here)` : '';
    const gap = g == null ? '<span class="muted">&ndash;</span>'
      : Math.abs(g) < 5 ? '<span class="muted">&middot;</span>'
      : `<span class="${g > 0 ? 'gap-cheap' : 'gap-dear'}" title="${g > 0
          ? `Sleeper drafts him ${g} places later than the consensus, so he comes cheaper there`
          : `Sleeper drafts him ${Math.abs(g)} places earlier than the consensus, so he costs more there`}${normNote}">${g > 0 ? '+' : ''}${g}</span>`;

    const split = p.spread == null ? '<span class="muted">&ndash;</span>'
      : `<span class="${p.spread >= 24 ? 'split-wide' : p.spread >= 12 ? '' : 'muted'}">${p.spread}</span>`;

    // A player already taken in the live draft, shown only when "hide taken" is off.
    const tk = p.taken
      ? ` <span class="tkchip${p.taken.mine ? ' mine' : ''}">#${p.taken.pick}${p.taken.mine ? ' you' : ''}</span>`
      : '';

    body += `<tr${p.taken ? ' class="taken"' : ''}>
      <td class="rk">${n}</td>
      <td class="nm"><div class="pname">${esc(p.n)} ${delta}${tk}</div>
        <div class="pmeta">${esc(p.t || 'FA')} &middot; ${p.p}${p.pr_pos}${p.sc < 2 ? ' &middot; 1 source' : ''}</div></td>
      <td><span class="chip ${p.p}">${p.p}</span></td>
      <td class="dim">${(state.format === 'DYN' ? p.age : p.b) ?? '&ndash;'}</td>
      ${cols.map(c => { const v = c[1](p); return `<td class="dim">${v == null ? '&ndash;' : (v > 999 ? v.toLocaleString() : fmt1(v))}</td>`; }).join('')}
      <td class="big">${fmt1(p.h)}</td>
      ${state.format === 'DYN' ? '' : `<td class="dim">${p.round}</td>`}
      <td>${gap}</td>
      <td>${split}</td>
      ${showModel ? `<td class="big">${p.xvor == null ? '&ndash;' : p.xvor}</td>`
        + `<td class="dim">${p.xc == null ? '&ndash;' : p.xc.toFixed(0)}</td>` : ''}
      <td class="dim">${p.pr == null ? '&ndash;' : p.pr.toFixed(0)}</td>
      <td class="dim">${p.projRank != null ? p.p + p.projRank : '&ndash;'}</td>
    </tr>`;
  }

  // Preserve where the user was scrolled to, so toggling a source mid-draft does not
  // throw them back to pick one.
  const pane = document.querySelector('.board-scroll');
  const keepTop = pane ? pane.scrollTop : 0;
  const keepLeft = pane ? pane.scrollLeft : 0;

  document.getElementById('board').innerHTML =
    `<div class="scroller board-scroll"><table class="board-table">${head}<tbody>${body}</tbody></table></div>`;

  const fresh = document.querySelector('.board-scroll');
  if (fresh) { fresh.scrollTop = keepTop; fresh.scrollLeft = keepLeft; }
}

/* ---------------- positional tiers ---------------- */
function renderCols(rows) {
  const shown = state.pos ? [state.pos] : POS;
  document.getElementById('cols').innerHTML = shown.map(pos => {
    const list = rows.filter(p => p.p === pos).slice(0, 48);
    const tiers = tierBreaks(list);
    return `<div>
      <div class="col-head ${pos}">${pos}<span>${list.length}</span></div>
      ${tiers.map((t, i) => `<div class="tier">
        <div class="tier-lab">Tier ${i + 1}</div>
        <ol>${t.map(p => `<li>
          <span class="n">${esc(p.n)}</span>
          <span class="t">${esc(p.t || 'FA')}${state.format === 'DYN' ? (p.age ? ' · ' + p.age : '') : (p.b ? ' · ' + p.b : '')}</span>
          <span class="a">${fmt1(p.h)}</span>
        </li>`).join('')}</ol>
      </div>`).join('')}
    </div>`;
  }).join('');
}

/* ---------------- callouts ---------------- */
function renderCalls(rows) {
  const host = document.getElementById('calls-sec');
  if (state.format === 'DYN') { host.hidden = true; return; }
  host.hidden = false;

  const graded = rows.filter(p => p.value != null && p.h <= state.teams * 15);
  const line = p => `<li><span class="n">${esc(p.n)}</span>
    <span class="t" style="color:var(--${p.p.toLowerCase()});font-size:10px;font-weight:700">${p.p}${p.pr_pos}</span>
    <span class="g">ADP ${fmt1(p.h)} · projects ${p.p}${p.projRank}</span></li>`;

  document.getElementById('values').innerHTML =
    graded.slice().sort((a, b) => b.value - a.value).slice(0, 8).map(line).join('');
  document.getElementById('reaches').innerHTML =
    graded.slice().sort((a, b) => a.value - b.value).slice(0, 8).map(line).join('');
}

/* ---------------- sources panel ---------------- */
function renderSources() {
  const defs = state.format === 'DYN' ? DYN_SOURCES[state.league] : SOURCES[key()];
  const refs = (REFERENCE_SOURCES[key()] || []);
  const activeCount = defs.filter(([f]) => !isOff(f)).length;
  const onlyOneLeft = activeCount <= 1;

  const card = ([field, label], isRef) => {
    const meta = SOURCE_META[field] || {};
    const off = isOff(field);
    const disabled = !isRef && !off && onlyOneLeft;
    return `<label class="srccard${off ? ' off' : ''}${isRef ? ' ref' : ''}">
      <input type="checkbox" data-src="${field}" ${off ? '' : 'checked'} ${disabled ? 'disabled' : ''}>
      <span class="nm">${esc(label)}</span>
      <span class="kind kind-${meta.kind || 'adp'}">${esc(meta.kindLabel || '')}</span>
      <span class="tip">
        <b>${esc(meta.label || label)}</b>
        ${esc(meta.what || '')}
        <span class="meta">
          Scoring: ${esc(meta.scoringLabel || '—')}<br>
          From: ${esc(meta.provider || '—')}
          ${isRef ? '<br><span class="warn">Shown for reference — never averaged in</span>' : ''}
          ${disabled ? '<br><span class="warn">Cannot switch off the last source</span>' : ''}
        </span>
      </span>
    </label>`;
  };

  document.getElementById('src-lead').innerHTML =
    `The <b>${state.format === 'DYN' ? 'Rank' : 'Consensus'}</b> column averages the ` +
    `<b>${activeCount}</b> of ${defs.length} sources ticked below, and you can sort the ` +
    `board by any of them. Untick one to take it out of the average and off the board — ` +
    `the choice sticks when you switch Superflex on and off. Hover any source to see what it is.`;

  document.getElementById('src-list').innerHTML =
    defs.map(d => card(d, false)).join('') + refs.map(d => card(d, true)).join('');

  const editedHere = [...defs, ...refs].some(([f]) => isOff(f));
  document.getElementById('src-reset').hidden = !editedHere;
}

/* ---------------- sort control ---------------- */
function renderSortOptions() {
  const refs = (REFERENCE_SOURCES[key()] || []).filter(([f]) => !isOff(f));
  const opts = [
    ['', state.format === 'DYN' ? 'Dynasty rank' : 'Consensus'],
    ...[...activeSources(), ...refs].map(([f, label]) => [f, label]),
    ['__gap', 'Cheapest on Sleeper'],
    ['__split', 'Most disagreement'],
    ...(state.format === 'DYN' ? [['__age', 'Age (youngest)']] : []),
    ['__proj', 'Projected points'],
    ...(state.format !== 'DYN' && !isOff('xfp')
      ? [['__vor', 'Value over replacement'], ['__ceil', 'Highest ceiling']] : []),
  ];
  const sel = document.getElementById('sortby');
  // Fall back to the consensus if the previously chosen source has been switched off.
  if (!opts.some(([v]) => v === state.sort)) state.sort = '';
  sel.innerHTML = opts.map(([v, l]) =>
    `<option value="${v}"${v === state.sort ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

// Ordering for whichever sort the user picked. Everything falls back to the consensus.
function sortRows(rows) {
  const k = state.sort;
  const by = (get, dir) => rows.slice().sort((a, b) => {
    const av = get(a), bv = get(b);
    if (av == null && bv == null) return a.h - b.h;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === 'desc' ? bv - av : av - bv;
  });
  if (k === '__gap') return by(p => p.slGapAdj, 'desc');
  if (k === '__split') return by(p => p.spread, 'desc');
  if (k === '__age') return by(p => p.age, 'asc');
  if (k === '__proj') return by(p => p.pr, 'desc');
  if (k === '__vor') return by(p => p.xvor, 'desc');
  if (k === '__ceil') return by(p => p.xc, 'desc');
  if (k && SOURCE_META[k]) {
    // ADP and ranks count up from the best pick; trade values, projections and betting
    // lines count down from it. Reading this the wrong way round does not error, it
    // just quietly puts the worst player at the top of the board.
    const desc = ['value', 'model', 'market'].includes(SOURCE_META[k].kind);
    return by(p => p[k], desc ? 'desc' : 'asc');
  }
  return rows;
}

/* ---------------- wiring ---------------- */
function render() {
  const all = pool();
  const rows = state.pos ? all.filter(p => p.p === state.pos) : all;

  document.getElementById('board-sec').hidden = state.view !== 'board';
  document.getElementById('cols-sec').hidden = state.view !== 'tiers';

  renderSources();
  renderSortOptions();
  renderMap(all);
  if (state.view === 'board') renderBoard(sortRows(rows).slice(0, 240)); else renderCols(all);
  renderCalls(all);

  const sortLabel = document.querySelector('#sortby option:checked');
  document.getElementById('board-why').textContent = state.sort !== ''
    ? `Ordered by ${(sortLabel ? sortLabel.textContent : 'your chosen source').toLowerCase()}. The Rd column still shows the round at ${state.teams} teams.`
    : state.format === 'DYN'
      ? 'Ordered by mean rank across the dynasty value sources, in blocks of 24.'
      : `Grouped by the round the pick falls in at ${state.teams} teams. Headings stay put as you scroll.`;

  const active = activeSources().length;
  document.getElementById('count').textContent =
    `${rows.length} ranked · ${active} source${active === 1 ? '' : 's'}`;

  document.querySelectorAll('[data-set]').forEach(b => {
    const [k, v] = b.dataset.set.split('=');
    b.setAttribute('aria-pressed', String(state[k] === coerceSet(k, v)));
  });

  // Superflex only exists as a concept where a source publishes it.
  document.querySelectorAll('[data-set^="league"]').forEach(b => { b.disabled = false; });
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-set]');
  if (!b) return;
  const [k, v] = b.dataset.set.split('=');
  state[k] = coerceSet(k, v);
  if (k === 'teams') savePrefs();
  render();
});

document.getElementById('sortby').addEventListener('change', e => {
  state.sort = e.target.value;
  render();
});

document.addEventListener('change', e => {
  const box = e.target.closest('[data-src]');
  if (!box) return;
  const family = FAMILY_OF[box.dataset.src];
  state.off = box.checked
    ? state.off.filter(f => f !== family)
    : [...state.off, family];
  savePrefs();
  render();
});

document.getElementById('src-reset').addEventListener('click', () => {
  state.off = [];
  savePrefs();
  render();
});

render();
