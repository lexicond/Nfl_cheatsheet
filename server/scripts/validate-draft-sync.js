#!/usr/bin/env node
/**
 * Assert the live Sleeper draft sync is doing what it claims.
 *
 * Like validate-sources.js, this asserts on what the data implies rather than on
 * whether a request returned 200: that the season guard actually refuses a stale
 * draft, that a pick lands on the player it names and not a near-namesake, that an
 * undone pick frees the player again.
 *
 *   node server/scripts/validate-draft-sync.js
 *   SLEEPER_DRAFT_ID=<id> node server/scripts/validate-draft-sync.js   # your own draft
 *
 * Exits non-zero on failure. It writes to draft_picks and draft_sync, so it refuses
 * to run while a draft is connected unless --force is passed.
 */

const { db } = require('../db');
const {
  parseDraftRef, currentSeason, fetchDraft, fetchPicks, slotForPick, nextPickForSlot,
} = require('../scrapers/sleeperDraft');
const draftRoutes = require('../routes/draft');

// A real, finished, public NFL draft from a past season — the fixture the offline
// checks run against, and the one the season guard must refuse.
const PAST_DRAFT = { id: '650130288072040449', season: '2021' };

let failures = 0;
let warnings = 0;

function assert(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function warn(name, detail = '') {
  console.log(`  warn  ${name}${detail ? ` — ${detail}` : ''}`);
  warnings++;
}

function section(title) {
  console.log(`\n${title}`);
}

async function main() {
  const connected = db.prepare('SELECT * FROM draft_sync WHERE id = 1').get();
  if (connected && !process.argv.includes('--force')) {
    console.error(
      `A draft is currently connected (${connected.draft_id}). This script rewrites the\n` +
      'pick tables, so it will not run mid-draft. Pass --force if you are sure.'
    );
    process.exit(2);
  }

  // --- Reading a draft reference ------------------------------------------------
  section('Draft references');
  assert('a draft URL yields its id',
    parseDraftRef('https://sleeper.com/draft/nfl/650130288072040449') === '650130288072040449');
  assert('sleeper.app links work too',
    parseDraftRef('https://sleeper.app/draft/nfl/650130288072040449') === '650130288072040449');
  assert('a bare id passes through',
    parseDraftRef('650130288072040449') === '650130288072040449');
  assert('junk is refused rather than guessed at', parseDraftRef('my draft') === null);
  assert('an empty reference is refused', parseDraftRef('') === null);

  // --- Pick order ---------------------------------------------------------------
  section('Pick order');
  const snake = { type: 'snake', teams: 4, rounds: 4, reversal_round: 0 };
  assert('a snake turns at the end of the round',
    [1, 2, 3, 4, 5, 6, 7, 8].map(n => slotForPick(n, snake)).join(',') === '1,2,3,4,4,3,2,1');
  assert('a linear draft does not turn',
    [1, 2, 3, 4, 5, 6, 7, 8].map(n => slotForPick(n, { ...snake, type: 'linear' })).join(',') === '1,2,3,4,1,2,3,4');
  // Guessing here would put the wrong team on the clock, which is worse than saying
  // nothing at all.
  assert('an auction reports no pick order', slotForPick(1, { ...snake, type: 'auction' }) === null);
  assert('a third-round reversal reports no pick order',
    slotForPick(1, { ...snake, reversal_round: 3 }) === null);
  assert('your next pick is found from where the draft stands',
    nextPickForSlot(5, 3, snake) === 6, `got ${nextPickForSlot(5, 3, snake)}`);
  assert('being on the clock reads as zero picks away',
    nextPickForSlot(3, 3, snake) === 3);

  // --- The season guard ---------------------------------------------------------
  section('Season guard');
  const season = await currentSeason();
  assert('Sleeper reports a plausible current season',
    /^\d{4}$/.test(season) && Number(season) >= 2024, season);

  let rejected = null;
  try {
    await fetchDraft(PAST_DRAFT.id);
    rejected = false;
  } catch (err) {
    rejected = err.message;
  }
  // The failure this stops: /v1/draft/<id> answers 200 for any draft Sleeper has ever
  // hosted. Connecting to last year's would mark a few hundred players taken, and the
  // board would look plausible while being entirely wrong.
  assert('a past-season draft is refused',
    typeof rejected === 'string' && rejected.includes(PAST_DRAFT.season),
    rejected === false ? 'it was accepted' : rejected);

  // --- Matching picks onto the board --------------------------------------------
  section('Matching picks onto the board');
  const meta = await fetchDraft(PAST_DRAFT.id, PAST_DRAFT.season);
  const picks = await fetchPicks(PAST_DRAFT.id);
  assert('the fixture draft returns picks', picks.length > 0, `${picks.length} picks`);

  db.prepare('DELETE FROM draft_picks').run();
  const stored = draftRoutes.storePicks(meta.draft_id, picks);
  assert('every pick is stored',
    db.prepare('SELECT COUNT(*) c FROM draft_picks').get().c === picks.length);

  const matchedRows = db.prepare(`
    SELECT dp.pick_no, dp.player_name, dp.position AS pick_pos, dp.nfl_team AS pick_team,
           dp.sleeper_player_id AS pick_sid,
           p.name AS board_name, p.position AS board_pos, p.sleeper_player_id AS board_sid
    FROM draft_picks dp JOIN players p ON p.id = dp.player_id
  `).all();

  // Two ways a pick can find its player, and they deserve different scrutiny.
  //
  // An id match is Sleeper's own player id on both sides: authoritative, and the names
  // are allowed to differ. They genuinely do — a draft made in a past season carries
  // the name of the day, so Kenneth Gainwell arrives against a board that now says
  // Kenny Gainwell. That is the id doing its job, not a mismatch.
  //
  // A name match is the fallback for board rows that have no Sleeper id yet, and it is
  // the one that can go wrong: a surname-only match once put Omari Evans onto Mike
  // Evans. Here it must agree on first name and position exactly.
  const byId = matchedRows.filter(r => r.pick_sid && r.pick_sid === r.board_sid);
  const byName = matchedRows.filter(r => !(r.pick_sid && r.pick_sid === r.board_sid));
  console.log(`        ${byId.length} matched on Sleeper id, ${byName.length} on name`);

  const firstName = s => (s || '').toLowerCase().replace(/[^a-z ]/g, '').split(' ')[0];

  const nameDisagrees = byName.filter(r => firstName(r.player_name) !== firstName(r.board_name));
  assert('every name-matched pick agrees on first name', nameDisagrees.length === 0,
    nameDisagrees.slice(0, 3).map(r => `${r.player_name} → ${r.board_name}`).join(', '));

  const posDisagrees = byName.filter(r => r.pick_pos && r.board_pos !== r.pick_pos);
  assert('every name-matched pick agrees on position', posDisagrees.length === 0,
    posDisagrees.slice(0, 3).map(r => `${r.player_name} → ${r.board_name}`).join(', '));

  // An id match landing on a different position is not a bad match — it is a board row
  // whose position has gone stale against Sleeper's roster.
  const idPosDrift = byId.filter(r => r.pick_pos && r.board_pos !== r.pick_pos);
  if (idPosDrift.length > 0) {
    warn('an id-matched player sits at a different position on the board',
      idPosDrift.slice(0, 3).map(r => `${r.board_name} ${r.board_pos}≠${r.pick_pos}`).join(', '));
  }

  const doubled = db.prepare(`
    SELECT player_id, COUNT(*) c FROM draft_picks
    WHERE player_id IS NOT NULL GROUP BY player_id HAVING c > 1
  `).all();
  assert('no player is claimed by two picks', doubled.length === 0,
    `${doubled.length} doubled`);

  const rate = stored.matched / picks.length;
  console.log(`        ${stored.matched}/${picks.length} picks matched (${(rate * 100).toFixed(0)}%)`);
  // Unmatched picks are normal — kickers, defences, and anyone off the board's tail.
  // A collapse in the rate is not.
  if (rate < 0.5) {
    assert('picks match onto the board at a sane rate', false, `only ${(rate * 100).toFixed(0)}%`);
  } else if (rate < 0.75) {
    warn('match rate is lower than expected', `${(rate * 100).toFixed(0)}% — fine for an old fixture draft, check it against a current one`);
  }

  // --- An undone pick -----------------------------------------------------------
  section('Undone picks');
  // A commissioner can undo a pick. A player left marked as taken after that never
  // comes back onto the board, which is worse than one briefly missing.
  const fewer = picks.filter(p => p.pick_no <= Math.floor(picks.length / 2));
  const after = draftRoutes.storePicks(meta.draft_id, fewer);
  assert('picks that vanish from Sleeper are dropped',
    after.removed === picks.length - fewer.length,
    `removed ${after.removed} of ${picks.length - fewer.length}`);
  assert('the store matches Sleeper exactly',
    db.prepare('SELECT COUNT(*) c FROM draft_picks').get().c === fewer.length);

  // --- Optionally, the owner's own draft ----------------------------------------
  if (process.env.SLEEPER_DRAFT_ID) {
    section(`Your draft (${process.env.SLEEPER_DRAFT_ID})`);
    try {
      const mine = await fetchDraft(process.env.SLEEPER_DRAFT_ID);
      assert('it is an NFL draft for this season', mine.season === season && mine.sport === 'nfl',
        `${mine.season} ${mine.sport}`);
      console.log(`        ${mine.league_name || 'mock draft'} · ${mine.status} · ${mine.type} · ` +
        `${mine.teams}-team · ${mine.rounds} rounds · ${mine.scoring_type}`);
      const myPicks = await fetchPicks(mine.draft_id);
      db.prepare('DELETE FROM draft_picks').run();
      const r = draftRoutes.storePicks(mine.draft_id, myPicks);
      console.log(`        ${r.matched}/${myPicks.length} picks matched onto the board`);
      // Half-PPR is what every number on this board is priced in.
      if (mine.scoring_type && !/half/.test(mine.scoring_type) && !/ppr/.test(mine.scoring_type)) {
        warn('the draft is not a PPR format', `${mine.scoring_type} — this board is half-PPR throughout`);
      }
    } catch (err) {
      assert('your draft could be read', false, err.message);
    }
  } else {
    console.log('\n  (set SLEEPER_DRAFT_ID to also check a draft of your own)');
  }

  db.prepare('DELETE FROM draft_picks').run();

  console.log(
    `\n${failures === 0 ? 'All draft-sync checks passed' : `${failures} check(s) FAILED`}` +
    `${warnings ? `, ${warnings} warning(s)` : ''}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\nvalidate-draft-sync crashed:', err.message);
  process.exit(1);
});
