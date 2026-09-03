#!/usr/bin/env node
/**
 * Star the players an expert round-up calls values, flag the ones it fades, and write
 * the reasoning into the notes.
 *
 *   node server/scripts/apply-expert-board.js [--file <path>] [--overwrite] [--dry-run]
 *
 * The input is `server/data/expert-board-2026.json` — a hand-compiled round-up of what
 * analysts are saying, with three lists: `targets` (buy), `fades` (avoid) and
 * `contested` (a real two-sided argument). A player may appear in more than one, and
 * everything said about him is merged into one set of notes.
 *
 * This writes to `player_overrides`, which is YOUR data, so it is deliberately narrow:
 *
 *   - it sets `starred` on targets and `flagged` on fades, and never clears either,
 *     because you may have starred someone for your own reasons;
 *   - it writes `note_upside` and `note_downside` only;
 *   - it never touches `personal_rank`, `tier`, `drafted` or `note_personal`;
 *   - every note it writes ends with a provenance line, and it refuses to overwrite a
 *     note that does not carry one — that note is yours. `--overwrite` says otherwise.
 *
 * `note_sources` — the "Analyst Notes" field — looks like the obvious home for this and
 * is the one field it must not touch: `scrapers/sleeper.js` owns it, refreshing every
 * player's projected stat line into it on every run and standing off only where the
 * existing text does not begin "Sleeper ". So writing here would both displace that
 * line for exactly the 34 players worth reading about and freeze it for them for ever,
 * with nothing in the UI to say the numbers had stopped updating. The verdict and the
 * analysts behind it go at the head of the upside or downside note instead.
 *
 * Re-running it is safe and idempotent.
 *
 * The board is the authority on which team a player is on, not this file: rosters move
 * and a round-up compiled in one week names last week's team. So the match is on name
 * and position and the file's team is only checked, never used — a disagreement is
 * printed rather than silently resolved either way.
 */
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { createMatcher } = require('../utils/match');

const argv = process.argv.slice(2);
const has = f => argv.includes(`--${f}`);
const value = (f) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 ? argv[i + 1] : null;
};

const FILE = value('file') || path.join(__dirname, '..', 'data', 'expert-board-2026.json');
const OVERWRITE = has('overwrite');
const DRY = has('dry-run');

const board = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const meta = board.meta || {};

// Stamped on the end of every generated note. It is what makes a re-run able to
// replace its own text without touching anything you typed, and it names the league
// the round-up was compiled for — a 10-team read of a 12-team ADP is not the same
// advice as a 12-team one, and the note has to say so where it is read.
const STAMP = `[expert board · ${meta.compiled || 'undated'} · ${meta.format || 'format unstated'}`
  + `${meta.adp_source ? ` · ADP: ${meta.adp_source}` : ''}]`;
const STAMP_MARK = '[expert board · ';

const stamp = text => `${text}\n\n${STAMP}`;
const isGenerated = v => v == null || v === '' || v.includes(STAMP_MARK);

/* ---------------- gather everything said about each player ---------------- */

const entries = new Map();
const keyOf = e => `${e.player}|${e.pos}`;
const slot = (e) => {
  const k = keyOf(e);
  if (!entries.has(k)) {
    entries.set(k, { name: e.player, pos: e.pos, team: e.team, star: false, flag: false, up: [], down: [] });
  }
  return entries.get(k);
};

// "ADP 38.0 (round 4 in a 10-team)" — the round is the one the file computed for the
// league it was compiled for, carried through rather than recomputed here.
const cost = e => `ADP ${e.sleeper_adp}${e.round_10tm ? ` · round ${e.round_10tm}` : ''}`;

// The verdict, what it costs and who is saying it lead each note. Without them the
// reasoning is an unattributed assertion, and half the value of a round-up is knowing
// whether one analyst said it or six did.
for (const e of board.targets || []) {
  const s = slot(e);
  s.star = true;
  s.up.push(`${e.verdict} — ${e.archetype} · ${cost(e)} · ${(e.experts || []).join(', ')}`
    + (e.why ? `\n${e.why}` : ''));
}

