/**
 * One-time seeder: populates adp_underdog and adp_sl_rd from user-pasted DraftSharks data.
 *
 * Usage:
 *   node server/scripts/seed_adp_paste.js
 *
 * Expects /tmp/ud_players.json and /tmp/sl_players.json produced by
 * server/scripts/parse_adp_paste.py (or re-run that script to regenerate them).
 *
 * The script is idempotent — re-running it updates ADP values in place.
 */
'use strict';
const path = require('path');
const { db } = require(path.join(__dirname, '../db'));
const { normalizeName } = require(path.join(__dirname, '../utils/normalize'));

const UDP_PATH = '/tmp/ud_players.json';
const SL_PATH  = '/tmp/sl_players.json';

if (!require('fs').existsSync(UDP_PATH) || !require('fs').existsSync(SL_PATH)) {
  console.error('Missing /tmp/ud_players.json or /tmp/sl_players.json');
  console.error('Run: python3 server/scripts/parse_adp_paste.py first');
  process.exit(1);
}

const udPlayers = require(UDP_PATH);
const slPlayers = require(SL_PATH);

// DraftSharks → Sleeper/DB team abbreviation differences
const TEAM_MAP = { LVR: 'LV', JAC: 'JAX' };
function mapTeam(t) { return TEAM_MAP[t] || t; }

const SUFFIX_SET = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

function parseAbbrevName(raw) {
  const parts = raw.trim().split(/\s+/);
  let init = '', lastParts = [], suffix = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const pl = p.toLowerCase().replace(/\.$/, '');
    if (i === 0 && /^[A-Z]\.$/.test(p)) {
      init = p[0].toUpperCase();
    } else if (SUFFIX_SET.has(pl)) {
      suffix = p;
    } else {
      lastParts.push(p);
    }
  }
  return { init, last: lastParts.join(' '), suffix };
}

function findPlayer(init, last, suffix, pos, rawTeam) {
  const normLast = normalizeName(last);
  const dbTeam = mapTeam(rawTeam);

  // Primary: position + last name in normalized name
  const rows = db.prepare(
    `SELECT * FROM players WHERE position = ? AND name_normalized LIKE ?`
  ).all(pos, `%${normLast}%`);

  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  // Narrow by team
  const byTeam = rows.filter(r => (r.nfl_team || '').toUpperCase() === dbTeam.toUpperCase());
  const pool = byTeam.length > 0 ? byTeam : rows;
  if (pool.length === 1) return pool[0];

  // Narrow by first initial
  const byInit = pool.filter(r => r.name.toUpperCase().startsWith(init.toUpperCase()));
  const pool2 = byInit.length > 0 ? byInit : pool;
  if (pool2.length === 1) return pool2[0];

  // Narrow by suffix
  if (suffix) {
    const sfNorm = suffix.toLowerCase().replace(/\.$/, '');
    const bySuffix = pool2.filter(r => normalizeName(r.name).includes(sfNorm));
    if (bySuffix.length === 1) return bySuffix[0];
  } else {
    const noSuffix = pool2.filter(r => !SUFFIX_SET.has(r.name.split(' ').pop().toLowerCase().replace(/\.$/, '')));
    if (noSuffix.length === 1) return noSuffix[0];
  }

  return pool2[0];
}

function seedSource(players, column) {
  const getByNamePos = db.prepare(`SELECT * FROM players WHERE name = ? AND position = ?`);
  const insertNew = db.prepare(`
    INSERT OR IGNORE INTO players (name, position, nfl_team, name_normalized, last_updated)
    VALUES (@name, @position, @nfl_team, @name_normalized, @ts)
  `);
  const updateAdp = db.prepare(`UPDATE players SET ${column} = @adp, last_updated = @ts WHERE id = @id`);
  const now = new Date().toISOString();

  let matched = 0, inserted = 0;
  const notFound = [];

  // Ensure a UNIQUE constraint exists on (name, position) to make INSERT OR IGNORE work
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_players_name_pos ON players (name, position)`);
  } catch (_) {}

  const run = db.transaction(() => {
    for (const p of players) {
      const { init, last, suffix } = parseAbbrevName(p.name);
      const dbTeam = mapTeam(p.team);

      let existing = findPlayer(init, last, suffix, p.position, dbTeam);

      if (!existing) {
        const abbrevFull = suffix ? `${init}. ${last} ${suffix}` : `${init}. ${last}`;
        insertNew.run({
          name: abbrevFull,
          position: p.position,
          nfl_team: dbTeam === 'UNS' ? null : dbTeam,
          name_normalized: normalizeName(abbrevFull),
          ts: now,
        });
        existing = getByNamePos.get(abbrevFull, p.position);
        if (existing) inserted++;
      } else {
        matched++;
      }

      if (existing) {
        updateAdp.run({ adp: p.adp, ts: now, id: existing.id });
      } else {
        notFound.push(`${p.name} ${p.position} ${p.team}`);
      }
    }
  });

  run();
  return { matched, inserted, notFound };
}

// --- Main ---
console.log(`Seeding adp_underdog (${udPlayers.length} players)...`);
const udResult = seedSource(udPlayers, 'adp_underdog');
console.log(`  matched=${udResult.matched}, inserted=${udResult.inserted}, not_found=${udResult.notFound.length}`);
if (udResult.notFound.length) console.log('  Not found:', udResult.notFound);

console.log(`\nSeeding adp_sl_rd (${slPlayers.length} skill players)...`);
const slResult = seedSource(slPlayers, 'adp_sl_rd');
console.log(`  matched=${slResult.matched}, inserted=${slResult.inserted}, not_found=${slResult.notFound.length}`);
if (slResult.notFound.length) console.log('  Not found:', slResult.notFound);

const total   = db.prepare('SELECT COUNT(*) as n FROM players').get().n;
const withUD  = db.prepare('SELECT COUNT(*) as n FROM players WHERE adp_underdog IS NOT NULL').get().n;
const withSL  = db.prepare('SELECT COUNT(*) as n FROM players WHERE adp_sl_rd IS NOT NULL').get().n;
console.log(`\nDB: ${total} players | ${withUD} with adp_underdog | ${withSL} with adp_sl_rd`);
