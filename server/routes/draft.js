const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { normalizeName } = require('../utils/normalize');
const {
  parseDraftRef, currentSeason, fetchDraft, fetchPicks, fetchLeagueUsers,
  fetchUserDrafts, slotForPick, nextPickForSlot,
} = require('../scrapers/sleeperDraft');

// Sleeper asks for under 1000 calls a minute. A floor between fetches keeps several
// open tabs — or a hammered refresh button — down to one poll every couple of seconds
// however many clients are watching.
const MIN_FETCH_INTERVAL_MS = 2500;
let lastFetchAt = 0;

const getSession = () => db.prepare('SELECT * FROM draft_sync WHERE id = 1').get() || null;

const bySleeperId = db.prepare('SELECT id FROM players WHERE sleeper_player_id = ?');
const byNorm = db.prepare('SELECT id FROM players WHERE name_normalized = ? AND position = ?');

/**
 * Find the board row a pick refers to.
 *
 * Sleeper's own player_id is carried on both sides, so the match is an id lookup and
 * none of the name-matching traps apply. The name fallback is only for rows that
 * predate a Sleeper link, and it deliberately stops at an exact normalized name plus
 * position — no surname fallback. A wrong guess here does not just mis-rank a player,
 * it takes the wrong man off the board mid-draft.
 */
function matchPlayer(pick) {
  const sid = pick.player_id != null ? String(pick.player_id) : null;
  if (sid) {
    const hit = bySleeperId.get(sid);
    if (hit) return hit.id;
  }
  const md = pick.metadata || {};
  const name = [md.first_name, md.last_name].filter(Boolean).join(' ').trim();
  if (!name || !md.position) return null;
  const hit = byNorm.get(normalizeName(name), md.position);
  return hit ? hit.id : null;
}

const upsertPick = db.prepare(`
  INSERT INTO draft_picks (
    draft_id, pick_no, round, draft_slot, roster_id, picked_by, is_keeper,
    sleeper_player_id, player_id, player_name, position, nfl_team, seen_at
  ) VALUES (
    @draft_id, @pick_no, @round, @draft_slot, @roster_id, @picked_by, @is_keeper,
    @sleeper_player_id, @player_id, @player_name, @position, @nfl_team, @seen_at
  )
  ON CONFLICT(draft_id, pick_no) DO UPDATE SET
    round = excluded.round,
    draft_slot = excluded.draft_slot,
    roster_id = excluded.roster_id,
    picked_by = excluded.picked_by,
    is_keeper = excluded.is_keeper,
    sleeper_player_id = excluded.sleeper_player_id,
    player_id = excluded.player_id,
    player_name = excluded.player_name,
    position = excluded.position,
    nfl_team = excluded.nfl_team
`);
// seen_at is never overwritten: it is when this pick first appeared to us, which is
// what "new since you last looked" is counted from.

/**
 * Pull the current pick list and store it.
 *
 * The stored set is made to match Sleeper's exactly rather than only appended to,
 * because a commissioner can undo a pick — and a player left sitting as "taken" after
 * that is worse than one missing, since he silently never comes back onto the board.
 */
function storePicks(draftId, picks) {
  const now = new Date().toISOString();
  let matched = 0;

  const write = db.transaction(() => {
    const keep = new Set();
    for (const p of picks) {
      const pickNo = Number(p.pick_no);
      if (!Number.isFinite(pickNo)) continue;
      keep.add(pickNo);
      const md = p.metadata || {};
      const playerId = matchPlayer(p);
      if (playerId) matched++;
      upsertPick.run({
        draft_id: draftId,
        pick_no: pickNo,
        round: Number(p.round) || null,
        draft_slot: Number(p.draft_slot) || null,
        roster_id: Number(p.roster_id) || null,
        picked_by: p.picked_by ? String(p.picked_by) : null,
        is_keeper: p.is_keeper ? 1 : 0,
        sleeper_player_id: p.player_id != null ? String(p.player_id) : null,
        player_id: playerId,
        player_name: [md.first_name, md.last_name].filter(Boolean).join(' ').trim() || null,
        position: md.position || null,
        nfl_team: md.team || null,
        seen_at: now,
      });
    }

    const stored = db.prepare('SELECT pick_no FROM draft_picks WHERE draft_id = ?').all(draftId);
    const stale = stored.map(r => r.pick_no).filter(n => !keep.has(n));
    if (stale.length > 0) {
      const del = db.prepare('DELETE FROM draft_picks WHERE draft_id = ? AND pick_no = ?');
      for (const n of stale) del.run(draftId, n);
    }
    return stale.length;
  });

  const removed = write();
  return { matched, removed, total: picks.length };
}

/**
 * Refresh the connected draft from Sleeper. Returns the session row as it now stands.
 * A failed poll is recorded on the session and does not throw: losing the wifi for a
 * moment mid-draft should show a stale marker, not tear down the connection.
 */
