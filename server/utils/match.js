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

// First-name pairs the prefix rule below cannot bridge, because the short form is not
// a prefix of the long one. Kenny/Kenneth is the case that split one running back
// across two rows until it was added here.
const NICKNAMES = [
  ['kenny', 'kenneth'], ['mike', 'michael'], ['bobby', 'robert'], ['bob', 'robert'],
  ['bill', 'william'], ['billy', 'william'], ['jim', 'james'], ['jimmy', 'james'],
  ['drew', 'andrew'], ['andy', 'andrew'], ['tony', 'anthony'], ['nate', 'nathaniel'],
  ['nate', 'nathan'], ['rick', 'richard'], ['ricky', 'richard'], ['ted', 'theodore'],
  ['tj', 'tyler'], ['dj', 'demetrius'], ['chuck', 'charles'], ['charlie', 'charles'],
  ['hank', 'henry'], ['jack', 'john'], ['johnny', 'john'], ['joe', 'joseph'],
  ['tom', 'thomas'], ['tommy', 'thomas'], ['steve', 'stephen'], ['steve', 'steven'],
];
const NICKNAME_PAIRS = new Set(NICKNAMES.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));

/**
 * Are these two first names plausibly the same person?
 *
 * Uniqueness alone is not enough for a surname match. If a source lists a player the
 * database has never seen, the only row sharing his surname is by definition unique —
 * so "Omari Evans" resolved onto Mike Evans and overwrote his ranking. The first names
 * have to be compatible too: identical, one an abbreviation of the other, or an
 * initial.
 */
function firstNamesCompatible(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // A bare initial, however it was punctuated before normalising.
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  if (NICKNAME_PAIRS.has(`${a}|${b}`)) return true;
  // Ken / Kenneth, Josh / Joshua, Cam / Cameron.
  const [shortName, longName] = a.length <= b.length ? [a, b] : [b, a];
  return shortName.length >= 3 && longName.startsWith(shortName);
}

/**
 * Build a matcher bound to a db handle.
 *
 * Match order: exact name+pos → normalized name+pos → alias → surname + pos + team →
 * surname + pos, and every surname route additionally requires compatible first names.
 *
 * When the source gives a team, a surname match must be on that team. Falling through
 * to a same-surname player on a different team is how one player's numbers land on
 * another's row.
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
    const first = parts[0];
    const likeLast = `% ${last}`;

    const firstOf = row => (row.name_normalized || '').split(' ')[0];
    const compatible = list => list.filter(r => firstNamesCompatible(first, firstOf(r)));

    if (team) {
      const teamHits = compatible(byLastTeam.all(position, team.toUpperCase(), last, likeLast));
      if (teamHits.length === 1) return teamHits[0];
      // The source knows the team. If nobody on it fits, this is a player the database
      // does not have — not a reason to reach for the same surname elsewhere.
      return null;
    }

    const hits = compatible(byLast.all(position, last, likeLast));
    return hits.length === 1 ? hits[0] : null;
  };
}

/**
 * Guard against two source entries landing on the same row within one pass. Even with
 * a strict matcher this can happen through the alias table, and silently taking
 * whichever came last is how a star ends up with a bench player's ranking.
 */
function createClaimGuard(label) {
  const claimed = new Map();
  return function claim(id, name) {
    if (claimed.has(id)) {
      console.warn(`[${label}] "${name}" also matched the row already taken by "${claimed.get(id)}" — keeping the first`);
      return false;
    }
    claimed.set(id, name);
    return true;
  };
}

module.exports = { createMatcher, createClaimGuard, firstNamesCompatible, ALIASES };