for (const e of board.fades || []) {
  const s = slot(e);
  s.flag = true;
  s.down.push(`${e.verdict} — ${e.archetype} · ${cost(e)} · fading: ${(e.experts_out || []).join(', ')}`
    + (e.why ? `\n${e.why}` : ''));
}

// Contested players get both sides and no star or flag of their own: the whole point of
// the list is that the analysts do not agree, so asserting one verdict on the board
// would throw away the only thing it records.
for (const e of board.contested || []) {
  const s = slot(e);
  if (e.bull) s.up.push(`Contested — ${e.verdict} · ${cost(e)} · for: ${(e.bull_side || []).join(', ')}`
    + `\nBull: ${e.bull}`);
  if (e.bear) s.down.push(`Contested — ${e.verdict} · ${cost(e)} · against: ${(e.bear_side || []).join(', ')}`
    + `\nBear: ${e.bear}`);
}

/* ---------------- match, then write ---------------- */

const findPlayer = createMatcher(db);
const readOverride = db.prepare('SELECT * FROM player_overrides WHERE player_id = ?');
// MAX rather than assignment on both flags: a star you set by hand is never taken away
// because this round-up happens not to mention him.
const upsert = db.prepare(`
  INSERT INTO player_overrides (player_id, starred, flagged, note_upside, note_downside, updated_at)
  VALUES (@id, @starred, @flagged, @up, @down, datetime('now'))
  ON CONFLICT(player_id) DO UPDATE SET
    starred = MAX(starred, @starred),
    flagged = MAX(flagged, @flagged),
    note_upside = @up, note_downside = @down,
    updated_at = datetime('now')
`);

const missing = [];
const teamMismatch = [];
const kept = [];
let written = 0;

const apply = db.transaction(() => {
  for (const e of entries.values()) {
    const target = findPlayer(e.name, e.pos);
    if (!target) { missing.push(`${e.name} (${e.pos}, ${e.team})`); continue; }
    if (e.team && target.nfl_team && target.nfl_team !== e.team) {
      teamMismatch.push(`${e.name}: round-up says ${e.team}, board says ${target.nfl_team}`);
    }

    const existing = readOverride.get(target.id) || {};
    const next = {
      id: target.id,
      starred: e.star ? 1 : 0,
      flagged: e.flag ? 1 : 0,
      up: e.up.length ? stamp(e.up.join('\n\n')) : (existing.note_upside ?? null),
      down: e.down.length ? stamp(e.down.join('\n\n')) : (existing.note_downside ?? null),
    };

    // Anything already in a note that this script did not write is yours. Keep it and
    // say which player was skipped, rather than quietly replacing your own reasoning
    // with somebody else's.
    if (!OVERWRITE) {
      for (const [field, col] of [['up', 'note_upside'], ['down', 'note_downside']]) {
        if (e[field].length && !isGenerated(existing[col])) {
          kept.push(`${e.name} · ${col}`);
          next[field] = existing[col];
        }
      }
    }

    if (!DRY) upsert.run(next);
    written++;
  }
});

apply();

console.log(`\n${DRY ? 'Would update' : 'Updated'} ${written} of ${entries.size} players`);
console.log(`  starred: ${[...entries.values()].filter(e => e.star).length}`
  + `  ·  flagged: ${[...entries.values()].filter(e => e.flag).length}`
  + `  ·  contested (notes only): ${(board.contested || []).length}`);

if (teamMismatch.length) {
  console.log(`\nTeam disagreements — matched on name and position, board's team kept:`);
  teamMismatch.forEach(m => console.log(`  ! ${m}`));
}
if (kept.length) {
  console.log(`\nYour own notes left alone (pass --overwrite to replace):`);
  kept.forEach(m => console.log(`  · ${m}`));
}
if (missing.length) {
  console.log(`\nNot on the board — nothing written:`);
  missing.forEach(m => console.log(`  ✗ ${m}`));
}
console.log('');
process.exit(missing.length ? 1 : 0);