async function syncDraft(session, { force = false } = {}) {
  if (!session) return null;
  const since = Date.now() - lastFetchAt;
  if (!force && since < MIN_FETCH_INTERVAL_MS) return session;
  lastFetchAt = Date.now();

  try {
    const meta = await fetchDraft(session.draft_id, session.season);
    const picks = await fetchPicks(session.draft_id);
    storePicks(session.draft_id, picks);

    db.prepare(`
      UPDATE draft_sync
      SET status = @status, type = @type, teams = @teams, rounds = @rounds,
          reversal_round = @reversal_round, league_name = COALESCE(@league_name, league_name),
          last_synced = @now, last_error = NULL
      WHERE id = 1
    `).run({
      status: meta.status,
      type: meta.type,
      teams: meta.teams,
      rounds: meta.rounds,
      reversal_round: meta.reversal_round,
      league_name: meta.league_name,
      now: new Date().toISOString(),
    });
  } catch (err) {
    db.prepare('UPDATE draft_sync SET last_error = ? WHERE id = 1').run(err.message);
    console.warn('[draft] sync failed:', err.message);
  }
  return getSession();
}

/** The session, its picks, and everything derived from them, shaped for the panel. */
function draftState(session) {
  if (!session) return { connected: false };

  const picks = db.prepare(`
    SELECT * FROM draft_picks WHERE draft_id = ? ORDER BY pick_no ASC
  `).all(session.draft_id);

  const parse = (json) => {
    try {
      return json ? JSON.parse(json) : {};
    } catch {
      return {};
    }
  };
  const teamNames = parse(session.team_names);
  const draftOrder = parse(session.draft_order);
  const userForSlot = (slot) =>
    Object.keys(draftOrder).find(uid => draftOrder[uid] === slot) || null;

  const meta = {
    type: session.type,
    teams: session.teams,
    rounds: session.rounds,
    reversal_round: session.reversal_round,
  };

  // Who made a pick. Mock drafts and autopicks leave picked_by empty, so the slot's
  // owner is the fallback before the bare slot number.
  const label = (pick) => {
    const uid = pick.picked_by || (pick.draft_slot ? userForSlot(pick.draft_slot) : null);
    return (uid && teamNames[uid]) || (pick.draft_slot ? `Slot ${pick.draft_slot}` : null);
  };

  const picksMade = picks.length;
  const totalPicks = session.teams && session.rounds ? session.teams * session.rounds : null;
  const nextPickNo = picksMade + 1;
  const complete = session.status === 'complete' || (totalPicks != null && picksMade >= totalPicks);

  const onClockSlot = complete ? null : slotForPick(nextPickNo, meta);
  const onClockUser = onClockSlot ? userForSlot(onClockSlot) : null;

  const myNext = !complete && session.my_slot
    ? nextPickForSlot(nextPickNo, session.my_slot, meta)
    : null;

  return {
    connected: true,
    draft: {
      draft_id: session.draft_id,
      status: session.status,
      type: session.type,
      season: session.season,
      scoring_type: session.scoring_type,
      league_name: session.league_name,
      teams: session.teams,
      rounds: session.rounds,
      last_synced: session.last_synced,
      last_error: session.last_error,
      url: `https://sleeper.com/draft/nfl/${session.draft_id}`,
    },
    me: session.my_slot ? {
      display_name: session.my_display_name,
      slot: session.my_slot,
      next_pick_no: myNext,
      // How many picks until it is your turn — 0 means you are on the clock.
      picks_away: myNext != null ? myNext - nextPickNo : null,
    } : null,
    picks_made: picksMade,
    total_picks: totalPicks,
    complete,
    on_the_clock: onClockSlot ? {
      pick_no: nextPickNo,
      round: session.teams ? Math.ceil(nextPickNo / session.teams) : null,
      slot: onClockSlot,
      team: (onClockUser && teamNames[onClockUser]) || `Slot ${onClockSlot}`,
      is_me: session.my_slot != null && onClockSlot === session.my_slot,
    } : null,
    // Newest first: during a draft the only picks worth screen space are the last few.
    recent: picks.slice(-12).reverse().map(p => ({
      pick_no: p.pick_no,
      round: p.round,
      draft_slot: p.draft_slot,
      name: p.player_name,
      position: p.position,
      nfl_team: p.nfl_team,
      by: label(p),
      is_keeper: p.is_keeper === 1,
      is_mine: session.my_slot != null && p.draft_slot === session.my_slot,
      // A pick we could not match is shown anyway, marked, so a kicker going off the
      // board never reads as this board silently missing a pick.
      matched: p.player_id != null,
    })),
    unmatched: picks.filter(p => p.player_id == null).length,
  };
}

