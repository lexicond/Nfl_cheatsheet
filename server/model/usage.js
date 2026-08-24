/**
 * The per-player, per-season usage table that Modules A and B both read.
 *
 * Built once and shared, because volume and efficiency are two questions about the
 * same rows — how many opportunities did he get, and what did he do with them — and
 * computing them from separate passes is how the two silently stop agreeing about how
 * many games a player actually played.
 *
 * Everything here is PER GAME PLAYED, not per season. A back who missed six games is
 * not a low-volume back, and a season total says he is. Games played is carried
 * separately so the availability model can use it.
 */
const { scoreWeek } = require('./scoring');

// Counting stats summed straight from the weekly rows.
const COUNTING = [
  'attempts', 'passing_yards', 'passing_tds', 'passing_interceptions',
  'carries', 'rushing_yards', 'rushing_tds',
  'targets', 'receptions', 'receiving_yards', 'receiving_tds',
  'receiving_air_yards',
];

const n = v => Number(v) || 0;

/**
 * A week counts as played only if the player did something measurable. nflverse emits
 * rows for inactive players on some feeds, and counting those as zero-production games
 * drags a healthy player's per-game rate down for weeks he was never on the field.
 */
function didPlay(row) {
  return n(row.attempts) > 0 || n(row.carries) > 0 || n(row.targets) > 0
    || n(row.receptions) > 0 || n(row.rushing_yards) !== 0 || n(row.receiving_yards) !== 0;
}

/**
 * Aggregate one season of weekly rows into a per-player season record.
 *
 * Keyed on gsis_id, which is what the crosswalk joins the board on. Position is taken
 * from the most recent week rather than the first: nflverse reclassifies players
 * mid-career and the latest label is the one that matches how he is drafted now.
 */
function aggregateSeason(rows, season) {
  const byPlayer = new Map();

  for (const row of rows) {
    const id = row.player_id;
    if (!id) continue;

    if (!byPlayer.has(id)) {
      byPlayer.set(id, {
        gsis_id: id,
        name: row.player_display_name || row.player_name,
        position: row.position,
        team: row.team,
        season,
        games: 0,
        points: 0,
        weeks: [],
        target_share_sum: 0,
        air_yards_share_sum: 0,
        share_weeks: 0,
        last_week: -1,
      });
      for (const c of COUNTING) byPlayer.get(id)[c] = 0;
    }

    const p = byPlayer.get(id);
    const week = Number(row.week);

    // Latest week wins for position and team — a traded player should read as playing
    // for the team he finished on, which is the one projecting him forward.
    if (week > p.last_week) {
      p.last_week = week;
      p.position = row.position || p.position;
      p.team = row.team || p.team;
    }

    if (!didPlay(row)) continue;

    p.games++;
    for (const c of COUNTING) p[c] += n(row[c]);

    const pts = scoreWeek(row);
    p.points += pts;
    p.weeks.push(pts);

    // Shares are already per-game rates in nflverse, so they are averaged over the
    // weeks that carry them rather than summed.
    if (row.target_share !== '' && row.target_share != null && row.target_share !== 'NA') {
      p.target_share_sum += n(row.target_share);
      p.air_yards_share_sum += n(row.air_yards_share);
      p.share_weeks++;
    }
  }

  // Per-game rates and the derived usage metrics the modules actually consume.
  for (const p of byPlayer.values()) {
    const g = p.games || 1;
    p.ppg = p.points / g;
    p.target_share = p.share_weeks ? p.target_share_sum / p.share_weeks : null;
    p.air_yards_share = p.share_weeks ? p.air_yards_share_sum / p.share_weeks : null;

    // WOPR — 1.5×target share + 0.7×air-yards share. A single composite of "how much of
    // this offence's passing game runs through him", and among the stickiest things a
    // pass-catcher has.
    p.wopr = (p.target_share != null && p.air_yards_share != null)
      ? 1.5 * p.target_share + 0.7 * p.air_yards_share
      : null;

    // Per-game opportunity — the quantities Module A projects forward.
    p.targets_pg = p.targets / g;
    p.carries_pg = p.carries / g;
    p.attempts_pg = p.attempts / g;
    p.opportunities_pg = p.targets_pg + p.carries_pg;

    // Per-opportunity efficiency — the rates Module B regresses.
    p.yards_per_target = p.targets > 0 ? p.receiving_yards / p.targets : null;
    p.yards_per_carry = p.carries > 0 ? p.rushing_yards / p.carries : null;
    p.catch_rate = p.targets > 0 ? p.receptions / p.targets : null;
    p.adot = p.targets > 0 ? p.receiving_air_yards / p.targets : null;
    p.yards_per_attempt = p.attempts > 0 ? p.passing_yards / p.attempts : null;
    p.pass_td_rate = p.attempts > 0 ? p.passing_tds / p.attempts : null;
    p.int_rate = p.attempts > 0 ? p.passing_interceptions / p.attempts : null;
    p.rush_td_rate = p.carries > 0 ? p.rushing_tds / p.carries : null;
    p.rec_td_rate = p.targets > 0 ? p.receiving_tds / p.targets : null;

    // Week-to-week spread of scoring, which the best-ball ceiling needs. Population
    // standard deviation over the weeks he actually played.
    if (p.weeks.length >= 4) {
      const mean = p.points / p.weeks.length;
      const varsum = p.weeks.reduce((a, w) => a + (w - mean) ** 2, 0);
      p.week_sd = Math.sqrt(varsum / p.weeks.length);
    } else {
      p.week_sd = null;
    }
  }

  return byPlayer;
}

