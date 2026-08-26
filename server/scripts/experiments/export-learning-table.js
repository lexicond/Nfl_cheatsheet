// Dump a supervised learning table with exactly the information the structured model
// has: prior-season usage and efficiency, age, position, and that season's depth chart.
// Target is next season's points per game. Also carries the structured model's own
// projection for the seasons it can be run on, so the two are compared on identical rows.
const P = '/home/user/Nfl_cheatsheet/server';
const nflverse = require(P + '/model/nflverse');
const { buildUsageHistory } = require(P + '/model/usage');
const { runModel } = require(P + '/model');
const fs = require('fs');

const HIST = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const TEST = [2023, 2024, 2025];

const F = ['ppg', 'games', 'targets_pg', 'carries_pg', 'attempts_pg', 'target_share',
  'air_yards_share', 'yards_per_target', 'yards_per_carry', 'catch_rate', 'adot'];

const g = (s, k) => (s && s[k] != null && Number.isFinite(s[k]) ? s[k] : '');

(async () => {
  const stats = [];
  for (const s of HIST) stats.push(await nflverse.loadSeasonStats(s));
  const history = buildUsageHistory(stats);
  const cross = await nflverse.loadCrosswalk();
  const depth = {};
  for (const s of HIST) { try { depth[s] = await nflverse.loadDepthChart(s); } catch { depth[s] = new Map(); } }

  const ageAt = (gs, season) => {
    const bd = cross.byGsis.get(gs)?.birthdate; if (!bd) return '';
    const born = Date.parse(bd); if (!Number.isFinite(born)) return '';
    return ((Date.UTC(season, 8, 1) - born) / (365.25 * 24 * 3600 * 1000)).toFixed(2);
  };

  // The structured model's own projection, per test season, on the same lookahead rules
  // the validator uses.
  const modelBySeason = {};
  for (const t of TEST) {
    const { projections } = await runModel({
      targetSeason: t, environmentMaxWeek: 6, useHistoryTeam: true, useOdds: false,
      iterations: 60, depthChart: depth[t],
    });
    modelBySeason[t] = new Map(projections.map(p => [p.gsis_id, p.ppg]));
  }

  const cols = ['gsis', 'season', 'position', 'age', 'depth_order',
    ...F.map(f => 'p1_' + f), ...F.map(f => 'p2_' + f),
    'p1_seasons_ago', 'model_ppg', 'naive_ppg', 'actual_ppg'];
  const out = [cols.join(',')];

  for (const [gsis, list] of history) {
    const bySeason = new Map(list.map(s => [s.season, s]));
    for (const season of HIST) {
      const act = bySeason.get(season);
      if (!act || act.games < 1) continue;                 // needs an outcome
      const p1 = bySeason.get(season - 1);
      const p2 = bySeason.get(season - 2);
      // Same pool rule as the validator: a real role in one of the two prior seasons.
      const qualifies = (p1 && p1.games >= 6) || (p2 && p2.games >= 6);
      if (!qualifies) continue;
      const pos = act.position || p1?.position || p2?.position;
      if (!['QB', 'RB', 'WR', 'TE'].includes(pos)) continue;
      const d = depth[season]?.get(gsis);
      out.push([
        gsis, season, pos, ageAt(gsis, season), d?.order ?? '',
        ...F.map(f => g(p1, f)), ...F.map(f => g(p2, f)),
        p1 && p1.games >= 6 ? 1 : 2,
        modelBySeason[season]?.get(gsis) ?? '',
        p1 ? p1.ppg : 0,
        act.ppg,
      ].join(','));
    }
  }
  fs.writeFileSync(process.argv[2], out.join('\n'));
  console.log(`wrote ${out.length - 1} rows to ${process.argv[2]}`);
})();
