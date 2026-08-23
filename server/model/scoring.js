/**
 * The league's scoring, in one place.
 *
 * This board is half-PPR with four-point passing touchdowns throughout, and the model
 * has to score under exactly that or its projections are not comparable with the
 * columns beside them. Two other copies of this arithmetic already exist —
 * `calcHalfPprPts` in scrapers/sleeper.js and `halfPprPoints` in scrapers/footballers.js
 * — because each scores a different provider's field names.
 *
 * They are NOT identical, and the difference is worth knowing before comparing columns:
 * the Footballers copy subtracts two points for a lost fumble and Sleeper's does not.
 * At roughly half a point a season for most players it changes nobody's rank, but it is
 * a real difference and it is left alone rather than quietly harmonised — changing it
 * would move `projected_pts` for every player on the board as a side effect of adding
 * a new column. This model scores fumbles, matching the Footballers convention, because
 * nflverse reports them and dropping a real negative would flatter high-volume backs.
 */

const RULES = {
  passing_yards: 0.04,
  passing_tds: 4,
  passing_interceptions: -2,
  rushing_yards: 0.1,
  rushing_tds: 6,
  receptions: 0.5,
  receiving_yards: 0.1,
  receiving_tds: 6,
  fumbles_lost: -2,
  two_point_conversions: 2,
};

/**
 * Score one stat line. Keys are the model's own canonical names, not any provider's —
 * every caller normalises into this shape first, so a provider renaming a field cannot
 * silently zero a scoring category.
 */
function score(stat) {
  const n = k => Number(stat[k]) || 0;
  return (
    n('passing_yards') * RULES.passing_yards +
    n('passing_tds') * RULES.passing_tds +
    n('passing_interceptions') * RULES.passing_interceptions +
    n('rushing_yards') * RULES.rushing_yards +
    n('rushing_tds') * RULES.rushing_tds +
    n('receptions') * RULES.receptions +
    n('receiving_yards') * RULES.receiving_yards +
    n('receiving_tds') * RULES.receiving_tds +
    n('fumbles_lost') * RULES.fumbles_lost +
    n('two_point_conversions') * RULES.two_point_conversions
  );
}

/**
 * Pull one nflverse weekly row into the canonical shape above.
 *
 * nflverse splits fumbles across three columns by how the ball was lost, and splits
 * two-point conversions across three by how it was scored. Summing them here keeps the
 * scoring function free of provider vocabulary.
 */
function fromNflverse(row) {
  const n = k => Number(row[k]) || 0;
  return {
    passing_yards: n('passing_yards'),
    passing_tds: n('passing_tds'),
    passing_interceptions: n('passing_interceptions'),
    rushing_yards: n('rushing_yards'),
    rushing_tds: n('rushing_tds'),
    receptions: n('receptions'),
    receiving_yards: n('receiving_yards'),
    receiving_tds: n('receiving_tds'),
    fumbles_lost: n('sack_fumbles_lost') + n('rushing_fumbles_lost') + n('receiving_fumbles_lost'),
    two_point_conversions:
      n('passing_2pt_conversions') + n('rushing_2pt_conversions') + n('receiving_2pt_conversions'),
  };
}

/** Points for one nflverse weekly row. */
function scoreWeek(row) {
  return score(fromNflverse(row));
}

module.exports = { RULES, score, fromNflverse, scoreWeek };
