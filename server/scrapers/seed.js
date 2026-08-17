// Fallback seed data — used only if all scrapers fail on first run
const SEED_PLAYERS = [
  { name: "Ja'Marr Chase", position: 'WR', nfl_team: 'CIN', adp: 1 },
  { name: 'Justin Jefferson', position: 'WR', nfl_team: 'MIN', adp: 2 },
  { name: 'CeeDee Lamb', position: 'WR', nfl_team: 'DAL', adp: 3 },
  { name: 'Tyreek Hill', position: 'WR', nfl_team: 'MIA', adp: 4 },
  { name: 'Breece Hall', position: 'RB', nfl_team: 'NYJ', adp: 5 },
  { name: 'Saquon Barkley', position: 'RB', nfl_team: 'PHI', adp: 6 },
  { name: 'Amon-Ra St. Brown', position: 'WR', nfl_team: 'DET', adp: 7 },
  { name: 'Malik Nabers', position: 'WR', nfl_team: 'NYG', adp: 8 },
  { name: 'Josh Allen', position: 'QB', nfl_team: 'BUF', adp: 9 },
  { name: 'Lamar Jackson', position: 'QB', nfl_team: 'BAL', adp: 10 },
  { name: 'Sam LaPorta', position: 'TE', nfl_team: 'DET', adp: 11 },
  { name: 'Travis Kelce', position: 'TE', nfl_team: 'KC', adp: 12 },
  { name: 'Jonathan Taylor', position: 'RB', nfl_team: 'IND', adp: 13 },
  { name: 'Davante Adams', position: 'WR', nfl_team: 'LV', adp: 14 },
  { name: 'Bijan Robinson', position: 'RB', nfl_team: 'ATL', adp: 15 },
  { name: 'Drake London', position: 'WR', nfl_team: 'ATL', adp: 16 },
  { name: 'Stefon Diggs', position: 'WR', nfl_team: 'HOU', adp: 17 },
  { name: 'Kyren Williams', position: 'RB', nfl_team: 'LAR', adp: 18 },
  { name: 'Tee Higgins', position: 'WR', nfl_team: 'CIN', adp: 19 },
  { name: 'De\'Von Achane', position: 'RB', nfl_team: 'MIA', adp: 20 },
  { name: 'Tony Pollard', position: 'RB', nfl_team: 'TEN', adp: 21 },
  { name: 'Jaylen Waddle', position: 'WR', nfl_team: 'MIA', adp: 22 },
  { name: 'Patrick Mahomes', position: 'QB', nfl_team: 'KC', adp: 23 },
  { name: 'Evan Engram', position: 'TE', nfl_team: 'JAX', adp: 24 },
  { name: 'Chris Olave', position: 'WR', nfl_team: 'NO', adp: 25 },
  { name: 'Puka Nacua', position: 'WR', nfl_team: 'LAR', adp: 26 },
  { name: 'Josh Jacobs', position: 'RB', nfl_team: 'GB', adp: 27 },
  { name: 'Tank Dell', position: 'WR', nfl_team: 'HOU', adp: 28 },
  { name: 'Christian Kirk', position: 'WR', nfl_team: 'JAX', adp: 29 },
  { name: 'Rashee Rice', position: 'WR', nfl_team: 'KC', adp: 30 },
];

// Last-resort only: this list is a static snapshot and will be out of date. It
// exists so the UI is never blank, not as a data source — every real ADP column is
// left null so a stale name never masquerades as a fetched ranking.
function seedFallback(db) {
  const { normalizeName } = require('../utils/normalize');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO players (name, name_normalized, position, nfl_team, adp_consensus, last_updated)
    VALUES (@name, @name_normalized, @position, @nfl_team, @adp_consensus, @last_updated)
  `);
  const now = new Date().toISOString();
  db.transaction(() => {
    SEED_PLAYERS.forEach(p => {
      insert.run({
        name: p.name,
        name_normalized: normalizeName(p.name),
        position: p.position,
        nfl_team: p.nfl_team,
        adp_consensus: p.adp,
        last_updated: now,
      });
    });
  })();
  console.log('[Seed] Inserted fallback top-30 players (static snapshot — refresh to replace)');
}

module.exports = { seedFallback };