// POST /api/draft/connect  { ref, username? }
router.post('/connect', async (req, res) => {
  try {
    const draftId = parseDraftRef(req.body.ref);
    if (!draftId) {
      return res.status(400).json({
        error: 'Could not read a draft id from that. Paste the draft URL from Sleeper, or the id itself.',
      });
    }

    const season = await currentSeason();
    // Throws with a plain reason if this is not an NFL draft for the current season.
    const meta = await fetchDraft(draftId, season);
    const teamNames = await fetchLeagueUsers(meta.league_id);

    // Knowing which slot is yours turns the pick feed into a countdown to your turn.
    let mine = { user_id: null, display_name: null, slot: null };
    const username = String(req.body.username || '').trim();
    if (username && meta.draft_order) {
      try {
        const { fetchUser } = require('../scrapers/sleeperDraft');
        const user = await fetchUser(username);
        mine = {
          user_id: user.user_id,
          display_name: teamNames[user.user_id] || user.display_name || username,
          slot: meta.draft_order[user.user_id] ?? null,
        };
      } catch (err) {
        // A bad username is not a reason to refuse the draft — connect without it.
        console.warn('[draft] username lookup failed:', err.message);
      }
    }

    const now = new Date().toISOString();
    db.prepare('DELETE FROM draft_sync').run();
    // Picks from a previous draft would otherwise stay on the board.
    db.prepare('DELETE FROM draft_picks').run();
    db.prepare(`
      INSERT INTO draft_sync (
        id, draft_id, status, type, season, scoring_type, league_id, league_name,
        teams, rounds, reversal_round, my_user_id, my_display_name, my_slot,
        team_names, draft_order, connected_at, last_synced
      ) VALUES (
        1, @draft_id, @status, @type, @season, @scoring_type, @league_id, @league_name,
        @teams, @rounds, @reversal_round, @my_user_id, @my_display_name, @my_slot,
        @team_names, @draft_order, @now, @now
      )
    `).run({
      draft_id: meta.draft_id,
      status: meta.status,
      type: meta.type,
      season: meta.season,
      scoring_type: meta.scoring_type,
      league_id: meta.league_id,
      league_name: meta.league_name,
      teams: meta.teams,
      rounds: meta.rounds,
      reversal_round: meta.reversal_round,
      my_user_id: mine.user_id,
      my_display_name: mine.display_name,
      my_slot: mine.slot,
      team_names: JSON.stringify(teamNames),
      draft_order: meta.draft_order ? JSON.stringify(meta.draft_order) : null,
      now,
    });

    const picks = await fetchPicks(meta.draft_id);
    const stored = storePicks(meta.draft_id, picks);

    res.json({
      ...draftState(getSession()),
      matched: stored.matched,
      // What the draft says it is. Worth reading before trusting the board: a 200 from
      // Sleeper proves the draft exists, not that it is the one you are sitting in.
      confirm: {
        league_name: meta.league_name,
        scoring_type: meta.scoring_type,
        type: meta.type,
        teams: meta.teams,
        rounds: meta.rounds,
        status: meta.status,
        season: meta.season,
      },
    });
  } catch (err) {
    console.error('[POST /api/draft/connect]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/draft/state — the poll endpoint. Syncs first unless asked not to.
router.get('/state', async (req, res) => {
  try {
    let session = getSession();
    if (session && req.query.sync !== '0') {
      session = await syncDraft(session);
    }
    res.json(draftState(session));
  } catch (err) {
    console.error('[GET /api/draft/state]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/draft/sync — force a poll, ignoring the throttle.
router.post('/sync', async (req, res) => {
  try {
    const session = getSession();
    if (!session) return res.status(400).json({ error: 'No draft connected' });
    res.json(draftState(await syncDraft(session, { force: true })));
  } catch (err) {
    console.error('[POST /api/draft/sync]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/draft/disconnect — stop following, and put every live pick back on the
// board. Players marked drafted by hand are untouched; they are a separate flag.
router.post('/disconnect', (req, res) => {
  try {
    db.prepare('DELETE FROM draft_picks').run();
    db.prepare('DELETE FROM draft_sync').run();
    res.json({ connected: false });
  } catch (err) {
    console.error('[POST /api/draft/disconnect]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/draft/lookup?username=… — find a user's drafts so a username is enough.
router.get('/lookup', async (req, res) => {
  try {
    const username = String(req.query.username || '').trim();
    if (!username) return res.status(400).json({ error: 'username is required' });
    res.json(await fetchUserDrafts(username));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
// Exported for tests/validate-draft-sync.js, which drives the pipeline against a real
// draft without going through HTTP.
module.exports.storePicks = storePicks;
module.exports.draftState = draftState;
module.exports.getSession = getSession;
module.exports.matchPlayer = matchPlayer;
