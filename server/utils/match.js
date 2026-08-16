const { normalizeName } = require('./normalize');

// Cross-site naming differences that normalizeName alone cannot bridge.
// Keys and values are both normalized forms.
const ALIASES = {
  'hollywood brown': 'marquise brown',
  'gabe davis': 'gabriel davis',
  'josh palmer': 'joshua palmer',
  'cam ward': 'cameron ward',
  'chig okonkwo': 'chigoziem okonkwo',
  'demario douglas': 'demario douglas',
  'mike thomas': 'michael thomas',
  'nathaniel dell': 'tank dell',
  'deebo samuel sr': 'deebo samuel',
  'marvin mims': 'marvin mims jr',
  'ken walker': 'kenneth walker',
  'kenny walker': 'kenneth walker',
  'jeffery wilson': 'jeff wilson',
  'chris rodriguez': 'christopher rodriguez',
  'tre harris': 'tre harris',
  'brian robinson': 'brian robinson jr',
};

function aliasOf(norm) {
  return ALIASES[norm] || null;
}

/**
 * Build a matcher bound to a db handle.
 *
 * Match order: exact name+pos → normalized name+pos → alias → last name + pos + team →
 * last name + pos when that last name is unique for the position.
 *
 * The last-name fallbacks deliberately refuse ambiguous hits. Two players share a
 * surname far more often than sources abbreviate a first name, so a greedy LIKE
 * match writes one player's ADP onto another (this is how "B. Robinson" used to
 * land on Bijan instead of Brian).
 */
function createMatcher(db) {
  const byExact = db.prepare('SELECT * FROM players WHERE name = ? AND position = ?');
  const byNorm = db.prepare('SELECT * FROM players WHERE name_normalized = ? AND position = ?');
  const byLastTeam = db.prepare(
    "SELECT * FROM players WHERE position = ? AND nfl_team = ? AND (name_normalized = ? OR name_normalized LIKE ?)"
  );
  const byLast = db.prepare(
    "SELECT * FROM players WHERE position = ? AND (name_normalized = ? OR name_normalized LIKE ?)"
  );

  return function findPlayer(name, position, team = null) {
    if (!name || !position) return null;

    const exact = byExact.get(name, position);
    if (exact) return exact;

    const norm = normalizeName(name);
    if (!norm) return null;

    const normHit = byNorm.get(norm, position);
    if (normHit) return normHit;

    const alias = aliasOf(norm);
    if (alias) {
      const aliasHit = byNorm.get(alias, position);
      if (aliasHit) return aliasHit;
    }

    const parts = norm.split(' ');
    if (parts.length < 2) return null;
    const last = parts[parts.length - 1];
    const firstInitial = parts[0][0];
    const likeLast = `% ${last}`;

    if (team) {
      const teamHits = byLastTeam.all(position, team.toUpperCase(), last, likeLast);
      if (teamHits.length === 1) return teamHits[0];
      const initialHits = teamHits.filter(r => (r.name_normalized || '')[0] === firstInitial);
      if (initialHits.length === 1) return initialHits[0];
    }

    const hits = byLast.all(position, last, likeLast);
    if (hits.length === 1) return hits[0];
    const initialHits = hits.filter(r => (r.name_normalized || '')[0] === firstInitial);
    if (initialHits.length === 1) return initialHits[0];

    return null;
  };
}

module.exports = { createMatcher, ALIASES };
