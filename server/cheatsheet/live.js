/* Live Sleeper draft sync for the standalone cheat sheet.
 *
 * The app has a server to poll through; this file does not. It talks to Sleeper
 * straight from the page, which works because api.sleeper.app answers with
 * `access-control-allow-origin: *`. That keeps the sheet what it is meant to be — one
 * HTML file, openable from a phone with no server behind it — while still emptying
 * itself as the room drafts.
 *
 * LIVE is injected by build-cheatsheet.js. With no draft configured the whole layer
 * stays dormant and the sheet behaves exactly as it always has.
 */

const TAKEN = Object.create(null);   // sleeper player id -> { pick, round, slot, by }
const LIVE_STATE = { picks: 0, status: null, meta: null, error: null, lastSync: null, teamNames: {} };

const POLL_MS = 5000;

/** Which slot owns an overall pick. Mirrors server/scrapers/sleeperDraft.js. */
function liveSlotForPick(pickNo, meta) {
  if (!meta || !meta.teams || !pickNo || pickNo < 1) return null;
  if (meta.type !== 'snake' && meta.type !== 'linear') return null;
  const round = Math.ceil(pickNo / meta.teams);
  const idx = pickNo - (round - 1) * meta.teams;
  if (meta.type === 'linear') return idx;
  // Under a third-round reversal the snake does not turn at the reversal round: that
  // round repeats the previous one's order, and every round after alternates from there.
  const forward = meta.reversal && round >= meta.reversal
    ? (round - meta.reversal) % 2 === 1
    : round % 2 === 1;
  return forward ? idx : meta.teams - idx + 1;
}

function liveNextPickForSlot(fromPick, slot, meta) {
  if (!slot || !meta || !meta.teams) return null;
  const limit = meta.rounds ? meta.teams * meta.rounds : meta.teams * 30;
  for (let n = Math.max(1, fromPick); n <= limit; n++) {
    if (liveSlotForPick(n, meta) === slot) return n;
  }
  return null;
}

// Bounded, because draft-room wifi fails by hanging as often as by refusing, and a
// request left pending forever would leave the bar looking live while it is not.
async function liveFetch(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'no answer from Sleeper' : err.message);
  } finally {
    clearTimeout(timer);
  }
}

async function livePoll() {
  if (!LIVE || !LIVE.draftId) return;
  try {
    const [draft, picks] = await Promise.all([
      liveFetch('https://api.sleeper.app/v1/draft/' + LIVE.draftId),
      liveFetch('https://api.sleeper.app/v1/draft/' + LIVE.draftId + '/picks'),
    ]);

    // The same assertion the app makes: a draft id alone proves nothing, since this
    // endpoint answers for every draft Sleeper has ever hosted in any sport or season.
    if (draft.sport !== 'nfl' || String(draft.season) !== String(LIVE.season)) {
      LIVE_STATE.error = 'That draft is ' + draft.sport + ' ' + draft.season + ', not NFL ' + LIVE.season;
      renderLiveBar();
      return;
    }

    const s = draft.settings || {};
    LIVE_STATE.meta = {
      type: draft.type,
      teams: Number(s.teams) || null,
      rounds: Number(s.rounds) || null,
      reversal: Number(s.reversal_round) || 0,
      name: (draft.metadata || {}).name || null,
      scoring: (draft.metadata || {}).scoring_type || null,
    };
    LIVE_STATE.status = draft.status;
    LIVE_STATE.order = draft.draft_order || {};

    // Your slot is resolved from your username once, here rather than at build time, so
    // the file stays correct if it is reused against another draft.
    if (LIVE.slot == null && LIVE.username && !LIVE_STATE.slotTried) {
      LIVE_STATE.slotTried = true;
      try {
        const user = await liveFetch('https://api.sleeper.app/v1/user/' + encodeURIComponent(LIVE.username));
        if (user && user.user_id && LIVE_STATE.order[user.user_id] != null) {
          LIVE.slot = LIVE_STATE.order[user.user_id];
        }
      } catch (e) { /* a bad username costs the countdown, not the sync */ }
    }

    // Open on the board that matches the room. Done once, on the first successful poll,
    // so it never yanks the view out from under someone who has since changed it.
    if (!LIVE_STATE.tuned) {
      LIVE_STATE.tuned = true;
      const sc = LIVE_STATE.meta.scoring || '';
      if (/dynasty/.test(sc)) state.format = 'DYN';
      else if (LIVE.format) state.format = LIVE.format;
      if (/2qb|superflex/.test(sc)) state.league = '2QB';
      if ([8, 10, 12, 14].indexOf(LIVE_STATE.meta.teams) >= 0) state.teams = LIVE_STATE.meta.teams;
    }

    // Rebuilt rather than appended to, so a pick undone by the commissioner puts the
    // player back on the board instead of stranding him as taken.
    for (const k of Object.keys(TAKEN)) delete TAKEN[k];
    for (const p of picks) {
      if (p.player_id == null) continue;
      TAKEN[String(p.player_id)] = {
        pick: p.pick_no,
        round: p.round,
        slot: p.draft_slot,
        mine: LIVE.slot != null && p.draft_slot === LIVE.slot,
      };
    }
    LIVE_STATE.picks = picks.length;
    LIVE_STATE.error = null;
    LIVE_STATE.lastSync = Date.now();
  } catch (err) {
    // A dropped poll is not worth tearing anything down — the next one is seconds away,
    // and the bar shows how stale the last good sync is.
    LIVE_STATE.error = err.message;
  }
  renderLiveBar();
  render();
}