/**
 * Build the multi-season history: gsis_id -> array of season records, newest first.
 * A player's seasons are kept apart rather than pooled so the modules can weight
 * recency and measure sample size themselves.
 */
function buildUsageHistory(seasonStats) {
  const history = new Map();
  // Newest first, so index 0 is always the most recent season a player appears in.
  const ordered = [...seasonStats].sort((a, b) => b.season - a.season);

  for (const { season, rows } of ordered) {
    for (const [id, rec] of aggregateSeason(rows, season)) {
      if (!history.has(id)) history.set(id, []);
      history.get(id).push(rec);
    }
  }
  return history;
}

/**
 * Positional baselines for every rate the modules regress toward, computed over players
 * with enough volume to be meaningful. A baseline drawn from every player who ever saw
 * one target is a baseline of deep-bench noise, so each metric carries a minimum
 * opportunity count.
 */
const BASELINE_MINIMUMS = {
  yards_per_target: ['targets', 25],
  yards_per_carry: ['carries', 40],
  catch_rate: ['targets', 25],
  adot: ['targets', 25],
  rec_td_rate: ['targets', 25],
  rush_td_rate: ['carries', 40],
  yards_per_attempt: ['attempts', 150],
  pass_td_rate: ['attempts', 150],
  int_rate: ['attempts', 150],
};

function positionalBaselines(history) {
  const buckets = new Map();   // position -> metric -> values

  for (const seasons of history.values()) {
    for (const s of seasons) {
      if (!s.position) continue;
      if (!buckets.has(s.position)) buckets.set(s.position, {});
      const b = buckets.get(s.position);
      for (const [metric, [countField, minimum]] of Object.entries(BASELINE_MINIMUMS)) {
        if (s[metric] == null || s[countField] < minimum) continue;
        (b[metric] = b[metric] || []).push(s[metric]);
      }
    }
  }

  const out = {};
  for (const [pos, metrics] of buckets) {
    out[pos] = {};
    for (const [metric, vals] of Object.entries(metrics)) {
      if (vals.length === 0) continue;
      // Median, not mean: touchdown rates have a long right tail and a handful of
      // goal-line specialists would drag a mean baseline well above typical.
      const sorted = vals.slice().sort((a, b) => a - b);
      out[pos][metric] = sorted[Math.floor(sorted.length / 2)];
      out[pos][`${metric}_n`] = vals.length;
    }
  }
  return out;
}

module.exports = {
  aggregateSeason, buildUsageHistory, positionalBaselines,
  didPlay, COUNTING, BASELINE_MINIMUMS,
};
