const { get, JSON_HEADERS } = require('../utils/http');

const API = 'https://api.sleeper.app/v1';

// Sleeper ids are snowflakes — long digit strings. Anything else is a username.
const ID_RE = /^\d{6,25}$/;

/**
 * Pull a draft id out of whatever the user pasted: a draft URL, a bare id, or a
 * league URL. Sleeper's draft links look like sleeper.com/draft/nfl/<id>, and its
 * mock drafts use the same path.
 */
function parseDraftRef(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (ID_RE.test(raw)) return raw;

  const url = raw.match(/sleeper\.(?:com|app)\/draft\/[a-z]+\/(\d{6,25})/i);
  if (url) return url[1];

  // A trailing id on any sleeper URL — covers /draft/nfl/<id>/... and shared links.
  const tail = raw.match(/sleeper\.(?:com|app)\/.*?(\d{12,25})/i);
  return tail ? tail[1] : null;
}

async function fetchJson(url, timeout = 15000) {
  const res = await get(url, { headers: JSON_HEADERS, timeout, retries: 1 });
  return res.data;
}

/** The season Sleeper itself considers current. */
async function currentSeason() {
  const state = await fetchJson(`${API}/state/nfl`);
  const season = state && state.season ? String(state.season) : null;
  if (!season) throw new Error('Sleeper state endpoint returned no season');
  return season;
}

/**
 * Fetch a draft and prove it is the one we think it is.
 *
 * A draft id is just a number: /v1/draft/<id> answers 200 for any draft Sleeper has
 * ever hosted, in any sport, from any season. A 2021 dynasty draft returns forty
 * perfectly valid picks that would mark forty players off this year's board. So the
 * sport and the season are asserted rather than assumed, and everything else the
 * draft claims about itself is handed back for the panel to display.
 */
async function fetchDraft(draftId, expectedSeason) {
  const d = await fetchJson(`${API}/draft/${draftId}`);
  if (!d || !d.draft_id) throw new Error(`No draft found with id ${draftId}`);

  if (d.sport !== 'nfl') {
    throw new Error(`That draft is ${String(d.sport || 'an unknown sport').toUpperCase()}, not NFL`);
  }
  const season = expectedSeason || (await currentSeason());
  if (String(d.season) !== season) {
    throw new Error(`That is a ${d.season} draft — this board is for ${season}`);
  }

  const s = d.settings || {};
  const meta = d.metadata || {};
  return {
    draft_id: String(d.draft_id),
    status: d.status || null,              // pre_draft | drafting | paused | complete
    type: d.type || null,                  // snake | linear | auction
    sport: d.sport,
    season: String(d.season),
    scoring_type: meta.scoring_type || null,
    league_id: d.league_id ? String(d.league_id) : null,
    league_name: meta.name || null,
    teams: Number(s.teams) || null,
    rounds: Number(s.rounds) || null,
    reversal_round: Number(s.reversal_round) || 0,
    pick_timer: Number(s.pick_timer) || 0,
    start_time: d.start_time || null,
    last_picked: d.last_picked || null,
    draft_order: d.draft_order || null,
    slot_to_roster_id: d.slot_to_roster_id || null,
  };
}

async function fetchPicks(draftId) {
  const picks = await fetchJson(`${API}/draft/${draftId}/picks`, 20000);
  if (!Array.isArray(picks)) throw new Error('Draft picks endpoint did not return a list');
  return picks;
}

/**
 * Display names for the teams in the draft, keyed by user id.
 * Mock drafts have no league, so this is best-effort — the panel falls back to slots.
 */
async function fetchLeagueUsers(leagueId) {
  if (!leagueId) return {};
  try {
    const users = await fetchJson(`${API}/league/${leagueId}/users`);
    if (!Array.isArray(users)) return {};
    const map = {};
    for (const u of users) {
      if (!u || !u.user_id) continue;
      map[String(u.user_id)] = u.metadata?.team_name || u.display_name || null;
    }
    return map;
  } catch {
    return {};
  }
}

/** Resolve a Sleeper username to a user id. */
async function fetchUser(username) {
  const u = await fetchJson(`${API}/user/${encodeURIComponent(String(username).trim())}`);
  if (!u || !u.user_id) throw new Error(`No Sleeper user called "${username}"`);
  return { user_id: String(u.user_id), display_name: u.display_name || null };
}

/**
 * Every NFL draft a user is in this season, newest first — so a username is enough
 * to find the draft without hunting for its id.
 */
async function fetchUserDrafts(username, season) {
  const user = await fetchUser(username);
  const yr = season || (await currentSeason());
  const drafts = await fetchJson(`${API}/user/${user.user_id}/drafts/nfl/${yr}`);
  const list = Array.isArray(drafts) ? drafts : [];
  return {
    user,
    season: yr,
    drafts: list
      .map(d => ({
        draft_id: String(d.draft_id),
        status: d.status || null,
        type: d.type || null,
        league_name: d.metadata?.name || null,
        scoring_type: d.metadata?.scoring_type || null,
        teams: Number(d.settings?.teams) || null,
        rounds: Number(d.settings?.rounds) || null,
        start_time: d.start_time || null,
        created: d.created || null,
      }))
      // A live draft is almost always what you want, then the ones yet to start.
      .sort((a, b) => {
        const rank = s => (s === 'drafting' || s === 'paused' ? 0 : s === 'pre_draft' ? 1 : 2);
        return rank(a.status) - rank(b.status) || (b.created || 0) - (a.created || 0);
      }),
  };
}

/**
 * Which draft slot owns a given overall pick.
 *
 * Returns null when the answer cannot be trusted: auctions have no pick order at all,
 * and a third-round reversal changes the direction of the snake in a way this does not
 * model. Showing nothing beats showing the wrong team on the clock.
 */
function slotForPick(pickNo, { type, teams, reversal_round }) {
  if (!teams || !pickNo || pickNo < 1) return null;
  if (type !== 'snake' && type !== 'linear') return null;
  if (type === 'snake' && reversal_round) return null;

  const round = Math.ceil(pickNo / teams);
  const idx = pickNo - (round - 1) * teams;
  if (type === 'linear') return idx;
  return round % 2 === 1 ? idx : teams - idx + 1;
}

/** The next pick at or after `fromPick` belonging to `slot`. */
function nextPickForSlot(fromPick, slot, meta) {
  if (!slot || !meta.teams) return null;
  const limit = meta.rounds ? meta.teams * meta.rounds : meta.teams * 30;
  for (let n = Math.max(1, fromPick); n <= limit; n++) {
    if (slotForPick(n, meta) === slot) return n;
  }
  return null;
}

module.exports = {
  API,
  parseDraftRef,
  currentSeason,
  fetchDraft,
  fetchPicks,
  fetchLeagueUsers,
  fetchUser,
  fetchUserDrafts,
  slotForPick,
  nextPickForSlot,
};