function renderLiveBar() {
  const host = document.getElementById('livebar');
  if (!host) return;
  if (!LIVE || !LIVE.draftId) { host.hidden = true; return; }
  host.hidden = false;

  const m = LIVE_STATE.meta || {};
  const total = m.teams && m.rounds ? m.teams * m.rounds : null;
  const done = LIVE_STATE.status === 'complete' || (total && LIVE_STATE.picks >= total);
  const nextPick = LIVE_STATE.picks + 1;
  const onSlot = done ? null : liveSlotForPick(nextPick, m);
  const mySlot = LIVE.slot;
  const myNext = done || !mySlot ? null : liveNextPickForSlot(nextPick, mySlot, m);
  const away = myNext == null ? null : myNext - nextPick;

  const staleSecs = LIVE_STATE.lastSync ? Math.floor((Date.now() - LIVE_STATE.lastSync) / 1000) : null;
  const stale = staleSecs != null && staleSecs > 20;

  let turn = '';
  if (done) {
    turn = '<span class="lv-done">Draft complete</span>';
  } else if (away === 0) {
    turn = '<span class="lv-you">YOU ARE ON THE CLOCK</span>';
  } else if (away != null) {
    turn = '<span class="lv-turn">Your pick <b>#' + myNext + '</b> &middot; ' +
      away + ' away</span>';
  } else if (onSlot) {
    turn = '<span class="lv-turn">Slot ' + onSlot + ' on the clock</span>';
  }

  host.innerHTML =
    '<div class="lv-left">' +
      '<span class="lv-dot' + (stale || LIVE_STATE.error ? ' bad' : '') + '"></span>' +
      '<span class="lv-name">' + (m.name || 'Live draft') + '</span>' +
      '<span class="lv-count"><b>' + LIVE_STATE.picks + '</b>' + (total ? '/' + total : '') + ' picks</span>' +
    '</div>' +
    '<div class="lv-right">' + turn +
      (LIVE_STATE.error
        ? '<span class="lv-warn" title="Retrying every few seconds">offline &middot; ' + esc(LIVE_STATE.error) + '</span>'
        : stale ? '<span class="lv-warn">last sync ' + staleSecs + 's ago</span>' : '') +
    '</div>';
}

function startLive() {
  if (!LIVE || !LIVE.draftId) return;
  livePoll();
  setInterval(livePoll, POLL_MS);
  // The board is the reason you are looking at the page; keep the clock honest between
  // polls so "3 away" does not sit there looking fresh while the room moves.
  setInterval(renderLiveBar, 1000);
}
