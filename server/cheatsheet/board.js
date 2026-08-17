const POS = ['QB', 'RB', 'WR', 'TE'];
const TEAM_SIZE = 12;

const state = { format: 'BB', league: '1QB', view: 'board', pos: null };

// Which source columns average into the headline number for each format. Mirrors
// the app: only sources that publish a format feed that format's consensus.
const SOURCES = {
  'BB:1QB': [['ud', 'Underdog'], ['fpb', 'FantasyPros BB']],
  'BB:2QB': [['fps', 'FantasyPros SF'], ['sls', 'Sleeper 2QB']],
  'RD:1QB': [['ffc', 'FFC'], ['fpr', 'FantasyPros'], ['slr', 'Sleeper'], ['esp', 'ESPN'], ['yah', 'Yahoo']],
  'RD:2QB': [['ffs', 'FFC 2QB'], ['fps', 'FantasyPros SF'], ['sls', 'Sleeper 2QB']],
};

const key = () => state.format + ':' + state.league;

function headline(p) {
  if (state.format === 'DYN') return state.league === '2QB' ? p.dys : p.dy;
  const vals = SOURCES[key()].map(([f]) => p[f]).filter(v => v != null);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

// Dynasty inputs, in the same order the app averages them.
const DYN_SOURCES = {
  '1QB': [['ktc', 'KTC'], ['ds', 'DSF'], ['fc', 'FCalc'], ['fpd', 'FP DYN'], ['sld', 'SL DYN']],
  '2QB': [['kts', 'KTC'], ['dss', 'DSF'], ['fcs', 'FCalc'], ['fpds', 'FP DYN'], ['slds', 'SL DYN']],
};

function sourceCount(p) {
  if (state.format === 'DYN') {
    return DYN_SOURCES[state.league].filter(([f]) => p[f] != null).length;
  }
  return SOURCES[key()].filter(([f]) => p[f] != null).length;
}

// The ranked pool for the current format, with positional ranks attached.
function pool() {
  const rows = PLAYERS
    .map(p => ({ ...p, h: headline(p), sc: sourceCount(p) }))
    .filter(p => p.h != null)
    .sort((a, b) => a.h - b.h);

  const posN = {}, projN = {};
  rows.forEach(p => { posN[p.p] = (posN[p.p] || 0) + 1; p.pr_pos = posN[p.p]; });

  // Projection rank within position, over the same pool.
  POS.forEach(pos => {
    rows.filter(p => p.p === pos && p.pr != null)
      .sort((a, b) => b.pr - a.pr)
      .forEach((p, i) => { p.projRank = i + 1; });
  });

  rows.forEach(p => {
    p.value = (p.projRank != null && state.format !== 'DYN') ? p.pr_pos - p.projRank : null;
  });
  rows.sort((a, b) => a.h - b.h);
  return rows;
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

  const MAX = 180;
  el.innerHTML = POS.map(pos => {
    const list = rows.filter(p => p.p === pos && p.h <= MAX);
    const dots = list.map(p =>
      `<i class="map-dot" style="left:${(p.h / MAX) * 100}%;background:var(--${pos.toLowerCase()})"></i>`
    ).join('');

    // Mark the two widest gaps inside the top 180 — the picks after which this
    // position's supply visibly thins.
    const gaps = [];
    for (let i = 0; i < list.length - 1; i++) gaps.push({ at: list[i].h, size: list[i + 1].h - list[i].h, after: i + 1 });
    const cliffs = gaps.filter(g => g.at > 12).sort((a, b) => b.size - a.size).slice(0, 2)
      .map(g => `<i class="map-cliff${g.at / MAX > 0.82 ? ' flip' : ''}" style="left:${(g.at / MAX) * 100}%" data-n="${pos}${g.after}"></i>`).join('');

    return `<div class="map-row">
      <div class="map-lab" style="color:var(--${pos.toLowerCase()})">${pos}</div>
      <div class="map-track">${dots}${cliffs}</div>
    </div>`;
  }).join('');

  document.getElementById('map-ticks').innerHTML =
    [1, 24, 48, 72, 96, 120, 144, 168].map(n =>
      `<span style="left:${(n / 180) * 100}%">${n}</span>`).join('');
}

/* ---------------- board ---------------- */
function renderBoard(rows) {
  const cols = state.format === 'DYN'
    ? DYN_SOURCES[state.league].map(([f, label]) => [label, p => p[f]])
    : SOURCES[key()].map(([f, label]) => [label, p => p[f]]);

  const head = `<thead><tr>
    <th class="l">#</th><th class="l">Player</th><th>Pos</th><th>${state.format === 'DYN' ? 'Age' : 'Bye'}</th>
    ${cols.map(c => `<th>${esc(c[0])}</th>`).join('')}
    <th>${state.format === 'DYN' ? 'Rank' : 'Consensus'}</th><th>Proj pts</th><th>Proj rk</th>
  </tr></thead>`;

  let html = '', lastGroup = null, n = 0;
  for (const p of rows) {
    n++;
    const group = state.format === 'DYN'
      ? `Top ${Math.ceil(n / 24) * 24}`
      : `Round ${Math.ceil(p.h / TEAM_SIZE)}`;
    if (group !== lastGroup) {
      html += `</tbody></table></div><div class="round">${esc(group)}</div><div class="scroller"><table>${head}<tbody>`;
      lastGroup = group;
    }

    const d = p.value;
    const delta = d == null || Math.abs(d) < 8 ? ''
      : `<span class="delta ${d > 0 ? 'up' : 'down'}" title="${d > 0
          ? `Projects ${d} spots higher at ${p.p} than his draft cost`
          : `Drafted ${Math.abs(d)} spots earlier at ${p.p} than he projects`}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;

    html += `<tr>
      <td class="rk">${n}</td>
      <td class="nm"><div class="pname">${esc(p.n)} ${delta}</div>
        <div class="pmeta">${esc(p.t || 'FA')} · ${p.p}${p.pr_pos}${p.sc < 2 ? ' · 1 source' : ''}</div></td>
      <td><span class="chip ${p.p}">${p.p}</span></td>
      <td class="dim">${(state.format === 'DYN' ? p.age : p.b) ?? '–'}</td>
      ${cols.map(c => { const v = c[1](p); return `<td class="dim">${v == null ? '–' : (v > 999 ? v.toLocaleString() : fmt1(v))}</td>`; }).join('')}
      <td class="big">${fmt1(p.h)}</td>
      <td class="dim">${p.pr == null ? '–' : p.pr.toFixed(0)}</td>
      <td class="dim">${p.projRank != null ? p.p + p.projRank : '–'}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  document.getElementById('board').innerHTML = html.replace(/^<\/tbody><\/table><\/div>/, '');
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

  const graded = rows.filter(p => p.value != null && p.h <= 180);
  const line = p => `<li><span class="n">${esc(p.n)}</span>
    <span class="t" style="color:var(--${p.p.toLowerCase()});font-size:10px;font-weight:700">${p.p}${p.pr_pos}</span>
    <span class="g">ADP ${fmt1(p.h)} · projects ${p.p}${p.projRank}</span></li>`;

  document.getElementById('values').innerHTML =
    graded.slice().sort((a, b) => b.value - a.value).slice(0, 8).map(line).join('');
  document.getElementById('reaches').innerHTML =
    graded.slice().sort((a, b) => a.value - b.value).slice(0, 8).map(line).join('');
}

/* ---------------- wiring ---------------- */
function render() {
  const all = pool();
  const rows = state.pos ? all.filter(p => p.p === state.pos) : all;

  document.getElementById('board-sec').hidden = state.view !== 'board';
  document.getElementById('cols-sec').hidden = state.view !== 'tiers';

  renderMap(all);
  if (state.view === 'board') renderBoard(rows.slice(0, 240)); else renderCols(all);
  renderCalls(all);

  document.getElementById('board-why').textContent = state.format === 'DYN'
    ? 'Ordered by mean rank across the dynasty value sources, in blocks of 24.'
    : 'Grouped by the round the pick actually falls in, at 12 teams.';

  document.getElementById('count').textContent =
    `${rows.length} ranked · ${SOURCE_COUNT[key()]}`;

  document.querySelectorAll('[data-set]').forEach(b => {
    const [k, v] = b.dataset.set.split('=');
    b.setAttribute('aria-pressed', String(state[k] === (v === 'null' ? null : v)));
  });

  // Superflex only exists as a concept where a source publishes it.
  document.querySelectorAll('[data-set^="league"]').forEach(b => { b.disabled = false; });
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-set]');
  if (!b) return;
  const [k, v] = b.dataset.set.split('=');
  state[k] = v === 'null' ? null : v;
  render();
});

render();
